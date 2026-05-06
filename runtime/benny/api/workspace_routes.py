"""
Workspace Routes - API endpoints for decentralized manifest management.
"""

from fastapi import APIRouter, HTTPException, Body
from ..core.workspace import load_manifest, save_manifest, ensure_workspace_structure, list_workspaces
from ..core.schema import WorkspaceManifest

router = APIRouter()

@router.get("", response_model=list[str])
async def get_workspaces():
    """List all available workspace IDs."""
    try:
        workspaces = list_workspaces()
        return [ws["id"] for ws in workspaces]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

from benny.core.graph_db import init_schema

@router.post("/{workspace_id}")
async def create_workspace(workspace_id: str):
    """Create a new workspace structure and initialize DB context."""
    try:
        result = ensure_workspace_structure(workspace_id)
        try:
            init_schema()
            result["db_initialized"] = True
        except Exception:
            result["db_initialized"] = False
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{workspace_id}/manifest", response_model=WorkspaceManifest)
async def get_workspace_manifest(workspace_id: str):
    """Retrieve the validated manifest for a workspace."""
    try:
        manifest = load_manifest(workspace_id)
        return manifest
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/{workspace_id}/manifest", response_model=WorkspaceManifest)
async def update_workspace_manifest(workspace_id: str, updates: dict = Body(...)):
    """
    Update specific fields in the workspace manifest (YAML).
    Performs a merge with existing configuration.
    """
    try:
        ensure_workspace_structure(workspace_id)
        
        # Validation specific to critical fields if present
        if "llm_timeout" in updates and updates["llm_timeout"] > 3600:
            raise HTTPException(status_code=400, detail="Timeout exceeds maximum governance limit (3600s)")
            
        from ..core.workspace import update_manifest
        manifest = update_manifest(workspace_id, updates)
        return manifest
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{workspace_id}")
async def delete_workspace_endpoint(workspace_id: str):
    """Deep delete a workspace and all its metadata."""
    try:
        from ..core.workspace import delete_workspace
        result = delete_workspace(workspace_id)
        return result
    except PermissionError as pe:
        raise HTTPException(status_code=403, detail=str(pe))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

