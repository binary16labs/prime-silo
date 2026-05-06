"""Pydantic contract models for the Pypes transformation engine.

This module is the single source of truth for what a Pypes manifest
*is*. Every CLI flag, API route, frontend canvas, and execution
engine in the pypes module reads and writes instances of these
types — never loose ``dict``s, never ad-hoc JSON.

Design notes
------------

* The ``PypesManifest`` is a peer of ``SwarmManifest`` (agentic workflow
  contract) and ``SR-1`` enrichment manifests. It sits on its own
  ``schema_version`` so pypes can evolve independently.
* The ``CLPMetaModel`` is the BCBS-239 backbone: every physical column
  in a Gold-layer artifact must map upward through a Logical attribute
  to a Conceptual business entity. The orchestrator enforces this
  mapping on every step output.
* ``PipelineStep.sub_manifest_uri`` allows recursive execution — a
  step may itself be a pypes manifest, so common cleansing libraries
  can be shared across pipelines the same way functions are shared
  across Python modules.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

PYPES_SCHEMA_VERSION = "1.0"


# =============================================================================
# ENGINE / FORMAT ENUMS
# =============================================================================


class EngineType(str, Enum):
    PANDAS = "pandas"
    POLARS = "polars"
    PYSPARK = "pyspark"
    IBIS = "ibis"
    TRINO = "trino"


class MedallionStage(str, Enum):
    BRONZE = "bronze"
    SILVER = "silver"
    GOLD = "gold"


class FormatType(str, Enum):
    PARQUET = "parquet"
    CSV = "csv"
    JSON = "json"
    MEMORY = "memory"
    DUCKDB = "duckdb"


# =============================================================================
# CLP SEMANTIC META-MODEL
# =============================================================================


class FieldMeta(BaseModel):
    """A single logical attribute with its physical column binding."""

    name: str
    type: str = "string"
    required: bool = True
    pii: bool = False
    description: Optional[str] = None
    physical_column: Optional[str] = Field(
        default=None,
        description="Physical column name in the storage engine; defaults to ``name``.",
    )
    threshold: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Validation thresholds, e.g. ``{'min': 0, 'max': 100000000}``.",
    )


class ConceptualModel(BaseModel):
    """Business entity — the top of the CLP triangle."""

    name: str
    description: Optional[str] = None
    owner: Optional[str] = None
    compliance_tags: List[str] = Field(default_factory=list)


class LogicalModel(BaseModel):
    """Typed attributes owned by a conceptual entity."""

    entity: str
    fields: List[FieldMeta]


class PhysicalModel(BaseModel):
    """Concrete storage binding for a logical attribute set."""

    entity: str
    uri_template: str = Field(
        description="URI template relative to the workspace, e.g. ``data_in/trades.csv``."
    )
    format: FormatType = FormatType.PARQUET
    primary_key: List[str] = Field(default_factory=list)


class CLPMetaModel(BaseModel):
    """Conceptual → Logical → Physical — the compliance backbone."""

    conceptual: List[ConceptualModel] = Field(default_factory=list)
    logical: List[LogicalModel] = Field(default_factory=list)
    physical: List[PhysicalModel] = Field(default_factory=list)

    def field_for(self, entity: str, name: str) -> Optional[FieldMeta]:
        for l in self.logical:
            if l.entity == entity:
                for f in l.fields:
                    if f.name == name:
                        return f
        return None


# =============================================================================
# EXECUTION CONTRACT PRIMITIVES
# =============================================================================


class SourceSpec(BaseModel):
    """A single input/output location for a pipeline step."""

    uri: str
    format: FormatType = FormatType.PARQUET
    options: Dict[str, Any] = Field(default_factory=dict)


class OperationSpec(BaseModel):
    """A named transformation dispatched through the ``OperationRegistry``."""

    operation: str
    params: Dict[str, Any] = Field(default_factory=dict)
    description: Optional[str] = None


class ValidationSpec(BaseModel):
    """Declarative data-quality rules applied pre or post step."""

    completeness: List[str] = Field(
        default_factory=list,
        description="Columns that must never be null.",
    )
    uniqueness: List[str] = Field(
        default_factory=list,
        description="Columns whose values must be unique across the frame.",
    )
    thresholds: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Per-column min/max numeric bounds.",
    )
    move_analysis: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Compare against a prior checkpoint (``baseline_run_id``).",
    )
    row_count: Optional[Dict[str, int]] = Field(
        default=None,
        description="Expected row count bounds, e.g. ``{'min': 1, 'max': 1000000}``.",
    )


class ValidationResult(BaseModel):
    status: Literal["PASS", "FAIL", "WARN"] = "PASS"
    checks: List[Dict[str, Any]] = Field(default_factory=list)
    row_count: Optional[int] = None
    column_count: Optional[int] = None
    fingerprint: Optional[str] = Field(
        default=None,
        description="SHA-256 of the canonical frame for tamper-evident audit.",
    )


class PipelineStep(BaseModel):
    """A single node in the pypes DAG.

    Either ``operations`` *or* ``sub_manifest_uri`` must be populated. If
    ``sub_manifest_uri`` is set, the orchestrator loads the target manifest
    and runs it inline, wiring ``inputs`` to the sub-manifest's declared
    inputs and collecting its outputs into the parent context.
    """

    id: str
    description: str = ""
    engine: EngineType = EngineType.PANDAS
    stage: MedallionStage = MedallionStage.SILVER

    inputs: List[str] = Field(
        default_factory=list,
        description="Named upstream step ids whose outputs feed this step.",
    )
    outputs: List[str] = Field(
        default_factory=list,
        description="Names this step emits into the pipeline context.",
    )
    source: Optional[SourceSpec] = None
    destination: Optional[SourceSpec] = None

    operations: List[OperationSpec] = Field(default_factory=list)
    sub_manifest_uri: Optional[str] = None

    pre_validations: Optional[ValidationSpec] = None
    post_validations: Optional[ValidationSpec] = None

    clp_binding: Optional[Dict[str, str]] = Field(
        default=None,
        description="Optional mapping {column: 'Entity.field'} for drill-back.",
    )

    requires_rationale: bool = Field(
        default=False,
        description="Mechanical-review gate: refuse to complete without a signed rationale.",
    )
    deterministic: bool = True
    checkpoint: bool = Field(
        default=True,
        description="Persist the step's output under runs/pypes-<run_id>/checkpoints/.",
    )

    @field_validator("outputs")
    @classmethod
    def _outputs_unique(cls, v: List[str]) -> List[str]:
        if len(set(v)) != len(v):
            raise ValueError("PipelineStep.outputs must be unique")
        return v


# =============================================================================
# REPORTS
# =============================================================================


class ReportSpec(BaseModel):
    """A financial-risk (or any other) drill-down report.

    A report is the *explanation layer* on top of a successful run. It
    names a Gold-layer step to aggregate, a set of drill-down dimensions,
    and the format to emit. ``sign_with_rationale`` attaches the agent's
    cognitive audit to the report so a human can see the "why" alongside
    the "what".
    """

    id: str
    title: str
    kind: Literal[
        "financial_risk",
        "threshold_breaches",
        "move_analysis",
        "generic_summary",
    ] = "generic_summary"
    source_step: str = Field(
        description="Step id whose checkpointed output is the report's input.",
    )
    drill_down_by: List[str] = Field(default_factory=list)
    metrics: Dict[str, str] = Field(
        default_factory=dict,
        description="Metric name → aggregation expression, e.g. ``{'total_exposure': 'sum(notional)'}``.",
    )
    format: Literal["markdown", "json", "html"] = "markdown"
    top_n: Optional[int] = 20
    sign_with_rationale: bool = False


# =============================================================================
# RUN RECEIPTS & CHECKPOINTS
# =============================================================================


class RunCheckpoint(BaseModel):
    """A persisted, tamper-evident snapshot of one step's output."""

    step_id: str
    run_id: str
    path: str
    format: FormatType
    row_count: Optional[int] = None
    column_count: Optional[int] = None
    fingerprint: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class RunReceipt(BaseModel):
    """Signed, immutable record of one pypes run."""

    run_id: str
    manifest_id: str
    workspace: str
    status: Literal["SUCCESS", "PARTIAL", "FAILED"] = "SUCCESS"
    started_at: str
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None

    step_results: Dict[str, ValidationResult] = Field(default_factory=dict)
    checkpoints: List[RunCheckpoint] = Field(default_factory=list)
    reports: Dict[str, str] = Field(
        default_factory=dict,
        description="Report id → path to the rendered artifact.",
    )
    lineage_namespace: str = "benny-pypes"
    errors: List[str] = Field(default_factory=list)
    signature: Optional[str] = None


# =============================================================================
# TOP-LEVEL MANIFEST
# =============================================================================


class PypesGovernance(BaseModel):
    compliance_tags: List[str] = Field(default_factory=list)
    owner: Optional[str] = None
    criticality: Literal["low", "medium", "high", "critical"] = "medium"
    pii_policy: Literal["block", "mask", "allow"] = "block"


class ExecutionContract(BaseModel):
    """Legacy single-step contract kept for the investment-bank port.

    Prefer ``PypesManifest`` for new pipelines — it is the DAG-native,
    recursive, CLP-aware contract.
    """

    contract_name: str
    version: str = "1.0.0"
    engine: EngineType = EngineType.PANDAS
    source: SourceSpec
    operations: List[OperationSpec] = Field(default_factory=list)
    validations: Optional[ValidationSpec] = None
    destination: Optional[SourceSpec] = None


class PypesManifest(BaseModel):
    """Declarative, DAG-based transformation contract."""

    schema_version: str = Field(default=PYPES_SCHEMA_VERSION)
    kind: Literal["pypes_pipeline"] = "pypes_pipeline"
    id: str
    name: str
    description: str = ""
    workspace: str = "default"

    governance: PypesGovernance = Field(default_factory=PypesGovernance)
    clp: CLPMetaModel = Field(default_factory=CLPMetaModel)

    variables: Dict[str, Any] = Field(default_factory=dict)
    steps: List[PipelineStep] = Field(default_factory=list)
    reports: List[ReportSpec] = Field(default_factory=list)

    config: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)

    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    created_by: str = "benny-pypes"

    content_hash: Optional[str] = None
    signature: Optional[str] = None

    @field_validator("steps")
    @classmethod
    def _step_ids_unique(cls, v: List[PipelineStep]) -> List[PipelineStep]:
        seen: set[str] = set()
        for s in v:
            if s.id in seen:
                raise ValueError(f"Duplicate step id: {s.id}")
            seen.add(s.id)
        return v

    def step(self, step_id: str) -> Optional[PipelineStep]:
        return next((s for s in self.steps if s.id == step_id), None)

    def report(self, report_id: str) -> Optional[ReportSpec]:
        return next((r for r in self.reports if r.id == report_id), None)
