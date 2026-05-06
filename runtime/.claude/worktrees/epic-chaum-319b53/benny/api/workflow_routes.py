"""
Workflow Routes - Execute and manage graph workflows
"""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any, List, AsyncGenerator
from pathlib import Path
import uuid
import asyncio
import logging
import json
from datetime import datetime

logger = logging.getLogger(__name__)

from langchain_core.messages import HumanMessage

from ..core.workspace import get_workspace_path, list_workspaces, ensure_workspace_structure
from ..graph.workflow import build_workflow_graph, WorkflowState
from ..graph.swarm import build_swarm_graph, run_swarm_workflow, get_governance_url
from ..core.state import create_swarm_state
from ..persistence.checkpointer import SQLiteCheckpointer, TimeTravelDebugger
from ..persistence.workflow_storage import WorkflowStorage
from ..governance.lineage import track_workflow_start, track_workflow_complete
from ..core.event_bus import event_bus
from ..governance.tracing import init_tracing, trace_span


router = APIRouter()


# =============================================================================
# INITIALIZATION
# =============================================================================

# Initialize tracing (optional - won't fail if Phoenix unavailable)
init_tracing()

# Create checkpointer for workflow state persistence
checkpointer = SQLiteCheckpointer()

# File-based workflow storage
workflow_storage = WorkflowStorage()

# In-memory execution tracking (use Redis in production)
executions: Dict[str, Dict] = {}

# Shared via event_bus


# =============================================================================
# WORKFLOW EXECUTION
# =============================================================================

class WorkflowRequest(BaseModel):
    workflow: str
    workspace: str = "default"
    message: Optional[str] = None
    model: Optional[str] = None
    params: Optional[Dict[str, Any]] = None


class WorkflowResponse(BaseModel):
    execution_id: str
    status: str
    workflow: str
    workspace: str
    artifact_path: Optional[str] = None
    governance_url: Optional[str] = None


# =============================================================================
# SSE EVENT UTILITIES
# =============================================================================

def _emit_swarm_event(execution_id: str, event_type: str, data: Dict[str, Any]):
    """Emit an event for swarm SSE streaming via centralized EventBus."""
    event_bus.emit(execution_id, event_type, data)


# =============================================================================
# WORKFLOW EXECUTION
# =============================================================================

async def _execute_workflow_async(
    execution_id: str,
    request: WorkflowRequest
) -> None:
    """Background task to execute workflow"""
    try:
        executions[execution_id]["status"] = "running"
        executions[execution_id]["started_at"] = datetime.now().isoformat()
        
        # Track workflow start in lineage
        try:
            track_workflow_start(execution_id, request.workflow, request.workspace)
        except Exception:
            pass  # Lineage tracking is optional
        
        # Build graph with checkpointer
        graph = build_workflow_graph(checkpointer)
        
        # Prepare initial state
        messages = []
        if request.message:
            messages.append(HumanMessage(content=request.message))
        
        initial_state: WorkflowState = {
            "messages": messages,
            "context": {
                "model": request.model,
                **(request.params or {})
            },
            "workspace": request.workspace,
            "current_node": "",
            "tool_outputs": {},
            "requires_approval": False,
            "approved": None,
            "error": None,
            "metadata": {}
        }
        
        # Execute the graph
        thread_config = {"configurable": {"thread_id": execution_id}}
        
        start_time = datetime.now()
        result = await graph.ainvoke(initial_state, thread_config)
        end_time = datetime.now()
        
        execution_time_ms = int((end_time - start_time).total_seconds() * 1000)
        
        # Check if waiting for human approval
        if result.get("requires_approval"):
            executions[execution_id]["status"] = "waiting_approval"
            executions[execution_id]["state"] = result
        else:
            executions[execution_id]["status"] = "completed"
            executions[execution_id]["result"] = result.get("context", {}).get("final_response")
            executions[execution_id]["completed_at"] = end_time.isoformat()
            
            try:
                nodes_executed = ["process_input", "call_llm", "format_output"]
                track_workflow_complete(execution_id, request.workflow, request.workspace, nodes_executed, execution_time_ms)
            except Exception:
                pass
        
    except Exception as e:
        executions[execution_id]["status"] = "failed"
        executions[execution_id]["error"] = str(e)
        executions[execution_id]["failed_at"] = datetime.now().isoformat()
        try:
            from ..governance.lineage import track_workflow_fail
            track_workflow_fail(execution_id, request.workflow, request.workspace, str(e))
        except Exception:
            pass


async def _execute_swarm_async(
    execution_id: str,
    request: WorkflowRequest
) -> None:
    """Background task to execute swarm workflow"""
    import os
    logging.info(f"[AUDIT] Swarm background task started | execution_id: {execution_id} | workflow: {request.workflow}")
    try:
        executions[execution_id]["status"] = "running"
        executions[execution_id]["started_at"] = datetime.now().isoformat()
        logging.info(f"[AUDIT] Marked execution as running: {execution_id}")
        
        # Get configuration from env or params
        max_concurrency = int(os.getenv("SWARM_MAX_CONCURRENCY", "1"))
        handover_limit = 500
        
        if request.params:
            if "max_concurrency" in request.params:
                max_concurrency = request.params["max_concurrency"]
            if "handover_summary_limit" in request.params:
                handover_limit = request.params["handover_summary_limit"]
        
        # Fetch the strategy YAML to get trigger files and outputs
        workflow_def = workflow_storage.get_workflow(request.workflow)
        input_files = []
        output_files = []
        strategy_config = {}
        
        if workflow_def:
            # Re-read the raw YAML data if possible (workflow_storage returns visualized dict)
            # Better: let's assume we can get the raw data from the strategy path
            import yaml
            strategy_path = workflow_def.get("file_path")
            if strategy_path and os.path.exists(strategy_path):
                with open(strategy_path, 'r', encoding='utf-8') as f:
                    raw_data = yaml.safe_load(f)
                    if raw_data:
                        input_files = raw_data.get("trigger", {}).get("files", [])
                        strategy_config = raw_data.get("strategy", {})
                        output_files = strategy_config.get("outputs", [])
        
        # Execute the swarm workflow
        logging.info(f"[AUDIT] Calling run_swarm_workflow | execution_id: {execution_id} | max_concurrency: {max_concurrency}")
        result = await run_swarm_workflow(
            request=request.message or "",
            workspace=request.workspace,
            model=request.model,
            execution_id=execution_id,
            max_concurrency=max_concurrency,
            input_files=input_files,
            output_files=output_files,
            config=strategy_config
        )
        logging.info(f"[AUDIT] Swarm workflow completed | execution_id: {execution_id} | status: {result.get('status')}")
        
        # Update execution state with enhanced swarm fields
        executions[execution_id]["status"] = result.get("status", "completed")
        executions[execution_id]["result"] = result.get("final_document")
        executions[execution_id]["artifact_path"] = result.get("artifact_path")
        executions[execution_id]["governance_url"] = result.get("governance_url")
        executions[execution_id]["plan"] = result.get("plan")
        executions[execution_id]["waves"] = result.get("waves")
        executions[execution_id]["current_wave"] = result.get("current_wave")
        executions[execution_id]["ascii_dag"] = result.get("ascii_dag")
        executions[execution_id]["review_pass_results"] = result.get("review_pass_results")
        executions[execution_id]["completed_at"] = datetime.now().isoformat()
        
        if result.get("errors"):
            executions[execution_id]["errors"] = result["errors"]
        
    except Exception as e:
        logging.error(f"[AUDIT] Swarm execution background task failed | execution_id: {execution_id} | error: {str(e)}", exc_info=True)
        logger.error(f"Swarm execution background task failed: {e}")
        executions[execution_id]["status"] = "failed"
        executions[execution_id]["error"] = str(e)
        executions[execution_id]["failed_at"] = datetime.now().isoformat()


@router.post("/workflow/execute", response_model=WorkflowResponse)
async def execute_workflow(request: WorkflowRequest, background_tasks: BackgroundTasks):
    """Execute a workflow"""
    execution_id = str(uuid.uuid4())
    logging.info(f"[AUDIT] POST /workflow/execute | workflow: {request.workflow} | workspace: {request.workspace} | message: {request.message[:50] if request.message else 'none'}")
    
    # Ensure workspace exists
    ensure_workspace_structure(request.workspace)
    
    # Store execution state
    executions[execution_id] = {
        "id": execution_id,
        "status": "pending",
        "workflow": request.workflow,
        "workspace": request.workspace,
        "params": request.params or {},
        "model": request.model,
        "result": None,
        "error": None,
        "created_at": datetime.now().isoformat()
    }
    logging.info(f"[AUDIT] Created execution_id: {execution_id}")
    
    # Determine if it's a swarm/strategy workflow
    is_swarm = request.workflow == "swarm"
    if not is_swarm:
        wf_def = workflow_storage.get_workflow(request.workflow)
        if wf_def and wf_def.get("type") == "strategy":
            is_swarm = True
            logging.info(f"[AUDIT] Workflow '{request.workflow}' is strategy type - routing to swarm")
            # Events are handled via centralized EventBus
            logging.info(f"[AUDIT] Initialized EventBus tracking for swarm: {execution_id}")
            
    # Route to appropriate workflow handler
    if is_swarm:
        background_tasks.add_task(_execute_swarm_async, execution_id, request)
        logging.info(f"[AUDIT] Started background task for swarm: {execution_id}")
    else:
        background_tasks.add_task(_execute_workflow_async, execution_id, request)
        logging.info(f"[AUDIT] Started background task for regular workflow: {execution_id}")
    
    response = WorkflowResponse(
        execution_id=execution_id,
        status="pending",
        workflow=request.workflow,
        workspace=request.workspace,
        governance_url=get_governance_url(execution_id, request.workflow) if request.workflow == "swarm" else None
    )
    logging.info(f"[AUDIT] Returning response: execution_id={execution_id}, is_swarm={is_swarm}")
    return response


from ..core.task_manager import task_manager

@router.get("/workflow/{execution_id}/status")
async def get_workflow_status(execution_id: str):
    """Get status of a workflow execution"""
    if execution_id not in executions:
        raise HTTPException(404, f"Execution not found: {execution_id}")
    
    execution = executions[execution_id]
    
    # Merge TaskManager AER logs if available
    task = task_manager.get_task(execution_id)
    if task:
        execution["aer_log"] = task.aer_log
        
    return execution


class InterruptResponse(BaseModel):
    approved: bool
    data: Optional[Dict[str, Any]] = None


@router.post("/workflow/{execution_id}/interrupt")
async def respond_to_interrupt(execution_id: str, response: InterruptResponse):
    """Respond to a human-in-the-loop interrupt"""
    if execution_id not in executions:
        raise HTTPException(404, f"Execution not found: {execution_id}")
    
    execution = executions[execution_id]
    if execution["status"] != "waiting_approval":
        raise HTTPException(400, "Execution is not waiting for approval")
    
    # Get the current state
    state = execution.get("state", {})
    state["approved"] = response.approved
    state["requires_approval"] = False
    
    # Resume the workflow
    graph = build_workflow_graph(checkpointer)
    thread_config = {"configurable": {"thread_id": execution_id}}
    
    try:
        result = await graph.ainvoke(state, thread_config)
        execution["status"] = "completed"
        execution["result"] = result.get("context", {}).get("final_response")
        execution["completed_at"] = datetime.now().isoformat()
    except Exception as e:
        execution["status"] = "failed"
        execution["error"] = str(e)
    
    return {"status": execution["status"], "approved": response.approved}


# =============================================================================
# TIME TRAVEL DEBUGGING
# =============================================================================

@router.get("/workflow/{execution_id}/history")
async def get_workflow_history(execution_id: str):
    """Get checkpoint history for time travel debugging"""
    debugger = TimeTravelDebugger(checkpointer)
    return debugger.get_history(execution_id)


@router.get("/workflow/{execution_id}/state/{checkpoint_id}")
async def get_workflow_state_at(execution_id: str, checkpoint_id: str):
    """Get workflow state at a specific checkpoint"""
    debugger = TimeTravelDebugger(checkpointer)
    state = debugger.get_state_at(execution_id, checkpoint_id)
    if not state:
        raise HTTPException(404, f"Checkpoint not found: {checkpoint_id}")
    return state


# =============================================================================
# WORKSPACE MANAGEMENT
# =============================================================================

@router.get("/workspaces")
async def get_workspaces():
    """List all workspaces"""
    return list_workspaces()


@router.post("/workspaces/{workspace_id}")
async def create_workspace(workspace_id: str):
    """Create a new workspace"""
    result = ensure_workspace_structure(workspace_id)
    return result


# =============================================================================
# FILE ACCESS
# =============================================================================

@router.get("/files/{workspace}/{path:path}")
async def get_file(workspace: str, path: str):
    """Download a file from workspace"""
    file_path = get_workspace_path(workspace) / path
    
    if not file_path.exists():
        raise HTTPException(404, f"File not found: {path}")
    
    if not file_path.is_file():
        raise HTTPException(400, f"Not a file: {path}")
    
    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type="application/octet-stream"
    )


# =============================================================================
# WORKFLOW DEFINITIONS (for Studio UI)
# =============================================================================

class NodeDefinition(BaseModel):
    id: str
    type: str
    position: Dict[str, float]
    data: Dict[str, Any]


class EdgeDefinition(BaseModel):
    id: str
    source: str
    target: str
    sourceHandle: Optional[str] = None
    targetHandle: Optional[str] = None


class WorkflowDefinition(BaseModel):
    id: str
    name: str
    nodes: List[NodeDefinition]
    edges: List[EdgeDefinition]


# (workflow_storage instance moved to top-level initialization)


@router.get("/workflows")
async def list_workflows():
    """List all saved workflow definitions"""
    return workflow_storage.list_workflows()


@router.get("/workflows/{workflow_id}")
async def get_workflow(workflow_id: str):
    """Get a specific workflow definition"""
    workflow = workflow_storage.get_workflow(workflow_id)
    if not workflow:
        raise HTTPException(404, f"Workflow not found: {workflow_id}")
    return workflow


@router.post("/workflows")
async def save_workflow(workflow: WorkflowDefinition):
    """Save a workflow definition"""
    workflow_dict = workflow.dict()
    return workflow_storage.save_workflow(workflow_dict)


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(workflow_id: str):
    """Delete a workflow definition"""
    try:
        return workflow_storage.delete_workflow(workflow_id)
    except FileNotFoundError:
        raise HTTPException(404, f"Workflow not found: {workflow_id}")
