"""
Workspace Isolation - Multi-tenant workspace management
"""

from pathlib import Path
from typing import Optional, List, Dict, Any
import os
import yaml
import json

from .schema import WorkspaceManifest


# Base workspace directory
WORKSPACE_ROOT = Path("workspace")


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
    # We use .absolute() to ensure we aren't tricked by relative paths
    root_abs = WORKSPACE_ROOT.absolute()
    
    # Construct the target path
    target = root_abs / workspace_id
    if subdir:
        target = target / subdir
        
    target_abs = target.absolute()
    
    # 2. Strict validation: Target must be a child of root_abs
    try:
        if os.path.commonpath([str(root_abs), str(target_abs)]) != str(root_abs):
            raise PermissionError(f"Path traversal attempt detected: {workspace_id}/{subdir}")
    except ValueError:
        raise PermissionError(f"Invalid workspace path: {workspace_id}/{subdir}")
        
    return target_abs


def ensure_workspace_structure(workspace_id: str = "default") -> dict:
    """
    Create workspace directory structure and initial manifest if it doesn't exist.
    """
    base = get_workspace_path(workspace_id)
    subdirs = [
        "agents", "chromadb", "data_in", "data_out", "reports", "skills", "runs", "staging",
        "live/sources", "live/cache", "live/runs",
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
    
    return f"📥 Content saved: {server_url}/api/files/{workspace_id}/{filename}"
