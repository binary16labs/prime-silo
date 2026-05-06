"""DAG orchestrator — topologically sorted step execution with checkpoints.

Execution lifecycle (one call to ``Orchestrator.run``):

1. Validate the manifest (CLP consistency, DAG cycles, unique ids).
2. Compute topological order from step ``inputs``/``outputs`` + explicit
   ``dependencies`` (honoring both graphs so a step can say "I need
   cleansed_trades" without knowing which step produced it).
3. For each step in order:
     a. Resolve inputs from the pipeline context (named datasets from
        prior steps) or from ``step.source``.
     b. Run pre-validations.
     c. Dispatch operations through ``OperationRegistry`` *or* recurse
        into a sub-manifest if ``sub_manifest_uri`` is set.
     d. Run post-validations (with move-analysis against the prior run's
        checkpoint if declared).
     e. Persist the output as a checkpoint and register it in the run
        context under each of ``step.outputs``.
     f. Emit a lineage step event.
4. Render any declared reports.
5. Sign the ``RunReceipt`` (sha256 of canonical payload) and write it.

Re-run semantics: if ``resume_from_run_id`` is set, the orchestrator
first loads that run's checkpoints into the context and then executes
only the steps that (a) come after ``resume_from_step`` in topological
order, or (b) have no cached checkpoint.

This is *the* place all pypes runs go through — it is also the module
the API and the CLI both call.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

from .checkpoints import CheckpointStore
from .engine import ExecutionEngine
from .engines import get_engine
from .lineage import LineageEmitter
from .models import (
    EngineType,
    OperationSpec,
    PipelineStep,
    PypesManifest,
    ReportSpec,
    RunReceipt,
    ValidationResult,
    ValidationSpec,
)
from .registry import OperationRegistry, default_registry
from .reports import render_report
from .validators import run_validations

log = logging.getLogger(__name__)


# =============================================================================
# VARIABLE SUBSTITUTION (same contract as knowledge_enrichment_pipeline)
# =============================================================================


def _substitute(value: Any, variables: Dict[str, Any]) -> Any:
    """Replace ``${var}`` tokens in strings, recursing into dicts/lists."""
    if isinstance(value, str):
        out = value
        for k, v in variables.items():
            out = out.replace(f"${{{k}}}", str(v))
        return out
    if isinstance(value, list):
        return [_substitute(x, variables) for x in value]
    if isinstance(value, dict):
        return {k: _substitute(v, variables) for k, v in value.items()}
    return value


# =============================================================================
# RESULT / RUN CONTEXT
# =============================================================================


class StepOutcome(BaseModel):
    step_id: str
    status: str = "PENDING"
    duration_ms: int = 0
    validation: Optional[ValidationResult] = None
    output_names: List[str] = []
    error: Optional[str] = None


class PipelineContext:
    """Named dataset store passed between steps of one run."""

    def __init__(self) -> None:
        self._frames: Dict[str, Any] = {}

    def set(self, name: str, value: Any) -> None:
        self._frames[name] = value

    def get(self, name: str) -> Any:
        return self._frames.get(name)

    def has(self, name: str) -> bool:
        return name in self._frames

    def snapshot(self) -> Dict[str, Any]:
        return dict(self._frames)


# =============================================================================
# ORCHESTRATOR
# =============================================================================


class Orchestrator:
    def __init__(
        self,
        workspace_root: Optional[Path] = None,
        registry: Optional[OperationRegistry] = None,
    ) -> None:
        self.workspace_root = Path(workspace_root) if workspace_root else None
        self.registry = registry or default_registry

    # ------------------------------------------------------------------ API

    def run(
        self,
        manifest: PypesManifest,
        *,
        run_id: Optional[str] = None,
        variables: Optional[Dict[str, Any]] = None,
        resume_from_run_id: Optional[str] = None,
        only_steps: Optional[List[str]] = None,
    ) -> RunReceipt:
        run_id = run_id or uuid.uuid4().hex[:12]
        start = time.time()

        # Substitute variables (merge manifest defaults with caller overrides)
        merged_vars: Dict[str, Any] = dict(manifest.variables or {})
        merged_vars.update(variables or {})
        merged_vars.setdefault("workspace", manifest.workspace)
        merged_vars.setdefault("run_id", run_id)
        # Inject BENNY_HOME so templates can reference ${benny_home}
        benny_home_env = os.environ.get("BENNY_HOME")
        if benny_home_env:
            merged_vars.setdefault("benny_home", benny_home_env)
            merged_vars.setdefault("BENNY_HOME", benny_home_env)
        else:
            merged_vars.setdefault("benny_home", str(Path.cwd()))
            merged_vars.setdefault("BENNY_HOME", str(Path.cwd()))
        resolved = PypesManifest.model_validate(
            _substitute(manifest.model_dump(mode="json"), merged_vars)
        )

        workspace_root = self._resolve_workspace_root(resolved.workspace)
        run_dir = workspace_root / "runs" / f"pypes-{run_id}"
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "manifest_snapshot.json").write_text(
            resolved.model_dump_json(indent=2), encoding="utf-8"
        )

        store = CheckpointStore(run_dir)
        emitter = LineageEmitter(run_id, resolved)
        emitter.run_start()

        context = PipelineContext()
        prior_store = CheckpointStore.for_run(workspace_root, resume_from_run_id) if resume_from_run_id else None

        order = _topological_order(resolved.steps)
        log.info("pypes: run=%s manifest=%s order=%s", run_id, resolved.id, order)

        outcomes: Dict[str, StepOutcome] = {}
        errors: List[str] = []
        overall_status = "SUCCESS"

        for step_id in order:
            step = resolved.step(step_id)
            if step is None:
                continue
            if only_steps and step.id not in only_steps and (
                prior_store is None or not prior_store.has(step.id)
            ):
                # Skipped by filter and no prior checkpoint — mark pending.
                outcomes[step.id] = StepOutcome(step_id=step.id, status="SKIPPED")
                continue

            # Resume path: reuse prior checkpoint if available and step not forced.
            if prior_store is not None and (not only_steps or step.id not in only_steps):
                if prior_store.has(step.id):
                    engine = _select_engine(step.engine)
                    df = prior_store.read(engine, step.id)
                    for out_name in step.outputs or [step.id]:
                        context.set(out_name, df)
                    # Persist the inherited checkpoint under this run too, so downstream
                    # drill-downs always resolve locally.
                    store.write(engine, step.id, run_id, df)
                    outcomes[step.id] = StepOutcome(
                        step_id=step.id,
                        status="REUSED",
                        output_names=step.outputs or [step.id],
                    )
                    continue

            emitter.step_start(step)
            t0 = time.time()
            try:
                df, validation = self._execute_step(
                    step=step,
                    manifest=resolved,
                    context=context,
                    workspace_root=workspace_root,
                    run_id=run_id,
                    variables=merged_vars,
                )
                duration = int((time.time() - t0) * 1000)

                # Persist checkpoint if requested
                if step.checkpoint and df is not None:
                    store.write(_select_engine(step.engine), step.id, run_id, df)

                # Wire outputs into context
                for out_name in step.outputs or [step.id]:
                    context.set(out_name, df)

                if validation.status == "FAIL":
                    overall_status = "PARTIAL"
                outcomes[step.id] = StepOutcome(
                    step_id=step.id,
                    status=validation.status,
                    duration_ms=duration,
                    validation=validation,
                    output_names=step.outputs or [step.id],
                )
                emitter.step_complete(step, validation)
            except Exception as exc:
                duration = int((time.time() - t0) * 1000)
                err = f"{type(exc).__name__}: {exc}"
                log.exception("pypes: step '%s' failed", step.id)
                errors.append(f"{step.id}: {err}")
                outcomes[step.id] = StepOutcome(
                    step_id=step.id,
                    status="FAIL",
                    duration_ms=duration,
                    error=err,
                )
                emitter.step_complete(
                    step,
                    ValidationResult(status="FAIL", checks=[{"check": "execution", "status": "FAILED", "error": err}]),
                )
                overall_status = "FAILED"
                # Fail-fast by default — downstream steps have no inputs anyway
                break

        # Render reports (best effort — a failed report never downgrades the run)
        report_paths: Dict[str, str] = {}
        receipt = self._build_receipt(
            resolved, run_id, outcomes, store, errors, overall_status, start
        )
        for report in resolved.reports:
            try:
                baseline_store = CheckpointStore.for_run(
                    workspace_root, resume_from_run_id
                ) if resume_from_run_id else _find_baseline_store(
                    workspace_root, resolved.id, run_id
                )
                path = render_report(
                    engine=_select_engine(EngineType.PANDAS),
                    manifest=resolved,
                    spec=report,
                    store=store,
                    receipt=receipt,
                    baseline_store=baseline_store,
                )
                report_paths[report.id] = path
            except Exception as exc:  # pragma: no cover
                log.warning("pypes.report[%s] failed: %s", report.id, exc)

        receipt.reports = report_paths
        receipt.completed_at = datetime.utcnow().isoformat()
        receipt.duration_ms = int((time.time() - start) * 1000)
        receipt.signature = _sign_receipt(receipt)
        (run_dir / "receipt.json").write_text(receipt.model_dump_json(indent=2), encoding="utf-8")
        emitter.run_complete(receipt.status)
        return receipt

    # -------------------------------------------------------------- steps

    def _execute_step(
        self,
        step: PipelineStep,
        manifest: PypesManifest,
        context: PipelineContext,
        workspace_root: Path,
        run_id: str,
        variables: Dict[str, Any],
    ) -> Tuple[Any, ValidationResult]:
        engine = _select_engine(step.engine)

        # 1. Load input frame
        df = self._resolve_input(step, engine, context, workspace_root)

        # 2. Pre-validation
        if step.pre_validations is not None:
            pre = run_validations(engine, df, step.pre_validations)
            if pre.status == "FAIL":
                raise ValueError(
                    f"pre-validation FAIL on step '{step.id}': "
                    + "; ".join(c.get("check", "?") for c in pre.checks if c.get("status") == "FAILED")
                )

        # 3. Sub-manifest recursion OR operation dispatch
        if step.sub_manifest_uri:
            df = self._run_sub_manifest(
                step, df, manifest, workspace_root, run_id, variables
            )
        else:
            for op in step.operations:
                df = self.registry.execute(
                    engine,
                    df,
                    OperationSpec(
                        operation=op.operation,
                        params={**op.params, "context": context.snapshot()} if op.operation in {"join", "union"} else op.params,
                    ),
                )

        # 4. Destination save (if declared — checkpointing handles the default)
        if step.destination is not None:
            try:
                engine.save(df, step.destination, workspace_root=str(workspace_root))
            except Exception as exc:
                # Parquet engine may be missing — fall back to CSV alongside the original.
                from .models import FormatType, SourceSpec
                fallback_uri = step.destination.uri.rsplit(".", 1)[0] + ".csv"
                log.warning(
                    "pypes: destination save failed for step '%s' (%s); writing CSV fallback to %s",
                    step.id, exc, fallback_uri,
                )
                engine.save(
                    df,
                    SourceSpec(uri=fallback_uri, format=FormatType.CSV),
                    workspace_root=str(workspace_root),
                )

        # 5. Post-validation with optional move-analysis baseline
        baseline_df = None
        if step.post_validations and step.post_validations.move_analysis:
            baseline_path = CheckpointStore.discover_baseline(
                workspace_root, manifest.id, run_id, step.id
            )
            if baseline_path is not None:
                try:
                    from .models import FormatType, SourceSpec

                    baseline_df = engine.load(
                        SourceSpec(
                            uri=str(baseline_path),
                            format=FormatType.PARQUET if str(baseline_path).endswith(".parquet") else FormatType.CSV,
                        )
                    )
                except Exception:  # pragma: no cover
                    baseline_df = None

        validation = run_validations(engine, df, step.post_validations, baseline_df=baseline_df)
        return df, validation

    def _resolve_input(
        self,
        step: PipelineStep,
        engine: ExecutionEngine,
        context: PipelineContext,
        workspace_root: Path,
    ) -> Any:
        if step.source is not None:
            return engine.load(step.source, workspace_root=str(workspace_root))
        if step.inputs:
            first = step.inputs[0]
            if not context.has(first):
                raise KeyError(
                    f"step '{step.id}' depends on '{first}' but no upstream step produced it"
                )
            return context.get(first)
        return None

    def _run_sub_manifest(
        self,
        step: PipelineStep,
        df: Any,
        parent: PypesManifest,
        workspace_root: Path,
        parent_run_id: str,
        variables: Dict[str, Any],
    ) -> Any:
        uri = step.sub_manifest_uri
        assert uri is not None
        sub_path = self._resolve_uri(uri, workspace_root)
        sub = load_manifest(sub_path)
        sub.workspace = parent.workspace
        receipt = Orchestrator(workspace_root=workspace_root, registry=self.registry).run(
            sub,
            run_id=f"{parent_run_id}.{step.id}",
            variables={**variables, **({"_parent_input": df} if df is not None else {})},
        )
        # Expose the sub-manifest's last step output under the parent step outputs
        last_step = sub.steps[-1] if sub.steps else None
        if last_step is None:
            return df
        sub_store = CheckpointStore(workspace_root / "runs" / f"pypes-{receipt.run_id}")
        engine = _select_engine(step.engine)
        return sub_store.read(engine, last_step.id)

    # ---------------------------------------------------------- bookkeeping

    def _resolve_workspace_root(self, workspace: str) -> Path:
        if self.workspace_root is not None:
            return self.workspace_root
        benny_home = os.environ.get("BENNY_HOME")
        base = Path(benny_home) if benny_home else Path.cwd()
        ws_root = base / "workspace" / workspace
        ws_root.mkdir(parents=True, exist_ok=True)
        return ws_root

    def _resolve_uri(self, uri: str, workspace_root: Path) -> Path:
        p = Path(uri)
        if p.is_absolute() and p.exists():
            return p
        ws_path = workspace_root / uri
        if ws_path.exists():
            return ws_path
        cwd_path = Path.cwd() / uri
        if cwd_path.exists():
            return cwd_path
        raise FileNotFoundError(f"Cannot resolve sub-manifest '{uri}'")

    def _build_receipt(
        self,
        manifest: PypesManifest,
        run_id: str,
        outcomes: Dict[str, StepOutcome],
        store: CheckpointStore,
        errors: List[str],
        status: str,
        start: float,
    ) -> RunReceipt:
        return RunReceipt(
            run_id=run_id,
            manifest_id=manifest.id,
            workspace=manifest.workspace,
            status="SUCCESS" if status == "SUCCESS" else "PARTIAL" if status == "PARTIAL" else "FAILED",
            started_at=datetime.utcfromtimestamp(start).isoformat(),
            step_results={
                sid: (
                    o.validation
                    if o.validation is not None
                    else ValidationResult(
                        status="PASS" if o.status in {"SUCCESS", "REUSED", "SKIPPED", "PASS"} else "FAIL"
                    )
                )
                for sid, o in outcomes.items()
            },
            checkpoints=store.manifest(),
            errors=errors,
        )


# =============================================================================
# MODULE-LEVEL HELPERS
# =============================================================================


def _topological_order(steps: List[PipelineStep]) -> List[str]:
    """Kahn's algorithm over explicit ``inputs``/``outputs`` edges.

    Edges: a step A depends on B if any of A.inputs is in B.outputs. If
    A.inputs is empty (source step) or references a name no step produces,
    that name is assumed external (e.g. a raw file) and contributes no edge.
    """
    producers: Dict[str, str] = {}
    for s in steps:
        for o in s.outputs or [s.id]:
            producers[o] = s.id

    # Build adjacency
    deps: Dict[str, set[str]] = {s.id: set() for s in steps}
    for s in steps:
        for name in s.inputs:
            prod = producers.get(name)
            if prod and prod != s.id:
                deps[s.id].add(prod)

    ready = [s.id for s in steps if not deps[s.id]]
    order: List[str] = []
    while ready:
        ready.sort()  # deterministic
        sid = ready.pop(0)
        order.append(sid)
        for t, t_deps in deps.items():
            if sid in t_deps:
                t_deps.remove(sid)
                if not t_deps and t not in order and t not in ready:
                    ready.append(t)
    remaining = [s.id for s in steps if s.id not in order]
    if remaining:
        raise ValueError(
            f"DAG cycle or unresolved dependency among steps: {remaining}"
        )
    return order


def _select_engine(kind: EngineType) -> ExecutionEngine:
    return get_engine(kind)


def _find_baseline_store(
    workspace_root: Path, manifest_id: str, current_run_id: str
) -> Optional[CheckpointStore]:
    """Locate the most recent prior run for ``manifest_id`` (for move-analysis reports)."""
    runs_root = workspace_root / "runs"
    if not runs_root.exists():
        return None
    candidates = sorted(runs_root.glob("pypes-*"), reverse=True)
    for run_dir in candidates:
        if run_dir.name == f"pypes-{current_run_id}":
            continue
        snap = run_dir / "manifest_snapshot.json"
        if not snap.exists():
            continue
        try:
            m = json.loads(snap.read_text(encoding="utf-8"))
            if m.get("id") == manifest_id:
                return CheckpointStore(run_dir)
        except Exception:
            continue
    return None


def _sign_receipt(receipt: RunReceipt) -> str:
    payload = receipt.model_dump(mode="json")
    payload.pop("signature", None)
    canonical = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def load_manifest(path: str | Path) -> PypesManifest:
    """Load a pypes manifest from disk — JSON only for v1.0."""
    p = Path(path)
    raw = json.loads(p.read_text(encoding="utf-8"))
    return PypesManifest.model_validate(raw)


def run_manifest(
    path: str | Path,
    *,
    workspace_root: Optional[Path] = None,
    variables: Optional[Dict[str, Any]] = None,
    resume_from_run_id: Optional[str] = None,
    only_steps: Optional[List[str]] = None,
) -> RunReceipt:
    """CLI/API convenience wrapper around ``Orchestrator.run``."""
    manifest = load_manifest(path)
    if variables and "workspace" in variables:
        manifest.workspace = variables["workspace"]
    orch = Orchestrator(workspace_root=workspace_root)
    return orch.run(
        manifest,
        variables=variables,
        resume_from_run_id=resume_from_run_id,
        only_steps=only_steps,
    )
