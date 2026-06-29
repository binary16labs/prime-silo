"""End-to-end orchestration: submit -> route -> execute -> gate -> digest.

This is the heart of ADR-004. It enforces the two disciplines that actually save
the planner's tokens:

1. Red tasks never run the executor — they escalate immediately with a one-line
   reason. The planner keeps the hard 25%.
2. Everything the planner reads back is a **compact digest** (:func:`build_digest`),
   never the raw artifact. The full artifact + logs are persisted to the outbox
   for human promotion (ADR-001), not streamed back into the planner's context.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import gate as gate_mod
from . import ledger as ledger_mod
from .executor import execute, ExecResult
from .manifest import OffloadManifest, from_dict
from .paths import offload_subdir, INBOX, OUTBOX
from .router import classify, RouterDecision

logger = logging.getLogger(__name__)


@dataclass
class TaskOutcome:
    task_id: str
    status: str                       # passed | failed | escalated | red-escalated
    final_tier: str
    escalate: bool
    digest: Dict[str, Any]
    outbox_path: Optional[str] = None


def _resolve_models(manifest: OffloadManifest, decision: RouterDecision) -> tuple[str, str]:
    defaults = decision.defaults
    exec_model = manifest.executor_model or defaults.get("executor_model", "")
    judge_model = manifest.judge_model or defaults.get("judge_model", "")
    return exec_model, judge_model


def build_digest(manifest: OffloadManifest, decision: RouterDecision,
                 status: str, *, exec_result: Optional[ExecResult] = None,
                 gate_result: Optional["gate_mod.GateResult"] = None,
                 iterations: int = 0, reason: str = "",
                 outbox_path: Optional[str] = None) -> Dict[str, Any]:
    """The ONLY thing the planner reads back. Deliberately tiny — pointers, not dumps."""
    digest: Dict[str, Any] = {
        "task_id": manifest.id,
        "status": status,                       # passed | failed | escalated | red-escalated
        "tier": decision.final_tier,
        "tier_upgraded_from": decision.declared_tier if decision.upgraded else None,
        "router": decision.reasons[0] if decision.reasons else "",
    }
    if gate_result is not None:
        digest["gate"] = gate_result.summary
        if gate_result.judge_score is not None:
            digest["judge_score"] = round(gate_result.judge_score, 2)
        failed = [c.command for c in gate_result.checks if not c.ok]
        if failed:
            # one short pointer per failed check, not the full output
            digest["failed_checks"] = failed[:5]
    if reason:
        digest["reason"] = reason
    if iterations:
        digest["iterations"] = iterations
    if outbox_path:
        digest["artifact"] = outbox_path        # pointer; planner reads only if it must
    digest["next"] = {
        "passed": "human-promote outbox artifact via signed manifest (ADR-001)",
        "escalated": "planner adjudication required",
        "failed": "planner adjudication required",
        "red-escalated": "planner must handle directly (not offloadable)",
    }.get(status, "")
    return digest


def _write_outbox(manifest: OffloadManifest, payload: Dict[str, Any]) -> str:
    out_dir = offload_subdir(manifest.workspace, OUTBOX)
    path = out_dir / f"{manifest.id}.result.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


async def run_task(data: Dict[str, Any]) -> TaskOutcome:
    """Run a single task dict (already-parsed manifest JSON) to completion."""
    start = time.time()
    manifest = from_dict(data)                  # raises ManifestError on bad input
    decision = classify(manifest)
    exec_model, judge_model = _resolve_models(manifest, decision)

    # --- RED: never offload -------------------------------------------------
    if decision.escalate_immediately:
        reason = decision.reasons[0] if decision.reasons else "classified red"
        digest = build_digest(manifest, decision, "red-escalated", reason=reason)
        ledger_mod.record(ledger_mod.LedgerEntry(
            task_id=manifest.id, workspace=manifest.workspace, ts=ledger_mod.now_iso(),
            declared_tier=decision.declared_tier, final_tier=decision.final_tier,
            upgraded=decision.upgraded, status="red-escalated", escalated=True,
            iterations=0, local_model="", judge_model="",
            local_prompt_tokens=0, local_completion_tokens=0, judge_score=None,
            collusion_flag=False, digest_chars=len(json.dumps(digest)),
            artifact_chars=0, duration_ms=int((time.time() - start) * 1000),
            planner_tokens_saved_estimate=0, note=reason,
        ))
        return TaskOutcome(manifest.id, "red-escalated", decision.final_tier, True, digest)

    # --- GREEN / YELLOW: execute with bounded retries -----------------------
    last_exec: Optional[ExecResult] = None
    last_gate: Optional[gate_mod.GateResult] = None
    iterations = 0
    for iterations in range(1, manifest.max_iterations + 1):
        last_exec = await execute(manifest, exec_model)
        if not last_exec.ok:
            # executor itself failed (e.g. local server down) — retry within budget
            continue
        last_gate = await gate_mod.evaluate(
            manifest, last_exec.artifact, decision.final_tier, exec_model, judge_model
        )
        if last_gate.passed or not last_gate.escalate:
            break
        if last_gate.escalate:
            break

    passed = bool(last_gate and last_gate.passed)
    escalate = bool(last_gate and last_gate.escalate) or (last_exec is not None and not last_exec.ok)
    status = "passed" if passed else ("escalated" if escalate else "failed")

    # persist full artifact + logs to outbox (human-promotable, NOT read by planner)
    outbox_payload = {
        "task_id": manifest.id,
        "status": status,
        "tier": decision.final_tier,
        "router_reasons": decision.reasons,
        "executor": {
            "mode": last_exec.mode if last_exec else "",
            "model": exec_model,
            "ok": last_exec.ok if last_exec else False,
            "error": last_exec.error if last_exec else "executor never ran",
            "artifact": last_exec.artifact if last_exec else "",
        },
        "gate": {
            "summary": last_gate.summary if last_gate else "gate never ran",
            "deterministic_ok": last_gate.deterministic_ok if last_gate else False,
            "checks": [
                {"command": c.command, "ok": c.ok, "exit_code": c.exit_code,
                 "output_tail": c.output_tail}
                for c in (last_gate.checks if last_gate else [])
            ],
            "judge_score": last_gate.judge_score if last_gate else None,
            "judge_rationale": last_gate.judge_rationale if last_gate else "",
            "collusion_flag": last_gate.collusion_flag if last_gate else False,
        },
        "iterations": iterations,
        "generated_at": ledger_mod.now_iso(),
    }
    outbox_path = _write_outbox(manifest, outbox_payload)

    digest = build_digest(
        manifest, decision, status, exec_result=last_exec, gate_result=last_gate,
        iterations=iterations,
        outbox_path=outbox_path if status != "red-escalated" else None,
    )

    artifact_chars = len(last_exec.artifact) if last_exec else 0
    completion_tokens = last_exec.completion_tokens if last_exec else 0
    ledger_mod.record(ledger_mod.LedgerEntry(
        task_id=manifest.id, workspace=manifest.workspace, ts=ledger_mod.now_iso(),
        declared_tier=decision.declared_tier, final_tier=decision.final_tier,
        upgraded=decision.upgraded, status=status, escalated=escalate,
        iterations=iterations, local_model=exec_model, judge_model=judge_model,
        local_prompt_tokens=last_exec.prompt_tokens if last_exec else 0,
        local_completion_tokens=completion_tokens,
        judge_score=last_gate.judge_score if last_gate else None,
        collusion_flag=last_gate.collusion_flag if last_gate else False,
        digest_chars=len(json.dumps(digest)),
        artifact_chars=artifact_chars,
        duration_ms=int((time.time() - start) * 1000),
        # ESTIMATE: deliverable tokens the planner did not have to generate.
        planner_tokens_saved_estimate=(completion_tokens if passed else 0),
        note=last_gate.summary if last_gate else "",
    ))

    return TaskOutcome(manifest.id, status, decision.final_tier, escalate, digest, outbox_path)


# ---- async queue lane ------------------------------------------------------

def enqueue(data: Dict[str, Any]) -> str:
    """Drop a validated manifest into the workspace inbox for the async runner."""
    manifest = from_dict(data)
    inbox = offload_subdir(manifest.workspace, INBOX)
    path = inbox / f"{manifest.id}.task.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def list_inbox(workspace: str = "default") -> List[str]:
    inbox = offload_subdir(workspace, INBOX)
    return sorted(str(p) for p in inbox.glob("*.task.json"))
