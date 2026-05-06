"""
Global Schema - Pydantic models for workspace manifests, governance, and synthesis pipeline types.
"""

from pydantic import BaseModel, Field, field_validator
from typing import List, Dict, Any, Optional, Literal
from enum import Enum
from datetime import datetime


# =============================================================================
# KNOWLEDGE TRIPLE - Core data type for the entire synthesis pipeline
# =============================================================================

class KnowledgeTriple(BaseModel):
    """
    A single knowledge triple extracted from text by the synthesis engine.
    Used throughout the pipeline instead of raw Dict[str, Any].
    """
    subject: str
    subject_type: str = "Concept"
    predicate: str
    object: str
    object_type: str = "Concept"
    citation: str = ""
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    section_title: str = ""
    model_id: str = "unknown"
    strategy: str = "safe" # safe, aggressive
    fragment_id: Optional[str] = None  # DNA trace: MD5 of source chunk text
    # Live Mode provenance fields
    source_type: Literal["document", "live"] = "document"
    fetched_at: Optional[str] = None  # ISO-8601 timestamp set by live connectors

    @field_validator("subject", "predicate", "object")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()

    @property
    def normalized_key(self) -> str:
        """Normalized deduplication key (lowercase subject|predicate|object)."""
        return f"{self.subject.lower()}|{self.predicate.lower()}|{self.object.lower()}"


# =============================================================================
# SYNTHESIS CONFIGURATION - Replaces all hardcoded engine defaults
# =============================================================================

class SynthesisConfig(BaseModel):
    """
    Centralised configuration for the synthesis engine.
    Can be overridden per-workspace via the manifest.
    """
    # Chunking
    max_context_tokens: int = Field(default=4000, description="Max tokens per LLM context chunk (~4 chars/token)")
    min_section_chars: int = Field(default=50, description="Minimum chars for a section to be processed")

    # Parallel extraction
    parallel_limit: int = Field(default=1, description="Max concurrent LLM calls for section extraction")
    inference_delay: float = Field(default=0.5, description="Delay between calls to prevent thermal throttle")

    # Quality
    min_confidence: float = Field(default=0.3, description="Discard triples below this confidence")
    deduplicate: bool = Field(default=True, description="Remove near-duplicate triples")
    max_conflict_triples: int = Field(default=30, description="Max triples sent to conflict detection")

    # Retry
    max_retries: int = Field(default=3, description="LLM call retry attempts")
    retry_base_delay: float = Field(default=1.0, description="Base delay for exponential backoff (seconds)")

    # Embedding
    embedding_batch_size: int = Field(default=8, description="Concurrent embedding requests")


# =============================================================================
# SSE INGESTION EVENTS - Structured events for real-time progress streaming
# =============================================================================

class IngestionEventType(str, Enum):
    STARTED = "started"
    SECTION_PROGRESS = "section_progress"
    TRIPLES_EXTRACTED = "triples_extracted"
    CONFLICTS_CHECKED = "conflicts_checked"
    STORED = "stored"
    EMBEDDING_PROGRESS = "embedding_progress"
    CENTRALITY_UPDATED = "centrality_updated"
    COMPLETED = "completed"
    ERROR = "error"


class IngestionEvent(BaseModel):
    """A single SSE event emitted during ingestion."""
    event: IngestionEventType
    run_id: str = ""
    source_name: str = ""
    data: Dict[str, Any] = Field(default_factory=dict)
    message: str = ""

    def to_sse(self) -> str:
        """Format as an SSE wire-format string."""
        import json
        payload = self.model_dump()
        return f"event: {self.event.value}\ndata: {json.dumps(payload)}\n\n"


# =============================================================================
# LIVE MODE CONFIGURATION
# =============================================================================

class LiveConfig(BaseModel):
    """Per-workspace Live Mode configuration stored in manifest.yaml."""
    enabled_sources: List[str] = Field(
        default_factory=list,
        description="Source IDs to enable, e.g. ['tmdb', 'spotify', 'wikipedia']"
    )
    cache_ttl_hours: int = Field(default=24, description="Hours before cached API responses expire")
    max_entities_per_run: int = Field(default=100, description="Hard cap on entities enriched per run")
    auto_enrich_on_ingest: bool = Field(
        default=False,
        description="Automatically trigger enrichment when new files are ingested"
    )
    credential_source: Literal["env", "vault"] = Field(
        default="env",
        description="Where to read API keys: 'env' (env vars) or 'vault' (credential store)"
    )


class SourceManifestExample(BaseModel):
    """One enrichment example embedded in a source manifest."""
    entity_name: str
    entity_type: str
    expected_triples: List[List[str]] = Field(
        default_factory=list,
        description="List of [subject, predicate, object] triples expected from this entity"
    )


class SourceManifest(BaseModel):
    """
    Per-source configuration manifest loaded from workspace/live/sources/<id>.yaml.
    Drives connector behaviour and documents expected output for testing.
    """
    source_id: str
    name: str
    version: str = "v1"
    base_url: str
    entity_types: List[str] = Field(default_factory=lambda: ["any"])
    auth: Dict[str, Any] = Field(default_factory=dict)
    rate_limit: Dict[str, Any] = Field(default_factory=dict)
    confidence_default: float = Field(default=0.80, ge=0.0, le=1.0)
    enabled: bool = True
    examples: List[SourceManifestExample] = Field(default_factory=list)


# =============================================================================
# WORKSPACE MANIFEST
# =============================================================================

class WorkspaceManifest(BaseModel):
    """
    Workspace configuration manifest (manifest.yaml).
    
    This is the "Decentralized Manifest" that teams own in their workspace repo.
    """
    version: str = Field(default="1.0.0", description="Schema version for governance and migrations")
    llm_timeout: float = Field(default=300.0, description="LLM call timeout in seconds")
    default_model: Optional[str] = Field(None, description="Primary model for this workspace")
    model_roles: Dict[str, str] = Field(default_factory=dict, description="Task-specific model assignments (chat, swarm, tts, stt, graph_synthesis)")
    embedding_provider: str = Field(default="local", description="Provider for vector embeddings")
    governance_tags: List[str] = Field(default_factory=list, description="Audit and compliance tags")
    exclude_patterns: List[str] = Field(default_factory=lambda: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.venv/**"], description="Glob patterns for graph exclusion")
    deep_scan: bool = Field(default=True, description="Whether to perform deep symbol analysis")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary extension fields")

    # Synthesis engine overrides
    synthesis: SynthesisConfig = Field(default_factory=SynthesisConfig, description="Synthesis engine config")

    # Live Mode
    live_mode: bool = Field(default=False, description="Enable external data enrichment")
    live_config: LiveConfig = Field(default_factory=LiveConfig, description="Live mode connector settings")

    class Config:
        json_schema_extra = {
            "example": {
                "version": "1.0.0",
                "llm_timeout": 600.0,
                "default_model": "gemma-4-26b-a4b",
                "governance_tags": ["high_compliance", "sensitive_data"],
                "metadata": {"owner": "AI Platform Team"},
                "synthesis": {"max_context_tokens": 2000, "min_confidence": 0.5}
            }
        }


# =============================================================================
# AGENT GOVERNANCE
# =============================================================================

class AgentManifest(BaseModel):
    """Formalized class blueprint for an agent node."""
    name: str
    persona: str
    tools_allowed: List[str] = Field(default_factory=list)
    memory_collections: List[str] = Field(default_factory=list)
    token_budget: int = 0
    access_scope: str = "workspace"


# =============================================================================
# TASK MANAGEMENT
# =============================================================================

class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


class Task(BaseModel):
    """Audit record for a long-running process."""
    task_id: str
    workspace: str
    type: str  # indexing, synthesis, etl, workflow
    status: TaskStatus = TaskStatus.QUEUED
    progress: int = 0  # 0-100
    total_steps: int = 0
    current_step: int = 0
    message: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Custom task metrics and stage info")
    aer_log: List[Dict[str, Any]] = Field(default_factory=list, description="Agent Execution Record narrative")
    event_log: List[Dict[str, Any]] = Field(default_factory=list, description="Historical record of SSE events for this run")
    topology: Optional[Dict[str, Any]] = Field(default=None, description="Graph nodes and edges for 3D visualization")
    lineage_run_id: Optional[str] = None

    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
