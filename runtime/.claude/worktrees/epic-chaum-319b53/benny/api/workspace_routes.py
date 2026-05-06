"""
Workspace Routes - API endpoints for decentralized manifest management.
"""

from fastapi import APIRouter, HTTPException, Body
from ..core.workspace import load_manifest, save_manifest, ensure_workspace_structure, list_workspaces
from ..core.schema import WorkspaceManifest

router = APIRouter()

@router.get("/", response_model=list[str])
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
        # Initialize graph schema for the new workspace context
        init_schema()
        result["db_initialized"] = True
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
async def update_workspace_manifest(workspace_id: str, manifest: WorkspaceManifest):
    """
    Update the workspace manifest (YAML).
    This endpoint enforces schema validation and governance policies.
    """
    try:
        ensure_workspace_structure(workspace_id)
        
        # Governance: Audit version increment or policy checks can go here
        if manifest.llm_timeout > 3600:
            raise HTTPException(status_code=400, detail="Timeout exceeds maximum governance limit (3600s)")
            
        save_manifest(workspace_id, manifest)
        return manifest
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
