"""
Remix Server — Virtualized, curated MCP tool endpoint.

A Remix Server is a scoped view of the skill registry that:
1. Exposes only specific tools (not the full catalog)
2. Enforces per-tool RBAC permissions
3. Bounds the agent's decision space to minimize misuse
"""

from __future__ import annotations

import logging
import json
from typing import List, Dict, Any, Optional
from pathlib import Path
from datetime import datetime

from pydantic import BaseModel, Field

from ..core.skill_registry import registry, Skill
from ..core.workspace import get_workspace_path
from .rbac import AgentRole, ToolOperation, check_permission

logger = logging.getLogger(__name__)


class RemixServerConfig(BaseModel):
    """Configuration for a Remix Server instance."""
    id: str
    name: str
    description: str = ""
    skill_ids: List[str]              # Skills exposed in this Remix Server
    agent_role: AgentRole = AgentRole.EXECUTOR
    workspace: str = "default"
    max_calls_per_session: int = 100
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class RemixExecutionResult(BaseModel):
    """Result from executing a tool via Remix Server."""
    success: bool
    tool_id: str
    output: Optional[str] = None
    error: Optional[str] = None
    permission_granted: bool = True


class RemixServer:
    """
    A runtime instance of a Remix Server.
    
    Usage:
        config = RemixServerConfig(id="rag_only", name="RAG Only", skill_ids=["search_kb", "list_documents"])
        server = RemixServer(config)
        result = server.execute("search_kb", "default", agent_id="executor_1", query="test")
    """
    
    def __init__(self, config: RemixServerConfig):
        self.config = config
        self._call_count = 0
        self._available_skills: Optional[List[Skill]] = None
    
    @property
    def available_skills(self) -> List[Skill]:
        """Get the skills this Remix Server exposes."""
        if self._available_skills is None:
            self._available_skills = registry.get_skills_by_ids(
                self.config.skill_ids,
                self.config.workspace
            )
        return self._available_skills
    
    def list_tools(self) -> List[Dict[str, Any]]:
        """List available tools in this Remix Server (for agent discovery)."""
        return [s.to_dict() for s in self.available_skills]
    
    def get_tool_schemas(self) -> List[Dict]:
        """Get OpenAI function-calling schemas for available tools."""
        return [s.to_openai_tool_schema() for s in self.available_skills]
    
    def execute(
        self,
        tool_id: str,
        workspace: str,
        agent_id: str = "default",
        **kwargs
    ) -> RemixExecutionResult:
        """
        Execute a tool through the Remix Server with RBAC enforcement.
        
        Args:
            tool_id: ID of the tool to execute
            workspace: Current workspace
            agent_id: Identifier of the calling agent
            **kwargs: Tool-specific arguments
        
        Returns:
            RemixExecutionResult with outcome
        """
        # Check 1: Tool is in this Remix Server's scope
        if tool_id not in self.config.skill_ids:
            return RemixExecutionResult(
                success=False,
                tool_id=tool_id,
                error=f"Tool '{tool_id}' is not available in this Remix Server '{self.config.name}'",
                permission_granted=False,
            )
        
        # Check 2: Session call limit
        if self._call_count >= self.config.max_calls_per_session:
            return RemixExecutionResult(
                success=False,
                tool_id=tool_id,
                error=f"Session call limit ({self.config.max_calls_per_session}) exceeded",
                permission_granted=False,
            )
        
        # Check 3: RBAC permission
        permitted = check_permission(
            workspace=workspace,
            agent_role=self.config.agent_role,
            tool_id=tool_id,
            operation=ToolOperation.EXECUTE,
            agent_id=agent_id,
        )
        
        if not permitted:
            return RemixExecutionResult(
                success=False,
                tool_id=tool_id,
                error=f"Permission denied: role '{self.config.agent_role.value}' cannot execute '{tool_id}'",
                permission_granted=False,
            )
        
        # Execute the tool
        self._call_count += 1
        try:
            output = registry.execute_skill(tool_id, workspace, **kwargs)
            return RemixExecutionResult(
                success=True,
                tool_id=tool_id,
                output=output,
            )
        except Exception as e:
            return RemixExecutionResult(
                success=False,
                tool_id=tool_id,
                error=str(e),
            )


def _remix_configs_dir(workspace: str) -> Path:
    """Get the Remix Server configs directory."""
    path = get_workspace_path(workspace) / "remix_servers"
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_remix_config(config: RemixServerConfig) -> Dict:
    """Persist a Remix Server configuration."""
    path = _remix_configs_dir(config.workspace) / f"{config.id}.json"
    path.write_text(json.dumps(config.model_dump(), indent=2), encoding="utf-8")
    return {"status": "saved", "id": config.id}


def load_remix_config(workspace: str, remix_id: str) -> Optional[RemixServerConfig]:
    """Load a saved Remix Server configuration."""
    path = _remix_configs_dir(workspace) / f"{remix_id}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return RemixServerConfig(**data)


def list_remix_configs(workspace: str) -> List[RemixServerConfig]:
    """List all saved Remix Server configurations."""
    configs = []
    for file in _remix_configs_dir(workspace).glob("*.json"):
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
            configs.append(RemixServerConfig(**data))
        except Exception as e:
            logger.warning("Failed to load remix config %s: %s", file, e)
    return configs


def create_remix_server(workspace: str, remix_id: str) -> Optional[RemixServer]:
    """Create a RemixServer instance from a saved config."""
    config = load_remix_config(workspace, remix_id)
    if config is None:
        return None
    return RemixServer(config)
