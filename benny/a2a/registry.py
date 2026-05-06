"""
A2A Agent Registry — Local storage for discovered external agents.

Agents are stored as JSON files under workspace/agents/<agent_id>.json
"""

from __future__ import annotations

import json
import logging
import hashlib
from typing import List, Optional, Dict
from pathlib import Path

from .models import AgentCard
from ..core.workspace import get_workspace_path

logger = logging.getLogger(__name__)


class AgentRegistry:
    """
    Manages registered A2A agents for a workspace.
    """
    
    def _agents_dir(self, workspace: str) -> Path:
        """Get agents directory for a workspace, creating if needed."""
        agents_dir = get_workspace_path(workspace) / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)
        return agents_dir
    
    def _agent_id(self, url: str) -> str:
        """Generate a deterministic agent ID from URL."""
        return hashlib.md5(url.encode()).hexdigest()[:12]
    
    def register_agent(self, workspace: str, agent_card: AgentCard) -> Dict:
        """
        Register or update an agent in the workspace registry.
        
        Args:
            workspace: Target workspace
            agent_card: Agent's capability manifest
        
        Returns:
            Registration status dict
        """
        agent_id = self._agent_id(agent_card.url)
        file_path = self._agents_dir(workspace) / f"{agent_id}.json"
        
        data = agent_card.model_dump()
        data["_registry_id"] = agent_id
        
        file_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        
        return {"status": "registered", "agent_id": agent_id, "name": agent_card.name}
    
    def list_agents(self, workspace: str) -> List[AgentCard]:
        """List all registered agents in a workspace."""
        agents = []
        agents_dir = self._agents_dir(workspace)
        
        if not agents_dir.exists():
            return []
            
        for file in agents_dir.glob("*.json"):
            try:
                data = json.loads(file.read_text(encoding="utf-8"))
                data.pop("_registry_id", None)
                agents.append(AgentCard(**data))
            except Exception as e:
                logger.warning("Could not load agent %s: %s", file, e)
        
        return agents
    
    def get_agent(self, workspace: str, agent_id: str) -> Optional[AgentCard]:
        """Get a specific registered agent."""
        file_path = self._agents_dir(workspace) / f"{agent_id}.json"
        if not file_path.exists():
            return None
        
        data = json.loads(file_path.read_text(encoding="utf-8"))
        data.pop("_registry_id", None)
        return AgentCard(**data)
    
    def find_agent_for_skill(self, workspace: str, skill_name: str) -> Optional[AgentCard]:
        """Find an agent that advertises a specific skill."""
        for agent in self.list_agents(workspace):
            for skill in agent.skills:
                if skill.id == skill_name or skill_name.lower() in skill.name.lower():
                    return agent
        return None
    
    def remove_agent(self, workspace: str, agent_id: str) -> Dict:
        """Remove an agent from the registry."""
        file_path = self._agents_dir(workspace) / f"{agent_id}.json"
        if not file_path.exists():
            return {"status": "not_found", "agent_id": agent_id}
        file_path.unlink()
        return {"status": "removed", "agent_id": agent_id}


# Global registry instance
agent_registry = AgentRegistry()
