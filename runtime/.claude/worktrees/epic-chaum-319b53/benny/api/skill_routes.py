"""
Skill Routes - REST API for managing workspace skills and catalog
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, List, Any, Optional

from ..core.skill_registry import registry, SkillParameter


router = APIRouter()


class SkillParameterCreate(BaseModel):
    name: str
    type: str
    description: str
    required: bool = True
    default: Optional[Any] = None


class SkillCreate(BaseModel):
    id: str
    name: str
    description: str
    category: str = "custom"
    parameters: List[SkillParameterCreate] = []


@router.get("/skills")
async def list_skills(workspace: str = "default"):
    """Get all available skills (built-in + workspace)"""
    try:
        skills = registry.get_all_skills(workspace)
        return {
            "workspace": workspace,
            "skills": [s.to_dict() for s in skills],
            "count": len(skills)
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to list skills: {str(e)}")


@router.get("/skills/catalog")
async def get_skill_catalog(workspace: str = "default"):
    """Get skills grouped by category for progressive discovery"""
    try:
        catalog = registry.get_catalog(workspace)
        return {
            "workspace": workspace,
            "catalog": catalog
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to get catalog: {str(e)}")


@router.post("/skills")
async def create_skill(request: SkillCreate, workspace: str = "default"):
    """Save a custom skill to the workspace"""
    try:
        # Check if overriding a built-in skill
        builtins = {s.id for s in registry.get_builtin_skills()}
        if request.id in builtins:
            # We allow overriding, but maybe add a warning or specific flag later
            pass
            
        skill_data = request.model_dump()
        result = registry.save_workspace_skill(workspace, skill_data)
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to save skill: {str(e)}")


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: str, workspace: str = "default"):
    """Delete a custom workspace skill"""
    try:
        # Built-in skills cannot be deleted
        builtins = {s.id for s in registry.get_builtin_skills()}
        if skill_id in builtins:
            raise HTTPException(400, f"Cannot delete built-in skill: {skill_id}")
            
        result = registry.delete_workspace_skill(workspace, skill_id)
        return result
    except FileNotFoundError:
        raise HTTPException(404, f"Skill not found in workspace: {skill_id}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to delete skill: {str(e)}")


# =============================================================================
# GATEWAY & REMIX SERVER ROUTES
# =============================================================================

from ..gateway.remix_server import (
    RemixServerConfig, save_remix_config, list_remix_configs,
    load_remix_config, create_remix_server,
)
from ..gateway.rbac import AgentRole, load_policy, save_policy, RBACPolicy


@router.post("/remix-servers")
async def create_remix_server_config(config: RemixServerConfig):
    """Create a new Remix Server configuration."""
    try:
        return save_remix_config(config)
    except Exception as e:
        raise HTTPException(500, f"Failed to save remix config: {str(e)}")


@router.get("/remix-servers")
async def get_remix_servers(workspace: str = "default"):
    """List all Remix Server configurations for a workspace."""
    try:
        configs = list_remix_configs(workspace)
        return {"remix_servers": [c.model_dump() for c in configs]}
    except Exception as e:
        raise HTTPException(500, f"Failed to list remix servers: {str(e)}")


@router.get("/remix-servers/{remix_id}")
async def get_remix_server(remix_id: str, workspace: str = "default"):
    """Get a specific Remix Server and its available tools."""
    try:
        server = create_remix_server(workspace, remix_id)
        if not server:
            raise HTTPException(404, f"Remix Server not found: {remix_id}")
        return {
            "config": server.config.model_dump(),
            "available_tools": server.list_tools(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to get remix server: {str(e)}")


@router.get("/rbac/policy")
async def get_rbac_policy(workspace: str = "default"):
    """Get the current RBAC policy for a workspace."""
    try:
        return load_policy(workspace).model_dump()
    except Exception as e:
        raise HTTPException(500, f"Failed to load RBAC policy: {str(e)}")


@router.put("/rbac/policy")
async def update_rbac_policy(policy: RBACPolicy, workspace: str = "default"):
    """Update the RBAC policy for a workspace."""
    try:
        save_policy(workspace, policy)
        return {"status": "updated"}
    except Exception as e:
        raise HTTPException(500, f"Failed to update RBAC policy: {str(e)}")
