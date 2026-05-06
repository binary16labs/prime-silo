"""Benny Pypes — declarative, contract-driven transformation engine.

Pypes turns Benny into a third data plane alongside documents and code:
a manifest-driven transformation engine for tabular data, financial risk
aggregation, and explainable reports.

Core pillars:
  * **CLP Semantic Meta-Model** — Conceptual → Logical → Physical mapping so
    every Gold-layer aggregate traces back to a bronze-layer source column.
  * **DAG execution** — ``PipelineStep`` with declared inputs/outputs;
    the orchestrator topologically sorts them and runs each with
    pre/post validation hooks.
  * **Engine-agnostic** — ``ExecutionEngine`` protocol with a Pandas
    default and optional Polars backend. Adding Ibis/PySpark is a
    new registry entry, not a rewrite.
  * **Checkpoints + re-run** — every step's output is persisted under
    ``runs/pypes-<run_id>/checkpoints/<step_id>.parquet`` so any
    downstream step can be recomputed without re-running the whole DAG.
  * **OpenLineage + drill-down** — each step emits a lineage event to
    Marquez with CLP context, enabling BCBS-239-style drill-back from
    a risk aggregate to the raw trade rows.
  * **Financial risk reports** — first-class ``ReportSpec`` that
    renders counterparty exposure, threshold breaches, and move-analysis
    deltas as markdown with per-row provenance.

Public API::

    from benny.pypes import (
        PypesManifest, PipelineStep, CLPMetaModel,
        Orchestrator, OperationRegistry,
        load_manifest, run_manifest,
    )

The module is intentionally import-cheap — heavy deps (polars, ibis)
are imported lazily inside engine implementations.
"""

from __future__ import annotations

from .models import (
    CLPMetaModel,
    ConceptualModel,
    EngineType,
    ExecutionContract,
    FieldMeta,
    LogicalModel,
    OperationSpec,
    PhysicalModel,
    PipelineStep,
    PypesManifest,
    ReportSpec,
    RunCheckpoint,
    RunReceipt,
    SourceSpec,
    ValidationResult,
    ValidationSpec,
)
from .registry import OperationRegistry, default_registry
from .orchestrator import Orchestrator, load_manifest, run_manifest

__all__ = [
    "CLPMetaModel",
    "ConceptualModel",
    "EngineType",
    "ExecutionContract",
    "FieldMeta",
    "LogicalModel",
    "OperationRegistry",
    "OperationSpec",
    "Orchestrator",
    "PhysicalModel",
    "PipelineStep",
    "PypesManifest",
    "ReportSpec",
    "RunCheckpoint",
    "RunReceipt",
    "SourceSpec",
    "ValidationResult",
    "ValidationSpec",
    "default_registry",
    "load_manifest",
    "run_manifest",
]
