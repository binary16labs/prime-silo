"""
Skill Registry — Workspace-scoped tool catalog for agents.

Skills are reusable capabilities (tools) that can be attached to agents.
Built-in skills are always available; workspace skills override/extend them.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, List, Optional
from pathlib import Path
import json
import yaml
import re

from .workspace import get_workspace_path
from ..governance.permission_manifest import validate_tool_access


# =============================================================================
# SKILL MODEL
# =============================================================================

@dataclass
class SkillParameter:
    """A single parameter for a skill."""
    name: str
    type: str  # string, integer, boolean, number
    description: str
    required: bool = True
    default: Any = None


@dataclass
class Skill:
    """A skill (tool) that an agent can use."""
    id: str
    name: str
    description: str
    category: str  # knowledge, files, data, custom
    parameters: List[SkillParameter] = field(default_factory=list)
    builtin: bool = True
    workspace: Optional[str] = None  # None = global built-in
    content: Optional[str] = None  # Full Markdown instructions from SKILL.md
    metadata: Dict[str, Any] = field(default_factory=dict) # Extensible attributes (priority, author, etc.)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "parameters": [asdict(p) for p in self.parameters],
            "builtin": self.builtin,
            "workspace": self.workspace,
            "content": self.content,
            "metadata": self.metadata,
        }

    def to_openai_tool_schema(self) -> dict:
        """Convert to OpenAI function-calling tool schema."""
        properties = {}
        required = []
        for p in self.parameters:
            prop: Dict[str, Any] = {"type": p.type, "description": p.description}
            if p.default is not None:
                prop["default"] = p.default
            properties[p.name] = prop
            if p.required:
                required.append(p.name)

        return {
            "type": "function",
            "function": {
                "name": self.id,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                }
            }
        }


# =============================================================================
# BUILT-IN SKILLS
# =============================================================================

BUILTIN_SKILLS: List[Skill] = [
    Skill(
        id="search_kb",
        name="Search Knowledge Base",
        description="Search the workspace knowledge base using semantic similarity. Returns relevant document excerpts with sources.",
        category="knowledge",
        parameters=[
            SkillParameter("query", "string", "Search query to find relevant documents"),
            SkillParameter("top_k", "integer", "Number of results to return", required=False, default=20),
        ],
    ),
    Skill(
        id="list_documents",
        name="List Documents",
        description="List all documents available in the workspace knowledge base with chunk counts.",
        category="knowledge",
        parameters=[],
    ),
    Skill(
        id="read_document",
        name="Read Full Document",
        description="Retrieve the complete text of a specific document from the knowledge base.",
        category="knowledge",
        parameters=[
            SkillParameter("document_name", "string", "Name of the document to read"),
        ],
    ),
    Skill(
        id="read_file",
        name="Read File",
        description="Read a file from the workspace (data_in or data_out directory).",
        category="files",
        parameters=[
            SkillParameter("filename", "string", "Name of the file to read"),
            SkillParameter("subdir", "string", "Directory to read from (data_in or data_out)", required=False, default="data_in"),
        ],
    ),
    Skill(
        id="write_file",
        name="Write File",
        description="Write content to a file in the workspace data_out directory.",
        category="files",
        parameters=[
            SkillParameter("filename", "string", "Target filename"),
            SkillParameter("content", "string", "Content to write to the file"),
        ],
    ),
    Skill(
        id="list_files",
        name="List Files",
        description="List all files in a workspace directory.",
        category="files",
        parameters=[
            SkillParameter("subdir", "string", "Directory to list (data_in, data_out, reports)", required=False, default="data_out"),
        ],
    ),
    Skill(
        id="extract_pdf",
        name="Extract PDF Text",
        description="Extract text content from a PDF file in the workspace.",
        category="data",
        parameters=[
            SkillParameter("pdf_path", "string", "Path to PDF file (relative to data_in)"),
        ],
    ),
    Skill(
        id="query_csv",
        name="Query CSV",
        description="Query a CSV file using Pandas query syntax. Supports column filters and df.head()/df.describe() expressions.",
        category="data",
        parameters=[
            SkillParameter("csv_path", "string", "Path to CSV file (relative to data_in)"),
            SkillParameter("query", "string", "Pandas query string (e.g., 'amount > 100' or 'df.head(10)')"),
        ],
    ),
    Skill(
        id="query_graph",
        name="Query Neural Graph",
        description="Query the Neo4j knowledge and code graph using Cypher. Allows exploring code structure, dependencies, and semantic relations.",
        category="knowledge",
        parameters=[
            SkillParameter("query", "string", "The Cypher query to execute"),
        ],
    ),
]


# =============================================================================
# SKILL EXECUTION HANDLERS
# =============================================================================

def _execute_search_kb(workspace: str, **kwargs) -> str:
    """Execute search_kb skill."""
    from ..tools.knowledge import search_knowledge_workspace
    return search_knowledge_workspace.invoke({
        "query": kwargs.get("query", ""),
        "workspace": workspace,
        "top_k": kwargs.get("top_k", 20),
    })


def _execute_list_documents(workspace: str, **kwargs) -> str:
    from ..tools.knowledge import list_available_documents
    return list_available_documents.invoke({"workspace": workspace})


def _execute_read_document(workspace: str, **kwargs) -> str:
    from ..tools.knowledge import read_full_document
    return read_full_document.invoke({
        "document_name": kwargs.get("document_name", ""),
        "workspace": workspace,
    })


def _execute_read_file(workspace: str, **kwargs) -> str:
    from ..tools.files import read_file
    return read_file.invoke({
        "filename": kwargs.get("filename", ""),
        "workspace": workspace,
        "subdir": kwargs.get("subdir", "data_in"),
    })


def _execute_write_file(workspace: str, **kwargs) -> str:
    from ..tools.files import write_file
    return write_file.invoke({
        "filename": kwargs.get("filename", ""),
        "content": kwargs.get("content", ""),
        "workspace": workspace,
    })


def _execute_list_files(workspace: str, **kwargs) -> str:
    from ..tools.files import list_files
    return list_files.invoke({
        "workspace": workspace,
        "subdir": kwargs.get("subdir", "data_out"),
    })


def _execute_extract_pdf(workspace: str, **kwargs) -> str:
    from ..tools.data import extract_pdf_text
    return extract_pdf_text.invoke({
        "pdf_path": kwargs.get("pdf_path", ""),
        "workspace": workspace,
    })


def _execute_query_csv(workspace: str, **kwargs) -> str:
    from ..tools.data import query_csv
    return query_csv.invoke({
        "csv_path": kwargs.get("csv_path", ""),
        "query": kwargs.get("query", ""),
        "workspace": workspace,
    })


def _execute_query_graph(workspace: str, **kwargs) -> str:
    from ..core.graph_db import run_cypher, scope_cypher_query
    
    query = kwargs.get("query", "")
    nexus_id = kwargs.get("active_nexus_id")
    
    # If a Neural Nexus is selected, deterministically scope the query
    if nexus_id and nexus_id != "neural_nexus":
        query = scope_cypher_query(query, nexus_id)
        # We also pass nexus_id as a parameter to the query for the $nexus_id placeholders
        params = {"nexus_id": nexus_id}
    else:
        params = {}
        
    results = run_cypher(
        query=query,
        params=params,
        workspace=workspace
    )
    return json.dumps(results, indent=2, default=str)


# Map skill IDs to their handler functions
SKILL_HANDLERS: Dict[str, Callable] = {
    "search_kb": _execute_search_kb,
    "list_documents": _execute_list_documents,
    "read_document": _execute_read_document,
    "read_file": _execute_read_file,
    "write_file": _execute_write_file,
    "list_files": _execute_list_files,
    "extract_pdf": _execute_extract_pdf,
    "query_csv": _execute_query_csv,
    "query_graph": _execute_query_graph,
}


# =============================================================================
# SKILL REGISTRY
# =============================================================================

class SkillRegistry:
    """Manages built-in + workspace-scoped skills."""

    def __init__(self):
        self._builtins: Dict[str, Skill] = {s.id: s for s in BUILTIN_SKILLS}

    def get_builtin_skills(self) -> List[Skill]:
        return list(self._builtins.values())

    def get_workspace_skills(self, workspace: str) -> List[Skill]:
        """Load custom skills from workspace/skills/ directory."""
        skills_dir = get_workspace_path(workspace, "skills")
        if not skills_dir.exists():
            return []

        custom_skills = []
        
        # Format 1: Standalone JSON skills
        for skill_file in skills_dir.glob("*.json"):
            try:
                data = json.loads(skill_file.read_text(encoding="utf-8"))
                params = [SkillParameter(**p) for p in data.get("parameters", [])]
                skill = Skill(
                    id=data["id"],
                    name=data["name"],
                    description=data["description"],
                    category=data.get("category", "custom"),
                    parameters=params,
                    builtin=False,
                    workspace=workspace,
                    metadata=data.get("metadata", {})
                )
                custom_skills.append(skill)
            except Exception as e:
                print(f"Warning: Could not load JSON skill {skill_file}: {e}")

        # Format 2: Agent Skills Standard (Folder based with SKILL.md)
        for skill_folder in skills_dir.iterdir():
            if not skill_folder.is_dir():
                continue
            
            skill_md = skill_folder / "SKILL.md"
            if not skill_md.exists():
                continue
                
            try:
                raw_content = skill_md.read_text(encoding="utf-8")
                
                # Extract YAML frontmatter
                fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", raw_content, re.DOTALL)
                if fm_match:
                    yaml_fm = fm_match.group(1)
                    instructions = fm_match.group(2)
                    data = yaml.safe_load(yaml_fm)
                else:
                    # Fallback: Treat whole file as instructions if no frontmatter
                    data = {"name": skill_folder.name, "description": f"Skill from {skill_folder.name}"}
                    instructions = raw_content
                
                # Align with Skill model
                skill_id = data.get("id") or data.get("name", skill_folder.name).lower().replace(" ", "-")
                params_data = data.get("parameters", [])
                params = [SkillParameter(**p) for p in params_data]
                
                skill = Skill(
                    id=skill_id,
                    name=data.get("name", skill_folder.name),
                    description=data.get("description", ""),
                    category=data.get("category", "custom"),
                    parameters=params,
                    builtin=False,
                    workspace=workspace,
                    content=instructions.strip(),
                    metadata=data.get("metadata", data) # Keep all FM data in metadata
                )
                custom_skills.append(skill)
            except Exception as e:
                print(f"Warning: Could not load Agent Skill {skill_md}: {e}")

        return custom_skills

    def get_all_skills(self, workspace: str) -> List[Skill]:
        """Get merged catalog: built-in + workspace skills."""
        all_skills = self.get_builtin_skills()
        ws_skills = self.get_workspace_skills(workspace)

        # Workspace skills can override built-ins by ID
        ws_ids = {s.id for s in ws_skills}
        merged = [s for s in all_skills if s.id not in ws_ids]
        merged.extend(ws_skills)
        return merged

    def get_skills_by_ids(self, skill_ids: List[str], workspace: str) -> List[Skill]:
        """Get specific skills by their IDs."""
        all_skills = {s.id: s for s in self.get_all_skills(workspace)}
        return [all_skills[sid] for sid in skill_ids if sid in all_skills]

    def get_skill_by_id(self, skill_id: str, workspace: str) -> Optional[Skill]:
        """Get a specific skill by its ID."""
        all_skills = {s.id: s for s in self.get_all_skills(workspace)}
        return all_skills.get(skill_id)

    def get_tool_schemas(self, skill_ids: List[str], workspace: str) -> List[dict]:
        """Get OpenAI function-calling schemas for given skill IDs."""
        skills = self.get_skills_by_ids(skill_ids, workspace)
        return [s.to_openai_tool_schema() for s in skills]

    def execute_skill(self, skill_id: str, workspace: str, agent_role: str = "executor", agent_id: str = "default", active_nexus_id: Optional[str] = None, **kwargs) -> str:
        """Execute a skill by ID with RBAC enforcement and optional Nexus scoping."""
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
        
        # Least Skills Security Check (Permission Manifest)
        violation = validate_tool_access(agent_id, skill_id, workspace)
        if violation:
            return f"❌ SECURITY_PERMISSION_VIOLATION: {violation.message}"
        
        handler = SKILL_HANDLERS.get(skill_id)
        if not handler:
            return f"❌ Unknown skill: {skill_id}"
        try:
            result = handler(workspace=workspace, active_nexus_id=active_nexus_id, **kwargs)
            
            # Context Guard: Protect against massive tool outputs
            from .context_guard import guard_tool_output
            # Note: In a real scenario, we'd pass the actual model name if available. 
            # Defaulting to 'local' thresholds if unknown.
            return guard_tool_output(result, model="fastflowlm", tool_name=skill_id)
            
        except Exception as e:
            return f"❌ Skill execution error ({skill_id}): {str(e)}"

    def get_catalog(self, workspace: str) -> Dict[str, List[dict]]:
        """Get skills grouped by category for progressive discovery."""
        all_skills = self.get_all_skills(workspace)
        catalog: Dict[str, List[dict]] = {}
        for skill in all_skills:
            cat = skill.category
            if cat not in catalog:
                catalog[cat] = []
            catalog[cat].append(skill.to_dict())
        return catalog

    def save_workspace_skill(self, workspace: str, skill_data: dict) -> dict:
        """Save a custom skill to the workspace."""
        skills_dir = get_workspace_path(workspace, "skills")
        skills_dir.mkdir(parents=True, exist_ok=True)

        skill_id = skill_data.get("id", "")
        if not skill_id:
            raise ValueError("Skill must have an 'id' field")

        file_path = skills_dir / f"{skill_id}.json"
        file_path.write_text(json.dumps(skill_data, indent=2), encoding="utf-8")
        return {"status": "saved", "id": skill_id, "path": str(file_path)}

    def delete_workspace_skill(self, workspace: str, skill_id: str) -> dict:
        """Delete a custom skill from the workspace."""
        file_path = get_workspace_path(workspace, "skills") / f"{skill_id}.json"
        if not file_path.exists():
            raise FileNotFoundError(f"Skill not found: {skill_id}")
        file_path.unlink()
        return {"status": "deleted", "id": skill_id}


# Global registry instance
registry = SkillRegistry()
