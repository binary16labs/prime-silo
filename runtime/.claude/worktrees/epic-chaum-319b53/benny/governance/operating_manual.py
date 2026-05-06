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
from typing import Optional, Dict, Any, List
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
            # Handle headers like "# Name" by taking "name"
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
    """Load and parse the agent identity from SOUL.md."""
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
    """Load and parse enterprise context from USER.md."""
    content = _read_manual(workspace, "USER.md")
    if not content:
        return UserContext(raw_content="")
    
    sections = _parse_sections(content)
    
    return UserContext(
        organization=sections.get("organization", ""),
        authorized_personnel=_parse_list(sections.get("authorized personnel", "")),
        escalation_paths=_parse_list(sections.get("escalation paths", "")),
        domain_context=sections.get("domain context", ""),
        compliance_requirements=_parse_list(sections.get("compliance requirements", "")),
        raw_content=content,
    )


def get_operational_rules(workspace: str) -> OperationalRules:
    """Load and parse operational rules from AGENTS.md."""
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
    Returns: String to prepend to system prompts, or empty string if no manuals exist.
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
        
    # Standardized Reasoning Instruction
    parts.append("\n=== REASONING PROTOCOL ===")
    parts.append("If you need to think, process, or plan before answering, wrap your internal monologue in <think> tags.")
    parts.append("Output your final response outside these tags. Do not mention your thinking process in the final response unless requested.")
    
    if not parts:
        return ""
    
    return "\n".join(parts) + "\n\n"
