"""OpenLineage emission for pypes runs.

Every step produces a START and COMPLETE event attached to the
``benny-pypes`` namespace in Marquez. A custom ``PypesStepFacet``
carries CLP context, the step's validation result summary, and the
checkpoint fingerprint so a drill-back from a Gold aggregate to its
Bronze source is always one query away.

Failures here never propagate — lineage is observability, not a gate.
If Marquez is down, the pipeline keeps running and we log a single
``[pypes.lineage]`` warning.

AOS-001 Phase 8 extension
--------------------------
  emit_column_lineage(step_id, stage, columns_used, columns_generated,
                      run_id, manifest_id, *, cde_refs=None,
                      workspace_path=None) -> dict | None
      Returns a PROV-O column-level lineage block for silver/gold steps
      (AOS-F24).  Bronze steps return ``None`` (raw data; no lineage).
      When *workspace_path* is provided, the block is also written as a
      JSON-LD sidecar at
      ``<workspace>/data_out/lineage/pypes_{step_id}.jsonld``.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from .models import PipelineStep, PypesManifest, ValidationResult

log = logging.getLogger(__name__)

_NAMESPACE = "benny-pypes"

# OpenLineage requires runId to be a valid UUID. Pypes uses a short 12-char
# hex run id (e.g. "3c66acae71a2") for human-readable folders, so we deterministically
# inflate it to a UUID per-emit. uuid5 in this fixed namespace yields a stable
# UUID for the same short id, so START/COMPLETE events correlate in Marquez.
_RUN_ID_NAMESPACE = uuid.UUID("c1b00d12-3c4f-5a6b-8d9e-bcd0c1c2c3c4")


def _uuid_for(short_id: str) -> str:
    """Return a stable UUID string for any input id (UUID-safe or short hex)."""
    try:
        # If it's already a valid UUID, pass through.
        return str(uuid.UUID(short_id))
    except (ValueError, AttributeError, TypeError):
        return str(uuid.uuid5(_RUN_ID_NAMESPACE, short_id or ""))


def _safe_import_client() -> Optional[Any]:
    try:
        from openlineage.client import OpenLineageClient  # type: ignore
        from openlineage.client.run import (  # type: ignore
            Dataset,
            Job,
            Run,
            RunEvent,
            RunState,
        )

        return {
            "client": OpenLineageClient.from_environment(),
            "Dataset": Dataset,
            "Job": Job,
            "Run": Run,
            "RunEvent": RunEvent,
            "RunState": RunState,
        }
    except Exception as exc:  # pragma: no cover — optional
        log.debug("pypes.lineage: openlineage unavailable (%s)", exc)
        return None


class LineageEmitter:
    """Best-effort OpenLineage emitter. Never raises."""

    def __init__(self, run_id: str, manifest: PypesManifest) -> None:
        self.run_id = run_id
        self.manifest = manifest
        self._bridge = _safe_import_client()
        self._step_run_ids: Dict[str, str] = {}

    # --- public API -------------------------------------------------------

    def run_start(self) -> None:
        self._emit_pipeline("START")

    def run_complete(self, status: str = "SUCCESS") -> None:
        self._emit_pipeline("COMPLETE" if status == "SUCCESS" else "FAIL")

    def step_start(self, step: PipelineStep) -> None:
        # Stable per-step UUID derived from (run_id, step.id) so START/COMPLETE
        # events correlate even if the orchestrator restarts mid-run.
        self._step_run_ids[step.id] = _uuid_for(f"{self.run_id}:{step.id}")
        self._emit_step(step, "START", validation=None)

    def step_complete(self, step: PipelineStep, validation: ValidationResult) -> None:
        self._emit_step(
            step,
            "COMPLETE" if validation.status != "FAIL" else "FAIL",
            validation=validation,
        )

    # --- internals --------------------------------------------------------

    def _emit_pipeline(self, state: str) -> None:
        if not self._bridge:
            return
        try:
            client = self._bridge["client"]
            Run = self._bridge["Run"]
            Job = self._bridge["Job"]
            RunEvent = self._bridge["RunEvent"]
            RunState = self._bridge["RunState"]
            event = RunEvent(
                eventType=getattr(RunState, state.upper(), RunState.COMPLETE),
                eventTime=_now(),
                run=Run(runId=_uuid_for(self.run_id)),
                job=Job(namespace=_NAMESPACE, name=f"pypes.{self.manifest.id}"),
                producer="benny.pypes",
                inputs=[],
                outputs=[],
            )
            client.emit(event)
        except Exception as exc:  # pragma: no cover
            log.warning("pypes.lineage: pipeline emit failed: %s", exc)

    def _emit_step(
        self,
        step: PipelineStep,
        state: str,
        validation: Optional[ValidationResult],
    ) -> None:
        if not self._bridge:
            return
        try:
            client = self._bridge["client"]
            Run = self._bridge["Run"]
            Job = self._bridge["Job"]
            Dataset = self._bridge["Dataset"]
            RunEvent = self._bridge["RunEvent"]
            RunState = self._bridge["RunState"]

            step_run_id = self._step_run_ids.get(step.id) or _uuid_for(f"{self.run_id}:{step.id}")
            self._step_run_ids[step.id] = step_run_id

            inputs: List[Any] = [
                Dataset(namespace=_NAMESPACE, name=name) for name in step.inputs
            ]
            outputs: List[Any] = [
                Dataset(namespace=_NAMESPACE, name=name) for name in step.outputs
            ]
            event = RunEvent(
                eventType=getattr(RunState, state.upper(), RunState.COMPLETE),
                eventTime=_now(),
                run=Run(
                    runId=step_run_id,
                    facets=_step_run_facets(self.manifest, step, validation, self.run_id),
                ),
                job=Job(
                    namespace=_NAMESPACE,
                    name=f"pypes.{self.manifest.id}.{step.id}",
                ),
                producer="benny.pypes",
                inputs=inputs,
                outputs=outputs,
            )
            client.emit(event)
        except Exception as exc:  # pragma: no cover
            log.warning("pypes.lineage: step emit failed (%s): %s", step.id, exc)


def _now() -> str:
    from datetime import datetime

    return datetime.utcnow().isoformat() + "Z"


def _step_run_facets(
    manifest: PypesManifest,
    step: PipelineStep,
    validation: Optional[ValidationResult],
    parent_run_id: str,
) -> Dict[str, Any]:
    facets: Dict[str, Any] = {
        "pypes_step": {
            "_producer": "benny.pypes",
            "_schemaURL": "https://benny.io/schemas/pypes-step.json",
            "parent_run_id": parent_run_id,
            "manifest_id": manifest.id,
            "stage": step.stage.value,
            "engine": step.engine.value,
            "deterministic": step.deterministic,
            "clp_binding": step.clp_binding or {},
        }
    }
    if validation is not None:
        facets["pypes_validation"] = {
            "_producer": "benny.pypes",
            "_schemaURL": "https://benny.io/schemas/pypes-validation.json",
            "status": validation.status,
            "row_count": validation.row_count,
            "column_count": validation.column_count,
            "fingerprint": validation.fingerprint,
            "checks": validation.checks[:50],
        }
    if manifest.governance.compliance_tags:
        facets["pypes_governance"] = {
            "_producer": "benny.pypes",
            "_schemaURL": "https://benny.io/schemas/pypes-governance.json",
            "compliance_tags": manifest.governance.compliance_tags,
            "owner": manifest.governance.owner,
            "criticality": manifest.governance.criticality,
        }
    return facets


# ---------------------------------------------------------------------------
# AOS-001 Phase 8 — column-level lineage (AOS-F24)
# ---------------------------------------------------------------------------

_SILVER_GOLD_STAGES = {"silver", "gold"}

# Inline PROV-O prefix map (stdlib-only, no network)
_PROV_CONTEXT = {
    "prov":  "http://www.w3.org/ns/prov#",
    "xsd":   "http://www.w3.org/2001/XMLSchema#",
    "benny": "https://benny.io/ontology/",
    "prov:used":      {"@id": "prov:used"},
    "prov:generated": {"@id": "prov:generated"},
    "benny:cde_refs": {"@id": "benny:cde_refs", "@container": "@list"},
    "benny:manifest_id": {"@id": "benny:manifest_id"},
    "benny:stage":    {"@id": "benny:stage"},
}


def emit_column_lineage(
    *,
    step_id: str,
    stage: str,
    columns_used: list[str],
    columns_generated: list[str],
    run_id: str,
    manifest_id: str,
    cde_refs: Optional[list[str]] = None,
    workspace_path: Optional[Any] = None,
) -> Optional[dict[str, Any]]:
    """Emit a PROV-O column-level lineage block for a pypes step (AOS-F24).

    Only ``silver`` and ``gold`` stage steps produce lineage — ``bronze``
    is raw ingestion and returns ``None``.

    Parameters
    ----------
    step_id:
        Pypes step identifier, e.g. ``"silver_trades"``.
    stage:
        Stage name: ``"bronze"``, ``"silver"``, or ``"gold"``.
        Returns ``None`` for ``"bronze"``.
    columns_used:
        List of fully-qualified input column names, e.g.
        ``["raw.trade_id", "raw.notional"]``.
    columns_generated:
        List of fully-qualified output column names, e.g.
        ``["silver.trade_id", "silver.notional_usd"]``.
    run_id:
        AOS run identifier.
    manifest_id:
        Pypes manifest identifier (for traceability).
    cde_refs:
        Optional list of CDE column names (AOS-COMP2 bridge).
    workspace_path:
        Optional workspace root.  When provided, the block is written to
        ``<workspace>/data_out/lineage/pypes_{step_id}.jsonld``.

    Returns
    -------
    dict | None
        The column-level lineage block, or ``None`` for bronze stages.
    """
    if stage not in _SILVER_GOLD_STAGES:
        return None

    block: dict[str, Any] = {
        "@context": _PROV_CONTEXT,
        "@type": "prov:Activity",
        "@id": f"urn:benny:run:{run_id}:pypes:{step_id}",
        "benny:stage": stage,
        "benny:manifest_id": manifest_id,
        "prov:used": list(columns_used),
        "prov:generated": list(columns_generated),
    }
    if cde_refs:
        block["benny:cde_refs"] = list(cde_refs)

    # Optional sidecar write
    if workspace_path is not None:
        import json
        from pathlib import Path as _Path

        lineage_dir = _Path(workspace_path) / "data_out" / "lineage"
        lineage_dir.mkdir(parents=True, exist_ok=True)
        sidecar = lineage_dir / f"pypes_{step_id}.jsonld"
        sidecar.write_text(json.dumps(block, indent=2), encoding="utf-8")

    return block
