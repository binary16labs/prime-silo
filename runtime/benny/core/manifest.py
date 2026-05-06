"""
SwarmManifest - Unified declarative contract for plan-then-run workflows.

A single JSON document that:
  1. Captures what the planner produced (requirement, plan, DAG, config)
  2. Is copy-pasteable and shareable
  3. Drives the CLI (`benny run manifest.json`)
  4. Drives the UI canvas (nodes/edges come from this)
  5. Anchors run history (runs[] reference this manifest by id)

Design principle: one source of truth. Today `WorkflowRequest`,
`SwarmState.plan`, and the studio node/edge shape are three different
things. `SwarmManifest` subsumes them.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

MANIFEST_SCHEMA_VERSION = "1.0"
# AOS-001 Phase 0: additive v1.1 extension — all new fields optional for back-compat
AOS_SCHEMA_VERSION = "1.1"


class OutputFormat(str, Enum):
    MARKDOWN = "md"
    DOCX = "docx"
    PDF = "pdf"
    HTML = "html"
    CODE = "code"
    JSON = "json"
    TEXT = "txt"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class RunStatus(str, Enum):
    PENDING = "pending"
    PLANNING = "planning"
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL_SUCCESS = "partial_success"
    FAILED = "failed"
    CANCELLED = "cancelled"


# =============================================================================
# MANIFEST COMPONENTS
# =============================================================================


class OutputSpec(BaseModel):
    """What the workflow should produce."""

    files: List[str] = Field(default_factory=list)
    format: OutputFormat = OutputFormat.MARKDOWN
    word_count_target: Optional[int] = Field(
        default=None,
        description="Target word count for long-form outputs. Drives swarm fan-out.",
    )
    sections: List[str] = Field(
        default_factory=list, description="Optional section outline for structured outputs"
    )
    spec: str = Field(default="", description="Free-form specification / acceptance criteria")


class InputSpec(BaseModel):
    files: List[str] = Field(default_factory=list)
    context: Dict[str, Any] = Field(default_factory=dict)


class ManifestConfig(BaseModel):
    """Execution-time configuration."""

    model: str = Field(default="")
    max_concurrency: int = Field(default=1)
    max_depth: int = Field(default=3)
    handover_summary_limit: int = Field(default=500)
    allow_swarm: bool = Field(
        default=True,
        description="If False, planner emits a linear sequence only (no fan-out).",
    )
    skills_allowed: List[str] = Field(default_factory=list)
    # AOS-001 OQ-1: per-persona model overrides.  Resolution order:
    #   task.assigned_model → model_per_persona[persona] → model → registry default
    model_per_persona: Dict[str, str] = Field(default_factory=dict)


class ManifestTask(BaseModel):
    """A single node in the workflow DAG.

    Subsumes `TaskItem` (runtime) and studio `NodeDefinition` (canvas).
    """

    id: str
    description: str = ""
    skill_hint: Optional[str] = None
    assigned_skills: List[str] = Field(default_factory=list)
    assigned_model: Optional[str] = None
    dependencies: List[str] = Field(default_factory=list)
    wave: int = 0
    depth: int = 0
    parent_id: Optional[str] = None
    is_pillar: bool = False
    is_expanded: bool = False
    deterministic: bool = False            # When True, executor runs skill_hint directly — no LLM
    skill_args: Dict[str, Any] = Field(default_factory=dict)  # Args forwarded to the skill
    complexity: Literal["low", "medium", "high"] = "medium"
    files_touched: List[str] = Field(default_factory=list)
    estimated_tokens: Optional[int] = None
    status: TaskStatus = TaskStatus.PENDING

    # UI hint; optional, auto-laid out if absent
    position: Optional[Dict[str, float]] = None
    node_type: str = Field(
        default="task",
        description="Canvas hint: task | planner | orchestrator | aggregator | input | output",
    )


class ManifestEdge(BaseModel):
    """Dependency edge between tasks (also used for canvas rendering)."""

    id: Optional[str] = None
    source: str
    target: str
    label: Optional[str] = None
    animated: bool = True

    @model_validator(mode="before")
    @classmethod
    def from_list(cls, data: Any) -> Any:
        if isinstance(data, list) and len(data) >= 2:
            return {"source": data[0], "target": data[1]}
        return data


class ManifestPlan(BaseModel):
    tasks: List[ManifestTask] = Field(default_factory=list)
    edges: List[ManifestEdge] = Field(default_factory=list)
    waves: List[List[str]] = Field(
        default_factory=list, description="Computed: [[task_ids in wave 0], ...]"
    )
    ascii_dag: Optional[str] = None
    # AOS-001 Phase 3: Mermaid diagram populated by benny.sdlc.diagrams.populate_mermaid
    mermaid: Optional[str] = None


# =============================================================================
# RUN RECORD
# =============================================================================


class RunRecord(BaseModel):
    """One execution of a manifest. Stored persistently for history/audit."""

    run_id: str
    manifest_id: str
    workspace: str = "default"
    status: RunStatus = RunStatus.PENDING
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None

    # Outputs
    final_document: Optional[str] = None
    artifact_paths: List[str] = Field(default_factory=list)

    # Per-task status overlay — maps task_id → status
    node_states: Dict[str, TaskStatus] = Field(default_factory=dict)

    # Observability
    governance_url: Optional[str] = None
    errors: List[str] = Field(default_factory=list)
    trace_id: Optional[str] = None

    # Config snapshot (in case the manifest changes later)
    manifest_snapshot: Optional[Dict[str, Any]] = None

    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


# =============================================================================
# MANIFEST
# =============================================================================


class SwarmManifest(BaseModel):
    """The single declarative contract.

    A manifest is a complete description of a workflow: the requirement, the
    plan (DAG), the execution config, and the run history. It is enough to
    reproduce the workflow from scratch via `benny run manifest.json`.
    """

    schema_version: str = Field(default=MANIFEST_SCHEMA_VERSION)
    id: str
    name: str
    description: str = ""

    # The requirement that was decomposed into the plan.
    requirement: str = ""
    workspace: str = "default"

    inputs: InputSpec = Field(default_factory=InputSpec)
    outputs: OutputSpec = Field(default_factory=OutputSpec)
    plan: ManifestPlan = Field(default_factory=ManifestPlan)
    config: ManifestConfig = Field(default_factory=ManifestConfig)

    # Authoring metadata
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    created_by: str = "benny-planner"
    tags: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    # Runs are stored separately but referenced here for convenience
    latest_run: Optional[RunRecord] = None

    # AOS-001 v1.1 extension fields — all Optional so v1.0 payloads still parse.
    # Values are stored as plain dicts; use benny.sdlc.contracts for typed access.
    sdlc: Optional[Dict[str, Any]] = None    # SdlcConfig
    policy: Optional[Dict[str, Any]] = None  # PolicyConfig
    memory: Optional[Dict[str, Any]] = None  # MemoryConfig

    # Reproducibility contract (PBR-001 Phase 2).
    # `content_hash` is SHA-256 of the canonical JSON (sorted keys, volatile
    # fields removed). `signature` is either `sha256:<hex>` or
    # `hmac-sha256:<hex>`, see `benny.core.manifest_hash`.
    content_hash: Optional[str] = None
    signature: Optional[str] = None

    def touch(self) -> None:
        self.updated_at = datetime.utcnow().isoformat()


# =============================================================================
# CONVERSIONS — bridge to existing shapes so we don't break anything.
# =============================================================================


def manifest_from_swarm_state(state: Dict[str, Any]) -> SwarmManifest:
    """Convert an in-flight `SwarmState` (TypedDict) to a manifest snapshot.

    Used after planning so the manifest can be handed to the UI/CLI.
    """
    plan_items = state.get("plan", []) or []
    dep_graph: Dict[str, List[str]] = state.get("dependency_graph", {}) or {}
    waves: List[List[str]] = state.get("waves", []) or []

    tasks: List[ManifestTask] = []
    for t in plan_items:
        tasks.append(
            ManifestTask(
                id=t.get("task_id", ""),
                description=t.get("description", ""),
                skill_hint=t.get("skill_hint"),
                assigned_skills=list(t.get("assigned_skills", []) or []),
                assigned_model=t.get("assigned_model"),
                dependencies=list(t.get("dependencies", []) or []),
                wave=int(t.get("wave", 0) or 0),
                depth=int(t.get("depth", 0) or 0),
                parent_id=t.get("parent_id"),
                is_pillar=bool(t.get("is_pillar", False)),
                is_expanded=bool(t.get("is_expanded", False)),
                complexity=t.get("complexity", "medium") or "medium",
                files_touched=list(t.get("files_touched", []) or []),
                estimated_tokens=t.get("estimated_tokens"),
                status=TaskStatus(t.get("status", "pending")) if t.get("status") in [s.value for s in TaskStatus] else TaskStatus.PENDING,
            )
        )

    edges: List[ManifestEdge] = []
    for target, sources in dep_graph.items():
        for src in sources or []:
            edges.append(ManifestEdge(id=f"e_{src}_{target}", source=src, target=target))

    manifest_id = state.get("manifest_id") or state.get("execution_id") or "manifest"
    cfg = ManifestConfig(
        model=state.get("model", "ollama/llama3.2"),
        max_concurrency=int(state.get("max_concurrency", 1) or 1),
        max_depth=int(state.get("max_depth", 3) or 3),
        handover_summary_limit=int(state.get("handover_summary_limit", 500) or 500),
    )

    return SwarmManifest(
        id=manifest_id,
        name=state.get("config", {}).get("name", f"Plan {manifest_id[:8]}"),
        description=state.get("config", {}).get("description", ""),
        requirement=state.get("original_request", ""),
        workspace=state.get("workspace", "default"),
        inputs=InputSpec(files=list(state.get("input_files", []) or [])),
        outputs=OutputSpec(files=list(state.get("output_files", []) or [])),
        plan=ManifestPlan(
            tasks=tasks,
            edges=edges,
            waves=[list(w) for w in waves],
            ascii_dag=state.get("ascii_dag"),
        ),
        config=cfg,
    )


def swarm_state_seed_from_manifest(
    manifest: SwarmManifest, execution_id: str
) -> Dict[str, Any]:
    """Build an initial `SwarmState` kwargs dict from a manifest.

    Callers can pass this to `create_swarm_state(...)` to execute the manifest
    as-is (i.e. without re-planning).
    """
    plan_items = []
    for t in manifest.plan.tasks:
        plan_items.append(
            {
                "task_id": t.id,
                "description": t.description,
                "status": t.status.value,
                "skill_hint": t.skill_hint,
                "assigned_skills": list(t.assigned_skills),
                "parent_id": t.parent_id,
                "depth": t.depth,
                "wave": t.wave,
                "dependencies": list(t.dependencies),
                "assigned_model": t.assigned_model,
                "files_touched": list(t.files_touched),
                "estimated_tokens": t.estimated_tokens,
                "complexity": t.complexity,
                "is_pillar": t.is_pillar,
                "is_expanded": t.is_expanded,
                "deterministic": t.deterministic,
                "skill_args": dict(t.skill_args) if t.skill_args else {},
            }
        )

    dep_graph: Dict[str, List[str]] = {t.id: list(t.dependencies) for t in manifest.plan.tasks}

    return {
        "execution_id": execution_id,
        "workspace": manifest.workspace,
        "original_request": manifest.requirement,
        "model": manifest.config.model,
        "max_concurrency": manifest.config.max_concurrency,
        "max_depth": manifest.config.max_depth,
        "handover_summary_limit": manifest.config.handover_summary_limit,
        "input_files": list(manifest.inputs.files),
        "output_files": list(manifest.outputs.files),
        "config": manifest.metadata,
        "plan": plan_items,
        "dependency_graph": dep_graph,
        "waves": [list(w) for w in manifest.plan.waves],
        "manifest_id": manifest.id,
    }


# =============================================================================
# HEURISTICS — "should this be a swarm?"
# =============================================================================


_LONG_FORM_KEYWORDS = (
    "report",
    "book",
    "thesis",
    "whitepaper",
    "deep dive",
    "comprehensive",
    "dossier",
    "codebase",
    "refactor",
    "migration plan",
    "rfc",
    "spec",
    "analysis",
    "audit",
)


def should_trigger_swarm(
    message: str,
    input_files: Optional[List[str]] = None,
    output_spec: Optional[OutputSpec] = None,
) -> tuple[bool, str]:
    """Simple heuristic: does this request warrant fan-out planning?

    Returns (trigger, reason). Intentionally conservative — false negatives are
    cheap (single-shot chat works), false positives are expensive (user pays
    swarm latency for a one-liner).
    """
    msg = (message or "").lower()
    n_files = len(input_files or [])
    target_words = output_spec.word_count_target if output_spec else None

    if target_words and target_words >= 1500:
        return True, f"output word_count_target={target_words} exceeds single-pass threshold"

    if n_files >= 3:
        return True, f"{n_files} input files — cross-document synthesis warrants fan-out"

    if len(msg) > 1200:
        return True, "long requirement text — likely multi-part request"

    hits = [kw for kw in _LONG_FORM_KEYWORDS if kw in msg]
    if len(hits) >= 2:
        return True, f"long-form keywords detected: {hits[:3]}"

    return False, "single-shot chat is fine"


__all__ = [
    "MANIFEST_SCHEMA_VERSION",
    "OutputFormat",
    "TaskStatus",
    "RunStatus",
    "OutputSpec",
    "InputSpec",
    "ManifestConfig",
    "ManifestTask",
    "ManifestEdge",
    "ManifestPlan",
    "RunRecord",
    "SwarmManifest",
    "manifest_from_swarm_state",
    "swarm_state_seed_from_manifest",
    "should_trigger_swarm",
]
