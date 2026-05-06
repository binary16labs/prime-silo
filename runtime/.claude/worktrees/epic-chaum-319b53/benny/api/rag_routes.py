"""
RAG Routes - Document ingestion and semantic search
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, AsyncGenerator
from fastapi.responses import StreamingResponse
from ..core.event_bus import event_bus
from pathlib import Path
import fitz  # PyMuPDF
import httpx

from ..core.workspace import get_workspace_path
from ..core.extraction import extract_structured_text
from ..tools.knowledge import get_chromadb_client
from ..core.models import LOCAL_PROVIDERS
from ..core.task_manager import task_manager
from ..governance.lineage import track_workflow_start, track_workflow_complete, track_aer, track_workflow_fail, track_llm_call
from ..governance.permission_manifest import register_manifest, create_ephemeral_manifest
import uuid
import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

router = APIRouter()


class IngestRequest(BaseModel):
    workspace: str = "default"
    files: Optional[List[str]] = None
    notebook_id: Optional[str] = None
    batch_size: Optional[int] = 500
    run_id: Optional[str] = None # Optional existing run/nexus ID
    deep_synthesis: bool = False # Whether to extract triples and run clustering
    strategy: str = "safe" # Heuristic layer: 'safe' or 'aggressive'
    correlation_threshold: float = 0.70 # Similarity threshold for aggressive mode



class QueryRequest(BaseModel):
    query: str
    workspace: str = "default"
    top_k: int = 5
    selected_sources: Optional[List[str]] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    mode: str = "semantic" # "semantic", "graph_agent", or "discovery_swarm"
    active_nexus_id: Optional[str] = None # For grounding graph agents
    run_id: Optional[str] = None

class AdaptiveRAGRequest(BaseModel):
    query: str
    workspace: str = "default"
    model: str = "Qwen3-8B-Hybrid"
    max_retries: int = 3

class AdaptiveRAGResponse(BaseModel):
    answer: Optional[str]
    route: str
    route_explanation: str
    documents_retrieved: int
    documents_relevant: int
    retry_count: int
    execution_trace: List[str]
    hallucination_check: Optional[bool]
    answer_quality: Optional[bool]

@router.post("/rag/ingest")
async def ingest_files(request: IngestRequest):
    """Ingest files from data_in into ChromaDB using structured extraction (Docling)."""
    run_id = request.run_id or str(uuid.uuid4())
    task = task_manager.create_task(request.workspace, "rag_ingest", task_id=run_id)
    
    try:
        track_workflow_start(run_id, "rag_ingest", request.workspace, inputs=request.files or [])
        task_manager.add_aer_entry(
            run_id, 
            intent=f"Ingesting {len(request.files) if request.files else 'all'} files from data_in",
            observation="Initialization complete",
            plan=f"1. Extract text via Docling 2. Chunk 3. Batch upsert to ChromaDB ({collection_name if 'collection_name' in locals() else 'knowledge'})"
        )
    except Exception as e:
        logger.warning("Lineage tracking failed (init): %s", e)

    try:
        data_in_path = get_workspace_path(request.workspace, "data_in")
        if not data_in_path.exists():
            task_manager.update_task(run_id, status="failed", message="No files found in data_in")
            raise HTTPException(404, "No files found in data_in")
        
        # Get files to ingest
        if request.files:
            file_paths = [data_in_path / f for f in request.files]
        else:
            file_paths = list(data_in_path.glob("*.*"))
        
        # Filter for supported types
        supported = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.html']
        file_paths = [f for f in file_paths if f.suffix.lower() in supported]
        
        if not file_paths:
            task_manager.update_task(run_id, status="failed", message="No supported files found")
            raise HTTPException(404, "No supported files found")
        
        # Get ChromaDB client
        client = get_chromadb_client(request.workspace)
        collection_name = f"notebook_{request.notebook_id}" if request.notebook_id else "knowledge"
        collection = client.get_or_create_collection(collection_name)

        # Update task total steps
        task_manager.update_task(run_id, total_steps=len(file_paths), progress=10)
        
        ingested = []
        for idx, file_path in enumerate(file_paths):
            try:
                msg = f"Processing {file_path.name} ({idx+1}/{len(file_paths)})..."
                task_manager.update_task(
                    run_id, 
                    message=msg, 
                    current_step=idx+1,
                    metadata={
                        "stage": "EXTRACTING",
                        "current_file": file_path.name
                    }
                )
                
                # Emit AER for extraction
                try:
                    track_aer(run_id, "rag_ingest", f"Extracting {file_path.name}", "Docling engine started")
                except Exception:
                    pass
                text = extract_structured_text(file_path)
                
                # Simple chunking (split by paragraphs)
                chunks = [c.strip() for c in text.split('\n\n') if c.strip()]
                
                if chunks:
                    task_manager.update_task(run_id, metadata={"stage": "INDEXING", "current_file": file_path.name, "chunks": len(chunks)})
                    
                    # 1. DELETE old entries for this source to prevent duplicates
                    collection.delete(where={"source": file_path.name})

                    # 2. UPLOAD in batches
                    batch_size = request.batch_size or 500
                    for i in range(0, len(chunks), batch_size):
                        batch_chunks = chunks[i:i + batch_size]
                        batch_ids = [f"{file_path.stem}_{run_id[-4:]}_{j}" for j in range(i, i + len(batch_chunks))]
                        batch_metadatas = [
                            {"source": file_path.name, "chunk_index": j, "run_id": run_id} 
                            for j in range(i, i + len(batch_chunks))
                        ]
                        
                        collection.add(documents=batch_chunks, metadatas=batch_metadatas, ids=batch_ids)
                        
                        # Emit AER for commit
                        perc = (i + len(batch_chunks)) / len(chunks) * 100
                        task_manager.update_task(run_id, metadata={
                            "stage": "INDEXING", 
                            "current_file": file_path.name, 
                            "chunks": len(chunks),
                            "indexed_count": i + len(batch_chunks)
                        })
                        try:
                            track_aer(run_id, "rag_ingest", f"Committing chunks for {file_path.name}", f"Committed {i+len(batch_chunks)}/{len(chunks)} chunks ({perc:.0f}%)")
                        except Exception:
                            pass
                
                # 3. DEEP SYNTHESIS (Optional)
                if request.deep_synthesis:
                    try:
                        from ..synthesis.engine import extract_triples
                        from ..graph.triples import save_knowledge_triples
                        
                        track_aer(run_id, "rag_ingest", f"Deep Synthesis for {file_path.name}", "Extracting triples via LLM Engine")
                        task_manager.update_task(run_id, metadata={"stage": "SYNTHESIZING", "current_file": file_path.name})
                        
                        # Process text in batches if very large, but for now we'll take top 10k chars
                        sample_text = text[:10000] 
                        triples = await extract_triples(
                            sample_text, 
                            source_name=file_path.name, 
                            run_id=run_id, 
                            workspace=request.workspace,
                            strategy=request.strategy
                        )
                        
                        if triples:
                            await save_knowledge_triples(request.workspace, triples, file_path.name)
                            track_aer(run_id, "rag_ingest", f"Synthesis complete for {file_path.name}", f"Extracted {len(triples)} triples")
                            
                            # 3b. Generate Librarian Wiki Article (Karpathy-style)
                            try:
                                from ..synthesis.engine import save_concept_article
                                # Use the first few triples to identify the primary concept or use the filename
                                primary_concept = file_path.stem
                                summary_prompt = f"Summarize the core concepts of this document section in 3-4 sentences for a technical wiki:\n\n{sample_text[:2000]}"
                                from ..synthesis.engine import call_llm
                                summary = await call_llm(summary_prompt, run_id=run_id)
                                
                                wiki_file = await save_concept_article(
                                    workspace=request.workspace,
                                    concept_name=primary_concept,
                                    summary=summary,
                                    relationships=[t.model_dump() for t in triples[:10]],
                                    source_files=[file_path.name]
                                )
                                track_aer(run_id, "rag_ingest", f"Wiki Generated", f"Saved Rationale Hub to {primary_concept}.md")
                            except Exception as wiki_e:
                                logger.error(f"Wiki generation error: {wiki_e}")
                    except Exception as synth_e:
                        logger.error(f"Deep Synthesis error: {synth_e}")
                        track_aer(run_id, "rag_ingest", f"Synthesis failed for {file_path.name}", str(synth_e))

                ingested.append({"file": file_path.name, "chunks": len(chunks)})
                task_manager.update_task(run_id, progress=10 + int(80 * (idx+1) / len(file_paths)))
                
            except Exception as e:
                task_manager.add_aer_entry(run_id, "Error", f"Failed {file_path.name}: {str(e)}")
                ingested.append({"file": file_path.name, "error": str(e)})
        
        # 4. FINAL CLUSTERING & CORRELATION (if deep synthesis enabled)
        if request.deep_synthesis:
            try:
                from ..graph.clustering_service import ClusteringService
                from ..synthesis.correlation import run_full_correlation_suite
                
                track_aer(run_id, "rag_ingest", "Running Topological Clustering", "Community detection started (LPA)")
                task_manager.update_task(run_id, metadata={"stage": "CLUSTERING"})
                cluster_results = ClusteringService.run_lpa_on_workspace(request.workspace)
                
                track_aer(run_id, "rag_ingest", "Running Knowledge-to-Code Correlation", "Cross-linking Concepts and Symbols")
                task_manager.update_task(run_id, metadata={"stage": "CORRELATING"})
                correlation_results = await run_full_correlation_suite(request.workspace, threshold=request.correlation_threshold)
                
                track_aer(run_id, "rag_ingest", "Deep Processing complete", 
                          f"Clusters: {cluster_results.get('communities_found', 0)}, " 
                          f"Safe Links: {correlation_results.get('safe_links', 0)}, "
                          f"Aggressive Links: {correlation_results.get('aggressive_links', 0)}")
            except Exception as post_e:
                logger.error(f"Post-processing error: {post_e}")
 

        task_manager.update_task(run_id, status="completed", progress=100, message="Ingestion finished successfully")
        try:
            track_workflow_complete(
                run_id, 
                "rag_ingest", 
                request.workspace, 
                ["extraction", "chunking", "upsert"], 
                0, 
                outputs=[f"chromadb:{collection_name}"]
            ) 
        except Exception:
            pass
        
        return {
            "status": "completed",
            "run_id": run_id,
            "workspace": request.workspace,
            "ingested": ingested,
            "total_documents": collection.count()
        }
        
    except Exception as e:
        task_manager.update_task(run_id, status="failed", message=str(e))
        raise HTTPException(500, f"Ingestion failed: {str(e)}")


@router.get("/rag/logs")
async def get_rag_logs(workspace: str = "default"):
    """Get the latest ingestion tasks from TaskManager."""
    try:
        tasks = task_manager.list_tasks(workspace)
        rag_tasks = [t for t in tasks if t.type == "rag_ingest"]
        if not rag_tasks:
            return {"tasks": []}
        
        # Sort by updated_at descending
        rag_tasks.sort(key=lambda x: x.updated_at, reverse=True)
        
        return {"tasks": [t.model_dump() for t in rag_tasks[:5]]}
    except Exception as e:
        return {"error": str(e), "tasks": []}


@router.get("/rag/status")
async def get_rag_status(workspace: str = "default"):
    """Get RAG status and document count"""
    try:
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        
        # Get unique sources - optimized by only fetching metadatas
        all_data = collection.get(include=['metadatas'])
        sources = set()
        for meta in all_data['metadatas']:
            sources.add(meta.get('source', 'Unknown'))
        
        return {
            "workspace": workspace,
            "total_chunks": collection.count(),
            "unique_documents": len(sources),
            "documents": list(sources),
            "sources": list(sources) # Alias for consistency with graph API
        }

    except Exception as e:
        raise HTTPException(500, f"Status check failed: {str(e)}")


@router.get("/rag/indexing-manifest")
async def get_indexing_manifest(workspace: str = "default"):
    """Reconcile workspace files with ChromaDB to find unindexed or changed documents."""
    try:
        # 1. Get indexed sources
        client = get_chromadb_client(workspace)
        collection = client.get_or_create_collection("knowledge")
        all_data = collection.get(include=['metadatas'])
        
        indexed_sources = {} # source_name -> {chunk_count, last_indexed}
        if all_data.get('metadatas'):
            for meta in all_data['metadatas']:
                if meta is None: continue
                src = meta.get('source')
                if not src: continue
                if src not in indexed_sources:
                    indexed_sources[src] = {"chunks": 0, "last_indexed": meta.get('timestamp')}
                indexed_sources[src]["chunks"] += 1

        # 2. Get disk files (Recursive scan focus on data_in and root)
        data_in_path = get_workspace_path(workspace, "data_in")
        supported = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.html', '.py', '.ts', '.json', '.sql']
        
        manifest = []
        import os
        from ..core.workspace import get_workspace_path
        
        import os
        for base_path_obj in scan_paths:
            base_path = str(base_path_obj)
            if not os.path.exists(base_path):
                continue
                
            for root, dirs, files in os.walk(base_path):
                # Skip some folders
                if "chromadb" in root or "__pycache__" in root or ".git" in root:
                    continue
                
                for name in files:
                    file_path = Path(root) / name
                    ext = file_path.suffix.lower()
                    if ext not in supported:
                        continue
                        
                    # Use os.path.relpath for Windows resilience (handles c: vs C: issues)
                    rel_path_str = os.path.relpath(str(file_path), base_path)
                    source_key = name # We often use just the filename as the source key
                    
                    status = "MISSING"
                    chunks = 0
                    if source_key in indexed_sources:
                        status = "ALIGNED" # Basic check: existence. In future: hash check
                        chunks = indexed_sources[source_key]["chunks"]
                    
                    manifest.append({
                        "name": name,
                        "path": rel_path_str.replace("\\", "/"),
                        "status": status,
                        "chunks": chunks,
                        "size": file_path.stat().st_size,
                        "modified": file_path.stat().st_mtime,
                        "type": ext.lstrip('.')
                    })
                    
        return {
            "workspace": workspace,
            "manifest": manifest,
            "total_indexed": len(indexed_sources)
        }
    except Exception as e:
        raise HTTPException(500, f"Indexing manifest failed: {str(e)}")


@router.post("/rag/query")
async def query_rag(request: QueryRequest):
    """Test semantic search"""
    try:
        client = get_chromadb_client(request.workspace)
        collection = client.get_or_create_collection("knowledge")
        
        if collection.count() == 0:
            return {
                "results": [],
                "message": "Knowledge base is empty"
            }
        
        results = collection.query(
            query_texts=[request.query],
            n_results=min(request.top_k, collection.count())
        )
        
        formatted_results = []
        for doc, meta, distance in zip(
            results['documents'][0],
            results['metadatas'][0],
            results['distances'][0]
        ):
            formatted_results.append({
                "text": doc,
                "source": meta.get('source', 'Unknown'),
                "relevance": round((1 - distance) * 100, 1)
            })
        

        return {
            "query": request.query,
            "results": formatted_results,
            "count": len(formatted_results)
        }
        
    except Exception as e:
        raise HTTPException(500, f"Query failed: {str(e)}")
@router.post("/rag/chat")
async def chat_rag(request: QueryRequest):
    """RAG-augmented chat for workspace documents or Neural Graph Agent"""
    # Generate a consistent run_id for lineage tracking
    run_id = request.run_id or f"chat-{uuid.uuid4().hex[:8]}"
    start_time = datetime.now()
    
    # Audit trail: Include configuration details
    lineage_audit = {
        "run_id": run_id,
        "workspace": request.workspace,
        "mode": request.mode,
        "provider": request.provider,
        "model": request.model,
        "top_k": request.top_k,
        "active_nexus_id": request.active_nexus_id,
        "timestamp": start_time.isoformat()
    }

    try:
        # Handle Graph Agent Mode (Linear)
        if request.mode == "graph_agent":
            # 1. Load the System Workflow Definition
            from .workflow_routes import workflow_storage
            from .studio_executor import topological_sort, StudioExecuteRequest
            
            wf_def = workflow_storage.get_workflow("System_GraphChatAgent")
            if not wf_def:
                 track_workflow_fail(run_id, "chat_graph_agent", request.workspace, "System_GraphChatAgent definition missing")
                 raise HTTPException(404, "System_GraphChatAgent workflow definition not found.")

            # 2. Trigger Workflow Execution
            # Map workflow definition to request nodes/edges
            nodes = wf_def.get("nodes", [])
            edges = wf_def.get("edges", [])
            
            # Update the LLM node with the user's specific request and provider/model choice
            for node in nodes:
                if node.get("type") == "llm":
                    if "config" not in node["data"]: node["data"]["config"] = {}
                    if request.model:
                        node["data"]["config"]["model"] = request.model
            
            from .studio_executor import StudioNode, StudioEdge
            pydantic_nodes = [StudioNode(**n) for n in nodes]
            pydantic_edges = [StudioEdge(**e) for e in edges]
            
            # Sort and Run
            sorted_nodes = topological_sort(pydantic_nodes, pydantic_edges)
            
            context = {
                "message": request.query, 
                "workspace": request.workspace,
                "active_nexus_id": request.active_nexus_id
            }
            
            # PRE-CHECK: If no nexus is provided for a graph agent, fail fast to trigger UI wizard
            if not request.active_nexus_id or request.active_nexus_id == "neural_nexus":
                track_workflow_fail(run_id, "chat_graph_agent", request.workspace, "nexus_required interruption")
                return {
                    "answer": "",
                    "status": "nexus_required",
                    "message": "Neural Graph Agent requires a grounded Nexus context selection to proceed. Use the Map or Forge to select an active Nexus.",
                    "run_id": run_id,
                    "lineage_audit": lineage_audit
                }

            # Security: Register ephemeral manifest for this specific chat agent run
            chat_manifest = create_ephemeral_manifest(run_id, ["query_graph", "search_kb", "read_file", "get_neighbors", "search_knowledge_workspace"])
            register_manifest(chat_manifest)

            # Initial track
            track_workflow_start(run_id, "chat_graph_agent", request.workspace, inputs=[request.query])
            task_manager.create_task(request.workspace, "chat_graph_agent", task_id=run_id)

            from .studio_executor import execute_trigger_node, execute_llm_node, execute_data_node
            final_answer = ""
            nodes_executed = 0
            
            for node in sorted_nodes:
                try:
                    nodes_executed += 1
                    if node.type == "trigger":
                        output = await execute_trigger_node(node, request.query, context)
                    elif node.type == "llm":
                        output = await execute_llm_node(node, context, request.workspace, run_id=run_id, agent_id=run_id)
                        if output.get("response"):
                            context["llm_output"] = output["response"]
                            final_answer = output["response"]
                    elif node.type == "data":
                        output = await execute_data_node(node, context, request.workspace)
                    
                    if output.get("error"):
                        final_answer = f"Agent execution stopped at node '{node.id}': {output['error']}"
                        break
                except Exception as e:
                    track_workflow_fail(run_id, "chat_graph_agent", request.workspace, str(e))
                    final_answer = f"Error in agent reasoning at node '{node.id}': {str(e)}"
                    break

            lineage_audit["nodes_executed"] = nodes_executed
            track_workflow_complete(run_id, "chat_graph_agent", request.workspace, ["reasoning"], int((datetime.now()-start_time).total_seconds()*1000))
            task_manager.update_task(run_id, status="completed" if final_answer else "failed", progress=100)

            return {
                "answer": final_answer or "No response generated.",
                "sources": ["Neural Graph", "Workspace Files"],
                "query": request.query,
                "mode": "graph_agent",
                "run_id": run_id,
                "lineage_audit": lineage_audit
            }

        # Handle Discovery Swarm Mode (Progressive)
        if request.mode == "discovery_swarm":
            from ..graph.discovery_swarm import run_discovery_swarm
            
            # Pre-check Nexus grounding
            if not request.active_nexus_id or request.active_nexus_id == "neural_nexus":
                track_workflow_fail(run_id, "discovery_swarm", request.workspace, "nexus_required interruption")
                return {
                    "answer": "",
                    "status": "nexus_required",
                    "message": "Discovery Swarm requires a grounded Nexus context selection. Use the Map or Forge to select an active Nexus.",
                    "run_id": run_id,
                    "lineage_audit": lineage_audit
                }

            track_workflow_start(run_id, "discovery_swarm", request.workspace, inputs=[request.query])
            
            # Execute the Swarm
            swarm_result = await run_discovery_swarm(
                workspace=request.workspace,
                nexus_id=request.active_nexus_id,
                query=request.query,
                run_id=run_id,
                provider=request.provider,
                model=request.model
            )
            
            final_report = "\n".join(swarm_result.get("findings", ["No findings generated."]))
            
            track_workflow_complete(run_id, "discovery_swarm", request.workspace, ["scouting", "planning"], int((datetime.now()-start_time).total_seconds()*1000))
            
            return {
                "answer": swarm_result.get("answer", f"### Discovery Report\n\n{final_report}"),
                "sources": ["Neural Graph"],
                "query": request.query,
                "mode": "discovery_swarm",
                "run_id": run_id,
                "lineage_audit": lineage_audit
            }

        # --- LEGACY / SEMANTIC MODE ---
        track_workflow_start(run_id, "chat_semantic_rag", request.workspace, inputs=[request.query])
        
        # 1. Retrieve context
        client = get_chromadb_client(request.workspace)
        collection = client.get_or_create_collection("knowledge")
        
        context_text = ""
        sources = []
        
        if collection.count() > 0:
            import re
            from pathlib import Path
            all_data = collection.get(include=['metadatas'])
            available_sources = set(meta.get('source', 'Unknown') for meta in all_data['metadatas'] if 'source' in meta)
            mentioned_sources = []
            
            if request.selected_sources and len(request.selected_sources) > 0:
                mentioned_sources = [s for s in request.selected_sources if s in available_sources]
            else:
                query_lower = request.query.lower()
                for source in available_sources:
                    source_stem = Path(source).stem.lower()
                    words = [w for w in set(re.split(r'[^a-zA-Z0-9]', source_stem)) if len(w) > 3]
                    for w in words:
                        if w in query_lower:
                            mentioned_sources.append(source)
                            break
                        
            results_list = []
            if mentioned_sources:
                k_per_source = max(3, request.top_k // len(mentioned_sources))
                for source in mentioned_sources:
                    try:
                        res = collection.query(query_texts=[request.query], n_results=min(k_per_source, collection.count()), where={"source": source})
                        if res['documents'] and res['documents'][0]:
                            for doc, meta in zip(res['documents'][0], res['metadatas'][0]):
                                results_list.append((doc, meta))
                    except Exception: pass
                try:
                    gen_res = collection.query(query_texts=[request.query], n_results=min(3, collection.count()))
                    if gen_res['documents'] and gen_res['documents'][0]:
                        for doc, meta in zip(gen_res['documents'][0], gen_res['metadatas'][0]):
                            results_list.append((doc, meta))
                except Exception: pass
            else:
                try:
                    res = collection.query(query_texts=[request.query], n_results=min(request.top_k, collection.count()))
                    if res['documents'] and res['documents'][0]:
                        for doc, meta in zip(res['documents'][0], res['metadatas'][0]):
                            results_list.append((doc, meta))
                except Exception: pass

            seen_docs = set()
            for doc, meta in results_list:
                if doc not in seen_docs:
                    seen_docs.add(doc)
                    source = meta.get('source', 'Unknown')
                    context_text += f"[Source: {source}]\n{doc}\n\n"
                    sources.append(source)

        lineage_audit["selected_sources"] = request.selected_sources
        lineage_audit["sources_retrieved"] = list(set(sources))

        # 2. Build Prompt
        system_prompt = "You are a helpful AI assistant. Answer based on context. Cite sources [Source: filename.ext]."
        
        # Truncate context to prevent 'Max length reached' errors
        from ..core.context_guard import ContextGuard
        profile = ContextGuard.get_profile(request.model or "fastflowlm")
        context_text = ContextGuard.guard_string(context_text, profile.max_rag_context_chars, "rag_context")
             
        content = f"{system_prompt}\n\nCONTEXT:\n{context_text if context_text else 'No documents found.'}\n\nQUESTION: {request.query}\n\nANSWER:"

        # 3. Call LLM
        try:
            provider_name = request.provider or "fastflowlm"
            provider_config = LOCAL_PROVIDERS.get(provider_name, LOCAL_PROVIDERS["fastflowlm"])
            
            # Model selection
            model_name = request.model or ("llama3" if provider_name == "ollama" else "amd/Qwen3-8B-Hybrid" if provider_name == "lemonade" else "gemma3:4b")
            model_core = model_name.split('/')[-1]

            chat_url = f"{provider_config['base_url']}/chat/completions"
            payload = {
                "model": model_core,
                "messages": [{"role": "user", "content": content}],
                "temperature": 0.7,
                "max_tokens": 1024
            }
            
            async with httpx.AsyncClient(timeout=300.0) as client:
                response = await client.post(chat_url, json=payload, headers={"Content-Type": "application/json"})
                
                if response.status_code == 200:
                    data = response.json()
                    
                    if "error" in data:
                        err_obj = data["error"]
                        err_msg = err_obj.get("message", str(err_obj)) if isinstance(err_obj, dict) else str(err_obj)
                        error_msg = f"LLM Error in 200 OK: {err_msg}"
                        track_workflow_fail(run_id, "chat_semantic_rag", request.workspace, error_msg)
                        raise HTTPException(503, f"LLM Provider {provider_name} returned error: {error_msg}")
                    
                    if "choices" not in data or not data["choices"]:
                        error_msg = f"LLM unexpected response format: {json.dumps(data)}"
                        track_workflow_fail(run_id, "chat_semantic_rag", request.workspace, error_msg)
                        raise HTTPException(503, error_msg)
                        
                    answer = data.get("choices", [{}])[0].get("message", {}).get("content", "No content in LLM response.")
                    
                    # Trace LLM Call
                    track_llm_call(run_id, model_core, provider_name, usage=data.get("usage"), parent_job_name="chat_semantic_rag")
                    track_workflow_complete(run_id, "chat_semantic_rag", request.workspace, ["retrieval", "generation"], int((datetime.now()-start_time).total_seconds()*1000))
                    
                    return {
                        "answer": answer,
                        "sources": list(set(sources)),
                        "query": request.query,
                        "run_id": run_id,
                        "lineage_audit": lineage_audit
                    }
                else:
                    error_msg = f"LLM Error {response.status_code}: {response.text}"
                    track_workflow_fail(run_id, "chat_semantic_rag", request.workspace, error_msg)
                    raise HTTPException(503, f"LLM Provider {provider_name} returned error: {error_msg}")

        except HTTPException:
            raise
        except Exception as e:
            import traceback
            error_msg = f"Internal chat system error (LLM Call): {str(e)}\n{traceback.format_exc()}"
            logger.error(error_msg)
            track_workflow_fail(run_id, "chat_system", request.workspace, str(e))
            raise HTTPException(500, f"Internal chat system error. Check logs for trace: {run_id}")

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_msg = f"Internal chat system error (Main): {str(e)}\n{traceback.format_exc()}"
        logger.error(error_msg)
        track_workflow_fail(run_id, "chat_system", request.workspace, str(e))
        raise HTTPException(500, f"Internal chat system error. Check logs for trace: {run_id}")


@router.get("/rag/chat/events/{run_id}")
async def stream_chat_events(run_id: str):
    """
    SSE endpoint: stream real-time progress events for a chat / swarm run.
    """
    return StreamingResponse(
        event_bus.subscribe(run_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

from fastapi import Response

@router.get("/rag/wiki/articles")
async def list_wiki_articles(workspace: str = "default"):
    """List all Rationale Hub articles generated by synthesis."""
    try:
        from ..core.workspace import get_workspace_path
        wiki_path = get_workspace_path(workspace) / ".benny" / "wiki"
        
        if not wiki_path.exists():
            return {"articles": []}
            
        articles = []
        for file in wiki_path.glob("*.md"):
            articles.append({
                "name": file.stem.replace("_", " "),
                "filename": file.name,
                "path": str(file),
                "modified": file.stat().st_mtime
            })
            
        return {"articles": sorted(articles, key=lambda x: x["modified"], reverse=True)}
    except Exception as e:
        raise HTTPException(500, f"Failed to list wiki: {str(e)}")

@router.get("/rag/wiki/article/{filename}")
async def get_wiki_article(filename: str, workspace: str = "default"):
    """Get content of a specific Rationale Hub article."""
    try:
        from ..core.workspace import get_workspace_path
        wiki_path = get_workspace_path(workspace) / ".benny" / "wiki"
        file_path = wiki_path / filename
        
        if not file_path.exists():
            raise HTTPException(404, "Article not found")
            
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        return {"content": content, "filename": filename}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to read article: {str(e)}")

from fastapi import Response

@router.post("/rag/adaptive-query", response_model=AdaptiveRAGResponse)
async def adaptive_rag_query(request: AdaptiveRAGRequest, response: Response):
    """
    Adaptive RAG query — self-correcting retrieval pipeline.
    Routes queries through no_retrieval / single_step / multi_hop 
    with quality grading and automatic query rewriting.
    """
    from ..core.adaptive_rag import run_adaptive_rag
    
    try:
        result = await run_adaptive_rag(
            query=request.query,
            workspace=request.workspace,
            model=request.model,
            max_retries=request.max_retries,
        )
        
        # Set the strategy header
        response.headers["X-RAG-Strategy"] = result.get("route", "single_step")
        
        return AdaptiveRAGResponse(
            answer=result.get("generation"),
            route=result.get("route", "single_step"),
            route_explanation=result.get("route_explanation", ""),
            documents_retrieved=len(result.get("documents", [])),
            documents_relevant=len(result.get("graded_documents", [])),
            retry_count=result.get("retry_count", 0),
            execution_trace=result.get("execution_trace", []),
            hallucination_check=result.get("hallucination_check"),
            answer_quality=result.get("answer_quality"),
        )
    except Exception as e:
        raise HTTPException(500, f"Adaptive RAG failed: {str(e)}")

@router.post("/rag/correlate")
async def manual_correlate(workspace: str = "default", threshold: float = 0.70):
    """Manually trigger the correlation suite (Neural Spark) for a workspace."""
    try:
        from ..synthesis.correlation import run_full_correlation_suite
        results = await run_full_correlation_suite(workspace, threshold=threshold)
        return {
            "status": "completed",
            "workspace": workspace,
            "threshold": threshold,
            "results": results
        }
    except Exception as e:
        raise HTTPException(500, f"Correlation failed: {str(e)}")

@router.get("/rag/config/context")
async def get_context_config(model: str = "fastflowlm"):
    """Expose ContextGuard profiles to the frontend."""
    from ..core.context_guard import ContextGuard
    profile = ContextGuard.get_profile(model)
    return {
        "model": model,
        "max_total_chars": profile.max_total_chars,
        "max_tool_output_chars": profile.max_tool_output_chars,
        "max_rag_context_chars": profile.max_rag_context_chars,
    }
