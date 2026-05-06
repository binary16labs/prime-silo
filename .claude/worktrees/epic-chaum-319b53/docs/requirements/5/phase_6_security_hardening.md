# Phase 6 — Security Hardening & Operating Manuals

> **Owner**: Implementation Agent  
> **PRD Reference**: `C:\Users\nsdha\OneDrive\code\benny\docs\requirements\5\PRD_dog_pound.txt`  
> **Parent Plan**: `C:\Users\nsdha\.gemini\antigravity\brain\fd945150-1e44-4e58-baa2-97d8004a2eb2\implementation_plan.md`  
> **Priority**: Production Hardening — required for enterprise deployment  
> **Estimated Scope**: 3 new backend files, 1 modified backend file, 1 modified frontend file, workspace templates

---

## 1. Objective

Implement the PRD's security architecture:
1. **Operating Manuals** (SOUL.md / USER.md / AGENTS.md) — structured identity and behavioural rules for agents
2. **Permission Manifests** — explicit declaration of tool capabilities, enforced at runtime
3. **Immutable Audit Trail** — SHA-256 integrity verification for all governance events
4. **Workspace Security Templates** — default security scaffolding on workspace creation
5. **AI Contribution Disclosure** — explicit tracking of what was AI-generated

---

## 2. Current State (READ THESE FILES FIRST)

| File | Purpose | Why You Need It |
|------|---------|-----------------|
| `C:\Users\nsdha\OneDrive\code\benny\benny\governance\audit.py` | `emit_governance_event()`, audit log writing | You will ADD SHA-256 verification and security events |
| `C:\Users\nsdha\OneDrive\code\benny\benny\governance\lineage.py` | OpenLineage integration, custom facets | Reference for governance patterns |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\workspace.py` | `get_workspace_path()`, `ensure_workspace_structure()` | You will modify template generation |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\models.py` | `call_model()` — all LLM calls go through here | Operating Manuals augment system prompts before call_model |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Admin\GlobalAdminDashboard.tsx` | Admin panel | You will add security sections |
| `C:\Users\nsdha\OneDrive\code\benny\benny\governance\__init__.py` | Governance package init | Reference for module structure |

---

## 3. Files to Create or Modify

### 3.1 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\governance\operating_manual.py`

```python
"""
Operating Manual System — SOUL.md / USER.md / AGENTS.md

Operating Manuals define agent identity, behavioral constraints, and
operational rules. They are loaded from workspace root and injected
into LLM system prompts at execution time.

Structure:
  workspace/
    SOUL.md   — Agent identity, purpose, communication style
    USER.md   — Enterprise context, authorized personnel, escalation paths
    AGENTS.md — Operational rules, coding standards, tool usage policies
"""

from __future__ import annotations

import logging
from typing import Optional, Dict, Any
from pathlib import Path
from dataclasses import dataclass, field

from ..core.workspace import get_workspace_path

logger = logging.getLogger(__name__)


@dataclass
class AgentIdentity:
    """Parsed identity from SOUL.md."""
    name: str = "Benny"
    purpose: str = ""
    communication_style: str = ""
    core_values: list = field(default_factory=list)
    boundaries: list = field(default_factory=list)
    raw_content: str = ""


@dataclass
class UserContext:
    """Parsed context from USER.md."""
    organization: str = ""
    authorized_personnel: list = field(default_factory=list)
    escalation_paths: list = field(default_factory=list)
    domain_context: str = ""
    compliance_requirements: list = field(default_factory=list)
    raw_content: str = ""


@dataclass
class OperationalRules:
    """Parsed rules from AGENTS.md."""
    coding_standards: list = field(default_factory=list)
    tool_usage_policies: list = field(default_factory=list)
    forbidden_actions: list = field(default_factory=list)
    output_formatting: str = ""
    language_requirements: str = ""
    raw_content: str = ""


def _read_manual(workspace: str, filename: str) -> str:
    """Read a manual file from workspace root."""
    file_path = get_workspace_path(workspace) / filename
    if file_path.exists():
        try:
            return file_path.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to read %s: %s", filename, e)
    return ""


def _parse_sections(content: str) -> Dict[str, str]:
    """
    Parse a markdown file into sections.
    Returns dict of heading → content.
    """
    sections: Dict[str, str] = {}
    current_heading = "preamble"
    current_content = []
    
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("# ") or stripped.startswith("## "):
            if current_content:
                sections[current_heading] = "\n".join(current_content).strip()
            current_heading = stripped.lstrip("#").strip().lower()
            current_content = []
        else:
            current_content.append(line)
    
    if current_content:
        sections[current_heading] = "\n".join(current_content).strip()
    
    return sections


def _parse_list(section_content: str) -> list:
    """Parse a markdown bulleted list into a Python list."""
    items = []
    for line in section_content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("- ") or stripped.startswith("* "):
            items.append(stripped[2:].strip())
    return items


def get_agent_identity(workspace: str) -> AgentIdentity:
    """
    Load and parse the agent identity from SOUL.md.
    
    Expected SOUL.md structure:
    ```
    # Name
    Benny
    
    # Purpose
    Enterprise cognitive mesh orchestration...
    
    # Communication Style
    Professional, precise...
    
    # Core Values
    - Accuracy over speed
    - Transparency in reasoning
    
    # Boundaries
    - Never modify production data without approval
    - Always cite sources
    ```
    """
    content = _read_manual(workspace, "SOUL.md")
    if not content:
        return AgentIdentity(raw_content="")
    
    sections = _parse_sections(content)
    
    return AgentIdentity(
        name=sections.get("name", "Benny").strip(),
        purpose=sections.get("purpose", ""),
        communication_style=sections.get("communication style", ""),
        core_values=_parse_list(sections.get("core values", "")),
        boundaries=_parse_list(sections.get("boundaries", "")),
        raw_content=content,
    )


def get_user_context(workspace: str) -> UserContext:
    """
    Load and parse enterprise context from USER.md.
    
    Expected USER.md structure:
    ```
    # Organization
    Acme Corp
    
    # Authorized Personnel
    - John Doe (Admin)
    - Jane Smith (Reviewer)
    
    # Domain Context
    Financial services, portfolio management...
    
    # Compliance Requirements
    - SOX compliance required
    - PII must be redacted
    ```
    """
    content = _read_manual(workspace, "USER.md")
    if not content:
        return UserContext(raw_content="")
    
    sections = _parse_sections(content)
    
    return AgentIdentity(
        organization=sections.get("organization", ""),
        authorized_personnel=_parse_list(sections.get("authorized personnel", "")),
        escalation_paths=_parse_list(sections.get("escalation paths", "")),
        domain_context=sections.get("domain context", ""),
        compliance_requirements=_parse_list(sections.get("compliance requirements", "")),
        raw_content=content,
    )


def get_operational_rules(workspace: str) -> OperationalRules:
    """
    Load and parse operational rules from AGENTS.md.
    
    Expected AGENTS.md structure:
    ```
    # Coding Standards
    - Use type hints in all Python functions
    - Follow PEP 8
    
    # Tool Usage Policies
    - Always use call_model() for LLM calls
    - Never access the filesystem outside the workspace
    
    # Forbidden Actions
    - Do not delete production data
    - Do not make external API calls without approval
    ```
    """
    content = _read_manual(workspace, "AGENTS.md")
    if not content:
        return OperationalRules(raw_content="")
    
    sections = _parse_sections(content)
    
    return OperationalRules(
        coding_standards=_parse_list(sections.get("coding standards", "")),
        tool_usage_policies=_parse_list(sections.get("tool usage policies", "")),
        forbidden_actions=_parse_list(sections.get("forbidden actions", "")),
        output_formatting=sections.get("output formatting", ""),
        language_requirements=sections.get("language requirements", ""),
        raw_content=content,
    )


def build_system_prompt_augmentation(workspace: str) -> str:
    """
    Build a system prompt augmentation string from all Operating Manuals.
    
    This should be PREPENDED to the system prompt for every LLM call
    within this workspace.
    
    Returns:
        String to prepend to system prompts, or empty string if no manuals exist
    """
    identity = get_agent_identity(workspace)
    user_ctx = get_user_context(workspace)
    rules = get_operational_rules(workspace)
    
    parts = []
    
    if identity.raw_content:
        parts.append(f"=== AGENT IDENTITY ===")
        if identity.name:
            parts.append(f"Name: {identity.name}")
        if identity.purpose:
            parts.append(f"Purpose: {identity.purpose}")
        if identity.communication_style:
            parts.append(f"Communication Style: {identity.communication_style}")
        if identity.boundaries:
            parts.append(f"Boundaries: {'; '.join(identity.boundaries)}")
    
    if user_ctx.raw_content:
        parts.append(f"\n=== ENTERPRISE CONTEXT ===")
        if user_ctx.organization:
            parts.append(f"Organization: {user_ctx.organization}")
        if user_ctx.domain_context:
            parts.append(f"Domain: {user_ctx.domain_context}")
        if user_ctx.compliance_requirements:
            parts.append(f"Compliance: {'; '.join(user_ctx.compliance_requirements)}")
    
    if rules.raw_content:
        parts.append(f"\n=== OPERATIONAL RULES ===")
        if rules.forbidden_actions:
            parts.append(f"FORBIDDEN: {'; '.join(rules.forbidden_actions)}")
        if rules.tool_usage_policies:
            parts.append(f"Tool Policies: {'; '.join(rules.tool_usage_policies)}")
    
    if not parts:
        return ""
    
    return "\n".join(parts) + "\n\n"
```

### 3.2 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\governance\permission_manifest.py`

```python
"""
Permission Manifest — Explicit capability declaration for skills/tools.

Each skill MUST declare what it can do (file read, file write, network access, etc.)
and the runtime enforcer validates that actual behavior matches declarations.

Manifest format (permissions.json alongside skill code):
{
    "skill_id": "write_file",
    "declared_capabilities": ["file:write", "file:read"],
    "max_file_size_bytes": 10485760,
    "allowed_path_patterns": ["workspace/**"],
    "forbidden_path_patterns": ["../**", "/etc/**", "C:\\Windows\\**"],
    "network_access": false,
    "subprocess_access": false
}
"""

from __future__ import annotations

import re
import logging
from typing import List, Optional, Dict, Any
from pathlib import Path
from fnmatch import fnmatch
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from ..governance.audit import emit_governance_event

logger = logging.getLogger(__name__)


class PermissionManifest(BaseModel):
    """Declared capabilities for a skill/tool."""
    skill_id: str
    declared_capabilities: List[str] = Field(default_factory=list)
    # Valid capabilities: file:read, file:write, file:delete, network:http, 
    #                    network:ws, subprocess:run, database:read, database:write
    max_file_size_bytes: int = 10 * 1024 * 1024  # 10MB default
    allowed_path_patterns: List[str] = Field(default_factory=lambda: ["workspace/**"])
    forbidden_path_patterns: List[str] = Field(default_factory=lambda: [
        "../**", "../../**",  # Path traversal
        "/etc/**", "/root/**",  # Linux system
        "C:\\Windows\\**", "C:\\Program Files\\**",  # Windows system
    ])
    network_access: bool = False
    subprocess_access: bool = False


class ManifestViolation:
    """A detected violation between declared and actual behavior."""
    def __init__(self, skill_id: str, violation_type: str, message: str, severity: str = "high"):
        self.skill_id = skill_id
        self.violation_type = violation_type
        self.message = message
        self.severity = severity
    
    def __repr__(self):
        return f"ManifestViolation({self.skill_id}: {self.violation_type} - {self.message})"


# Global manifest registry
_manifests: Dict[str, PermissionManifest] = {}


def register_manifest(manifest: PermissionManifest) -> None:
    """Register a permission manifest for a skill."""
    _manifests[manifest.skill_id] = manifest


def get_manifest(skill_id: str) -> Optional[PermissionManifest]:
    """Get the manifest for a skill."""
    return _manifests.get(skill_id)


def validate_file_access(
    skill_id: str,
    file_path: str,
    operation: str,  # "read", "write", "delete"
    workspace: str = "default"
) -> Optional[ManifestViolation]:
    """
    Validate a file access attempt against the skill's manifest.
    
    Args:
        skill_id: Tool attempting the file access
        file_path: Path being accessed
        operation: read/write/delete
        workspace: Current workspace
    
    Returns:
        ManifestViolation if blocked, None if allowed
    """
    manifest = get_manifest(skill_id)
    
    if manifest is None:
        # No manifest = deny by default (PRD requirement)
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="no_manifest",
            message=f"No permission manifest registered for '{skill_id}'",
        )
        _audit_violation(violation, workspace)
        return violation
    
    # Check capability declaration
    required_capability = f"file:{operation}"
    if required_capability not in manifest.declared_capabilities:
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="undeclared_capability",
            message=f"'{skill_id}' did not declare '{required_capability}' capability",
        )
        _audit_violation(violation, workspace)
        return violation
    
    # Normalize path for pattern matching
    normalized = file_path.replace("\\", "/")
    
    # Check forbidden patterns first (deny takes precedence)
    for pattern in manifest.forbidden_path_patterns:
        if fnmatch(normalized, pattern):
            violation = ManifestViolation(
                skill_id=skill_id,
                violation_type="forbidden_path",
                message=f"Path '{file_path}' matches forbidden pattern '{pattern}'",
            )
            _audit_violation(violation, workspace)
            return violation
    
    # Check allowed patterns
    path_allowed = False
    for pattern in manifest.allowed_path_patterns:
        if fnmatch(normalized, pattern):
            path_allowed = True
            break
    
    if not path_allowed:
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="path_not_allowed",
            message=f"Path '{file_path}' does not match any allowed patterns",
        )
        _audit_violation(violation, workspace)
        return violation
    
    return None  # Access allowed


def validate_network_access(skill_id: str, workspace: str = "default") -> Optional[ManifestViolation]:
    """Validate that a tool is allowed to make network calls."""
    manifest = get_manifest(skill_id)
    
    if manifest is None:
        violation = ManifestViolation(skill_id, "no_manifest", "No manifest registered")
        _audit_violation(violation, workspace)
        return violation
    
    if not manifest.network_access:
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="undeclared_network",
            message=f"'{skill_id}' attempted network access but manifest declares network_access=False",
        )
        _audit_violation(violation, workspace)
        return violation
    
    return None


def validate_subprocess_access(skill_id: str, workspace: str = "default") -> Optional[ManifestViolation]:
    """Validate that a tool is allowed to spawn subprocesses."""
    manifest = get_manifest(skill_id)
    
    if manifest is None:
        violation = ManifestViolation(skill_id, "no_manifest", "No manifest registered")
        _audit_violation(violation, workspace)
        return violation
    
    if not manifest.subprocess_access:
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="undeclared_subprocess",
            message=f"'{skill_id}' attempted subprocess execution but manifest declares subprocess_access=False",
        )
        _audit_violation(violation, workspace)
        return violation
    
    return None


def _audit_violation(violation: ManifestViolation, workspace: str) -> None:
    """Emit a governance event for manifest violations."""
    try:
        emit_governance_event(
            event_type="PERMISSION_MANIFEST_VIOLATION",
            data={
                "skill_id": violation.skill_id,
                "violation_type": violation.violation_type,
                "message": violation.message,
                "severity": violation.severity,
            },
            workspace_id=workspace
        )
    except Exception:
        pass


def register_builtin_manifests() -> None:
    """Register permission manifests for all built-in skills."""
    manifests = [
        PermissionManifest(
            skill_id="search_kb",
            declared_capabilities=["database:read"],
            network_access=False,
            subprocess_access=False,
        ),
        PermissionManifest(
            skill_id="read_document",
            declared_capabilities=["file:read"],
            allowed_path_patterns=["workspace/**"],
            network_access=False,
            subprocess_access=False,
        ),
        PermissionManifest(
            skill_id="list_documents",
            declared_capabilities=["file:read"],
            allowed_path_patterns=["workspace/**"],
            network_access=False,
            subprocess_access=False,
        ),
        PermissionManifest(
            skill_id="write_file",
            declared_capabilities=["file:write", "file:read"],
            allowed_path_patterns=["workspace/**"],
            network_access=False,
            subprocess_access=False,
        ),
        PermissionManifest(
            skill_id="read_file",
            declared_capabilities=["file:read"],
            allowed_path_patterns=["workspace/**"],
            network_access=False,
            subprocess_access=False,
        ),
    ]
    
    for m in manifests:
        register_manifest(m)
```

### 3.3 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\governance\audit.py`

Add SHA-256 integrity verification and security-specific event types.

Read the existing `audit.py` first. Then add these modifications:

#### Add import:
```python
import hashlib
```

#### Modify `emit_governance_event()` to include SHA-256 hash:

In the function that writes audit events, before writing the event to the log file, compute and add a hash:

```python
def emit_governance_event(event_type: str, data: Any, workspace_id: str = "default"):
    """Emit a governance audit event with integrity verification."""
    # ... existing code to build event_record ...
    
    # Add SHA-256 integrity hash
    event_json = json.dumps(event_record, sort_keys=True, default=str)
    event_record["_integrity_hash"] = hashlib.sha256(event_json.encode()).hexdigest()
    
    # ... existing code to write event ...
```

#### Add new security event function:

```python
def emit_security_event(
    event_type: str,
    agent_id: str,
    action: str,
    result: str,
    details: Dict[str, Any] = None,
    workspace_id: str = "default"
):
    """
    Emit a security-specific audit event.
    
    Event types:
      - UNAUTHORIZED_ACCESS: Agent tried to access something it shouldn't
      - PERMISSION_VIOLATION: RBAC check failed
      - MANIFEST_VIOLATION: Tool exceeded its declared capabilities
      - CREDENTIAL_ACCESS: Credential was accessed from the vault
      - RATE_LIMIT_EXCEEDED: Agent exceeded call rate limits
    """
    emit_governance_event(
        event_type=f"SECURITY_{event_type}",
        data={
            "agent_id": agent_id,
            "action": action,
            "result": result,
            "details": details or {},
            "co_authored_by": "ai_agent",  # Explicit AI disclosure per PRD
        },
        workspace_id=workspace_id
    )
```

#### Add integrity verification function:

```python
def verify_audit_integrity(workspace_id: str = "default") -> Dict[str, Any]:
    """
    Verify the integrity of the audit log by checking SHA-256 hashes.
    
    Returns:
        {
            "total_events": int,
            "verified": int,
            "tampered": int,
            "missing_hash": int,
            "tampered_events": [...]
        }
    """
    audit_path = get_workspace_path(workspace_id) / "governance.log"
    if not audit_path.exists():
        return {"total_events": 0, "verified": 0, "tampered": 0, "missing_hash": 0}
    
    total = 0
    verified = 0
    tampered = 0
    missing_hash = 0
    tampered_events = []
    
    for line in audit_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        
        total += 1
        try:
            event = json.loads(line)
            stored_hash = event.pop("_integrity_hash", None)
            
            if stored_hash is None:
                missing_hash += 1
                continue
            
            # Recompute hash without the _integrity_hash field
            recomputed = hashlib.sha256(
                json.dumps(event, sort_keys=True, default=str).encode()
            ).hexdigest()
            
            if recomputed == stored_hash:
                verified += 1
            else:
                tampered += 1
                tampered_events.append({
                    "line": total,
                    "expected_hash": stored_hash,
                    "actual_hash": recomputed,
                })
        except json.JSONDecodeError:
            missing_hash += 1
    
    return {
        "total_events": total,
        "verified": verified,
        "tampered": tampered,
        "missing_hash": missing_hash,
        "tampered_events": tampered_events,
    }
```

### 3.4 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\core\workspace.py`

In the `ensure_workspace_structure()` function that creates workspace directories, ADD creation of default Operating Manual templates:

```python
# After existing directory creation, add:

# Create default Operating Manuals if they don't exist
_create_default_manual(ws_path / "SOUL.md", """# Name
Benny

# Purpose
Enterprise cognitive mesh orchestration platform for structured knowledge work.

# Communication Style
Professional, precise, and transparent. Always explain reasoning.

# Core Values
- Accuracy over speed
- Transparency in all reasoning
- Human oversight for critical decisions
- Data privacy and security

# Boundaries
- Never modify production data without explicit human approval
- Always cite sources when providing information
- Escalate to human reviewers when confidence is below 70%
- Never expose credentials or sensitive information in outputs
""")

_create_default_manual(ws_path / "USER.md", """# Organization
[Your Organization Name]

# Authorized Personnel
- [Admin Name] (Admin)

# Domain Context
[Describe your business domain and subject matter]

# Compliance Requirements
- All outputs must be auditable via governance logs
- PII must be handled per applicable regulations
""")

_create_default_manual(ws_path / "AGENTS.md", """# Coding Standards
- Use type hints in all Python functions
- Follow PEP 8 style guidelines
- Write docstrings for all public functions

# Tool Usage Policies
- Always use call_model() for LLM calls, never raw litellm
- Use the SkillRegistry for tool execution
- Log all file system operations

# Forbidden Actions
- Do not delete files outside the workspace directory
- Do not make external API calls without RBAC authorization
- Do not bypass governance middleware
- Do not store credentials in plain text

# Output Formatting
- Use Markdown for all generated documents
- Include timestamps and provenance in generated artifacts
""")

# Create policies directory
(ws_path / "policies").mkdir(exist_ok=True)
(ws_path / "agents").mkdir(exist_ok=True)
(ws_path / "credentials").mkdir(exist_ok=True)
```

Add the helper function:

```python
def _create_default_manual(path: Path, content: str) -> None:
    """Create a default manual file if it doesn't exist."""
    if not path.exists():
        try:
            path.write_text(content.strip(), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to create default manual %s: %s", path, e)
```

### 3.5 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Admin\GlobalAdminDashboard.tsx`

Add security-related sections. Read the existing file first, then ADD these sections to the dashboard tabs/panels:

#### Operating Manual Editor Section

```tsx
{/* Operating Manual Editor */}
<div className="admin-section">
  <h3 style={{ marginBottom: '12px' }}>📖 Operating Manuals</h3>
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
    {['SOUL.md', 'USER.md', 'AGENTS.md'].map(filename => (
      <div key={filename} style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border-color)',
        borderRadius: '8px',
        padding: '12px',
      }}>
        <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px' }}>{filename}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
          {filename === 'SOUL.md' && 'Agent identity and boundaries'}
          {filename === 'USER.md' && 'Enterprise context and compliance'}
          {filename === 'AGENTS.md' && 'Operational rules and standards'}
        </div>
        <button
          className="btn btn-outline"
          style={{ width: '100%', fontSize: '12px' }}
          onClick={async () => {
            try {
              const res = await fetch(
                `${API_BASE_URL}/api/workspaces/${currentWorkspace}/files/${filename}`,
                { headers: GOVERNANCE_HEADERS }
              );
              if (res.ok) {
                const data = await res.json();
                const content = prompt(`Edit ${filename}:`, data.content);
                if (content !== null) {
                  await fetch(
                    `${API_BASE_URL}/api/workspaces/${currentWorkspace}/files/${filename}`,
                    {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', ...GOVERNANCE_HEADERS },
                      body: JSON.stringify({ content }),
                    }
                  );
                }
              }
            } catch (e) { console.error(e); }
          }}
        >
          Edit
        </button>
      </div>
    ))}
  </div>
</div>
```

#### Audit Integrity Verification Section

```tsx
{/* Audit Integrity */}
<div className="admin-section" style={{ marginTop: '16px' }}>
  <h3>🔐 Audit Integrity</h3>
  <button
    className="btn btn-gradient"
    onClick={async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/workspaces/${currentWorkspace}/audit/verify`,
          { headers: GOVERNANCE_HEADERS }
        );
        if (res.ok) {
          const result = await res.json();
          alert(`Audit Verification Results:\n\nTotal Events: ${result.total_events}\nVerified: ${result.verified}\nTampered: ${result.tampered}\nMissing Hash: ${result.missing_hash}`);
        }
      } catch (e) { console.error(e); }
    }}
  >
    Verify Audit Log Integrity
  </button>
</div>
```

### 3.6 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\workspace_routes.py`

Add an endpoint for audit integrity verification:

```python
@router.get("/{workspace}/audit/verify")
async def verify_audit(workspace: str):
    """Verify the integrity of the workspace audit log."""
    from ..governance.audit import verify_audit_integrity
    return verify_audit_integrity(workspace)
```

---

## 4. BDD Acceptance Criteria

```gherkin
Feature: Operating Manual Loading

  Scenario: SOUL.md defines agent identity
    Given a workspace with a SOUL.md file containing "# Name\nBenny Research Assistant"
    When get_agent_identity(workspace) is called
    Then the identity.name should be "Benny Research Assistant"

  Scenario: Missing manuals produce empty defaults
    Given a workspace without any Operating Manual files
    When get_agent_identity(workspace) is called
    Then the identity.raw_content should be empty
    And no errors should be raised

  Scenario: System prompt augmentation
    Given SOUL.md, USER.md, and AGENTS.md all exist
    When build_system_prompt_augmentation(workspace) is called
    Then the result should contain "AGENT IDENTITY", "ENTERPRISE CONTEXT", and "OPERATIONAL RULES"

Feature: Permission Manifest Enforcement

  Scenario: Tool with valid manifest can access allowed path
    Given write_file has manifest allowing "workspace/**"
    When it writes to "workspace/docs/output.md"
    Then no violation should be returned

  Scenario: Tool accessing forbidden path is blocked
    Given write_file has manifest forbidding "../**"
    When it tries to write to "../../etc/passwd"
    Then a ManifestViolation should be returned with type "forbidden_path"

  Scenario: Tool without manifest is denied
    Given skill "unknown_tool" has no registered manifest
    When it attempts any file access
    Then a ManifestViolation should be returned with type "no_manifest"

  Scenario: Undeclared capability is blocked
    Given read_file declares only "file:read"
    When it attempts a write operation
    Then a ManifestViolation should be returned with type "undeclared_capability"

Feature: Audit Trail Integrity

  Scenario: Audit events include SHA-256 hash
    When a governance event is emitted
    Then the log entry should contain "_integrity_hash" field
    And the hash should be a valid 64-character hex string

  Scenario: Integrity verification passes for unmodified logs
    Given an untampered audit log
    When verify_audit_integrity() is called
    Then tampered should be 0
    And verified should equal total_events (minus missing_hash)

Feature: Workspace Templates

  Scenario: New workspace gets default Operating Manuals
    When ensure_workspace_structure("new_workspace") is called
    Then SOUL.md should exist with "Benny" as the agent name
    And USER.md should exist with placeholders
    And AGENTS.md should exist with coding standards
    And policies/ directory should exist
    And agents/ directory should exist
```

---

## 5. TDD Test File

### Create: `C:\Users\nsdha\OneDrive\code\benny\tests\test_security.py`

```python
"""
Test suite for Phase 6 — Security Hardening & Operating Manuals.
Run with: python -m pytest tests/test_security.py -v
"""

import pytest
import json
from pathlib import Path
from unittest.mock import patch

from benny.governance.operating_manual import (
    get_agent_identity, get_user_context, get_operational_rules,
    build_system_prompt_augmentation, _parse_sections, _parse_list,
)
from benny.governance.permission_manifest import (
    PermissionManifest, register_manifest, get_manifest,
    validate_file_access, validate_network_access,
    validate_subprocess_access, _manifests,
)


class TestOperatingManuals:

    def test_parse_sections(self):
        content = "# Name\nBenny\n\n# Purpose\nTest agent\n"
        sections = _parse_sections(content)
        assert "name" in sections
        assert "Benny" in sections["name"]
        assert "purpose" in sections

    def test_parse_list(self):
        content = "- Item 1\n- Item 2\n* Item 3\nNot a list item"
        items = _parse_list(content)
        assert items == ["Item 1", "Item 2", "Item 3"]

    def test_get_identity_from_soul_md(self, tmp_path):
        soul_md = tmp_path / "SOUL.md"
        soul_md.write_text("# Name\nTest Agent\n\n# Purpose\nTesting\n\n# Boundaries\n- No production access\n", encoding="utf-8")
        
        with patch("benny.governance.operating_manual.get_workspace_path", return_value=tmp_path):
            identity = get_agent_identity("test")
            assert identity.name == "Test Agent"
            assert identity.purpose == "Testing"
            assert "No production access" in identity.boundaries

    def test_missing_soul_md_returns_default(self, tmp_path):
        with patch("benny.governance.operating_manual.get_workspace_path", return_value=tmp_path):
            identity = get_agent_identity("test")
            assert identity.name == "Benny"  # Default
            assert identity.raw_content == ""

    def test_system_prompt_augmentation(self, tmp_path):
        (tmp_path / "SOUL.md").write_text("# Name\nBotAgent\n# Boundaries\n- Be safe\n", encoding="utf-8")
        (tmp_path / "AGENTS.md").write_text("# Forbidden Actions\n- No deletions\n", encoding="utf-8")
        
        with patch("benny.governance.operating_manual.get_workspace_path", return_value=tmp_path):
            augmentation = build_system_prompt_augmentation("test")
            assert "AGENT IDENTITY" in augmentation
            assert "BotAgent" in augmentation
            assert "OPERATIONAL RULES" in augmentation
            assert "No deletions" in augmentation

    def test_empty_workspace_returns_empty_augmentation(self, tmp_path):
        with patch("benny.governance.operating_manual.get_workspace_path", return_value=tmp_path):
            augmentation = build_system_prompt_augmentation("test")
            assert augmentation == ""


class TestPermissionManifest:

    def setup_method(self):
        _manifests.clear()

    def test_register_and_get(self):
        manifest = PermissionManifest(skill_id="test_tool", declared_capabilities=["file:read"])
        register_manifest(manifest)
        retrieved = get_manifest("test_tool")
        assert retrieved is not None
        assert retrieved.skill_id == "test_tool"

    def test_no_manifest_blocks_access(self):
        with patch("benny.governance.permission_manifest.emit_governance_event"):
            violation = validate_file_access("unknown", "/some/path", "read")
            assert violation is not None
            assert violation.violation_type == "no_manifest"

    def test_undeclared_capability_blocked(self):
        register_manifest(PermissionManifest(
            skill_id="read_only",
            declared_capabilities=["file:read"],
        ))
        with patch("benny.governance.permission_manifest.emit_governance_event"):
            violation = validate_file_access("read_only", "workspace/f.txt", "write")
            assert violation is not None
            assert violation.violation_type == "undeclared_capability"

    def test_forbidden_path_blocked(self):
        register_manifest(PermissionManifest(
            skill_id="writer",
            declared_capabilities=["file:write"],
            forbidden_path_patterns=["../../**"],
        ))
        with patch("benny.governance.permission_manifest.emit_governance_event"):
            violation = validate_file_access("writer", "../../etc/passwd", "write")
            assert violation is not None
            assert violation.violation_type == "forbidden_path"

    def test_allowed_path_succeeds(self):
        register_manifest(PermissionManifest(
            skill_id="writer",
            declared_capabilities=["file:write"],
            allowed_path_patterns=["workspace/**"],
        ))
        with patch("benny.governance.permission_manifest.emit_governance_event"):
            violation = validate_file_access("writer", "workspace/output.md", "write")
            assert violation is None

    def test_network_access_blocked_when_undeclared(self):
        register_manifest(PermissionManifest(
            skill_id="local_tool",
            declared_capabilities=["file:read"],
            network_access=False,
        ))
        with patch("benny.governance.permission_manifest.emit_governance_event"):
            violation = validate_network_access("local_tool")
            assert violation is not None
            assert "network_access=False" in violation.message

    def test_subprocess_access_blocked_when_undeclared(self):
        register_manifest(PermissionManifest(
            skill_id="safe_tool",
            declared_capabilities=["file:read"],
            subprocess_access=False,
        ))
        with patch("benny.governance.permission_manifest.emit_governance_event"):
            violation = validate_subprocess_access("safe_tool")
            assert violation is not None


class TestAuditIntegrity:

    def test_hash_is_sha256(self):
        import hashlib
        test_data = '{"key": "value"}'
        hash_value = hashlib.sha256(test_data.encode()).hexdigest()
        assert len(hash_value) == 64
        assert all(c in '0123456789abcdef' for c in hash_value)
```

---

## 6. Execution Order

1. Read ALL files in Section 2
2. Create `C:\Users\nsdha\OneDrive\code\benny\tests\test_security.py`
3. Create `C:\Users\nsdha\OneDrive\code\benny\benny\governance\operating_manual.py`
4. Create `C:\Users\nsdha\OneDrive\code\benny\benny\governance\permission_manifest.py`
5. Run tests: `python -m pytest tests/test_security.py -v`
6. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\governance\audit.py` — add SHA-256 + security events
7. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\core\workspace.py` — add templates
8. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\workspace_routes.py` — add audit verify endpoint
9. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Admin\GlobalAdminDashboard.tsx`
10. Run full test suite
11. Verify: create a new workspace and confirm SOUL.md, USER.md, AGENTS.md are generated

---

## 7. Definition of Done

- [ ] All 12 tests in `test_security.py` pass
- [ ] SOUL.md/USER.md/AGENTS.md parse correctly into structured data
- [ ] `build_system_prompt_augmentation()` returns augmentation from all three manuals
- [ ] Missing manuals degrade gracefully (no errors, empty defaults)
- [ ] Permission manifests enforce file:read/write/delete capabilities
- [ ] Forbidden path patterns block access (e.g., `../../etc/passwd`)
- [ ] Undeclared capabilities are blocked
- [ ] Network and subprocess access is gated by manifest declarations
- [ ] All audit events include SHA-256 integrity hash
- [ ] `verify_audit_integrity()` detects tampered events
- [ ] New workspaces auto-generate default Operating Manuals
- [ ] Admin dashboard has Operating Manual editor and audit integrity verification
- [ ] All violations emit governance audit events
