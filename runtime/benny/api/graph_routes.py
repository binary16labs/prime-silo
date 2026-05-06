"""
Graph Routes - API endpoints for the Synthesis Knowledge Engine.

Provides CRUD for the knowledge graph, synthesis operations, 
real-time graph data for the 3D visualization, and SSE progress streaming.
"""

import asyncio
import anyio
import hashlib
import json
import logging
import re
import shutil
import uuid
import random
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, AsyncGenerator

from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..core.graph_db import (
    verify_connectivity, init_schema, get_full_graph, get_neighbors,
    get_graph_stats, add_triple, add_source_link, add_conflict,
    add_analogy, set_concept_embedding, vector_search,
    get_mapped_sources, delete_source_from_graph,
    create_synthesis_run, get_synthesis_history, delete_synthesis_run,
    update_graph_centrality, batch_add_triples, get_recent_updates, run_cypher
)
from ..synthesis.engine import (
    extract_triples, detect_conflicts, find_synthesis,
    cross_domain_analogy, get_embedding, compute_cluster_similarities,
    parallel_extract_triples, extract_directed_triples_from_section,
    batch_embed_concepts, deduplicate_triples
)
from ..core.workspace import get_workspace_path, load_manifest
from ..core.extraction import extract_structured_text
from ..core.schema import (
    KnowledgeTriple, SynthesisConfig, IngestionEvent, IngestionEventType
)
from ..core.task_manager import task_manager
from ..governance.lineage import (
    track_workflow_start, 
    track_workflow_complete, 
    track_llm_call,
    track_tool_execution,
    track_aer
)
from ..graph.code_analyzer import CodeGraphAnalyzer, get_workspace_graph, list_workspace_dirs

logger = logging.getLogger(__name__)

router = APIRouter()

@router.post("/graph/layout")
async def trigger_graph_layout(workspace: str = "default"):
    """
    Trigger the Gravity Index spatial layout calculation.
    Computes 3D coordinates (x, y, z) for all nodes based on graph topology.
    """
    try:
        from ..graph.gravity_index import GravityIndex
        engine = GravityIndex(workspace)
        result = await engine.run()
        return result
    except Exception as e:
        raise HTTPException(500, f"Layout calculation failed: {str(e)}")

@router.get("/graph/code/lod")
async def get_graph_lod(workspace: str = "default", tier: int = 1):
    """
    Return a semantically filtered graph based on Level-of-Detail (LoD).
    
    Tiers:
      1 (High):   Full graph (Files, Symbols, Concepts).
      2 (Medium): High-level hierarchy (Files, Classes, Hub Concepts).
      3 (Low):    Summary View (Folder Entry Points + Community Representatives).
    """
    try:
        from ..core.graph_db import read_session
        
        # Base node types for each tier
        tier_filters = {
            1: ["CodeEntity", "Concept", "File", "Class", "Function", "Documentation"],
            2: ["File", "Class", "Concept", "Documentation"],
            3: ["File", "Concept"] # Tier 3 also uses centrality logic below
        }
        
        labels = tier_filters.get(tier, tier_filters[1])
        
        query = """
        MATCH (n {workspace: $ws})
        WHERE any(label IN labels(n) WHERE label IN $labels)
        """
        
        # Additional Tier 3 logic: Limit to top nodes by degree or community hub
        if tier == 3:
            query += """
            WITH n
            MATCH (n)-[r]-()
            WITH n, count(r) as degree
            ORDER BY degree DESC
            LIMIT 66
            """
            
        query += """
        RETURN elementId(n) as id, n.name as name, labels(n)[0] as type, 
               n.pos_x as x, n.pos_y as y, n.pos_z as z,
               n.community_id as community_id, n.community_name as community_name
        """
        
        nodes = []
        with read_session() as session:
            result = session.run(query, ws=workspace, labels=labels)
            for record in result:
                # Default positions if layout hasn't run yet
                x = record["x"] or (random.random() * 20 - 10)
                y = record["y"] or (random.random() * 20 - 10)
                z = record["z"] or (random.random() * 20 - 10)
                
                nodes.append({
                    "id": record["id"],
                    "name": record["name"],
                    "type": record["type"],
                    "position": [x, y, z],
                    "metadata": {
                        "community_id": record["community_id"],
                        "community_name": record["community_name"]
                    }
                })
        
        # Fetch edges between the filtered nodes
        node_ids = [n["id"] for n in nodes]
        edge_query = """
        MATCH (n)-[r]->(m)
        WHERE elementId(n) IN $ids AND elementId(m) IN $ids
        RETURN elementId(n) as source, elementId(m) as target, type(r) as type,
               r.confidence as confidence, r.rationale as rationale, r.predicate as predicate
        """

        edges = []
        with read_session() as session:
            result = session.run(edge_query, ids=node_ids)
            for record in result:
                edge = {
                    "source": record["source"],
                    "target": record["target"],
                    "type": record["type"]
                }
                if record["confidence"] is not None:
                    edge["confidence"] = record["confidence"]
                if record["rationale"] is not None:
                    edge["rationale"] = record["rationale"]
                if record["predicate"] is not None:
                    edge["predicate"] = record["predicate"]
                edges.append(edge)
                
        return {"nodes": nodes, "edges": edges}
        
    except Exception as e:
        raise HTTPException(500, f"LoD graph fetch failed: {str(e)}")


# =============================================================================
# MODELS
# =============================================================================

class TripleRequest(BaseModel):
    subject: str
    predicate: str
    object: str
    source_name: Optional[str] = None
    workspace: str = "default"
    timestamp: Optional[str] = None


class GraphIngestRequest(BaseModel):
    text: str = ""
    source_name: str = "manual_entry"
    workspace: str = "default"
    provider: str = "ollama"
    model: Optional[str] = None
    embed: bool = True
    embedding_provider: str = "local"
    embedding_model: Optional[str] = None
    direction: str = ""
    inference_delay: float = 2.0
    name: Optional[str] = None


class IngestFilesRequest(BaseModel):
    files: List[str]
    workspace: str = "default"
    provider: str = "ollama"
    model: Optional[str] = None
    embed: bool = True
    embedding_provider: str = "local"
    embedding_model: Optional[str] = None
    direction: str = ""
    inference_delay: float = 2.0
    name: Optional[str] = None


class SynthesizeRequest(BaseModel):
    workspace: str = "default"
    provider: str = "lemonade"
    model: Optional[str] = None


class CrossDomainRequest(BaseModel):
    concept: str
    target_domain: str
    workspace: str = "default"
    provider: str = "lemonade"
    model: Optional[str] = None


class EmbedConceptRequest(BaseModel):
    concept: str
    workspace: str = "default"
    provider: str = "local"
    model: Optional[str] = None


class VectorSearchRequest(BaseModel):
    query: str
    workspace: str = "default"
    top_k: int = 10
    provider: str = "local"
    model: Optional[str] = None


class ClusterRequest(BaseModel):
    concepts: Optional[List[str]] = None
    workspace: str = "default"
    threshold: float = 0.75


class RunIDRequest(BaseModel):
    run_id: str
    workspace: str = "default"


class CodeGraphGenerateRequest(BaseModel):
    workspace: str = "default"
    root_dir: str = ""
    name: Optional[str] = None


class WorkspaceSettingsUpdateRequest(BaseModel):
    workspace: str = "default"
    exclude_patterns: Optional[List[str]] = None
    deep_scan: Optional[bool] = None


# =============================================================================
# STATUS & SCHEMA
# =============================================================================

@router.get("/graph/status")
async def graph_status():
    """Check Neo4j connectivity and return graph statistics."""
    conn = verify_connectivity()
    if conn["status"] == "connected":
        stats = get_graph_stats()
        conn["stats"] = stats
    return conn


@router.post("/graph/init")
async def initialize_graph():
    """Initialize the Neo4j schema (constraints, indexes)."""
    try:
        result = init_schema()
        return result
    except Exception as e:
        raise HTTPException(500, f"Schema init failed: {str(e)}")


@router.post("/graph/centrality")
async def trigger_centrality_update(workspace: str = "default"):
    """Recalculate node centrality (PageRank) across the graph."""
    try:
        return update_graph_centrality(workspace)
    except Exception as e:
        raise HTTPException(500, f"Centrality update failed: {str(e)}")


@router.get("/graph/schema-health")
async def schema_health(workspace: str = "default"):
    """
    Return a live schema diagnostic for the given workspace.

    Useful for:
      - Verifying that correlation queries will match actual labels.
      - Diagnosing the zero-link condition.
      - Confirming CORRELATES_WITH edges exist after ingestion.

    Returns:
      - labels: all Neo4j labels in the database
      - relationship_types: all relationship type names
      - entity_type_distribution: per-workspace entity type counts
      - expected_labels: labels the system expects to find
      - missing_labels: expected labels not yet present
      - semantic_edge_types_present: CORRELATES_WITH / REL if they exist
      - recommendation: 'label-based', 'property-based', or 'hybrid'
      - schema_mode: same as recommendation (canonical field name)
    """
    conn = verify_connectivity()
    if conn["status"] != "connected":
        raise HTTPException(503, f"Neo4j not available: {conn.get('error')}")

    try:
        from ..core.graph_db import introspect_schema
        from ..synthesis.schema_adapter import SchemaAdapter

        schema = introspect_schema(workspace)

        expected_labels = [
            "CodeEntity", "Concept", "Source", "File",
            "Class", "Function", "Interface", "Documentation"
        ]
        present_labels = schema.get("labels", [])
        missing_labels = [l for l in expected_labels if l not in present_labels]

        semantic_edge_types = ["CORRELATES_WITH", "REL", "RELATES_TO"]
        semantic_edges_present = [
            t for t in schema.get("relationship_types", [])
            if t in semantic_edge_types
        ]

        adapter = SchemaAdapter(workspace)
        schema_mode = adapter.get_schema_mode()

        return {
            **schema,
            "expected_labels": expected_labels,
            "missing_labels": missing_labels,
            "semantic_edge_types_present": semantic_edges_present,
            "zero_link_condition": "CORRELATES_WITH" not in schema.get("relationship_types", []),
            "recommendation": schema_mode,
            "schema_mode": schema_mode,
            "valid_entity_types": adapter.get_valid_entity_types(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Schema health check failed: {str(e)}")

@router.get("/graph/health")
async def graph_health_grade(workspace: str = "default"):
    """
    Return a scored health grade (A-F) for the Neural Nexus graph.

    Dimensions scored:
      - Label coverage         (30%): expected labels present in DB
      - Semantic edge density  (40%): CORRELATES_WITH + REL edge count
      - Temporal coverage      (20%): CodeEntity nodes with created_at
      - Rationale coverage     (10%): CORRELATES_WITH edges with rationale

    Also returns:
      - zero_link_condition: bool — True if CORRELATES_WITH is completely absent
      - recommendations: list of specific remediation steps
    """
    conn = verify_connectivity()
    if conn["status"] != "connected":
        raise HTTPException(503, f"Neo4j not available: {conn.get('error')}")
    try:
        from ..synthesis.diagnostics import get_graph_health
        return get_graph_health(workspace)
    except Exception as e:
        raise HTTPException(500, f"Health grade computation failed: {str(e)}")



@router.get("/graph/full")
async def full_graph(
    workspace: str = "default",
    page: Optional[int] = None,
    page_size: int = 200,
    show_all: bool = False,
    run_id: Optional[str] = None
):
    """
    Get the knowledge graph for visualization (nodes + edges).
    
    Modes:
      - ?show_all=true: Complete graph (no pagination)
      - ?page=0&page_size=200: Paginated for large graphs
      - ?run_id=XXX: Filter by specific synthesis run
      - Default: First 200 nodes + their edges
    """
    conn = verify_connectivity()
    if conn["status"] != "connected":
        raise HTTPException(status_code=503, detail=f"Neo4j not available: {conn.get('error')}")
    try:
        return get_full_graph(workspace, page=page, page_size=page_size, show_all=show_all, run_id=run_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch graph: {str(e)}")


@router.get("/graph/stats")
async def graph_statistics(workspace: str = "default"):
    """Get graph statistics (node / edge counts) — single optimised query."""
    conn = verify_connectivity()
    if conn["status"] != "connected":
        raise HTTPException(status_code=503, detail=f"Neo4j not available: {conn.get('error')}")
    try:
        return get_graph_stats(workspace)
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch stats: {str(e)}")


@router.get("/graph/sources")
async def graph_sources(workspace: str = "default"):
    """Get list of source documents mapped in the graph."""
    conn = verify_connectivity()
    if conn["status"] != "connected":
        raise HTTPException(status_code=503, detail=f"Neo4j not available: {conn.get('error')}")
    try:
        return {"sources": get_mapped_sources(workspace)}
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch sources: {str(e)}")


@router.delete("/graph/sources/{filename}")
async def delete_graph_source(filename: str, workspace: str = "default"):
    """Delete a source and all its associated triples from the graph."""
    try:
        return delete_source_from_graph(filename, workspace)
    except Exception as e:
        raise HTTPException(500, f"Failed to delete source: {str(e)}")


@router.get("/graph/neighbors/{concept}")
async def concept_neighbors(concept: str, workspace: str = "default", depth: int = 1):
    """Get neighbourhood of a concept up to N hops."""
    try:
        return get_neighbors(concept, workspace, depth)
    except Exception as e:
        raise HTTPException(500, f"Neighbor query failed: {str(e)}")


@router.get("/graph/history")
async def graph_history(workspace: str = "default"):
    """Get historical synthesis runs for a workspace."""
    try:
        return {"history": get_synthesis_history(workspace)}
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch history: {str(e)}")


@router.delete("/graph/runs/{run_id}")
async def delete_run(run_id: str, workspace: str = "default"):
    """Delete a specific synthesis run and its associated graph data."""
    try:
        # 1. Delete from graph
        graph_result = delete_synthesis_run(run_id, workspace)

        # 2. Delete file artifacts if they exist
        data_path = get_workspace_path(workspace, f"runs/{run_id}")
        if data_path.exists():
            import shutil
            shutil.rmtree(data_path)

        return {**graph_result, "files_deleted": True}
    except Exception as e:
        raise HTTPException(500, f"Failed to delete run: {str(e)}")


@router.get("/graph/catalog")
async def get_graph_catalog(workspace: str = "default"):
    """
    Get a unified list of all selectable graphs (snapshots and scans) 
    in a workspace.
    """
    try:
        from ..core.graph_db import get_code_scan_history, get_synthesis_history
        
        scans = get_code_scan_history(workspace)
        runs = get_synthesis_history(workspace)
        
        catalog = []
        
        # 1. Neural Nexus (Global Merged View)
        catalog.append({
            "id": "neural_nexus",
            "name": "Neural Nexus (Merged Global view)",
            "type": "knowledge",
            "timestamp": datetime.now().isoformat(),
            "is_global": True
        })
        
        # 2. Add Code Scans
        for s in scans:
            catalog.append({
                "id": s["scan_id"],
                "name": s["name"],
                "type": "code",
                "timestamp": str(s["created_at"])
            })
            
        # 3. Add Synthesis Runs
        for r in runs:
            catalog.append({
                "id": r["run_id"],
                "name": r.get("name") or f"Synthesis_{r['run_id'][:8]}",
                "type": "knowledge",
                "timestamp": str(r["created_at"])
            })
            
        return {"catalog": catalog}
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch catalog: {str(e)}")


@router.get("/graph/recent")
async def get_recent_graph_updates(workspace: str = "default", seconds: int = 10):
    """
    Get graph updates from the last N seconds using real timestamp filtering.
    Used for real-time 'fly-to-continent' visualization during ingestion.
    """
    try:
        return get_recent_updates(workspace, seconds)
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch recent updates: {str(e)}")


# =============================================================================
# CODE GRAPH (Tree-sitter & Logic)
# =============================================================================

@router.get("/graph/code")
async def fetch_code_graph(workspace: str = "default", snapshot_id: Optional[str] = None, path: Optional[str] = None):
    """Fetch the analyzed code graph for 3D visualization."""
    try:
        return get_workspace_graph(workspace, snapshot_id=snapshot_id, path_filter=path)
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch code graph: {str(e)}")


@router.post("/graph/code/generate")
async def generate_code_graph(request: CodeGraphGenerateRequest, background_tasks: BackgroundTasks):
    """Trigger a recursive tree-sitter scan of the workspace."""
    run_id = str(uuid.uuid4())
    
    # Load manifest to check deep_scan setting
    from ..core.workspace import load_manifest
    manifest = load_manifest(request.workspace)
    deep_scan = getattr(manifest, "deep_scan", True)

    async def _run_analyzer():
        try:
            # We use the actual workspace path
            ws_path = get_workspace_path(request.workspace)
            
            # Offload CPU-bound analyzer to a thread
            def _analyze():
                analyzer = CodeGraphAnalyzer(str(ws_path))
                analyzer.analyze_workspace(request.root_dir, deep_scan=deep_scan)
                # Save as a distinct snapshot
                analyzer.save_to_neo4j(request.workspace, run_id, name=request.name)
            
            await anyio.to_thread.run_sync(_analyze)
            
            # --- PHASE 3: TOPOLOGICAL LOGIC (LPA Clustering) ---
            try:
                from ..graph.clustering_service import ClusteringService
                await ClusteringService.run_lpa_on_workspace(request.workspace)
                logger.info(f"Clustering complete for {request.workspace}")
            except Exception as ce:
                logger.error(f"Clustering failed: {ce}")

            logger.info(f"Code graph snapshot generated for {request.workspace} (ID: {run_id})")
        except Exception as e:
            logger.error(f"Code graph generation failed: {e}", exc_info=True)

    background_tasks.add_task(_run_analyzer)
    
    return {
        "status": "accepted",
        "run_id": run_id,
        "message": "Neural code analysis started in background"
    }


@router.post("/graph/workspace/settings")
async def update_workspace_settings(request: WorkspaceSettingsUpdateRequest):
    """Update workspace-specific analysis settings in manifest.yaml."""
    try:
        from ..core.workspace import update_manifest
        updates = {}
        if request.exclude_patterns is not None:
            updates["exclude_patterns"] = request.exclude_patterns
        if request.deep_scan is not None:
            updates["deep_scan"] = request.deep_scan
        
        if not updates:
            return {"status": "no_changes"}
            
        update_manifest(request.workspace, updates)
        return {"status": "success", "updated": list(updates.keys())}
    except Exception as e:
        raise HTTPException(500, f"Failed to update settings: {str(e)}")


@router.get("/graph/dirs")
async def list_workspace_directories(workspace: str = "default"):
    """List directories for the folder picker."""
    try:
        ws_path = get_workspace_path(workspace)
        return {"directories": list_workspace_dirs(str(ws_path))}
    except Exception as e:
        raise HTTPException(500, f"Failed to list directories: {str(e)}")


@router.post("/graph/triple")
async def create_triple(request: TripleRequest):
    """Manually add a single triple to the graph."""
    try:
        result = add_triple(
            subject=request.subject,
            predicate=request.predicate,
            obj=request.object,
            workspace=request.workspace,
            source_name=request.source_name,
            timestamp=request.timestamp
        )
        return result
    except Exception as e:
        raise HTTPException(500, f"Failed to add triple: {str(e)}")


# =============================================================================
# INGESTION EVENT BUS (for SSE streaming)
# =============================================================================

# In-memory event queues per run_id
_ingestion_events: Dict[str, asyncio.Queue] = {}


async def _emit_event(event: IngestionEvent):
    """Push an event to the run's event queue for SSE streaming."""
    run_id = event.run_id
    if run_id in _ingestion_events:
        await _ingestion_events[run_id].put(event)
    # Also log for non-SSE observability
    logger.info("[%s] %s: %s", run_id[:8], event.event.value, event.message)


async def _event_generator(run_id: str) -> AsyncGenerator[str, None]:
    """Async generator that yields SSE events for a given run_id."""
    queue = _ingestion_events.get(run_id)
    if not queue:
        return

    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=300.0)
            yield event.to_sse()
            if event.event in (IngestionEventType.COMPLETED, IngestionEventType.ERROR):
                break
        except asyncio.TimeoutError:
            # Send keepalive
            yield ": keepalive\n\n"


@router.get("/graph/ingest/events/{run_id}")
async def stream_ingestion_events(run_id: str):
    """
    SSE endpoint: stream real-time progress events for an ingestion run.
    Connect with EventSource in the browser.
    """
    if run_id not in _ingestion_events:
        raise HTTPException(404, f"No active ingestion for run_id: {run_id}")

    return StreamingResponse(
        _event_generator(run_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


# =============================================================================
# MARKDOWN SEGMENTATION
# =============================================================================

def _split_markdown_into_segments(text: str) -> List[Dict[str, str]]:
    """Splits markdown text into logical sections based on headers."""
    segments = []
    lines = text.split('\n')
    current_title = "Introduction / Main"
    current_content = []

    for line in lines:
        header_match = re.match(r'^(#{1,3})\s+(.*)', line)
        if header_match:
            # Save the previous chunk
            if ''.join(current_content).strip():
                segments.append({"title": current_title, "text": '\n'.join(current_content)})
            current_title = header_match.group(2).strip()
            current_content = [line]
        else:
            current_content.append(line)

    if ''.join(current_content).strip():
        segments.append({"title": current_title, "text": '\n'.join(current_content)})

    # If no headers found at all, just return one big segment
    if not segments:
        return [{"title": "Main Content", "text": text}]

    return segments


# =============================================================================
# SYNTHESIS OPERATIONS
# =============================================================================

@router.post("/graph/ingest")
async def ingest_text(request: GraphIngestRequest, background_tasks: BackgroundTasks):
    """
    Ingest text: extract triples via LLM, store in Neo4j, optionally embed concepts.
    """
    try:
        run_id = str(uuid.uuid4())
        _ingestion_events[run_id] = asyncio.Queue()
        
        background_tasks.add_task(
            _process_content_to_graph,
            request.text,
            request.source_name,
            request.workspace,
            request.provider,
            request.model,
            request.embed,
            request.embedding_provider,
            request.embedding_model,
            request.direction,
            request.inference_delay,
            run_id,
            _emit_event,
            name=request.name
        )
        return {"status": "accepted", "run_id": run_id}
    except Exception as e:
        raise HTTPException(500, f"Ingestion failed: {str(e)}")


@router.post("/graph/ingest-files")
async def ingest_files_to_graph(request: IngestFilesRequest, background_tasks: BackgroundTasks):
    """
    Ingest selected files from the workspace as a background task.
    Returns immediately with a run_id for SSE progress tracking.
    """
    run_id = str(uuid.uuid4())

    # Create event queue for SSE streaming
    _ingestion_events[run_id] = asyncio.Queue()

    # Start background processing
    background_tasks.add_task(
        _background_ingest_files,
        run_id=run_id,
        files=request.files,
        workspace=request.workspace,
        provider=request.provider,
        model=request.model,
        embed=request.embed,
        embedding_provider=request.embedding_provider,
        embedding_model=request.embedding_model,
        direction=request.direction,
        inference_delay=request.inference_delay,
        name=request.name
    )

    return {
        "status": "accepted",
        "run_id": run_id,
        "sse_url": f"/api/graph/ingest/events/{run_id}",
        "message": f"Background ingestion started for {len(request.files)} file(s)"
    }


async def _background_ingest_files(
    run_id: str,
    files: List[str],
    workspace: str,
    provider: str,
    model: Optional[str],
    embed: bool,
    embedding_provider: str,
    embedding_model: Optional[str],
    direction: str,
    inference_delay: float,
    name: Optional[str] = None
):
    """Background task for batch file ingestion with SSE event emission."""
    results = []
    event_callback = _emit_event

    await event_callback(IngestionEvent(
        event=IngestionEventType.STARTED,
        run_id=run_id,
        message=f"Starting ingestion of {len(files)} file(s)",
        data={"files": files, "total": len(files)}
    ))

    # Register in TaskManager for Mesh Visibility
    task_manager.create_task(workspace, "graph_ingest", task_id=run_id)
    track_workflow_start(
        run_id, 
        "graph_ingest", 
        workspace, 
        inputs=files,
        outputs=[f"graph_run_{run_id}"]
    )
    task_manager.add_aer_entry(
        run_id,
        intent=f"Ingesting {len(files)} files into Knowledge Graph",
        observation="Initialization complete",
        plan="1. Structured extraction 2. Parallel Triple extraction 3. Conflict detection 4. Batch Neo4j store 5. Embedding"
    )

    try:
        data_in_path = get_workspace_path(workspace, "data_in")
        staging_path = get_workspace_path(workspace, "staging")
        
        # Step 0: Expand directories and resolve paths
        to_process = []
        workspace_root = get_workspace_path(workspace)
        for f in files:
            # Check path relative to workspace root first
            p = workspace_root / f
            if not p.exists():
                # Fallback to subdirectories if f is just a filename
                p = data_in_path / f
                if not p.exists():
                    p = staging_path / f
            
            if not p.exists():
                logger.warning("File or directory not found: %s", f)
                continue
            
            if p.is_dir():
                logger.info("Expanding directory: %s", f)
                for item in p.rglob("*"):
                    if item.is_file() and item.suffix.lower() in ['.md', '.txt', '.pdf']:
                        to_process.append(item)
            else:
                to_process.append(p)

        if not to_process:
            logger.warning("No eligible files found for ingestion.")
            await event_callback(IngestionEvent(
                event=IngestionEventType.COMPLETED,
                run_id=run_id,
                message="Ingestion complete: 0 file(s) processed (no eligible files found)",
                data={"files_processed": 0}
            ))
            return

        for file_idx, file_path in enumerate(to_process):
            filename = file_path.name
            
            # Determine if this file is in the staging area
            is_staged = staging_path in file_path.parents

            # Step 1: Extract structured text via Docling
            # content = extract_structured_text(file_path) # Wait, it was duplicated in original
            text = extract_structured_text(file_path)

            if not text.strip():
                logger.warning("No content extracted from %s", filename)
                continue

            # Step 2: Process to graph
            # We use the filename as source_name. 
            # Note: We align the DB with the final data_in location by using the filename
            file_result = await _process_content_to_graph(
                text=text,
                source_name=filename,
                workspace=workspace,
                provider=provider,
                model=model,
                embed=embed,
                embedding_provider=embedding_provider,
                embedding_model=embedding_model,
                direction=direction,
                inference_delay=inference_delay,
                run_id=run_id,
                event_callback=_emit_event,
                name=name
            )
            
            # Step 3: Lifecycle Management - Move from staging to data_in on success
            if file_result.get("status") == "ingested" and is_staged:
                try:
                    dest_path = data_in_path / filename
                    # Ensure we don't overwrite if it somehow exists (or we do?)
                    if dest_path.exists():
                        import time
                        dest_path = data_in_path / f"{int(time.time())}_{filename}"
                    
                    shutil.move(str(file_path), str(dest_path))
                    logger.info("Successfully moved %s to data_in", filename)
                except Exception as move_err:
                    logger.error("Failed to move %s to data_in: %s", filename, move_err)

            results.append({
                "file": filename,
                "status": file_result.get("status"),
                "triples": file_result.get("triples_extracted", 0)
            })
            
            # Update TaskManager Progress
            progress = int((file_idx + 1) / len(to_process) * 100)
            task_manager.update_task(run_id, progress=progress, message=f"Processed {file_idx+1}/{len(files)}: {filename}")

        await event_callback(IngestionEvent(
            event=IngestionEventType.COMPLETED,
            run_id=run_id,
            message=f"Ingestion complete: {len(results)} file(s) processed",
            data={
                "files_processed": len(results),
                "details": results
            }
        ))
        
        task_manager.update_task(run_id, status="completed", progress=100, message="Graph ingestion successful")
        track_workflow_complete(
            run_id, 
            "graph_ingest", 
            workspace, 
            ["extraction", "synthesis", "neo4j_store"], 
            0,
            outputs=[f"graph_run_{run_id}"]
        )
        return results

    except Exception as e:
        logger.error("Background ingestion failed: %s", e, exc_info=True)
        await event_callback(IngestionEvent(
            event=IngestionEventType.ERROR,
            run_id=run_id,
            message=f"Ingestion failed: {str(e)}"
        ))

    finally:
        # Clean up event queue after a delay (allow SSE client to receive final event)
        await asyncio.sleep(5)
        _ingestion_events.pop(run_id, None)


async def _process_content_to_graph(
    text: str,
    source_name: str,
    workspace: str,
    provider: str,
    model: Optional[str],
    embed: bool,
    embedding_provider: str,
    embedding_model: Optional[str] = None,
    direction: str = "",
    inference_delay: float = 2.0,
    run_id: Optional[str] = None,
    event_callback: Optional[Any] = None,
    name: Optional[str] = None
):
    """Core ingestion pipeline: extract -> validate -> store -> embed -> centrality."""
    # Step 0: Ensure Run ID and Partition Key
    if not run_id:
        run_id = str(uuid.uuid4())

    pk_source = f"{model or 'default'}-{source_name}"
    partition_key = hashlib.sha256(pk_source.encode()).hexdigest()
    content_hash = hashlib.sha256(text.encode()).hexdigest()

    # Step 0a: Check Neo4j connectivity
    conn = verify_connectivity()
    if conn["status"] != "connected":
        raise HTTPException(
            status_code=503,
            detail=f"Knowledge Graph database not available: {conn.get('error', 'Unknown connection error')}"
        )

    manifest = load_manifest(workspace)
    llm_timeout = manifest.llm_timeout
    synthesis_config = manifest.synthesis

    # Create SynthesisRun record
    create_synthesis_run(
        run_id=run_id,
        partition_key=partition_key,
        model=model or "default",
        workspace=workspace,
        files=[source_name],
        version="1.0.0",
        artifact_path=str(get_workspace_path(workspace, f"runs/{run_id}")),
        name=name
    )
    
    # Track metadata in TaskManager registry
    task_manager.update_task(run_id, content_hash=content_hash, partition_key=partition_key)

    # Step 1: Parallel Extraction of Triples
    sections = _split_markdown_into_segments(text)
    logger.info("Hierarchical parallel parsing initiated for %s: %d sections found.", source_name, len(sections))

    # Trace AER for extraction
    try:
        track_aer(run_id, "graph_ingest", workspace, f"Extracting triples from {source_name}", f"Split into {len(sections)} sections")
    except Exception as e:
        logger.warning("Lineage tracking failed (extraction): %s", e)

    # Filter microscopic sections early
    active_sections = [s for s in sections if len(s['text'].strip()) >= synthesis_config.min_section_chars]

    triples = await parallel_extract_triples(
        sections=active_sections,
        direction=direction,
        provider=provider,
        model=model,
        parallel_limit=synthesis_config.parallel_limit,
        inference_delay=inference_delay,
        timeout=llm_timeout,
        config=synthesis_config,
        event_callback=event_callback,
        workspace=workspace,
        run_id=run_id
    )

    if not triples:
        task_manager.add_aer_entry(run_id, "Extraction finished", f"No triples found for {source_name}")
        return {"status": "no_triples_found", "triples_extracted": 0}

    # Step 2: Check for conflicts against existing graph
    existing = []
    try:
        graph = get_full_graph(workspace, show_all=True)
        for edge in graph.get("edges", []):
            if edge.get("type") == "RELATES_TO":
                src_node = next((n for n in graph["nodes"] if n["id"] == edge["source"]), None)
                tgt_node = next((n for n in graph["nodes"] if n["id"] == edge["target"]), None)
                if src_node and tgt_node:
                    existing.append([src_node["name"], edge.get("predicate", ""), tgt_node["name"]])
    except Exception:
        pass

    conflicts = []
    if existing:
        conflicts = await detect_conflicts(
            existing_triples=existing,
            new_triples=triples,
            workspace=workspace,
            provider=provider,
            model=model,
            timeout=llm_timeout,
            config=synthesis_config,
            run_id=run_id
        )
        
        # Track conflict detection as a tool execution nested under the ingest workflow
        track_tool_execution(
            parent_run_id=run_id,
            tool_name="conflict_detection",
            tool_args={"existing_count": len(existing), "new_count": len(triples)},
            success=True,
            parent_job_name="graph_ingest"
        )

    if event_callback:
        await event_callback(IngestionEvent(
            event=IngestionEventType.CONFLICTS_CHECKED,
            run_id=run_id,
            source_name=source_name,
            message=f"Conflict check: {len(conflicts)} conflicts found",
            data={"conflicts": len(conflicts)}
        ))

    # Step 3: Store triples in Neo4j (Batch Mode)
    # Convert KnowledgeTriple objects to dicts for batch storage
    triple_dicts = [t.model_dump() if isinstance(t, KnowledgeTriple) else t for t in triples]
    stored_result = batch_add_triples(
        triples=triples,
        workspace=workspace,
        source_name=source_name,
        run_id=run_id
    )
    
    # Track Neo4j batch storage as a tool execution
    track_tool_execution(
        parent_run_id=run_id,
        tool_name="neo4j_batch_storage",
        tool_args={"workspace": workspace, "source": source_name, "count": len(triples)},
        success=stored_result.get("count", 0) > 0,
        parent_job_name="graph_ingest"
    )
    logger.info("[SUCCESS] Batched %d triples into Neo4j successfully.", stored_result['count'])

    if event_callback:
        await event_callback(IngestionEvent(
            event=IngestionEventType.STORED,
            run_id=run_id,
            source_name=source_name,
            message=f"Stored {stored_result['count']} triples",
            data={"count": stored_result["count"]}
        ))

    # Track AER for storage
    try:
        track_aer(run_id, "graph_ingest", workspace, f"Storing triples for {source_name}", f"Committed {stored_result['count']} triples to Neo4j database")
    except Exception as e:
        logger.warning("Lineage tracking failed (storage): %s", e)

    # Step 3b: Save Artifacts to Workspace Disk
    try:
        run_dir = get_workspace_path(workspace, f"runs/{run_id}")
        run_dir.mkdir(parents=True, exist_ok=True)

        # 1. Triples JSON
        with open(run_dir / "extraction.json", "w", encoding="utf-8") as f:
            json.dump(triple_dicts, f, indent=2, default=str)

        # 2. Metadata JSON
        meta = {
            "run_id": run_id,
            "partition_key": partition_key,
            "content_hash": content_hash,
            "model": model,
            "source": source_name,
            "triples_count": len(triples),
            "conflicts_count": len(conflicts),
            "timestamp": datetime.now().isoformat()
        }
        with open(run_dir / "metadata.json", "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)

        # 3. Simple Summary Markdown
        summary = f"# Synthesis Report: {source_name}\n\n"
        summary += f"- **Model**: {model or 'default'}\n"
        summary += f"- **Triples Extracted**: {len(triples)}\n"
        summary += f"- **Conflicts**: {len(conflicts)}\n\n"
        summary += "## Core Points\n"
        for t in triples[:10]:  # Top 10 for summary
            if isinstance(t, KnowledgeTriple):
                summary += f"- {t.subject} {t.predicate} {t.object} (Confidence: {t.confidence})\n"
            elif isinstance(t, dict):
                summary += f"- {t.get('subject')} {t.get('predicate')} {t.get('object')} (Confidence: {t.get('confidence')})\n"

        with open(run_dir / "summary.md", "w", encoding="utf-8") as f:
            f.write(summary)

    except Exception as e:
        logger.error("Failed to save artifacts: %s", e)

    # Step 4: Store conflicts
    for conflict in conflicts:
        try:
            add_conflict(
                concept_a=conflict["concept_a"],
                concept_b=conflict["concept_b"],
                description=conflict.get("description", ""),
                workspace=workspace
            )
        except Exception:
            pass

    # Step 5: Embed concepts (batch mode)
    embedded_count = 0
    if embed:
        all_concepts = set()
        for t in triples:
            if isinstance(t, KnowledgeTriple):
                if t.subject:
                    all_concepts.add(t.subject)
                if t.object:
                    all_concepts.add(t.object)
            elif isinstance(t, dict):
                if t.get("subject"):
                    all_concepts.add(t.get("subject"))
                if t.get("object"):
                    all_concepts.add(t.get("object"))

        # Use active provider for local embeddings instead of assuming Ollama
        actual_emb_provider = provider if embedding_provider == "local" else embedding_provider

        embeddings = await batch_embed_concepts(
            concepts=list(all_concepts),
            provider=actual_emb_provider,
            model=embedding_model,
            batch_size=synthesis_config.embedding_batch_size,
            event_callback=event_callback if event_callback else None
        )

        for concept_name, emb in embeddings.items():
            if emb:
                set_concept_embedding(concept_name, emb, workspace)
                embedded_count += 1
        
        # Step 5b: Sync to ChromaDB for semantic search (Snapshotted)
        try:
            from ..tools.knowledge import get_chromadb_client
            client = get_chromadb_client(workspace)
            collection = client.get_or_create_collection("knowledge")
            
            # Use paragraphs as simple chunks
            chunks = [c.strip() for c in text.split('\n\n') if c.strip()]
            if chunks:
                batch_ids = [f"{source_name}_{run_id[-4:]}_{j}" for j in range(len(chunks))]
                batch_metadatas = [
                    {"source": source_name, "chunk_index": j, "run_id": run_id} 
                    for j in range(len(chunks))
                ]
                collection.add(documents=chunks, metadatas=batch_metadatas, ids=batch_ids)
                logger.info(f"Synced {len(chunks)} chunks to ChromaDB (Nexus: {run_id})")
        except Exception as e:
            logger.warning(f"Failed to sync to ChromaDB: {e}")

    # Step 6: Update Graph Centrality for visual sizing
    try:
        update_graph_centrality(workspace)
        if event_callback:
            await event_callback(IngestionEvent(
                event=IngestionEventType.CENTRALITY_UPDATED,
                run_id=run_id,
                message="Centrality scores updated"
            ))
    except Exception:
        pass

    return {
        "status": "ingested",
        "run_id": run_id,
        "partition_key": partition_key,
        "triples_extracted": len(triples),
        "triples_stored": stored_result.get("count", 0),
        "conflicts_detected": len(conflicts),
        "concepts_embedded": embedded_count,
        "triples": triple_dicts,
        "conflicts": conflicts
    }


@router.post("/graph/synthesize")
async def synthesize(request: SynthesizeRequest, background_tasks: BackgroundTasks):
    """
    Run the Synthesis Layer: find structural isomorphisms across the graph.
    Runs as a background task to handle large graphs via topological batching.
    """
    task_id = str(uuid.uuid4())
    task_manager.create_task(request.workspace, "synthesis", task_id=task_id)
    
    background_tasks.add_task(
        _background_synthesis,
        workspace=request.workspace,
        provider=request.provider,
        model=request.model,
        task_id=task_id
    )
    
    return {
        "status": "started",
        "task_id": task_id,
        "message": "Synthesis initiated in background (Topological Batching mode)"
    }


async def _background_synthesis(
    workspace: str,
    provider: str,
    model: Optional[str],
    task_id: str
):
    """Background worker for community-based synthesis."""
    try:
        track_workflow_start(task_id, "synthesis", workspace)
        
        # 1. Fetch communities and their sizes
        query = """
            MATCH (n {workspace: $workspace}) 
            WHERE n.community_id IS NOT NULL
            RETURN n.community_id AS cid, count(*) AS count 
            ORDER BY count DESC
        """
        communities = run_cypher(query, {"workspace": workspace})
        
        if not communities:
            # Fallback to global synthesis if no communities found
            communities = [{"cid": None, "count": 0}]

        # Load manifest for timeout
        manifest = load_manifest(workspace)
        llm_timeout = manifest.llm_timeout
        
        total_analogies = 0
        all_analogies = []
        
        processed = 0
        for comm in communities:
            cid = comm["cid"]
            count = comm["count"]
            
            processed += 1
            progress = int((processed / len(communities)) * 95)
            task_manager.update_task(task_id, progress=progress, message=f"Analyzing community {processed}/{len(communities)} (id={cid})")

            # 2. Extract local subgraph summary
            # We exclude SOURCED_FROM and focus on RELATES_TO for conceptual synthesis
            if cid is not None:
                edge_query = """
                    MATCH (a {workspace: $workspace, community_id: $cid})-[r:RELATES_TO]->(b {workspace: $workspace, community_id: $cid})
                    RETURN a.name AS src, r.predicate AS pred, b.name AS tgt
                    LIMIT 1000
                """
                edges = run_cypher(edge_query, {"workspace": workspace, "cid": cid})
            else:
                # Global fallback
                edge_query = """
                    MATCH (a {workspace: $workspace})-[r:RELATES_TO]->(b {workspace: $workspace})
                    RETURN a.name AS src, r.predicate AS pred, b.name AS tgt
                    LIMIT 1000
                """
                edges = run_cypher(edge_query, {"workspace": workspace})

            if not edges:
                continue

            lines = [f"  {e['src']} --[{e['pred']}]--> {e['tgt']}" for e in edges]
            graph_summary = "\n".join(lines)

            # 3. Find synthesis patterns
            task_manager.add_aer_entry(
                task_id,
                intent=f"Finding isomorphisms in community {cid}",
                observation=f"Extracted {len(lines)} relationships",
                plan="LLM pattern match"
            )

            analogies = await find_synthesis(
                graph_summary=graph_summary,
                workspace=workspace,
                provider=provider,
                model=model,
                timeout=llm_timeout,
                run_id=task_id
            )


            # 4. Store discovered analogies
            for a in analogies:
                try:
                    add_analogy(
                        concept_a=a["concept_a"],
                        concept_b=a["concept_b"],
                        description=a.get("description", ""),
                        pattern=a.get("pattern", ""),
                        workspace=workspace
                    )
                    total_analogies += 1
                    all_analogies.append(a)
                except Exception:
                    pass

        task_manager.update_task(task_id, status="completed", progress=100, message=f"Found {total_analogies} analogies across {len(communities)} communities")
        track_workflow_complete(task_id, "synthesis", workspace, ["pattern_match", "graph_update"], 0)

    except Exception as e:
        logger.error("Background synthesis failed: %s", e, exc_info=True)
        task_manager.update_task(task_id, status="failed", message=f"Synthesis failed: {str(e)}")
        track_workflow_complete(task_id, "synthesis", workspace, ["failed"], 0, status="failed")


@router.post("/graph/cross-domain")
async def cross_domain(request: CrossDomainRequest):
    """Map a concept into a different domain (e.g., 'Show me X in Physics')."""
    try:
        # Get the concept's relationships
        neighbors = get_neighbors(request.concept, request.workspace, depth=2)

        rel_lines = []
        node_map = {n["id"]: n["name"] for n in neighbors["nodes"]}
        for edge in neighbors["edges"]:
            src = node_map.get(edge["source"], "?")
            tgt = node_map.get(edge["target"], "?")
            rel_lines.append(f"{src} --[{edge.get('predicate', edge.get('type', ''))}]--> {tgt}")

        relationships = "\n".join(rel_lines) if rel_lines else "No relationships found."

        # Load manifest for timeout
        manifest = load_manifest(request.workspace)
        llm_timeout = manifest.llm_timeout

        result = await cross_domain_analogy(
            concept=request.concept,
            relationships=relationships,
            target_domain=request.target_domain,
            workspace=request.workspace,
            provider=request.provider,
            model=request.model,
            timeout=llm_timeout
        )


        return {
            "concept": request.concept,
            "target_domain": request.target_domain,
            "result": result
        }

    except Exception as e:
        raise HTTPException(500, f"Cross-domain analogy failed: {str(e)}")


# =============================================================================
# EMBEDDING & CLUSTERING
# =============================================================================

@router.post("/graph/embed")
async def embed_concept(request: EmbedConceptRequest):
    """Compute and store an embedding for a concept."""
    try:
        emb = await get_embedding(
            request.concept,
            provider=request.provider,
            model=request.model
        )
        set_concept_embedding(request.concept, emb, request.workspace)
        return {
            "status": "embedded",
            "concept": request.concept,
            "dimensions": len(emb)
        }
    except Exception as e:
        raise HTTPException(500, f"Embedding failed: {str(e)}")


@router.post("/graph/search")
async def semantic_search(request: VectorSearchRequest):
    """Find concepts similar to a query by vector similarity."""
    try:
        query_emb = await get_embedding(
            request.query,
            provider=request.provider,
            model=request.model
        )
        results = vector_search(query_emb, request.workspace, request.top_k)
        return {"query": request.query, "results": results}
    except Exception as e:
        raise HTTPException(500, f"Vector search failed: {str(e)}")


@router.post("/graph/clusters")
async def find_clusters(request: ClusterRequest):
    """Find conceptual clusters (the 'Venn' overlap) using embedding similarity."""
    try:
        concepts = request.concepts
        if not concepts:
            # Use all concepts with embeddings
            from ..core.graph_db import get_driver
            driver = get_driver()
            with driver.session() as session:
                result = session.run("""
                    MATCH (c:Concept {workspace: $workspace})
                    WHERE c.embedding IS NOT NULL
                    RETURN c.name AS name
                """, workspace=request.workspace)
                concepts = [r["name"] for r in result]

        if len(concepts) < 2:
            return {"clusters": [], "message": "Need at least 2 embedded concepts."}

        clusters = await compute_cluster_similarities(
            concepts=concepts,
            workspace=request.workspace,
            threshold=request.threshold
        )

        return {"clusters": clusters, "count": len(clusters)}

    except Exception as e:
        raise HTTPException(500, f"Clustering failed: {str(e)}")
