"""
Studio Executor - Execute visual node graphs from the Studio canvas
Interprets nodes + edges and runs them in topological order
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import asyncio
import json
import httpx
from typing import AsyncGenerator, Dict, Any, List, Optional
import uuid
import logging
from datetime import datetime

from ..core.models import LOCAL_PROVIDERS, call_model, get_model_config, get_active_model
from ..governance.lineage import (
    track_workflow_start, 
    track_workflow_complete, 
    track_llm_call, 
    track_tool_execution,
    track_policy_breach
)
from ..governance.execution_audit import (
    emit_execution_failure,
    emit_node_execution_state,
    emit_execution_checkpoint,
    ExecutionPhase
)
from ..core.task_manager import task_manager
from ..core.workspace import get_workspace_path
from ..tools.knowledge import get_chromadb_client
from ..core.event_bus import event_bus
from ..core.reasoning import extract_reasoning, format_combined_output

router = APIRouter()

# Shared with workflow_routes.py via event_bus
# HITL responses waiting to be picked up (run_id → asyncio.Queue)
_hitl_responses: Dict[str, asyncio.Queue] = {}




def _emit_execution_event(run_id: str, event_type: str, data: Dict[str, Any]):
    """Push an event into the buffer for SSE consumers via centralized EventBus."""
    event_bus.emit(run_id, event_type, data)


@router.get("/{run_id}/events")
async def stream_execution_events(run_id: str):
    """SSE endpoint for real-time execution events via centralized EventBus."""
    logging.info(f"[AUDIT] SSE stream requested for run_id: {run_id}")
    
    return StreamingResponse(
        event_bus.subscribe(run_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.post("/{run_id}/hitl-response")
async def submit_hitl_response(run_id: str, response: Dict[str, Any]):
    """Submit a HITL response to resume a paused workflow."""
    if run_id not in _hitl_responses:
        raise HTTPException(404, f"Active run not found: {run_id}")
    
    # Push the response to the queue for the background worker
    await _hitl_responses[run_id].put(response)
    
    _emit_execution_event(run_id, "hitl_response_received", {
        "decision": response.get("decision"),
    })
    
    return {"status": "received", "run_id": run_id}


class StudioNode(BaseModel):
    id: str
    type: str  # trigger, llm, tool, data, logic
    position: Dict[str, float] = {}
    data: Dict[str, Any] = {}


class StudioEdge(BaseModel):
    id: str
    source: str
    target: str


class StudioExecuteRequest(BaseModel):
    nodes: List[StudioNode]
    edges: List[StudioEdge]
    workspace: str = "default"
    message: Optional[str] = None
    active_nexus_id: Optional[str] = None # The selected Neural Nexus/Snapshot


class NodeResult(BaseModel):
    node_id: str
    node_type: str
    status: str  # success, error
    output: Any = None
    error: Optional[str] = None


class StudioExecuteResponse(BaseModel):
    status: str
    node_results: List[NodeResult]
    artifact_path: Optional[str] = None
    final_output: Optional[str] = None


def topological_sort(nodes: List[StudioNode], edges: List[StudioEdge]) -> List[StudioNode]:
    """
    Sort nodes based on their dependencies.
    Raises ValueError on circular dependency or invalid references.
    """
    if not nodes:
        return []
        
    # Build adjacency list
    adj = {n.id: [] for n in nodes}
    in_degree = {n.id: 0 for n in nodes}
    for e in edges:
        if e.source in adj and e.target in adj:
            adj[e.source].append(e.target)
            in_degree[e.target] += 1
        elif e.source not in adj or e.target not in adj:
            # This should be caught by validate_workflow_graph, but we'll be safe
            continue
            
    # Queue for nodes with in-degree 0
    from collections import deque
    queue = deque([n.id for n in nodes if in_degree[n.id] == 0])
    sorted_ids = []
    
    while queue:
        u = queue.popleft()
        sorted_ids.append(u)
        for v in adj[u]:
            in_degree[v] -= 1
            if in_degree[v] == 0:
                queue.append(v)
                
    if len(sorted_ids) != len(nodes):
        unsorted = set([n.id for n in nodes]) - set(sorted_ids)
        raise ValueError(f"Circular dependency or invalid references detected in graph involving nodes: {unsorted}")
        
    # Return nodes in sorted order
    node_map = {n.id: n for n in nodes}
    return [node_map[nid] for nid in sorted_ids]


def validate_workflow_graph(nodes: List[StudioNode], edges: List[StudioEdge]) -> Optional[str]:
    """
    Perform pre-flight sanity checks on the graph nodes and edges.
    Returns error message if invalid, else None.
    """
    node_ids = {n.id for n in nodes}
    
    if not nodes:
        return "Workflow has no nodes."
        
    for edge in edges:
        if edge.source not in node_ids:
            return f"Edge references missing source node: {edge.source}"
        if edge.target not in node_ids:
            return f"Edge references missing target node: {edge.target}"
            
    # Check for duplicate node IDs
    if len(node_ids) != len(nodes):
        return "Duplicate node IDs detected in workflow."
            
    return None


async def execute_trigger_node(node: StudioNode, message: str, context: Dict) -> Dict:
    """Execute a trigger node — captures the user message"""
    trigger_type = (node.data.get("config") or {}).get("triggerType", "chat")
    return {
        "message": message or "No message provided",
        "trigger_type": trigger_type
    }


async def execute_data_node(node: StudioNode, context: Dict, workspace: str) -> Dict:
    """Execute a data node — RAG search or file write"""
    config = node.data.get("config") or {}
    operation = config.get("operation", "search")

    if operation == "search":
        # RAG search on workspace ChromaDB
        query = context.get("message", "")
        try:
            client = get_chromadb_client(workspace)
            collection = client.get_or_create_collection("knowledge")

            if collection.count() == 0:
                return {"results": [], "message": "Knowledge base empty — please ingest documents first"}

            results = collection.query(
                query_texts=[query],
                n_results=min(5, collection.count())
            )

            formatted = []
            context_text = ""
            for doc, meta in zip(results["documents"][0], results["metadatas"][0]):
                source = meta.get("source", "Unknown")
                formatted.append({"text": doc, "source": source})
                context_text += f"[Source: {source}]\n{doc}\n\n"

            return {
                "results": formatted,
                "context_text": context_text,
                "count": len(formatted)
            }
        except Exception as e:
            return {"error": str(e), "results": []}

    elif operation == "write":
        # Write the LLM output to a .md file
        content = context.get("llm_output", "No content generated")
        filename = config.get("path", "output.md")
        if not filename.endswith(".md"):
            filename += ".md"

        try:
            out_path = get_workspace_path(workspace, "data_out") / filename
            out_path.parent.mkdir(parents=True, exist_ok=True)

            # Build a proper markdown document
            md_content = f"# {filename.replace('.md', '').replace('_', ' ').title()}\n\n"
            md_content += f"*Generated by Benny Studio — {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n\n"
            md_content += "---\n\n"
            md_content += content

            out_path.write_text(md_content, encoding="utf-8")

            return {
                "written": True,
                "path": str(out_path),
                "filename": filename,
                "download_url": f"http://localhost:8005/api/files/{workspace}/data_out/{filename}"
            }
        except Exception as e:
            return {"error": str(e), "written": False}

    elif operation == "read":
        # Use 'path' from config, fallback to 'label' if not specified
        filename = config.get("path") or node.data.get("label", "")
        
        if not filename:
            return {
                "error": "Data node read operation requires 'path' in config or 'label' for filename",
                "hint": "Configure the path field or ensure label contains the filename"
            }
        
        try:
            path = get_workspace_path(workspace, "data_in") / filename
            if not path.exists():
                path = get_workspace_path(workspace, "data_out") / filename
            
            if path.exists():
                content = path.read_text(encoding="utf-8")
                return {"content": content, "filename": filename}
            return {"error": f"File not found: {filename}", "looked_in": ["data_in", "data_out"]}
        except Exception as e:
            return {"error": f"Failed to read file '{filename}': {str(e)}"}

    elif operation == "adaptive_search":
        from ..core.adaptive_rag import run_adaptive_rag
        
        query = context.get("message", "")
        max_retries = int(config.get("maxRetries", 3))
        
        try:
            result = await run_adaptive_rag(
                query=query,
                workspace=workspace,
                model=config.get("model", "Qwen3-8B-Hybrid"),
                max_retries=max_retries,
            )
            
            answer = result.get("generation", "")
            context_text = ""
            for doc in result.get("graded_documents", []):
                context_text += f"[Source: {doc.get('source', 'Unknown')}]\n{doc.get('content', '')}\n\n"
            
            return {
                "results": result.get("graded_documents", []),
                "context_text": context_text,
                "answer": answer,
                "route": result.get("route", "single_step"),
                "retry_count": result.get("retry_count", 0),
                "count": len(result.get("graded_documents", [])),
            }
        except Exception as e:
            return {"error": str(e), "results": []}

    return {"error": f"Unknown data operation: {operation}"}


async def execute_llm_node(node: StudioNode, context: Dict, workspace: str, run_id: str, agent_id: str = "default") -> Dict:
    """Execute an LLM node — the core reasoning brain."""
    from ..core.skill_registry import registry
    from ..core.models import get_active_model
    
    config = node.data.get("config") or {}
    system_prompt = config.get("systemPrompt", "You are a helpful assistant.")
    model_id = config.get("model")
    attached_skills = config.get("skills", [])
    
    # Check if this node REQUIRES a nexus context but none is active
    active_nexus_id = context.get("active_nexus_id")
    needs_nexus = any(s in attached_skills for s in ["query_graph", "search_kb", "get_neighbors"])
    
    if needs_nexus and (not active_nexus_id or active_nexus_id == "neural_nexus"):
        # EMIT HITL Event for Nexus Selection
        _emit_execution_event(run_id, "hitl_required", {
            "nodeId": node.id,
            "nodeName": node.data.get("label", "LLM Node"),
            "type": "nexus_selection",
            "action_description": "Neural Nexus selection required for graph interaction.",
            "reasoning": "The agent is configured to use graph tools but no specific context (Nexus) is active.",
            "options_url": f"/api/graph/catalog?workspace={workspace}",
            "message": "Please select a Neural Nexus (Snapshot or Code Scan) to ground the agent's reasoning."
        })
        
        # Wait for HITL Response
        if run_id not in _hitl_responses:
            _hitl_responses[run_id] = asyncio.Queue()
            
        try:
            response = await asyncio.wait_for(_hitl_responses[run_id].get(), timeout=3600.0)
            active_nexus_id = response.get("selected_nexus_id") or response.get("value")
            if not active_nexus_id:
                 return {"error": "Nexus selection cancelled or missing", "status": "failed"}
            
            # Update context for future nodes
            context["active_nexus_id"] = active_nexus_id
            logging.info(f"HITL: Nexus '{active_nexus_id}' selected for run {run_id}")
            
        except asyncio.TimeoutError:
            return {"error": "Nexus selection timed out", "status": "timeout"}
    
    # Prepare Tools
    tools = registry.get_tool_schemas(attached_skills, workspace)

    # Model resolution
    if not model_id or model_id == "Qwen3-8B-Hybrid":
        try:
            model_id = await get_active_model(workspace)
        except:
            model_id = "Qwen3-8B-Hybrid"
            
    model_cfg = get_model_config(model_id)
    model_name = model_cfg["model"]
    
    # Build messages
    messages = [{"role": "system", "content": system_prompt}]
    user_message = context.get("message", "")
    rag_context = context.get("context_text", "")
    
    # Truncate context to prevent 'Max length reached' errors
    if len(rag_context) > 6000:
        rag_context = rag_context[:6000] + "\n...[Context truncated due to length limits]..."
    
    if rag_context:
        messages.append({"role": "user", "content": f"CONTEXT:\n{rag_context}\n\nQUESTION:\n{user_message}"})
    else:
        messages.append({"role": "user", "content": user_message})

    api_base = model_cfg.get("base_url")
    chat_url = f"{api_base}/chat/completions"
    
    max_steps = 5
    current_step = 0
    total_tokens = 0
    executed_tools = []

    async with httpx.AsyncClient(timeout=300.0) as client:
        while current_step < max_steps:
            current_step += 1
            payload = {
                "model": model_name, 
                "messages": messages, 
                "temperature": config.get("temperature", 0.7),
                "max_tokens": 1024
            }
            if tools: payload["tools"] = tools

            try:
                response = await client.post(chat_url, json=payload, headers={"Content-Type": "application/json"})
            except Exception as e:
                return {"error": f"LLM connection error: {str(e)}", "response": None}

            if response.status_code != 200:
                # Robustness fallback: If tool-calling isn't supported by the model/endpoint, try without tools
                if "tools" in payload and (response.status_code == 400 or "tool" in response.text.lower()):
                    logging.warning(f"Model {model_name} failed tool-calling payload. Retrying without tools.")
                    payload.pop("tools")
                    response = await client.post(chat_url, json=payload, headers={"Content-Type": "application/json"})
                    if response.status_code != 200:
                        return {"error": f"LLM error (after tool fallback): {response.status_code}", "response": None}
                else:
                    return {"error": f"LLM error: {response.status_code} {response.text}", "response": None}

            data = response.json()
            
            if "error" in data:
                err_obj = data["error"]
                if isinstance(err_obj, dict):
                    err_msg = err_obj.get("message", "Unknown error")
                    details = err_obj.get("details", {})
                    if details and isinstance(details, dict) and "response" in details:
                        resp_err = details["response"].get("error", {})
                        if isinstance(resp_err, dict) and "message" in resp_err:
                            err_msg += f" - {resp_err['message']}"
                else:
                    err_msg = str(err_obj)
                return {"error": f"LLM provider error: {err_msg}", "response": None}

            if "choices" not in data or not data["choices"]:
                return {"error": f"LLM unexpected response format: {json.dumps(data)}", "response": None}
                
            message = data["choices"][0]["message"]
            messages.append(message)

            if "tool_calls" in message and message["tool_calls"]:
                for tc in message["tool_calls"]:
                    func_name = tc["function"]["name"]
                    try:
                        tool_args = json.loads(tc["function"]["arguments"])
                    except:
                        tool_args = {}

                    # Execute the skill with Nexus scoping
                    result_str = await registry.execute_skill(
                        skill_id=func_name, 
                        workspace=workspace,
                        agent_role="executor", 
                        agent_id=agent_id,
                        active_nexus_id=active_nexus_id,
                        **tool_args
                    )
                    
                    executed_tools.append({"name": func_name, "args": tool_args})
                    messages.append({"role": "tool", "tool_call_id": tc["id"], "name": func_name, "content": result_str})
                continue

            answer_raw = message.get("content") or ""
            answer_body, reasoning = extract_reasoning(answer_raw)
            return {"response": format_combined_output(answer_body, reasoning), "reasoning_trace": reasoning}

        return {"error": "Max steps reached", "response": messages[-1].get("content") or ""}



async def _run_workflow_background(run_id: str, request: StudioExecuteRequest, sorted_nodes: List[StudioNode]):
    """Background loop to process each node in topological order."""
    from .rag_routes import create_ephemeral_manifest, register_manifest
    
    # Register permissions for background workflow tools
    # We allow a broad set of common tools for Studio canvas execution
    manifest = create_ephemeral_manifest(run_id, ["query_graph", "search_kb", "read_file", "write_file", "list_files", "get_neighbors", "search_knowledge_workspace"])
    register_manifest(manifest)
    
    context = {"message": request.message, "workspace": request.workspace, "active_nexus_id": request.active_nexus_id}
    
    logging.info(f"[AUDIT] Background task started | run_id: {run_id} | workspace: {request.workspace} | nodes: {len(sorted_nodes)}")

    node_results: List[NodeResult] = []
    artifact_path = None
    final_output = None
    overall_status = "completed"
    
    try:
        emit_execution_checkpoint(run_id, request.workspace, "initialization", {"nodes_count": len(sorted_nodes)})
        
        for node in sorted_nodes:
            _emit_execution_event(run_id, "node_started", {"nodeId": node.id, "nodeName": node.data.get("label", node.type)})
            
            try:
                if node.type == "trigger":
                    output = await execute_trigger_node(node, request.message or "", context)
                    context["message"] = output.get("message", context["message"])
                elif node.type == "data":
                    output = await execute_data_node(node, context, request.workspace)
                    if "context_text" in output: context["context_text"] = output["context_text"]
                elif node.type == "llm":
                    output = await execute_llm_node(node, context, request.workspace, run_id=run_id)
                    if output.get("response"):
                        context["llm_output"] = output["response"]
                        final_output = output["response"]
                elif node.type == "a2a":
                    output = await execute_a2a_node(node, context, request.workspace)
                elif node.type == "intervention":
                    output = await execute_intervention_node(node, context, request.workspace, run_id)
                else:
                    output = {"message": "Node passed"}

                has_error = "error" in output
                status = "error" if has_error else "success"
                
                emit_node_execution_state(run_id, request.workspace, node.id, status, outputs=output)
                _emit_execution_event(run_id, "node_completed" if not has_error else "node_error", {"nodeId": node.id})
                
                node_results.append(NodeResult(node_id=node.id, node_type=node.type, status=status, output=output))
                if has_error:
                    overall_status = "failed"
                    break

            except Exception as e:
                emit_execution_failure(run_id, request.workspace, ExecutionPhase.EXECUTION, e, node_id=node.id)
                overall_status = "failed"
                break

        _emit_execution_event(run_id, "workflow_completed" if overall_status == "completed" else "workflow_failed", {})

    finally:
        if run_id in _hitl_responses: del _hitl_responses[run_id]
        task_manager.update_task(run_id, status=overall_status, progress=100)
        track_workflow_complete(run_id, "studio_workflow", request.workspace, [r.node_type for r in node_results], 0, status=overall_status)


@router.post("/execute")
async def execute_studio_workflow(request: StudioExecuteRequest):
    """Start Studio node graph execution in background."""
    logging.info(f"[AUDIT] /api/workflows/execute called | workspace={request.workspace} | nodes={len(request.nodes)}")
    
    if not request.nodes:
        raise HTTPException(400, "No nodes in workflow")

    run_id = f"run-{uuid.uuid4().hex[:8]}"
    _hitl_responses[run_id] = asyncio.Queue()
    
    # 1. Pre-flight Validation
    validation_error = validate_workflow_graph(request.nodes, request.edges)
    if validation_error:
        logging.error(f"[AUDIT] Pre-flight validation failed | run_id: {run_id} | error: {validation_error}")
        # Emit failure so it shows in governance despite not starting
        emit_execution_failure(run_id, request.workspace, ExecutionPhase.INITIALIZATION, ValueError(validation_error))
        raise HTTPException(400, f"Workflow validation failed: {validation_error}")

    # 2. Initialization & Topological Sort
    try:
        sorted_nodes = topological_sort(request.nodes, request.edges)
    except Exception as e:
        logging.error(f"[AUDIT] Initialization failed (sort) | run_id: {run_id} | error: {str(e)}")
        # Start & immediately fail the task for audit persistence
        task_manager.create_task(request.workspace, "studio_workflow", task_id=run_id)
        task_manager.update_task(run_id, status="failed", message=f"Initialization error: {str(e)}")
        emit_execution_failure(run_id, request.workspace, ExecutionPhase.INITIALIZATION, e)
        raise HTTPException(400, f"Workflow initialization failed: {str(e)}")

    # 3. Task Creation & Backgrounding
    task_manager.create_task(request.workspace, "studio_workflow", task_id=run_id)
    track_workflow_start(run_id, "studio_workflow", request.workspace, inputs=[], outputs=[])

    asyncio.create_task(_run_workflow_background(run_id, request, sorted_nodes))
    return {"run_id": run_id, "status": "started"}



async def execute_intervention_node(node: StudioNode, context: Dict, workspace: str, run_id: str) -> Dict:
    """
    Execute an Intervention node. 
    Checks if context matches a 'breach' condition. 
    If so, pauses execution and waits for HITL response.
    """
    config = node.data.get("config") or {}
    rule = config.get("rule", "")  # e.g. a regex or keyword
    description = config.get("description", "Policy violation detected")
    
    # Simple check: if 'rule' is found in context['llm_output'] or context['message']
    input_text = str(context.get("llm_output", context.get("message", "")))
    
    is_breached = False
    if rule and rule.lower() in input_text.lower():
        is_breached = True
    
    if is_breached:
        # 1. Log Exception in Lineage
        track_policy_breach(
            run_id=run_id,
            node_id=node.id,
            rule=rule,
            description=description,
            content_snippet=input_text[:200],
            workspace=workspace
        )
        
        # 2. Emit HITL Required Event
        _emit_execution_event(run_id, "hitl_required", {
            "nodeId": node.id,
            "nodeName": node.data.get("label", "Intervention"),
            "action_description": description,
            "reasoning": f"Data contains restricted pattern: '{rule}'",
            "current_state_summary": f"Breach detected in node output. Waiting for manual override.",
            "options": [
                {"label": "Approve (Override)", "value": "approve", "description": "Proceed despite breach"},
                {"label": "Reject", "value": "reject", "description": "Stop workflow"},
                {"label": "Edit & Resume", "value": "edit", "description": "Modify content then proceed"}
            ]
        })
        
        # 3. Wait for HITL Response
        if run_id not in _hitl_responses:
            _hitl_responses[run_id] = asyncio.Queue()
            
        try:
            # Wait with a long timeout (1 hour)
            response = await asyncio.wait_for(_hitl_responses[run_id].get(), timeout=3600.0)
            
            decision = response.get("decision", "reject")
            if decision == "reject":
                return {"error": "Workflow rejected by human in the loop", "status": "rejected"}
            
            if decision == "edit":
                edits = response.get("edits", {})
                new_content = edits.get("modified_content", input_text)
                # Update context with edited content
                if "llm_output" in context:
                    context["llm_output"] = new_content
                else:
                    context["message"] = new_content
                return {"message": "Breach edited and approved", "status": "edited"}
                
            return {"message": "Breach overridden and approved", "status": "approved"}
            
        except asyncio.TimeoutError:
            return {"error": "HITL response timed out after 1 hour", "status": "timeout"}
            
    return {"message": "No breach detected", "status": "bypass"}


async def execute_a2a_node(node: StudioNode, context: Dict, workspace: str) -> Dict:
    """Execute an A2A delegation node — sends task to a remote agent."""
    from ..a2a.client import A2AClient, A2AClientError
    
    config = node.data.get("config") or {}
    agent_url = config.get("agentUrl", "")
    timeout = float(config.get("timeout", 300))
    
    if not agent_url:
        return {"error": "No agent URL configured", "response": None}
    
    message = context.get("message", "") or context.get("llm_output", "")
    
    try:
        client = A2AClient(api_key="benny-mesh-2026-auth", timeout=timeout)
        
        # Send task
        task = await client.send_task(agent_url, message, workspace)
        
        # Poll for completion
        final_task = await client.poll_until_complete(
            agent_url, task.id,
            max_wait=timeout
        )
        
        # Extract response
        response_text = ""
        for msg in final_task.messages:
            if msg.role == "agent":
                for part in msg.parts:
                    if part.type.value == "text":
                        response_text += part.content
        
        return {
            "response": response_text,
            "task_id": final_task.id,
            "status": final_task.status.value,
            "artifacts": [a.model_dump() for a in final_task.artifacts],
        }
    except A2AClientError as e:
        return {"error": str(e), "response": None}
    except Exception as e:
        return {"error": f"A2A execution failed: {str(e)}", "response": None}
