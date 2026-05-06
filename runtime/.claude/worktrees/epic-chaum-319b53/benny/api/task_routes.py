from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from ..core.task_manager import task_manager
from ..core.schema import Task
from ..core.bpmn_converter import json_to_bpmn
from fastapi.responses import Response

router = APIRouter()

@router.get("/tasks", response_model=List[Task])
async def list_tasks(workspace: Optional[str] = Query(None)):
    """List all background tasks for a workspace."""
    return task_manager.list_tasks(workspace)

@router.get("/tasks/{task_id}", response_model=Task)
async def get_task(task_id: str):
    """Get detailed state and AER log for a specific task."""
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@router.post("/studio/export/bpmn")
async def export_studio_to_bpmn(request: dict):
    """
    Convert Studio ReactFlow JSON to BPMN 2.0 XML.
    Expected body: { "nodes": [], "edges": [], "name": "WorkflowName" }
    """
    nodes = request.get("nodes", [])
    edges = request.get("edges", [])
    name = request.get("name", "BennyWorkflow")
    
    if not nodes:
        raise HTTPException(status_code=400, detail="Cannot export empty graph to BPMN")
    
    try:
        xml_content = json_to_bpmn(nodes, edges, name)
        return Response(
            content=xml_content,
            media_type="application/xml",
            headers={
                "Content-Disposition": f"attachment; filename={name.lower().replace(' ', '_')}.bpmn.xml",
                "Access-Control-Expose-Headers": "Content-Disposition"
            }
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"BPMN conversion failed: {str(e)}")
