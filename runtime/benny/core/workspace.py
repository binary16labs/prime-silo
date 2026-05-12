"""
Workspace Isolation - Multi-tenant workspace management
"""

from pathlib import Path
from typing import Optional, List, Dict, Any
import os
import yaml
import json

from .schema import WorkspaceManifest


# Resolve workspace root: prefer $BENNY_HOME/workspaces when the env var is set
# (i.e. when the API was launched via `benny up`); fall back to a relative
# "workspace" dir for plain dev-server runs from the project root.
_benny_home = os.environ.get("BENNY_HOME")
WORKSPACE_ROOT = Path(_benny_home) / "workspaces" if _benny_home else Path("workspace")


def get_workspace_path(workspace_id: str = "default", subdir: str = "") -> Path:
    """
    Get workspace-scoped path for multi-tenant isolation.
    Strictly validates that the path is within WORKSPACE_ROOT to prevent traversal.
    
    Args:
        workspace_id: Workspace identifier
        subdir: Subdirectory within workspace (data_in, data_out, chromadb, etc.)
        
    Returns:
        Absolute path to the workspace directory or subdirectory
    """
    # 1. Resolve potential traversal before joining
    # We use .resolve() to satisfy traversal checks
    root_abs = WORKSPACE_ROOT.resolve()
    
    # Construct the target path
    target = root_abs / str(workspace_id)
    if subdir:
        target = target / str(subdir)
        
    target_abs = target.resolve()
    
    # 2. Strict validation: Target must be a child of root_abs
    try:
        common = os.path.commonpath([str(root_abs), str(target_abs)])
        if common != str(root_abs):
            raise PermissionError(f"Path traversal attempt detected: {workspace_id}/{subdir}")
    except ValueError:
        raise PermissionError(f"Invalid workspace path: {workspace_id}/{subdir}")
        
    return target_abs


# =============================================================================
# Agent Sandbox (ADR-001) — restricted write surface for agent-authored content
# =============================================================================
#
# The agent has full *read* access across the workspace, but its *writes* are
# confined to ``agent_sandbox/`` and its four declared subdirectories. Every
# write is gated by ``benny.api.agent_scope.agent_scope_guard`` middleware and
# lineage-emitted as a ``process=agent_authorship`` triple lineage event.
#
# Promotion to the deterministic side follows:
#     drafts/<file>  →  HITL review  →  sign_manifest()  →  manifests/  →  run

AGENT_SANDBOX_DIR = "agent_sandbox"
AGENT_SANDBOX_SUBDIRS = ("views", "notes", "drafts", "skills")


def get_agent_sandbox_path(workspace_id: str = "default", subdir: str = "") -> Path:
    """Return the absolute path to the workspace's agent sandbox or a subdir.

    ``subdir`` must be one of :data:`AGENT_SANDBOX_SUBDIRS` when provided.
    Path traversal attempts raise ``PermissionError`` via
    :func:`get_workspace_path`'s strict validation.
    """
    if subdir and subdir not in AGENT_SANDBOX_SUBDIRS:
        raise ValueError(
            f"Unknown agent_sandbox subdir {subdir!r}; "
            f"expected one of {AGENT_SANDBOX_SUBDIRS}"
        )
    relative = AGENT_SANDBOX_DIR
    if subdir:
        relative = f"{AGENT_SANDBOX_DIR}/{subdir}"
    return get_workspace_path(workspace_id, relative)


PINNED_VIEWS_DIR = "views"

# =============================================================================
# Session Checkpoints (ADR-001 Phase H) — draft + pinned paths
# =============================================================================
#
# Draft checkpoints live inside the agent sandbox:
#     ``$BENNY_HOME/workspaces/<ws>/agent_sandbox/checkpoints/``
# Pinned (HMAC-signed) checkpoints live outside the sandbox at:
#     ``$BENNY_HOME/workspaces/<ws>/checkpoints/``
#
# The split mirrors draft views (``agent_sandbox/views/``) vs pinned views
# (``views/``) introduced in Phase D3 / F2.

CHECKPOINT_DRAFT_SUBDIR = "checkpoints"
CHECKPOINT_PINNED_DIR = "checkpoints"


def get_checkpoint_draft_dir(workspace_id: str = "default") -> Path:
    """Return the absolute path to the workspace's *draft* checkpoints directory.

    Draft checkpoints live inside ``agent_sandbox/checkpoints/``. The agent has
    write access here (via ``AgentScopeMiddleware``). Pinning moves a checkpoint
    to the canonical location outside the sandbox.
    """
    return get_agent_sandbox_path(workspace_id) / CHECKPOINT_DRAFT_SUBDIR


def get_checkpoint_pinned_dir(workspace_id: str = "default") -> Path:
    """Return the absolute path to the workspace's *pinned* checkpoints directory.

    Pinned checkpoints live at ``$BENNY_HOME/workspaces/<ws>/checkpoints/``
    (outside the agent sandbox). ``AgentScopeMiddleware`` 403s every
    agent-scoped POST to ``/api/checkpoints/pin`` — pinning is human-only.
    """
    return get_workspace_path(workspace_id, CHECKPOINT_PINNED_DIR)


def get_pinned_views_path(workspace_id: str = "default") -> Path:
    """Return the absolute path to the workspace's *pinned* views directory.

    ADR-001 Phase F2: pinned views live OUTSIDE the agent sandbox at
    ``$BENNY_HOME/workspaces/<ws>/views/``. The agent cannot reach them —
    `AgentScopeMiddleware` 403s every agent-scoped POST that does not target
    `/api/agent_sandbox/*`. Pinning is a human-only promotion: the human
    reviews an agent draft from `agent_sandbox/views/`, the runtime signs
    it, embeds the signature, and writes it here for replayable use.
    """
    return get_workspace_path(workspace_id, PINNED_VIEWS_DIR)


def is_within_agent_sandbox(workspace_id: str, candidate: Path | str) -> bool:
    """Return True iff *candidate* resolves to a path inside the workspace's
    agent sandbox. Used by :mod:`benny.api.agent_scope` to authorise writes
    from callers carrying ``X-Benny-Agent-Scope: sandbox``.
    """
    try:
        sandbox = get_agent_sandbox_path(workspace_id).resolve()
    except PermissionError:
        return False
    try:
        candidate_abs = Path(candidate).resolve()
    except (OSError, ValueError):
        return False
    try:
        common = os.path.commonpath([str(sandbox), str(candidate_abs)])
    except ValueError:
        # Different drives on Windows, etc.
        return False
    return common == str(sandbox)


def ensure_workspace_structure(workspace_id: str = "default") -> dict:
    """
    Create workspace directory structure and initial manifest if it doesn't exist.
    """
    base = get_workspace_path(workspace_id)
    subdirs = [
        "agents", "chromadb", "data_in", "data_out", "reports", "skills", "runs", "staging",
        "live/sources", "live/cache", "live/runs",
        # ADR-001: agent sandbox — restricted agent-write surface
        f"{AGENT_SANDBOX_DIR}/views",
        f"{AGENT_SANDBOX_DIR}/notes",
        f"{AGENT_SANDBOX_DIR}/drafts",
        f"{AGENT_SANDBOX_DIR}/skills",
        # Phase H: session checkpoints (draft inside sandbox, pinned outside)
        f"{AGENT_SANDBOX_DIR}/checkpoints",
    ]
    
    created = []
    for subdir in subdirs:
        path = base / subdir
        if not path.exists():
            path.mkdir(parents=True, exist_ok=True)
            created.append(subdir)
    
    # Initialize manifest if missing
    manifest_path = base / "manifest.yaml"
    if not manifest_path.exists():
        manifest = WorkspaceManifest(version="1.0.0")
        with open(manifest_path, "w", encoding="utf-8") as f:
            yaml.dump(manifest.dict(), f, sort_keys=False)
        created.append("manifest.yaml")
    
    # Create default Operating Manuals if they don't exist
    _create_default_manual(base / "SOUL.md", """# Name
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

    _create_default_manual(base / "USER.md", """# Organization
[Your Organization Name]

# Authorized Personnel
- [Admin Name] (Admin)

# Domain Context
[Describe your business domain and subject matter]

# Compliance Requirements
- All outputs must be auditable via governance logs
- PII must be handled per applicable regulations
""")

    _create_default_manual(base / "AGENTS.md", """# Coding Standards
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

    # Seed default Live Mode source manifests (only if they don't exist)
    _seed_live_source_manifests(base / "live" / "sources")

    # Create security subdirectories
    for sec_dir in ["policies", "agents", "credentials"]:
        path = base / sec_dir
        if not path.exists():
            path.mkdir(parents=True, exist_ok=True)
            created.append(sec_dir)

    return {
        "status": "ready",
        "workspace_id": workspace_id,
        "path": str(base.absolute()),
        "created_dirs": [d for d in created if d != "manifest.yaml"],
        "manifest_created": "manifest.yaml" in created,
        "isolation": "scoped_directory_structure"
    }


def _create_default_manual(path: Path, content: str) -> None:
    """Create a default manual file if it doesn't exist."""
    if not path.exists():
        try:
            path.write_text(content.strip(), encoding="utf-8")
        except Exception as e:
            # We don't want task saving to crash the main process
            import logging
            logging.error(f"TaskManager persistence failed for {path}: {e}")


_DEFAULT_SOURCE_MANIFESTS = {
    "tmdb.yaml": """\
source_id: tmdb
name: "The Movie Database"
version: "3"
base_url: "https://api.themoviedb.org/3"
entity_types: [movie, tv_show, person]
auth:
  type: api_key
  env_var: TMDB_API_KEY
rate_limit:
  requests_per_second: 40
confidence_default: 0.95
enabled: true
examples:
  - entity_name: "Inception"
    entity_type: movie
    expected_triples:
      - [Inception, directed_by, "Christopher Nolan"]
      - [Inception, released_on, "2010-07-16"]
      - [Inception, has_genre, "Science Fiction"]
      - [Inception, has_runtime_minutes, "148"]
  - entity_name: "Breaking Bad"
    entity_type: tv_show
    expected_triples:
      - [Breaking Bad, created_by, "Vince Gilligan"]
      - [Breaking Bad, first_aired_on, "2008-01-20"]
      - [Breaking Bad, has_genre, Drama]
""",
    "spotify.yaml": """\
source_id: spotify
name: "Spotify Web API"
version: "v1"
base_url: "https://api.spotify.com/v1"
entity_types: [track, artist, album]
auth:
  type: oauth2_client_credentials
  env_var_client_id: SPOTIFY_CLIENT_ID
  env_var_client_secret: SPOTIFY_CLIENT_SECRET
  token_url: "https://accounts.spotify.com/api/token"
rate_limit:
  requests_per_second: 10
confidence_default: 0.92
enabled: true
examples:
  - entity_name: "Bohemian Rhapsody"
    entity_type: track
    expected_triples:
      - [Bohemian Rhapsody, performed_by, Queen]
      - [Bohemian Rhapsody, released_on, "1975-10-31"]
      - [Bohemian Rhapsody, belongs_to_album, "A Night at the Opera"]
  - entity_name: "Queen"
    entity_type: artist
    expected_triples:
      - [Queen, has_genre, Rock]
      - [Queen, origin_country, "United Kingdom"]
""",
    "wikipedia.yaml": """\
source_id: wikipedia
name: "Wikipedia REST API"
version: "v1"
base_url: "https://en.wikipedia.org/api/rest_v1"
entity_types: [any]
auth:
  type: none
rate_limit:
  requests_per_second: 5
confidence_default: 0.78
enabled: true
examples:
  - entity_name: "Dune (novel)"
    entity_type: any
    expected_triples:
      - ["Dune (novel)", written_by, "Frank Herbert"]
      - ["Dune (novel)", published_on, "1965-08-01"]
      - ["Dune (novel)", has_genre, "Science Fiction"]
  - entity_name: "Python (programming language)"
    entity_type: any
    expected_triples:
      - ["Python (programming language)", created_by, "Guido van Rossum"]
      - ["Python (programming language)", first_appeared_on, "1991-02-20"]
""",
    "wikidata.yaml": """\
source_id: wikidata
name: "Wikidata SPARQL"
version: "v1"
base_url: "https://query.wikidata.org/sparql"
entity_types: [any]
auth:
  type: none
rate_limit:
  requests_per_second: 2
confidence_default: 0.88
enabled: true
examples:
  - entity_name: "The Godfather"
    entity_type: movie
    expected_triples:
      - ["The Godfather", directed_by, "Francis Ford Coppola"]
      - ["The Godfather", released_on, "1972-03-24"]
      - ["The Godfather", has_imdb_id, tt0068646]
  - entity_name: "David Bowie"
    entity_type: person
    expected_triples:
      - ["David Bowie", born_on, "1947-01-08"]
      - ["David Bowie", has_genre, "Glam Rock"]
      - ["David Bowie", citizen_of, "United Kingdom"]
""",
    "google_cse.yaml": """\
source_id: google_cse
name: "Google Custom Search Engine"
version: "v1"
base_url: "https://www.googleapis.com/customsearch/v1"
entity_types: [any]
auth:
  type: api_key
  env_var: GOOGLE_CSE_API_KEY
  cx_env_var: GOOGLE_CSE_CX
rate_limit:
  requests_per_day: 100
confidence_default: 0.60
enabled: false
examples:
  - entity_name: "Pulp Fiction"
    entity_type: movie
    expected_triples:
      - ["Pulp Fiction", directed_by, "Quentin Tarantino"]
      - ["Pulp Fiction", released_on, "1994-10-14"]
""",
    "youtube.yaml": """\
source_id: youtube
name: "YouTube Data API v3"
version: "v3"
base_url: "https://www.googleapis.com/youtube/v3"
entity_types: [video, music_video, channel, playlist]
auth:
  type: api_key
  env_var: YOUTUBE_API_KEY
rate_limit:
  quota_units_per_day: 10000
  search_cost_units: 100
  videos_cost_units: 1
confidence_default: 0.88
enabled: true
examples:
  - entity_name: "Bohemian Rhapsody Official Video"
    entity_type: music_video
    expected_triples:
      - ["Bohemian Rhapsody Official Video", uploaded_by, "Queen Official"]
      - ["Bohemian Rhapsody Official Video", has_view_count, "1800000000"]
      - ["Bohemian Rhapsody Official Video", has_duration_seconds, "354"]
      - ["Bohemian Rhapsody Official Video", belongs_to_topic, "Rock music"]
  - entity_name: "Queen Official"
    entity_type: channel
    expected_triples:
      - ["Queen Official", has_subscriber_count, "20000000"]
      - ["Queen Official", has_country, GB]
""",
    "duckduckgo.yaml": """\
source_id: duckduckgo
name: "DuckDuckGo Instant Answer API"
version: "v1"
base_url: "https://api.duckduckgo.com"
entity_types: [any]
auth:
  type: none
rate_limit:
  requests_per_second: 2
confidence_default: 0.55
enabled: true
examples:
  - entity_name: "Interstellar"
    entity_type: movie
    expected_triples:
      - [Interstellar, directed_by, "Christopher Nolan"]
      - [Interstellar, released_on, "2014-11-07"]
  - entity_name: "Taylor Swift"
    entity_type: artist
    expected_triples:
      - ["Taylor Swift", has_genre, "Country Pop"]
      - ["Taylor Swift", born_on, "1989-12-13"]
""",
}


def _seed_live_source_manifests(sources_dir: Path) -> None:
    """Write default source manifests if they don't already exist."""
    sources_dir.mkdir(parents=True, exist_ok=True)
    for filename, content in _DEFAULT_SOURCE_MANIFESTS.items():
        dest = sources_dir / filename
        if not dest.exists():
            try:
                dest.write_text(content, encoding="utf-8")
            except Exception as e:
                import logging
                logging.warning(f"Could not seed live source manifest {filename}: {e}")


def load_manifest(workspace_id: str) -> WorkspaceManifest:
    """Load and validate the workspace manifest (YAML)."""
    path = get_workspace_path(workspace_id) / "manifest.yaml"
    if not path.exists():
        return WorkspaceManifest(version="1.0.0")
    
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not data:
            return WorkspaceManifest(version="1.0.0")
        return WorkspaceManifest(**data)
    except Exception as e:
        print(f"[WARNING] Error loading manifest for {workspace_id}: {e}")
        return WorkspaceManifest(version="1.0.0")


def save_manifest(workspace_id: str, manifest: WorkspaceManifest) -> None:
    """Save the workspace manifest to YAML."""
    path = get_workspace_path(workspace_id) / "manifest.yaml"
    with open(path, "w", encoding="utf-8") as f:
        # Use model_dump for Pydantic v2 if manifest is a model
        data = manifest.model_dump() if hasattr(manifest, "model_dump") else manifest.dict()
        yaml.dump(data, f, sort_keys=False)


def update_manifest(workspace_id: str, updates: Dict[str, Any]) -> WorkspaceManifest:
    """Update specific fields in the manifest and save it."""
    manifest = load_manifest(workspace_id)
    for key, value in updates.items():
        if hasattr(manifest, key):
            setattr(manifest, key, value)
    save_manifest(workspace_id, manifest)
    return manifest


def list_workspaces() -> List[dict]:
    """
    List all workspaces and act as a Discovery Catalog crawler.
    Enriches the results with manifest metadata for centralized observability.
    """
    if not WORKSPACE_ROOT.exists():
        WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
        return []
    
    workspaces = []
    for item in WORKSPACE_ROOT.iterdir():
        if item.is_dir():
            manifest = load_manifest(item.name)
            workspaces.append({
                "id": item.name,
                "path": str(item.absolute()),
                "has_chromadb": (item / "chromadb").exists(),
                "has_data": (item / "data_in").exists() and any((item / "data_in").iterdir()) if (item / "data_in").exists() else False,
                "manifest": manifest.dict()  # Enriched discovery metadata
            })
    
    return workspaces



def delete_workspace(workspace_id: str) -> dict:
    """
    Delete a workspace directory and its associated database records.
    
    Args:
        workspace_id: ID of the workspace to delete
        
    Returns:
        Status dictionary
    """
    if workspace_id == "default":
        raise PermissionError("The default workspace cannot be deleted.")
        
    # 1. Clean up Neo4j
    from .graph_db import delete_workspace_data
    try:
        delete_workspace_data(workspace_id)
    except Exception as e:
        import logging
        logging.error(f"Failed to clean up Neo4j data for workspace {workspace_id}: {e}")
        
    # 2. Delete the directory structure
    import shutil
    path = get_workspace_path(workspace_id)
    if path.exists():
        shutil.rmtree(path)
        
    return {"status": "deleted", "workspace_id": workspace_id}



def get_workspace_files(workspace_id: str, subdir: str = "data_out") -> List[dict]:
    """
    List files in a workspace subdirectory.
    
    Args:
        workspace_id: Workspace identifier
        subdir: Subdirectory to list (default: data_out)
        
    Returns:
        List of file info dicts
    """
    try:
        path = get_workspace_path(workspace_id, subdir)
        if not path.exists():
            return []
        
        files = []
        try:
            for item in path.iterdir():
                if item.is_file():
                    try:
                        files.append({
                            "name": item.name,
                            "path": str(item.relative_to(WORKSPACE_ROOT.absolute())),
                            "size": item.stat().st_size,
                            "modified": item.stat().st_mtime
                        })
                    except Exception:
                        continue # Skip problematic files
        except Exception:
            return []
        
        return files
    except Exception as e:
        import logging
        logging.error(f"Error listing files for {workspace_id}/{subdir}: {e}")
        return []


# Pass-by-reference threshold (5KB)
PASS_BY_REFERENCE_THRESHOLD = 5 * 1024


def smart_output(
    content: str, 
    filename: str, 
    workspace_id: str = "default",
    server_url: str = "http://localhost:8005"
) -> str:
    """
    Return content directly if small, otherwise save and return URL reference.
    
    Reduces token costs by 60-80% for large outputs.
    
    Args:
        content: Content to output
        filename: Filename if saved
        workspace_id: Target workspace
        server_url: Base URL for download links
        
    Returns:
        Content if small, or download URL if large
    """
    # Ensure we strip BOM to avoid confusion in MIME detection downstream
    content = content.lstrip('\ufeff')
    
    if len(content.encode('utf-8', errors='replace')) < PASS_BY_REFERENCE_THRESHOLD:
        return content
    
    # Save to file and return reference
    path = get_workspace_path(workspace_id, f"data_out/{filename}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    
    return f"[SAVED] Content saved: {server_url}/api/files/{workspace_id}/{filename}"
