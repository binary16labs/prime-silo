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
import sys
from typing import List, Optional, Dict, Any
from pathlib import Path
from fnmatch import fnmatch
from pydantic import BaseModel, Field
from datetime import datetime

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


def create_ephemeral_manifest(task_id: str, allowed_tools: List[str]) -> PermissionManifest:
    """Creates a temporary manifest for a specific task."""
    return PermissionManifest(
        skill_id=task_id,
        declared_capabilities=[f"tool:{t}" for t in allowed_tools],
        # Restrict to workspace only
        allowed_path_patterns=["workspace/**"],
        network_access=False 
    )


class ManifestViolation:
    """A detected violation between declared and actual behavior."""
    def __init__(self, skill_id: str, violation_type: str, message: str, severity: str = "high"):
        self.skill_id = skill_id
        self.violation_type = violation_type
        self.message = message
        self.severity = severity
    
    def __repr__(self):
        return f"ManifestViolation({self.skill_id}: {self.violation_type} - {self.message})"


# Global manifest registry — Shared across all module instances for security consistency
if not hasattr(sys, '_benny_manifests'):
    sys._benny_manifests = {}
_manifests = sys._benny_manifests

def register_manifest(manifest: PermissionManifest) -> None:
    """Register a permission manifest for a skill."""
    _manifests[manifest.skill_id] = manifest
    logging.debug(f"[SEC] Registered manifest for key: {manifest.skill_id}")


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
    normalized = str(file_path).replace("\\", "/")
    
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


def validate_tool_access(skill_id: str, tool_name: str, workspace: str = "default") -> Optional[ManifestViolation]:
    """Validate that a skill is allowed to call a specific tool."""
    manifest = get_manifest(skill_id)
    
    if manifest is None:
        # Deny by default
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="no_manifest",
            message=f"No permission manifest registered for '{skill_id}'",
        )
        _audit_violation(violation, workspace)
        return violation
    
    required_capability = f"tool:{tool_name}"
    # Special case: some tools might be implicitly allowed by file:write etc? 
    # For now, stick to explicit tool:name
    if required_capability not in manifest.declared_capabilities:
        violation = ManifestViolation(
            skill_id=skill_id,
            violation_type="SECURITY_PERMISSION_VIOLATION",
            message=f"'{skill_id}' attempted to call unauthorized tool '{tool_name}'",
        )
        _audit_violation(violation, workspace)
        return violation
    
    return None


def _audit_violation(violation: ManifestViolation, workspace: str) -> None:
    """Emit a governance event for manifest violations."""
    try:
        emit_governance_event(
            event_type="SECURITY_PERMISSION_VIOLATION" if violation.violation_type == "SECURITY_PERMISSION_VIOLATION" else "PERMISSION_MANIFEST_VIOLATION",
            data={
                "skill_id": violation.skill_id,
                "violation_type": violation.violation_type,
                "message": violation.message,
                "severity": violation.severity,
                "timestamp": datetime.utcnow().isoformat(),
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
        PermissionManifest(
            skill_id="query_graph",
            declared_capabilities=["database:read"],
            network_access=False,
            subprocess_access=False,
        ),
    ]
    
    for m in manifests:
        register_manifest(m)
