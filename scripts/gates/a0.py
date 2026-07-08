#!/usr/bin/env python3
"""Gate A0 — verify the real local offload path (ADR-004), not presumed.

Runs against the REAL lemonade endpoint (no mocks). Per the A0 contract:

  1. Probe lemonade health; record model id + ctx. Exit 1 reason=service_down
     if unreachable — that is a valid, honest failure, not a soft-pass.
  2. Run a trivial example manifest through the sync lane (``run_task`` — the
     same call the ``offload_exec`` MCP route makes) AND through the async
     lane (``enqueue`` -> inbox -> drain via ``run_task``, exactly what
     scripts/offload-runner.mjs does against a live server).
  3. Run judge calibration (5 known-good + 5 known-bad, seeded from the
     measured failure taxonomy) against the real judge model.
  4. Log the resolved workspace path explicitly (the manifest.workspace
     silently-overrides-env lesson from LONGVIEW).
  5. Assert total wall time < 5 minutes.

Watchdog unit coverage (wedge detection, prefill vs wedge, PID respawn) lives
in runtime/tests/offload/test_watchdog.py and is run here as part of the
overall pytest pass so the gate fails if that regresses.

Exit 0 = gate green. Exit 1 = honest failure (service_down or any scenario
not met) — never a silent pass.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RUN_TAG = str(int(time.time()))
REQUIRED_EXEC_MODEL = "qwen3.5-9b-FLM"  # A0 contract: prove the real qwen3.5-9B-FLM path
JUDGE_MODEL = "Phi-4-mini-instruct-NPU"  # per manifests/offload/JUDGE-CALIBRATION.md


def _model_matches(actual: str, required: str) -> bool:
    """Case-insensitive match tolerant of a ``lemonade/`` provider prefix.

    Owner-observed 2026-07-08: the executor was resolving to Phi-4, not qwen —
    the A8 catalog-roulette failure mode (unpinned default-role -> catalog
    models[0]). The gate MUST prove the real qwen path ran, so this comparison
    is used to hard-fail (not merely note) when the responding executor is not
    qwen3.5-9B-FLM.
    """
    a = (actual or "").split("/")[-1].strip().lower()
    r = (required or "").split("/")[-1].strip().lower()
    return a == r

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "runtime"
WORKSPACE = "a0-gate"
LEMONADE_HEALTH = "http://127.0.0.1:13305/api/v1/health"
WALL_CEILING_S = 5 * 60

sys.path.insert(0, str(RUNTIME))


def _log(msg: str) -> None:
    print(f"[a0] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# 1. lemonade probe
# --------------------------------------------------------------------------- #


def probe_lemonade() -> dict | None:
    """Return {"model_id", "ctx"} or None if the service is unreachable.

    KNOWN QUIRK (A8 lesson): lemonade reports loaded models under
    ``all_models_loaded[].model_name`` (a list), not a flat ``model_loaded``
    key alone. Probe the list form; fall back to the flat key if present.
    """
    try:
        with urllib.request.urlopen(LEMONADE_HEALTH, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        _log(f"lemonade health probe failed: {exc}")
        return None
    except Exception as exc:  # pragma: no cover - defensive
        _log(f"lemonade health probe failed unexpectedly: {exc}")
        return None

    loaded = data.get("all_models_loaded") or []
    if loaded:
        entry = loaded[0]
        model_id = entry.get("model_name", "")
        ctx = (entry.get("recipe_options") or {}).get("ctx_size")
        return {"model_id": model_id, "ctx": ctx, "raw": data}

    flat = data.get("model_loaded")
    if flat:
        return {"model_id": flat, "ctx": None, "raw": data}

    return None


# --------------------------------------------------------------------------- #
# 2. trivial manifests
# --------------------------------------------------------------------------- #


def _trivial_green_manifest(task_id: str) -> dict:
    """A fast, deterministic GREEN shell task — proves the pipe end-to-end
    without paying a full generation's wall time on every lane."""
    return {
        "format": "aamp.offload_task/1",
        "id": task_id,
        "intent": "a0 gate smoke task: print a fixed marker and exit zero",
        "risk_tier": "green",
        "executor": {"mode": "shell", "command": 'python -c "print(\'a0-gate-ok\')"'},
        "eval_plan": {"deterministic": ['python -c "raise SystemExit(0)"']},
        "acceptance_criteria": [
            {"id": "ac1", "statement": "exits zero", "verify": 'python -c "raise SystemExit(0)"'}
        ],
        "budget": {"max_iterations": 1, "max_seconds": 60},
        "workspace": WORKSPACE,
    }


def _real_model_manifest(task_id: str, model_id: str) -> dict:
    """A trivial GENERATE task that actually calls the real executor model —
    proves the real qwen3.5-9B-FLM endpoint executes, not just the shell lane.
    Kept tiny (short prompt, small max output) to respect the 5-minute wall
    budget even at the measured ~22s TTFT / 8.33 tok/s."""
    return {
        "format": "aamp.offload_task/1",
        "id": task_id,
        "intent": "a0 gate real-model smoke: reply with the single word ready",
        "risk_tier": "yellow",
        "executor": {
            "mode": "generate",
            "model": f"lemonade/{model_id}",
            "prompt": "Reply with exactly one word: ready",
        },
        "eval_plan": {"judge": {"enabled": False}},
        "acceptance_criteria": [{"id": "ac1", "statement": "produces a non-empty reply"}],
        "budget": {"max_iterations": 1, "max_seconds": 240},
        "escalation_policy": "on_fail",
        "workspace": WORKSPACE,
    }


async def run_sync_lane():
    from benny.core.offload.orchestrator import run_task

    # Always target the contract-required model explicitly rather than trust
    # whatever the health probe reported a moment ago: lemonade's llm slot
    # holds exactly one model (max_models.llm == 1) and a prior calibration
    # call in the same process can evict it. Pinning here is what actually
    # proves "qwen3.5-9B-FLM @16k", not just "whatever happens to be loaded".
    manifest = _real_model_manifest(f"a0-gate-sync-real-{RUN_TAG}", REQUIRED_EXEC_MODEL)
    _log(
        f"sync lane (offload_exec path): submitting {manifest['id']} "
        f"against lemonade/{REQUIRED_EXEC_MODEL}"
    )
    outcome = await run_task(manifest)
    _log(f"sync lane result: status={outcome.status} tier={outcome.final_tier}")
    return outcome


async def run_async_lane():
    from benny.core.offload.orchestrator import enqueue, list_inbox, run_task
    from benny.core.offload.paths import offload_root

    manifest = _trivial_green_manifest(f"a0-gate-async-green-{RUN_TAG}")
    path = enqueue(manifest)
    _log(f"async lane: enqueued {manifest['id']} -> {path}")
    pending_before = list_inbox(WORKSPACE)
    _log(f"async lane: inbox before drain: {len(pending_before)} task(s)")

    # This is exactly what scripts/offload-runner.mjs does against a live
    # server for each queued file: read, submit (wait=1 semantics == run_task),
    # move to processed/. We call run_task directly to avoid needing the full
    # FastAPI server up for the gate (the HTTP route is a thin wrapper — see
    # runtime/benny/api/offload_routes.py::submit).
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    outcome = await run_task(data)
    processed_dir = offload_root(WORKSPACE) / "processed"
    processed_dir.mkdir(parents=True, exist_ok=True)
    dest = processed_dir / Path(path).name
    if dest.exists():
        dest.unlink()  # idempotent: a stale file from a prior interrupted run
    Path(path).rename(dest)
    _log(f"async lane result: status={outcome.status} tier={outcome.final_tier}")
    return outcome


# --------------------------------------------------------------------------- #
# 3. judge calibration
# --------------------------------------------------------------------------- #


async def run_calibration(judge_model: str):
    from benny.core.offload import calibration as C

    results = await C.calibrate(f"lemonade/{judge_model}", threshold=0.8)
    correct = sum(1 for r in results if r.correct)
    for r in results:
        mark = "OK" if r.correct else "MISCALIBRATED"
        _log(f"  calibration[{r.fixture_id}] expected={r.label} score={r.score} -> {mark}")
    _log(f"judge calibration: {correct}/{len(results)} correct")
    return results, correct


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def run_watchdog_unit_tests() -> bool:
    _log("running watchdog + calibration unit tests (network-free)")
    p = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/offload/test_watchdog.py",
            "tests/offload/test_calibration.py",
            "-q",
        ],
        cwd=str(RUNTIME),
    )
    return p.returncode == 0


def main() -> int:
    start = time.time()

    if not run_watchdog_unit_tests():
        _log("GATE FAILED: watchdog/calibration unit tests did not pass")
        return 1

    health = probe_lemonade()
    if health is None:
        _log("GATE FAILED reason=service_down: lemonade unreachable at " f"{LEMONADE_HEALTH}")
        return 1

    model_id = health["model_id"]
    ctx = health["ctx"]
    _log(f"lemonade reachable: currently-loaded model_id={model_id} ctx={ctx}")
    if not _model_matches(model_id, REQUIRED_EXEC_MODEL):
        _log(
            f"note: currently-loaded model is '{model_id}', not '{REQUIRED_EXEC_MODEL}' — "
            f"the sync lane will request the required model explicitly and lemonade will "
            f"load it on demand (its llm slot holds exactly one model at a time). The "
            f"post-sync re-probe HARD-FAILS the gate if qwen is not what actually responded."
        )

    from benny.core.offload.paths import offload_root

    resolved_ws = offload_root(WORKSPACE)
    _log(f"resolved workspace -> {resolved_ws}")  # the LONGVIEW manifest.workspace lesson

    ok = True

    try:
        sync_outcome = asyncio.run(run_sync_lane())
        ok &= sync_outcome.status in ("passed", "escalated")  # escalated is still a real, honest run
        # HARD proof the real qwen path ran (owner catch 2026-07-08: executor
        # was resolving to Phi-4 via catalog roulette). The sync lane pinned and
        # forced-loaded qwen on demand; re-probe NOW — before the judge phase
        # requests Phi-4 and evicts it from lemonade's single llm slot — and
        # fail loudly if the responding executor is not qwen3.5-9B-FLM.
        post = probe_lemonade()
        responded = post["model_id"] if post else ""
        if not _model_matches(responded, REQUIRED_EXEC_MODEL):
            _log(
                f"GATE FAILED reason=wrong_executor_model: after the sync lane the "
                f"loaded executor is '{responded}', not '{REQUIRED_EXEC_MODEL}'. "
                f"This is the A8 catalog-roulette failure — the real qwen path was NOT proven."
            )
            ok = False
        else:
            _log(f"executor confirmed: responding model is '{responded}' (qwen path proven)")
    except Exception as exc:
        _log(f"sync lane raised: {exc}")
        ok = False

    try:
        async_outcome = asyncio.run(run_async_lane())
        ok &= async_outcome.status == "passed"
    except Exception as exc:
        _log(f"async lane raised: {exc}")
        ok = False

    try:
        _, correct = asyncio.run(run_calibration(JUDGE_MODEL))
        ok &= correct == 10
    except Exception as exc:
        _log(f"judge calibration raised: {exc}")
        ok = False

    wall_s = time.time() - start
    _log(f"wall time: {wall_s:.1f}s (ceiling {WALL_CEILING_S}s)")
    ok &= wall_s < WALL_CEILING_S

    if not ok:
        _log("GATE FAILED")
        return 1

    _log(
        f"GATE GREEN — executor_model={REQUIRED_EXEC_MODEL} ctx={ctx} judge={JUDGE_MODEL} "
        f"wall_s={wall_s:.1f} workspace={resolved_ws}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
