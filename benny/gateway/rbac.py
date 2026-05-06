"""
Role-Based Access Control for the MCP Gateway.

Policy storage: workspace/policies/rbac.json
"""

from __future__ import annotations

import json
import logging
from typing import Dict, List, Optional, Any
from pathlib import Path
from enum import Enum
from datetime import datetime

from pydantic import BaseModel, Field

from ..core.workspace import get_workspace_path
from ..governance.audit import emit_governance_event

logger = logging.getLogger(__name__)


class AgentRole(str, Enum):
    """Predefined agent roles with ascending privilege levels."""
    VIEWER = "viewer"          # Read-only access to knowledge tools
    EXECUTOR = "executor"      # Can execute tools within its Remix Server scope
    PLANNER = "planner"        # Can plan and execute, elevated tool access
    REVIEWER = "reviewer"      # Can review outputs and approve/reject
    ADMIN = "admin"            # Full access to all tools and settings


class ToolOperation(str, Enum):
    """Operations that can be performed on a tool."""
    READ = "read"
    WRITE = "write"
    EXECUTE = "execute"
    DELETE = "delete"


class ToolPermission(BaseModel):
    """Permission entry for a specific tool."""
    tool_id: str
    allowed_roles: List[AgentRole]
    allowed_operations: List[ToolOperation]
    max_calls_per_minute: int = 60
    allowed_workspaces: List[str] = Field(default_factory=lambda: ["*"])
    requires_approval: bool = False       # If True, requires HITL before execution
    credential_ref: Optional[str] = None  # Reference to a credential in the vault


class RBACPolicy(BaseModel):
    """Complete RBAC policy for a workspace."""
    version: str = "1.0"
    default_role: AgentRole = AgentRole.EXECUTOR
    permissions: List[ToolPermission] = Field(default_factory=list)
    rate_limits: Dict[str, int] = Field(default_factory=dict)  # role → calls/minute


# In-memory rate tracking (use Redis in production)
_rate_counters: Dict[str, List[float]] = {}


def _get_policy_path(workspace: str) -> Path:
    """Get the RBAC policy file path for a workspace."""
    policy_dir = get_workspace_path(workspace) / "policies"
    policy_dir.mkdir(parents=True, exist_ok=True)
    return policy_dir / "rbac.json"


def load_policy(workspace: str) -> RBACPolicy:
    """
    Load RBAC policy from workspace. Creates default if not exists.
    
    Args:
        workspace: Target workspace
    
    Returns:
        RBACPolicy for the workspace
    """
    policy_path = _get_policy_path(workspace)
    
    if policy_path.exists():
        try:
            data = json.loads(policy_path.read_text(encoding="utf-8"))
            return RBACPolicy(**data)
        except Exception as e:
            logger.warning("Failed to load RBAC policy: %s, using defaults", e)
    
    # Create default policy
    default_policy = _create_default_policy()
    save_policy(workspace, default_policy)
    return default_policy


def save_policy(workspace: str, policy: RBACPolicy) -> None:
    """Save RBAC policy to workspace."""
    policy_path = _get_policy_path(workspace)
    policy_path.write_text(
        json.dumps(policy.model_dump(), indent=2),
        encoding="utf-8"
    )


def _create_default_policy() -> RBACPolicy:
    """Create a sensible default RBAC policy."""
    return RBACPolicy(
        permissions=[
            # Knowledge tools — everyone can read
            ToolPermission(
                tool_id="search_kb",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="list_documents",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="read_document",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            # File write — executor and above
            ToolPermission(
                tool_id="write_file",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.WRITE, ToolOperation.EXECUTE],
            ),
            # Read files — executor and above
            ToolPermission(
                tool_id="read_file",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            # Neural Graph — executor and above (Planner and Admin have elevated access)
            ToolPermission(
                tool_id="query_graph",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="rag_ingest",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="kg3d_ingest",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="extract_pdf",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="code_scan",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="validate_enrichment",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="query_csv",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="list_files",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            # Graph Traversal tools
            ToolPermission(
                tool_id="get_concept_neighbors",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="search_similar_concepts",
                allowed_roles=[AgentRole.VIEWER, AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.READ, ToolOperation.EXECUTE],
            ),
            ToolPermission(
                tool_id="add_knowledge_triple",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.PLANNER, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.WRITE, ToolOperation.EXECUTE],
            ),
        ],
        rate_limits={
            AgentRole.VIEWER: 30,
            AgentRole.EXECUTOR: 60,
            AgentRole.PLANNER: 120,
            AgentRole.ADMIN: 9999,
        }
    )


def check_permission(
    workspace: str,
    agent_role: AgentRole,
    tool_id: str,
    operation: ToolOperation,
    agent_id: str = "default"
) -> bool:
    """
    Check if an agent has permission to perform an operation on a tool.
    
    This function ALWAYS emits a governance audit event, whether allowed or denied.
    
    Args:
        workspace: Current workspace
        agent_role: Role of the requesting agent
        tool_id: ID of the tool being accessed
        operation: Operation being attempted
        agent_id: Identifier of the specific agent (for rate limiting)
    
    Returns:
        True if permitted, False if denied
    """
    policy = load_policy(workspace)
    
    # Admin bypasses all checks
    if agent_role == AgentRole.ADMIN:
        _audit_permission(workspace, agent_id, tool_id, operation, agent_role, True, "admin_bypass")
        return True
    
    # Find matching permission
    matching_perm = None
    for perm in policy.permissions:
        if perm.tool_id == tool_id:
            matching_perm = perm
            break
    
    # No explicit permission → deny by default (PRD: "Deny-by-Default")
    if matching_perm is None:
        _audit_permission(workspace, agent_id, tool_id, operation, agent_role, False, "no_policy")
        return False
    
    # Check role
    if agent_role not in matching_perm.allowed_roles:
        _audit_permission(workspace, agent_id, tool_id, operation, agent_role, False, "role_denied")
        return False
    
    # Check operation
    if operation not in matching_perm.allowed_operations:
        _audit_permission(workspace, agent_id, tool_id, operation, agent_role, False, "operation_denied")
        return False
    
    # Check workspace scope
    if "*" not in matching_perm.allowed_workspaces and workspace not in matching_perm.allowed_workspaces:
        _audit_permission(workspace, agent_id, tool_id, operation, agent_role, False, "workspace_denied")
        return False
    
    # Check rate limit
    if not _check_rate_limit(agent_id, agent_role, policy):
        _audit_permission(workspace, agent_id, tool_id, operation, agent_role, False, "rate_limited")
        return False
    
    _audit_permission(workspace, agent_id, tool_id, operation, agent_role, True, "allowed")
    return True


def _check_rate_limit(agent_id: str, role: AgentRole, policy: RBACPolicy) -> bool:
    """Check if the agent has exceeded its rate limit."""
    import time
    
    max_rpm = policy.rate_limits.get(role, 60)
    key = f"{agent_id}:{role}"
    now = time.time()
    
    if key not in _rate_counters:
        _rate_counters[key] = []
    
    # Remove entries older than 60 seconds
    _rate_counters[key] = [t for t in _rate_counters[key] if now - t < 60]
    
    if len(_rate_counters[key]) >= max_rpm:
        return False
    
    _rate_counters[key].append(now)
    return True


def _audit_permission(
    workspace: str, agent_id: str, tool_id: str,
    operation: ToolOperation, role: AgentRole,
    allowed: bool, reason: str
):
    """Emit governance audit event for every permission check."""
    try:
        emit_governance_event(
            event_type="RBAC_CHECK",
            data={
                "agent_id": agent_id,
                "tool_id": tool_id,
                "operation": operation.value,
                "role": role.value,
                "allowed": allowed,
                "reason": reason,
                "timestamp": datetime.utcnow().isoformat(),
            },
            workspace_id=workspace
        )
    except Exception:
        pass  # Never fail on audit
