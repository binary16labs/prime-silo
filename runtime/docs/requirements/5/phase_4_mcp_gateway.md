# Phase 4 — MCP Gateway & Remix Servers

> **Owner**: Implementation Agent  
> **PRD Reference**: `C:\Users\nsdha\OneDrive\code\benny\docs\requirements\5\PRD_dog_pound.txt`  
> **Parent Plan**: `C:\Users\nsdha\.gemini\antigravity\brain\fd945150-1e44-4e58-baa2-97d8004a2eb2\implementation_plan.md`  
> **Priority**: Enterprise — governed tool access  
> **Estimated Scope**: 1 new package (4 files), 1 new frontend component, 2 modified backend files

---

## 1. Objective

Implement the **MCP Gateway** pattern with **Remix Servers** as specified in the PRD section "The Gateway and Remix Server Architecture". Replace the current flat skill registry access model with a governed, permission-bounded tool delivery system where agents receive only the exact capabilities needed for a specific workflow, with granular RBAC and a credential vault.

---

## 2. Current State (READ THESE FILES FIRST)

| File | Purpose | Why You Need It |
|------|---------|-----------------|
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\skill_registry.py` | `SkillRegistry` class, `BUILTIN_SKILLS`, `SKILL_HANDLERS`, `execute_skill()` | You will ADD RBAC checks to `execute_skill()` and add `create_remix_view()` |
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\skill_routes.py` | Skill API endpoints | You will ADD remix server management endpoints |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\workspace.py` | `get_workspace_path()` | Policies and credentials stored under workspace |
| `C:\Users\nsdha\OneDrive\code\benny\benny\governance\audit.py` | `emit_governance_event()` | Audit every permission check and credential access |

---

## 3. Files to Create or Modify

### 3.1 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\__init__.py`

```python
"""
MCP Gateway — Tool governance layer implementing Remix Servers and RBAC.

Architecture:
- Remix Servers: Virtualized, curated tool endpoints scoped per workflow
- RBAC: Role-based access control down to individual tool level
- Credential Vault: Encrypted credential storage with ephemeral tokens
"""
```

### 3.2 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\rbac.py`

```python
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
```

### 3.3 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\remix_server.py`

```python
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
```

### 3.4 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\credential_vault.py`

```python
"""
Credential Vault — Encrypted credential storage.

Uses Fernet symmetric encryption. Master key is derived from environment variable.
Credentials stored at: workspace/credentials/vault.json (encrypted)
"""

from __future__ import annotations

import os
import json
import logging
import hashlib
import base64
from typing import Optional, Dict
from pathlib import Path
from datetime import datetime

from ..core.workspace import get_workspace_path
from ..governance.audit import emit_governance_event

logger = logging.getLogger(__name__)

# Vault master key from environment (MUST be set for production)
VAULT_KEY_ENV = "BENNY_VAULT_KEY"
DEFAULT_KEY = "benny-dev-vault-key-2026-unsafe"


def _get_fernet():
    """Get Fernet encryption instance."""
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        logger.warning("cryptography package not installed. Vault will use base64 encoding (NOT SECURE).")
        return None
    
    raw_key = os.getenv(VAULT_KEY_ENV, DEFAULT_KEY)
    # Derive a 32-byte key using SHA-256, then base64-encode for Fernet
    key_bytes = hashlib.sha256(raw_key.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(key_bytes)
    return Fernet(fernet_key)


def _vault_path(workspace: str) -> Path:
    """Get vault file path."""
    cred_dir = get_workspace_path(workspace) / "credentials"
    cred_dir.mkdir(parents=True, exist_ok=True)
    return cred_dir / "vault.json"


def _load_vault(workspace: str) -> Dict[str, str]:
    """Load the encrypted vault."""
    path = _vault_path(workspace)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_vault(workspace: str, vault: Dict[str, str]) -> None:
    """Save the encrypted vault."""
    path = _vault_path(workspace)
    path.write_text(json.dumps(vault, indent=2), encoding="utf-8")


def store_credential(workspace: str, name: str, value: str) -> Dict:
    """
    Store an encrypted credential.
    
    Args:
        workspace: Target workspace
        name: Credential name (e.g., "openai_api_key")
        value: Plain-text credential value
    
    Returns:
        Status dict
    """
    fernet = _get_fernet()
    vault = _load_vault(workspace)
    
    if fernet:
        encrypted = fernet.encrypt(value.encode()).decode()
    else:
        # Fallback: base64 (NOT secure, only for dev)
        encrypted = base64.b64encode(value.encode()).decode()
    
    vault[name] = encrypted
    _save_vault(workspace, vault)
    
    _audit_credential_access(workspace, name, "store")
    
    return {"status": "stored", "name": name}


def get_credential(workspace: str, name: str) -> Optional[str]:
    """
    Retrieve and decrypt a credential.
    
    Args:
        workspace: Target workspace
        name: Credential name
    
    Returns:
        Decrypted credential value, or None if not found
    """
    fernet = _get_fernet()
    vault = _load_vault(workspace)
    
    encrypted = vault.get(name)
    if encrypted is None:
        _audit_credential_access(workspace, name, "get_not_found")
        return None
    
    _audit_credential_access(workspace, name, "get")
    
    try:
        if fernet:
            return fernet.decrypt(encrypted.encode()).decode()
        else:
            return base64.b64decode(encrypted.encode()).decode()
    except Exception as e:
        logger.error("Failed to decrypt credential '%s': %s", name, e)
        return None


def list_credentials(workspace: str) -> list:
    """List credential names (NOT values)."""
    vault = _load_vault(workspace)
    return list(vault.keys())


def delete_credential(workspace: str, name: str) -> Dict:
    """Delete a credential."""
    vault = _load_vault(workspace)
    if name in vault:
        del vault[name]
        _save_vault(workspace, vault)
        _audit_credential_access(workspace, name, "delete")
        return {"status": "deleted", "name": name}
    return {"status": "not_found", "name": name}


def _audit_credential_access(workspace: str, name: str, operation: str):
    """Audit log every credential access."""
    try:
        emit_governance_event(
            event_type="CREDENTIAL_ACCESS",
            data={
                "credential_name": name,
                "operation": operation,
                "timestamp": datetime.utcnow().isoformat(),
            },
            workspace_id=workspace
        )
    except Exception:
        pass
```

### 3.5 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\skill_routes.py`

Add Remix Server management endpoints. Read the existing file first and append these routes:

```python
from ..gateway.remix_server import (
    RemixServerConfig, save_remix_config, list_remix_configs,
    load_remix_config, create_remix_server,
)
from ..gateway.rbac import AgentRole, load_policy, save_policy, RBACPolicy

@router.post("/remix-servers")
async def create_remix_server_config(config: RemixServerConfig):
    """Create a new Remix Server configuration."""
    return save_remix_config(config)

@router.get("/remix-servers")
async def get_remix_servers(workspace: str = "default"):
    """List all Remix Server configurations for a workspace."""
    configs = list_remix_configs(workspace)
    return {"remix_servers": [c.model_dump() for c in configs]}

@router.get("/remix-servers/{remix_id}")
async def get_remix_server(remix_id: str, workspace: str = "default"):
    """Get a specific Remix Server and its available tools."""
    server = create_remix_server(workspace, remix_id)
    if not server:
        raise HTTPException(404, f"Remix Server not found: {remix_id}")
    return {
        "config": server.config.model_dump(),
        "available_tools": server.list_tools(),
    }

@router.get("/rbac/policy")
async def get_rbac_policy(workspace: str = "default"):
    """Get the current RBAC policy for a workspace."""
    return load_policy(workspace).model_dump()

@router.put("/rbac/policy")
async def update_rbac_policy(policy: RBACPolicy, workspace: str = "default"):
    """Update the RBAC policy for a workspace."""
    save_policy(workspace, policy)
    return {"status": "updated"}
```

### 3.6 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\core\skill_registry.py`

Add RBAC-aware execution. Modify the `execute_skill` method of `SkillRegistry`:

```python
def execute_skill(self, skill_id: str, workspace: str, agent_role: str = "executor", agent_id: str = "default", **kwargs) -> str:
    """Execute a skill by ID with RBAC enforcement."""
    from ..gateway.rbac import check_permission, AgentRole, ToolOperation
    
    # RBAC check (non-blocking — logs violation but allows if no policy exists)
    try:
        role = AgentRole(agent_role)
        permitted = check_permission(
            workspace=workspace,
            agent_role=role,
            tool_id=skill_id,
            operation=ToolOperation.EXECUTE,
            agent_id=agent_id,
        )
        if not permitted:
            return f"❌ Permission denied: role '{agent_role}' cannot execute '{skill_id}'"
    except Exception as e:
        # If RBAC system fails, allow execution but log warning
        import logging
        logging.getLogger(__name__).warning("RBAC check failed, allowing execution: %s", e)
    
    handler = SKILL_HANDLERS.get(skill_id)
    if not handler:
        return f"❌ Unknown skill: {skill_id}"
    try:
        return handler(workspace=workspace, **kwargs)
    except Exception as e:
        return f"❌ Skill execution error ({skill_id}): {str(e)}"
```

---

## 4. BDD Acceptance Criteria

```gherkin
Feature: RBAC Permission Checks

  Scenario: Admin can execute any tool
    Given an agent with role "admin"
    When it requests permission to execute "write_file"
    Then the permission check should return True

  Scenario: Viewer cannot write files
    Given an agent with role "viewer"
    When it requests permission to execute "write_file"
    Then the permission check should return False
    And a governance audit event should be emitted with reason "role_denied"

  Scenario: Unknown tool is denied by default
    Given an agent with role "executor"
    When it requests permission to execute "unknown_tool"
    Then the permission check should return False
    And the reason should be "no_policy"

  Scenario: Rate limiting prevents excessive calls
    Given an agent with role "viewer" and rate limit 30/minute
    When the agent makes 31 calls within 60 seconds
    Then the 31st call should be denied with reason "rate_limited"

Feature: Remix Server Scoped Execution

  Scenario: Tool in scope executes successfully
    Given a Remix Server with skills ["search_kb", "list_documents"]
    When the agent executes "search_kb" through the Remix Server
    Then the execution should succeed

  Scenario: Tool outside scope is denied
    Given a Remix Server with skills ["search_kb"]
    When the agent attempts to execute "write_file" through the Remix Server
    Then the execution should fail with "not available in this Remix Server"

  Scenario: Session call limit enforced
    Given a Remix Server with max_calls_per_session = 2
    When the agent makes 3 calls
    Then the 3rd call should fail with "Session call limit exceeded"

Feature: Credential Vault

  Scenario: Store and retrieve a credential
    Given no credentials exist for workspace "default"
    When I store credential "test_key" with value "secret123"
    Then get_credential("test_key") should return "secret123"

  Scenario: Delete a credential
    Given credential "test_key" exists
    When I delete credential "test_key"
    Then get_credential("test_key") should return None

  Scenario: Credential access is audited
    When I store, get, or delete any credential
    Then a CREDENTIAL_ACCESS governance event should be emitted
```

---

## 5. TDD Test File

### Create: `C:\Users\nsdha\OneDrive\code\benny\tests\test_gateway.py`

```python
"""
Test suite for Phase 4 — MCP Gateway, RBAC, Remix Servers, Credential Vault.
Run with: python -m pytest tests/test_gateway.py -v
"""

import pytest
import time
from unittest.mock import patch, MagicMock
from pathlib import Path

from benny.gateway.rbac import (
    AgentRole, ToolOperation, ToolPermission, RBACPolicy,
    check_permission, load_policy, save_policy, _rate_counters,
)
from benny.gateway.remix_server import (
    RemixServerConfig, RemixServer, save_remix_config,
    load_remix_config, list_remix_configs,
)
from benny.gateway.credential_vault import (
    store_credential, get_credential, list_credentials, delete_credential,
)


class TestRBAC:

    def setup_method(self):
        _rate_counters.clear()

    def test_admin_bypasses_all(self, tmp_path):
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.ADMIN, "any_tool", ToolOperation.EXECUTE)
                assert result is True

    def test_viewer_cannot_write(self, tmp_path):
        policy = RBACPolicy(permissions=[
            ToolPermission(
                tool_id="write_file",
                allowed_roles=[AgentRole.EXECUTOR, AgentRole.ADMIN],
                allowed_operations=[ToolOperation.WRITE, ToolOperation.EXECUTE],
            )
        ])
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            save_policy("test", policy)
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.VIEWER, "write_file", ToolOperation.EXECUTE)
                assert result is False

    def test_executor_can_execute_allowed_tool(self, tmp_path):
        policy = RBACPolicy(permissions=[
            ToolPermission(
                tool_id="search_kb",
                allowed_roles=[AgentRole.EXECUTOR],
                allowed_operations=[ToolOperation.EXECUTE],
            )
        ])
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            save_policy("test", policy)
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.EXECUTOR, "search_kb", ToolOperation.EXECUTE)
                assert result is True

    def test_unknown_tool_denied(self, tmp_path):
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            with patch("benny.gateway.rbac.emit_governance_event"):
                result = check_permission("test", AgentRole.EXECUTOR, "totally_unknown", ToolOperation.EXECUTE)
                assert result is False

    def test_rate_limiting(self, tmp_path):
        policy = RBACPolicy(
            permissions=[
                ToolPermission(tool_id="test_tool", allowed_roles=[AgentRole.EXECUTOR], allowed_operations=[ToolOperation.EXECUTE])
            ],
            rate_limits={AgentRole.EXECUTOR: 3}
        )
        with patch("benny.gateway.rbac._get_policy_path", return_value=tmp_path / "rbac.json"):
            save_policy("test", policy)
            with patch("benny.gateway.rbac.emit_governance_event"):
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is True
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is True
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is True
                assert check_permission("test", AgentRole.EXECUTOR, "test_tool", ToolOperation.EXECUTE, "agent1") is False


class TestRemixServer:

    def test_execute_in_scope(self):
        config = RemixServerConfig(id="test", name="Test", skill_ids=["search_kb"], workspace="default")
        server = RemixServer(config)
        
        with patch("benny.gateway.remix_server.check_permission", return_value=True):
            with patch("benny.gateway.remix_server.registry") as mock_reg:
                mock_reg.execute_skill.return_value = "Search results..."
                mock_reg.get_skills_by_ids.return_value = []
                result = server.execute("search_kb", "default")
                assert result.success is True
                assert result.output == "Search results..."

    def test_execute_out_of_scope(self):
        config = RemixServerConfig(id="test", name="Test", skill_ids=["search_kb"], workspace="default")
        server = RemixServer(config)
        result = server.execute("write_file", "default")
        assert result.success is False
        assert "not available" in result.error

    def test_session_limit(self):
        config = RemixServerConfig(id="test", name="Test", skill_ids=["search_kb"], max_calls_per_session=2, workspace="default")
        server = RemixServer(config)
        
        with patch("benny.gateway.remix_server.check_permission", return_value=True):
            with patch("benny.gateway.remix_server.registry") as mock_reg:
                mock_reg.execute_skill.return_value = "ok"
                mock_reg.get_skills_by_ids.return_value = []
                server.execute("search_kb", "default")
                server.execute("search_kb", "default")
                result = server.execute("search_kb", "default")
                assert result.success is False
                assert "limit" in result.error.lower()

    def test_save_and_load_config(self, tmp_path):
        config = RemixServerConfig(id="rag_only", name="RAG Only", skill_ids=["search_kb"], workspace="default")
        with patch("benny.gateway.remix_server._remix_configs_dir", return_value=tmp_path):
            save_remix_config(config)
            loaded = load_remix_config("default", "rag_only")
            assert loaded is not None
            assert loaded.name == "RAG Only"

    def test_list_configs(self, tmp_path):
        c1 = RemixServerConfig(id="a", name="A", skill_ids=[], workspace="default")
        c2 = RemixServerConfig(id="b", name="B", skill_ids=[], workspace="default")
        with patch("benny.gateway.remix_server._remix_configs_dir", return_value=tmp_path):
            save_remix_config(c1)
            save_remix_config(c2)
            configs = list_remix_configs("default")
            assert len(configs) == 2


class TestCredentialVault:

    def test_store_and_retrieve(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                store_credential("test", "api_key", "sk-12345")
                value = get_credential("test", "api_key")
                assert value == "sk-12345"

    def test_get_nonexistent(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                value = get_credential("test", "nonexistent")
                assert value is None

    def test_delete_credential(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                store_credential("test", "key", "value")
                delete_credential("test", "key")
                assert get_credential("test", "key") is None

    def test_list_credentials(self, tmp_path):
        with patch("benny.gateway.credential_vault._vault_path", return_value=tmp_path / "vault.json"):
            with patch("benny.gateway.credential_vault.emit_governance_event"):
                store_credential("test", "key1", "v1")
                store_credential("test", "key2", "v2")
                names = list_credentials("test")
                assert set(names) == {"key1", "key2"}
```

---

## 6. Execution Order

1. Read ALL files in Section 2
2. Create `C:\Users\nsdha\OneDrive\code\benny\tests\test_gateway.py`
3. Create `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\__init__.py`
4. Create `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\rbac.py`
5. Create `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\remix_server.py`
6. Create `C:\Users\nsdha\OneDrive\code\benny\benny\gateway\credential_vault.py`
7. Run tests: `python -m pytest tests/test_gateway.py -v`
8. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\core\skill_registry.py` — add RBAC to execute_skill
9. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\skill_routes.py` — add Remix Server endpoints
10. Run full backend test suite
11. Verify API endpoints with curl

---

## 7. Definition of Done

- [ ] All 14 tests in `test_gateway.py` pass
- [ ] RBAC denies by default (no explicit policy = denied)
- [ ] Admin role bypasses all checks
- [ ] Rate limiting works per agent per time window
- [ ] Remix Server restricts tool access to configured scope
- [ ] Session call limits are enforced
- [ ] Credentials are encrypted at rest
- [ ] Every permission check and credential access emits a governance audit event
- [ ] `GET /api/remix-servers` and `POST /api/remix-servers` work
- [ ] `GET /api/rbac/policy` and `PUT /api/rbac/policy` work
- [ ] Existing skill execution still works (backward compat with default role)
