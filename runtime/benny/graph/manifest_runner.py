"""
Manifest runner — plan-only and manifest-driven execution for SwarmManifest.

Two entry points:

  plan_from_requirement(...)  → runs planner + wave_scheduler (+ JIT pillar
                                 expansion up to max_depth) and returns a
                                 SwarmManifest WITHOUT executing any work.

  execute_manifest(...)       → takes a SwarmManifest and runs the existing
                                 swarm graph against its pre-built plan. The
                                 planner is skipped entirely (the manifest IS
                                 the plan).

This preserves the plan-then-approve-then-run contract requested in the
product direction doc: the user can review/edit the manifest before paying
for execution, and reruns use the exact same manifest deterministically.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from langgraph.checkpoint.memory import MemorySaver

from ..core.manifest import (
    ManifestConfig,
    ManifestEdge,
    ManifestPlan,
    ManifestTask,
    OutputSpec,
    RunRecord,
    RunStatus,
    SwarmManifest,
    manifest_from_swarm_state,
    swarm_state_seed_from_manifest,
)
from ..core.state import SwarmState, create_swarm_state

logger = logging.getLogger(__name__)


# =============================================================================
# PLAN-ONLY
# =============================================================================


async def plan_from_requirement(
    requirement: str,
    workspace: str = "default",
    model: str = None,  # Must be resolved by caller via LLM Manager
    input_files: Optional[List[str]] = None,
    output_spec: Optional[OutputSpec] = None,
    max_concurrency: int = 1,
    max_depth: int = 3,
    manifest_id: Optional[str] = None,
    name: Optional[str] = None,
) -> SwarmManifest:
    """Drive planner + wave_scheduler to completion, then return a manifest.

    No executor / dispatcher / aggregator runs. The returned manifest has a
    complete DAG but `plan.tasks[*].status == PENDING`.
    """
    # Deferred import: swarm.py has heavy dependencies and we don't want them
    # to load at manifest-module import time.
    from .swarm import planner_node, wave_scheduler_node

    manifest_id = manifest_id or f"manifest-{uuid.uuid4().hex[:12]}"
    planning_id = f"plan-{uuid.uuid4().hex[:12]}"

    state: SwarmState = create_swarm_state(
        execution_id=planning_id,
        workspace=workspace,
        original_request=requirement,
        model=model,
        max_concurrency=max_concurrency,
        input_files=input_files,
        output_files=output_spec.files if output_spec else None,
        config={"manifest_id": manifest_id, "name": name or "", "plan_only": True},
        max_depth=max_depth,
    )

    # 1. Macro-strategy pass.
    try:
        delta = await planner_node(state)
    except Exception as e:
        logger.exception("plan_from_requirement: macro planner failed")
        raise
    state = _apply_delta(state, delta)

    if state.get("status") == "failed":
        raise RuntimeError(f"Planner failed: {state.get('errors', ['unknown'])}")

    # 2. Compute initial waves.
    delta = wave_scheduler_node(state)
    state = _apply_delta(state, delta)

    # 3. JIT expansion: repeatedly expand the first unexpanded pillar until
    # none remain (or we hit max_depth via the planner's own guard).
    expansion_guard = 0
    max_expansions = 32  # safety — prevents runaway loops on buggy planners
    while expansion_guard < max_expansions:
        unexpanded = [
            t for t in (state.get("plan") or [])
            if t.get("is_pillar") and not t.get("is_expanded")
        ]
        if not unexpanded:
            break
        target = unexpanded[0]
        state["target_pillar_id"] = target["task_id"]
        try:
            delta = await planner_node(state)
        except Exception:
            logger.exception(
                "plan_from_requirement: expansion failed for pillar=%s", target["task_id"]
            )
            # Mark as expanded to unblock the loop; downstream review can flag.
            for t in state.get("plan", []) or []:
                if t["task_id"] == target["task_id"]:
                    t["is_expanded"] = True
            expansion_guard += 1
            continue
        state = _apply_delta(state, delta)
        expansion_guard += 1

        # Reschedule after expansion so wave numbers reflect new tasks.
        delta = wave_scheduler_node(state)
        state = _apply_delta(state, delta)

    # 4. Build the manifest from the now-complete state.
    manifest = manifest_from_swarm_state(state)
    manifest.id = manifest_id
    if name:
        manifest.name = name
    if output_spec:
        manifest.outputs = output_spec
    
    # Mark as planned and approved so execute_manifest can bypass macro-planner
    manifest.metadata["execution_status"] = "planned"
    manifest.metadata["plan_approved"] = True
    
    manifest.touch()

    return manifest


# =============================================================================
# MANIFEST EXECUTION
# =============================================================================


async def execute_manifest(
    manifest: SwarmManifest,
    run_id: Optional[str] = None,
    on_event: Optional[Any] = None,
) -> RunRecord:
    """Execute a pre-planned manifest. Skips the planner entirely.

    If the manifest still contains unexpanded pillars, they will be JIT-expanded
    by the swarm graph's orchestrator node (same as a fresh run).

    Returns a RunRecord summarizing the execution.
    """
    from .swarm import build_swarm_graph, get_governance_url

    run_id = run_id or f"run-{uuid.uuid4().hex[:12]}"

    # Seed SwarmState from the manifest.
    seed = swarm_state_seed_from_manifest(manifest, execution_id=run_id)
    state: SwarmState = create_swarm_state(
        execution_id=run_id,
        workspace=manifest.workspace,
        original_request=manifest.requirement,
        model=manifest.config.model,
        max_concurrency=manifest.config.max_concurrency,
        input_files=list(manifest.inputs.files),
        output_files=list(manifest.outputs.files),
        config=manifest.metadata,
        max_depth=manifest.config.max_depth,
        handover_summary_limit=manifest.config.handover_summary_limit,
    )
    
    # NEW: Register with TaskManager so aero/telemetry works
    from ..core.task_manager import task_manager
    task_manager.create_task(
        workspace=manifest.workspace,
        task_type="swarm_workflow",
        task_id=run_id
    )

    # Overlay the manifest's pre-built plan/dep_graph/waves so the planner
    # doesn't re-generate them.
    state["plan"] = seed["plan"]
    state["active_task_pool"] = list(seed["plan"])
    state["dependency_graph"] = seed["dependency_graph"]
    state["waves"] = seed["waves"]
    state["plan_approved"] = manifest.metadata.get("plan_approved", True)
    state["status"] = manifest.metadata.get("execution_status", "planning")

    # Persist pending run record before we start.
    from ..persistence.run_store import save_run, update_run_status

    record = RunRecord(
        run_id=run_id,
        manifest_id=manifest.id,
        workspace=manifest.workspace,
        status=RunStatus.RUNNING,
        started_at=datetime.utcnow().isoformat(),
        manifest_snapshot=manifest.model_dump(),
        governance_url=get_governance_url(run_id, manifest.name or "swarm"),
    )
    save_run(record)

    graph = build_swarm_graph(MemorySaver())
    thread_config = {
        "configurable": {"thread_id": run_id},
        "max_concurrency": manifest.config.max_concurrency,
    }

    try:
        # Increase recursion limit to support deep synthesis (PBR-001 §5.2)
        config = thread_config.copy()
        config["recursion_limit"] = 100
        result = await graph.ainvoke(state, config)
    except Exception as e:
        logger.exception("execute_manifest: run %s failed", run_id)
        update_run_status(run_id, RunStatus.FAILED, errors=[str(e)])
        raise

    final_status_str = result.get("status", "completed")
    try:
        final_status = RunStatus(final_status_str)
    except ValueError:
        final_status = RunStatus.COMPLETED if not result.get("errors") else RunStatus.FAILED

    # Build per-task status overlay from the result.
    node_states: Dict[str, str] = {}
    for t in result.get("plan", []) or []:
        node_states[t.get("task_id", "")] = t.get("status", "pending")

    artifact_paths: List[str] = []
    if result.get("artifact_path"):
        artifact_paths.append(result["artifact_path"])

    updated = update_run_status(
        run_id,
        final_status,
        errors=result.get("errors", []),
        final_document=result.get("final_document"),
        artifact_paths=artifact_paths,
        node_states=node_states,
        governance_url=result.get("governance_url"),
    )
    return updated or record


# =============================================================================
# HELPERS
# =============================================================================


def _apply_delta(state: SwarmState, delta: Dict[str, Any]) -> SwarmState:
    """Apply a node-return dict to a SwarmState TypedDict in place.

    LangGraph applies returned dicts via reducers at runtime, but we're calling
    nodes directly so we merge manually. For the keys that have reducer
    semantics in `SwarmState`, we extend lists rather than overwrite.
    """
    if not delta:
        return state
    for k, v in delta.items():
        if k == "errors" and isinstance(v, list):
            state["errors"] = list(state.get("errors", []) or []) + v
        elif k == "partial_results" and isinstance(v, list):
            state["partial_results"] = list(state.get("partial_results", []) or []) + v
        elif k == "messages" and isinstance(v, list):
            state["messages"] = list(state.get("messages", []) or []) + v
        else:
            state[k] = v
    return state


__all__ = ["plan_from_requirement", "execute_manifest"]
