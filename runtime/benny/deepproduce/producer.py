"""Deep-produce orchestrator — decompose → fan-out → synthesize → review.

One goal becomes a composite ``.aamp.view`` (a multi-panel dashboard) by:

  1. **decompose** — one model call turns the goal into a view title + a list of
     N complementary panel specs.
  2. **fan-out** — one model call PER panel produces that panel's Markdown. This
     is where the output exceeds a single call's context / a single render: each
     panel is generated in its own budget, then assembled.
  3. **aggregate** — the panels are composed into one ``.aamp.view``.
  4. **review** — a final model call critiques coherence/gaps; the critique is
     stored on the view (advisory, not auto-applied).

Every model call goes through :func:`benny.core.models.call_model` (offline
guard + logging + lineage). Each stage emits a ``NODE_EXECUTION_STATE``
governance event tagged with the ``run_id`` so the Bridge Runs widgets render
the fan-out, and the run is recorded in the same ``run_store`` the Runs list
reads. Fan-out is sequential for now (single local endpoint = a quality win over
the single-context ceiling); cross-machine parallelism is a later phase.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..core.manifest import RunRecord, RunStatus
from ..core.models import call_model, get_active_model
from ..core.workspace import get_workspace_path
from ..governance.audit import emit_governance_event


def _run_store():
    """Lazily resolve the run store. Imported on first use so merely importing
    deep_produce does not drag in benny.persistence (and its LangGraph
    checkpointer) — deep_produce only needs the run-record CRUD."""
    from ..persistence import run_store
    return run_store

DEFAULT_PANEL_COUNT = 4
MAX_PANEL_COUNT = 8
VIEW_FORMAT = "aamp.view/1"
MANIFEST_ID = "deep-produce"


def _now() -> str:
    return datetime.utcnow().isoformat()


def _slug(text: str, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return s or fallback


def _emit_node(
    workspace: str,
    run_id: str,
    node_id: str,
    status: str,
    *,
    reasoning: str = "",
    response: str = "",
    duration_ms: Optional[int] = None,
) -> None:
    """Emit a NODE_EXECUTION_STATE event the Runs widgets consume. The
    reasoning_trace widget renders any event whose ``data.outputs.reasoning_trace``
    is a non-empty string; lineage_timeline lists them on the run timeline."""
    emit_governance_event(
        "NODE_EXECUTION_STATE",
        {
            "run_id": run_id,
            "node_id": node_id,
            "status": status,
            "timestamp": _now(),
            "duration_ms": duration_ms,
            "outputs": {"reasoning_trace": reasoning, "response": response},
        },
        workspace_id=workspace,
    )


def _extract_json(text: str) -> Any:
    """Best-effort: pull the first JSON object/array out of a model response,
    tolerating ```json fences and surrounding prose. Returns None on failure."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.DOTALL)
    candidate = fenced.group(1).strip() if fenced else text.strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    match = re.search(r"(\{.*\}|\[.*\])", candidate, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            return None
    return None


def _fallback_panels(goal: str, panel_count: int) -> Dict[str, Any]:
    titles = ["Overview", "Key details", "Risks & considerations", "Next steps",
              "Context", "Data points", "Open questions", "Summary"]
    panels = [{"title": titles[i % len(titles)], "focus": goal} for i in range(panel_count)]
    return {"title": f"{goal[:80]}", "panels": panels}


async def _decompose(goal: str, model: str, run_id: str, workspace: str, panel_count: int) -> Dict[str, Any]:
    start = time.monotonic()
    prompt = (
        f"You are planning a multi-panel dashboard that thoroughly answers this goal:\n\n"
        f"GOAL: {goal}\n\n"
        f"Design exactly {panel_count} complementary, non-overlapping panels that together "
        f"cover the goal in depth. Reply with STRICT JSON only, no prose:\n"
        f'{{"title": "<concise dashboard title>", "panels": '
        f'[{{"title": "<panel title>", "focus": "<one sentence on what this panel should contain>"}}]}}'
    )
    raw = await call_model(model, [{"role": "user", "content": prompt}],
                           temperature=0.3, max_tokens=1024, run_id=run_id)
    parsed = _extract_json(raw)
    plan: Dict[str, Any]
    if isinstance(parsed, dict) and isinstance(parsed.get("panels"), list) and parsed["panels"]:
        plan = parsed
    elif isinstance(parsed, list) and parsed:
        plan = {"title": goal[:80], "panels": parsed}
    else:
        plan = _fallback_panels(goal, panel_count)
    # Normalise + clamp.
    panels = []
    for spec in plan["panels"][:panel_count]:
        if isinstance(spec, str):
            panels.append({"title": spec, "focus": goal})
        elif isinstance(spec, dict):
            panels.append({"title": str(spec.get("title") or "Panel"), "focus": str(spec.get("focus") or goal)})
    if not panels:
        panels = _fallback_panels(goal, panel_count)["panels"]
    plan["panels"] = panels
    plan["title"] = str(plan.get("title") or goal[:80])
    duration_ms = int((time.monotonic() - start) * 1000)
    _emit_node(
        workspace, run_id, "decompose", "success",
        reasoning=f"Decomposed the goal into {len(panels)} panels: "
                  + ", ".join(p["title"] for p in panels),
        response=json.dumps(plan), duration_ms=duration_ms,
    )
    return plan


async def _produce_panel(panel: Dict[str, Any], goal: str, model: str, run_id: str,
                         workspace: str, index: int) -> Dict[str, Any]:
    start = time.monotonic()
    title = panel["title"]
    focus = panel["focus"]
    prompt = (
        f"You are writing ONE panel of a multi-panel dashboard about:\n{goal}\n\n"
        f"This panel is titled \"{title}\". Focus: {focus}\n\n"
        f"Write concise, information-dense Markdown for THIS panel only — no title "
        f"heading (the panel already has one), no preamble, no closing remarks."
    )
    content = await call_model(model, [{"role": "user", "content": prompt}],
                               temperature=0.6, max_tokens=1536, run_id=run_id)
    content = (content or "").strip()
    duration_ms = int((time.monotonic() - start) * 1000)
    node_id = f"panel:{index + 1}:{_slug(title, str(index + 1))}"
    _emit_node(
        workspace, run_id, node_id, "success",
        reasoning=f"Produced panel '{title}' ({len(content)} chars). Focus: {focus}",
        response=content, duration_ms=duration_ms,
    )
    return {"id": f"panel-{index + 1}", "title": title, "type": "markdown", "markdown": content}


async def _review(view: Dict[str, Any], goal: str, model: str, run_id: str, workspace: str) -> str:
    start = time.monotonic()
    outline = "\n".join(f"- {p['title']}" for p in view["panels"])
    prompt = (
        f"Critique this multi-panel dashboard for coverage of the goal, coherence, "
        f"overlap, and gaps. Be specific and brief (max ~6 bullet points).\n\n"
        f"GOAL: {goal}\n\nPANELS:\n{outline}"
    )
    try:
        critique = (await call_model(model, [{"role": "user", "content": prompt}],
                                     temperature=0.3, max_tokens=768, run_id=run_id) or "").strip()
    except Exception as exc:  # review is advisory — never fail the run on it
        critique = f"(review skipped: {exc})"
    duration_ms = int((time.monotonic() - start) * 1000)
    _emit_node(workspace, run_id, "review", "success",
               reasoning=critique or "(no critique returned)", duration_ms=duration_ms)
    return critique


def _fanout_concurrency(model: str, panel_count: int) -> int:
    """How many panels to produce at once: the size of the active model
    provider's endpoint pool (so multi-machine setups parallelize), clamped to
    the panel count. Defaults to 1 (sequential) when no pool is configured."""
    try:
        from ..core.endpoints import get_endpoint_pools
        from ..core.models import get_model_config
        provider = (get_model_config(model).get("provider") or "").lower()
        pool = get_endpoint_pools().get(provider) or []
        return max(1, min(len(pool) or 1, panel_count))
    except Exception:
        return 1


def _write_view(workspace: str, run_id: str, view: Dict[str, Any]) -> str:
    """Persist the composite view under the workspace's agent_sandbox/views and
    return the workspace-relative path."""
    views_dir = get_workspace_path(workspace) / "agent_sandbox" / "views"
    views_dir.mkdir(parents=True, exist_ok=True)
    filename = f"deep-produce-{run_id}.aamp.view"
    (views_dir / filename).write_text(json.dumps(view, indent=2), encoding="utf-8")
    return f"agent_sandbox/views/{filename}"


async def deep_produce(
    goal: str,
    workspace: str = "default",
    model: Optional[str] = None,
    panel_count: int = DEFAULT_PANEL_COUNT,
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the full decompose → fan-out → aggregate → review loop. Records a run
    and emits per-stage governance events. Returns the run summary + view."""
    goal = (goal or "").strip()
    if not goal:
        raise ValueError("deep_produce requires a non-empty goal")

    run_id = run_id or f"dp-{uuid.uuid4().hex[:12]}"
    panel_count = max(1, min(MAX_PANEL_COUNT, int(panel_count or DEFAULT_PANEL_COUNT)))
    if not model:
        try:
            model = await get_active_model(workspace, role="chat", run_id=run_id)
        except Exception:
            model = "local_lemonade"

    _run_store().save_run(RunRecord(
        run_id=run_id, manifest_id=MANIFEST_ID, workspace=workspace,
        status=RunStatus.RUNNING, started_at=_now(),
        manifest_snapshot={"goal": goal, "panel_count": panel_count, "model": model},
    ))

    try:
        plan = await _decompose(goal, model, run_id, workspace, panel_count)

        # Parallelism follows the configured endpoint pool: if the active model's
        # provider has >1 machine endpoint (BENNY_MODEL_ENDPOINTS), fan the panel
        # calls out concurrently across them; otherwise stay sequential (one local
        # endpoint serializes anyway, and order stays deterministic).
        concurrency = _fanout_concurrency(model, len(plan["panels"]))
        if concurrency <= 1:
            panels: List[Dict[str, Any]] = []
            for index, spec in enumerate(plan["panels"]):
                panels.append(await _produce_panel(spec, goal, model, run_id, workspace, index))
        else:
            sem = asyncio.Semaphore(concurrency)

            async def _bounded(index: int, spec: Dict[str, Any]) -> Dict[str, Any]:
                async with sem:
                    return await _produce_panel(spec, goal, model, run_id, workspace, index)

            panels = list(await asyncio.gather(
                *(_bounded(i, s) for i, s in enumerate(plan["panels"]))))

        view: Dict[str, Any] = {
            "format": VIEW_FORMAT,
            "title": plan["title"],
            "goal": goal,
            "created_from_run": run_id,
            "generated_by": model,
            "generated_at": _now(),
            "panels": panels,
            "review": None,
        }
        view["review"] = await _review(view, goal, model, run_id, workspace)
        rel_path = _write_view(workspace, run_id, view)

        _run_store().update_run_status(
            run_id, RunStatus.COMPLETED,
            artifact_paths=[rel_path], final_document=view["title"],
            node_states={p["id"]: "completed" for p in panels},
        )
        return {"run_id": run_id, "status": "completed", "view": view,
                "view_path": rel_path, "model": model}
    except Exception as exc:
        _emit_node(workspace, run_id, "error", "failed", reasoning=str(exc))
        _run_store().update_run_status(run_id, RunStatus.FAILED, errors=[str(exc)])
        raise


def load_run_result(run_id: str, workspace: str = "default") -> Dict[str, Any]:
    """Return ``{run_id, status, view?, error?}`` for a deep-produce run, reading
    the run record and (when complete) the persisted view artifact."""
    rec = _run_store().get_run(run_id)
    if not rec:
        return {"run_id": run_id, "status": "unknown", "error": "run not found"}
    result: Dict[str, Any] = {"run_id": run_id, "status": rec.status.value if hasattr(rec.status, "value") else str(rec.status)}
    if rec.errors:
        result["error"] = rec.errors[0]
    for rel in rec.artifact_paths or []:
        if rel.endswith(".aamp.view"):
            try:
                view_path = get_workspace_path(workspace) / rel
                result["view"] = json.loads(view_path.read_text(encoding="utf-8"))
            except Exception as exc:
                result["error"] = f"could not read view artifact: {exc}"
            break
    return result
