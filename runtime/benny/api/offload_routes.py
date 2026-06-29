"""ADR-004 — Local Offload Orchestrator routes.

Surface for the sync (MCP ``offload_exec``) and async (queue) lanes. The planner
submits an ``aamp.offload_task/1`` manifest; the orchestrator routes, executes
locally, runs the gate, and returns a **compact digest** — never the raw
artifact. The full artifact is persisted to the workspace outbox for human
promotion (ADR-001).

Mounted at ``/api/offload`` in ``server.py``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..core.offload import manifest as manifest_mod
from ..core.offload import ledger as ledger_mod
from ..core.offload.orchestrator import enqueue, list_inbox, run_task
from ..core.offload.paths import offload_subdir, OUTBOX
from ..core.offload.router import classify

router = APIRouter()


class SubmitResponse(BaseModel):
    task_id: str
    mode: str                     # "sync" | "enqueued"
    digest: Optional[Dict[str, Any]] = None
    queued_path: Optional[str] = None


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "format": manifest_mod.FORMAT}


@router.post("/validate")
async def validate(task: Dict[str, Any]) -> dict:
    """Validate a manifest against the contract without running it."""
    problems = manifest_mod.validate_manifest(task)
    if problems:
        return {"valid": False, "problems": problems}
    m = manifest_mod.from_dict(task)
    decision = classify(m)
    return {
        "valid": True,
        "declared_tier": decision.declared_tier,
        "final_tier": decision.final_tier,
        "upgraded": decision.upgraded,
        "would_escalate_immediately": decision.escalate_immediately,
        "reasons": decision.reasons,
    }


@router.post("/submit", response_model=SubmitResponse)
async def submit(
    task: Dict[str, Any],
    wait: bool = Query(False, description="true = run now and return the digest (sync MCP lane); "
                                          "false = enqueue for the async runner."),
) -> SubmitResponse:
    problems = manifest_mod.validate_manifest(task)
    if problems:
        raise HTTPException(status_code=400, detail={"problems": problems})

    if wait:
        try:
            outcome = await run_task(task)
        except manifest_mod.ManifestError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return SubmitResponse(task_id=outcome.task_id, mode="sync", digest=outcome.digest)

    try:
        queued = enqueue(task)
    except manifest_mod.ManifestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SubmitResponse(task_id=task.get("id", ""), mode="enqueued", queued_path=queued)


@router.get("/result/{workspace}/{task_id}")
async def result(workspace: str, task_id: str, full: bool = Query(False)) -> dict:
    """Fetch a finished task. Default returns the compact outbox payload; ``full``
    includes the raw artifact (use sparingly — that's the expensive read)."""
    out = offload_subdir(workspace, OUTBOX) / f"{task_id}.result.json"
    if not out.is_file():
        raise HTTPException(status_code=404, detail=f"no result for '{task_id}' in '{workspace}'")
    import json
    payload = json.loads(out.read_text(encoding="utf-8"))
    if not full:
        # strip the heavy artifact from the response; leave a pointer
        payload.get("executor", {}).pop("artifact", None)
        payload["artifact_available_via"] = f"/api/offload/result/{workspace}/{task_id}?full=1"
    return payload


@router.get("/queue/{workspace}")
async def queue(workspace: str) -> dict:
    return {"workspace": workspace, "pending": list_inbox(workspace)}


@router.get("/ledger/{workspace}")
async def ledger(workspace: str) -> dict:
    """Raw ledger rows — feeds scripts/offload-report.mjs. Honest components only."""
    return {"workspace": workspace, "entries": ledger_mod.read_all(workspace)}
