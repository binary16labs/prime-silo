"""ADR-004 — Local Offload Orchestrator tests.

Network-free: every test here runs WITHOUT a real local model. Control-flow
(routing, validation, deterministic gate, ledger) runs directly; the
generate/judge/route network paths are exercised with a fake executor injected via
``resolve_executor`` so no server is required.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from benny.core.offload import manifest as M
from benny.core.offload import router as R
from benny.core.offload import gate as G
from benny.core.offload import ledger as L
from benny.core.offload import orchestrator as O
from benny.core.offload import executor as E


class _FakeExec:
    """Stand-in for a resolved local executor (LC-1/LC-3 surface)."""

    def __init__(self, reply):
        self._reply = reply  # str to return, or Exception to raise

    async def generate(self, prompt, system=None, **kwargs):
        if isinstance(self._reply, Exception):
            raise self._reply
        return self._reply

    def count_tokens(self, text):
        return len((text or "").split())


@pytest.fixture
def fake_models(monkeypatch):
    """Inject fake executors keyed by model string. Pass a {model: reply} map."""
    def _install(mapping):
        def _resolve(model_str):
            if model_str in mapping:
                return _FakeExec(mapping[model_str])
            return None
        # gate.py and executor.py both do `from ..local_executor import resolve_executor`
        # at call time, so patching the source module covers both.
        monkeypatch.setattr("benny.core.local_executor.resolve_executor", _resolve)
    return _install


@pytest.fixture
def offload_root(tmp_path, monkeypatch):
    """Redirect the workspace root (and therefore all offload paths) to a tmp dir."""
    root = (tmp_path / "workspace").resolve()
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("benny.core.workspace.WORKSPACE_ROOT", root)
    return root


def _green_task(**over):
    base = {
        "format": "aamp.offload_task/1",
        "id": "t-green",
        "intent": "a trivial deterministic task that just needs to exit zero",
        "risk_tier": "green",
        "executor": {"mode": "shell", "command": "python -c \"pass\""},
        "eval_plan": {"deterministic": ["python -c \"raise SystemExit(0)\""]},
        "acceptance_criteria": [
            {"id": "ac1", "statement": "exit zero", "verify": "python -c \"raise SystemExit(0)\""}
        ],
    }
    base.update(over)
    return base


# --------------------------------------------------------------------------- #
# manifest validation
# --------------------------------------------------------------------------- #

def test_validate_accepts_good_manifest():
    assert M.validate_manifest(_green_task()) == []


def test_validate_collects_all_problems():
    bad = {"format": "wrong", "id": "X", "intent": "x", "acceptance_criteria": [], "risk_tier": "blue"}
    problems = M.validate_manifest(bad)
    assert any("format" in p for p in problems)
    assert any("id must match" in p for p in problems)
    assert any("risk_tier" in p for p in problems)
    assert any("acceptance_criteria" in p for p in problems)


def test_from_dict_raises_on_invalid():
    with pytest.raises(M.ManifestError):
        M.from_dict({"format": "aamp.offload_task/1", "id": "ok-id", "intent": "too short?",
                     "risk_tier": "green", "acceptance_criteria": []})


def test_deterministic_checks_fold_in_verify_commands():
    m = M.from_dict(_green_task())
    # one explicit eval_plan check + one ac.verify, deduped
    assert m.deterministic_checks.count("python -c \"raise SystemExit(0)\"") == 1


# --------------------------------------------------------------------------- #
# router
# --------------------------------------------------------------------------- #

def test_router_keeps_declared_green():
    d = R.classify(M.from_dict(_green_task()))
    assert d.final_tier == "green" and not d.upgraded


def test_router_forces_red_on_guarded_path():
    d = R.classify(M.from_dict(_green_task(id="t-red-path", allowed_paths=["manifests/x.json"])))
    assert d.final_tier == "red" and d.escalate_immediately and d.upgraded


def test_router_forces_red_on_security_intent():
    d = R.classify(M.from_dict(_green_task(
        id="t-red-int", intent="rotate the signing key used for auth credentials")))
    assert d.final_tier == "red"


def test_router_upgrades_green_without_verify_to_yellow():
    task = {
        "format": "aamp.offload_task/1", "id": "t-noverify",
        "intent": "produce something judgemental with no deterministic check",
        "risk_tier": "green",
        "acceptance_criteria": [{"id": "ac1", "statement": "looks good"}],
    }
    d = R.classify(M.from_dict(task))
    assert d.final_tier == "yellow" and d.upgraded


def test_router_never_downgrades():
    d = R.classify(M.from_dict(_green_task(id="t-redkeep", risk_tier="red")))
    assert d.final_tier == "red"


def test_router_upgrades_generate_green_to_yellow():
    # a generate proposal is unapplied; deterministic checks can't validate it
    task = _green_task(id="t-gen", executor={"mode": "generate", "model": "lemonade/x",
                                             "prompt": "do it"})
    d = R.classify(M.from_dict(task))
    assert d.final_tier == "yellow" and d.upgraded
    assert any("generate" in r for r in d.reasons)


@pytest.mark.asyncio
async def test_generate_without_judge_escalates_not_passes(offload_root):
    # generate + judge disabled must NOT auto-pass on deterministic checks
    m = M.from_dict(_green_task(
        id="t-gen-nojudge",
        executor={"mode": "generate", "model": "lemonade/x", "prompt": "do it"},
        eval_plan={"deterministic": ["python -c \"raise SystemExit(0)\""],
                   "judge": {"enabled": False}},
    ))
    res = await G.evaluate(m, artifact="some proposed code", final_tier="green",
                           executor_model="lemonade/x", judge_model="")
    assert not res.passed and res.escalate and "deterministic checks" in res.summary


# --------------------------------------------------------------------------- #
# deterministic gate
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_deterministic_gate_pass():
    checks = await G.run_deterministic(M.from_dict(_green_task()))
    assert all(c.ok for c in checks) and len(checks) == 1


@pytest.mark.asyncio
async def test_deterministic_gate_failure_escalates():
    m = M.from_dict(_green_task(
        id="t-fail",
        eval_plan={"deterministic": ["python -c \"raise SystemExit(1)\""]},
        acceptance_criteria=[{"id": "ac1", "statement": "fails", "verify": "python -c \"raise SystemExit(1)\""}],
    ))
    res = await G.evaluate(m, artifact="", final_tier="green",
                           executor_model="lemonade/x", judge_model="ollama/y")
    assert not res.passed and not res.deterministic_ok and res.escalate


def test_extract_last_json_survives_reasoning_prefix():
    # a reasoning judge emits prose (and maybe stray braces) before the verdict
    reply = (
        "Okay, let me think. The function should collapse {runs}. "
        "Considering criterion ac1... and ac2...\n\n"
        '{"score": 0.9, "rationale": "meets both", "unmet": []}'
    )
    data = G._extract_last_json(reply)
    assert data is not None and data["score"] == 0.9 and data["unmet"] == []


def test_extract_last_json_strips_think_block():
    reply = '<think>maybe {0.2}? no...</think>\n{"score": 0.75, "rationale": "ok"}'
    data = G._extract_last_json(reply)
    assert data is not None and data["score"] == 0.75


def test_extract_last_json_returns_none_when_absent():
    assert G._extract_last_json("no json here, just reasoning that never finished") is None


@pytest.mark.asyncio
async def test_green_passes_on_deterministic_only_without_judge():
    res = await G.evaluate(M.from_dict(_green_task()), artifact="ok", final_tier="green",
                           executor_model="lemonade/x", judge_model="ollama/y")
    assert res.passed and not res.judge_ran


# --------------------------------------------------------------------------- #
# orchestrator
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_red_task_escalates_without_running_executor(offload_root):
    out = await O.run_task(_green_task(id="t-redflow", risk_tier="red"))
    assert out.status == "red-escalated" and out.escalate
    # red digest must NOT carry an artifact pointer (executor never ran)
    assert "artifact" not in out.digest


@pytest.mark.asyncio
async def test_green_shell_task_passes_and_writes_outbox(offload_root):
    out = await O.run_task(_green_task(id="t-greenflow"))
    assert out.status == "passed" and out.final_tier == "green"
    assert out.outbox_path and out.outbox_path.endswith("t-greenflow.result.json")
    payload = json.loads(open(out.outbox_path, encoding="utf-8").read())
    assert payload["gate"]["deterministic_ok"] is True


@pytest.mark.asyncio
async def test_digest_is_compact_relative_to_outbox(offload_root):
    out = await O.run_task(_green_task(id="t-compact"))
    digest_size = len(json.dumps(out.digest))
    outbox_size = len(open(out.outbox_path, encoding="utf-8").read())
    # the whole point: the planner reads the digest, never the full outbox
    assert digest_size < outbox_size
    assert digest_size < 800  # stays tiny


# --------------------------------------------------------------------------- #
# async queue lane + ledger
# --------------------------------------------------------------------------- #

def test_enqueue_and_list_inbox(offload_root):
    path = O.enqueue(_green_task(id="t-queued"))
    assert path.endswith("t-queued.task.json")
    assert any("t-queued" in p for p in O.list_inbox("default"))


@pytest.mark.asyncio
async def test_ledger_records_each_task(offload_root):
    await O.run_task(_green_task(id="t-led1"))
    await O.run_task(_green_task(id="t-led2", risk_tier="red"))
    rows = L.read_all("default")
    ids = {r["task_id"] for r in rows}
    assert {"t-led1", "t-led2"} <= ids
    red_row = next(r for r in rows if r["task_id"] == "t-led2")
    assert red_row["status"] == "red-escalated" and red_row["planner_tokens_saved_estimate"] == 0


# --------------------------------------------------------------------------- #
# executor — generate path (fake model)
# --------------------------------------------------------------------------- #

def _generate_task(**over):
    base = {
        "format": "aamp.offload_task/1", "id": "t-gen-exec", "risk_tier": "yellow",
        "intent": "produce a slugify function meeting the criteria",
        "acceptance_criteria": [{"id": "ac1", "statement": "defines slugify(s)"}],
        "executor": {"mode": "generate", "model": "fake/exec", "prompt": "write it"},
        "eval_plan": {"judge": {"enabled": True, "model": "fake/judge", "pass_threshold": 0.8}},
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_executor_generate_returns_artifact(fake_models):
    fake_models({"fake/exec": "def slugify(s): return s"})
    res = await E.execute(M.from_dict(_generate_task()), "fake/exec")
    assert res.ok and "slugify" in res.artifact and res.completion_tokens > 0


def test_gather_context_handles_real_and_missing_pointers(tmp_path):
    f = tmp_path / "ctx.py"
    f.write_text("# real file contents", encoding="utf-8")
    from benny.core.offload.executor import _gather_context
    blob = _gather_context(M.from_dict(_generate_task(
        id="t-ctx", context_pointers=[f"{f}:somesymbol", "not/a/real/file.xyz"])), tmp_path)
    assert "real file contents" in blob and "not a local file" in blob


@pytest.mark.asyncio
async def test_executor_generate_model_unavailable(fake_models):
    fake_models({})  # nothing resolves
    res = await E.execute(M.from_dict(_generate_task()), "fake/missing")
    assert not res.ok and "no local executor" in res.error


# --------------------------------------------------------------------------- #
# judge — fake model
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_run_judge_parses_score(fake_models):
    fake_models({"fake/judge": 'reasoning... {"score": 0.9, "rationale": "ok", "unmet": []}'})
    m = M.from_dict(_generate_task())
    v = await G.run_judge(m, "def slugify(s): ...", "fake/judge")
    assert v["score"] == 0.9 and v["available"]


@pytest.mark.asyncio
async def test_run_judge_unparseable_after_retry(fake_models):
    fake_models({"fake/judge": "no json at all, just prose"})
    v = await G.run_judge(M.from_dict(_generate_task()), "x", "fake/judge")
    assert v["score"] is None


@pytest.mark.asyncio
async def test_evaluate_yellow_judge_pass(fake_models):
    fake_models({"fake/judge": '{"score": 0.95, "rationale": "great"}'})
    m = M.from_dict(_generate_task())
    res = await G.evaluate(m, "artifact", "yellow", "fake/exec", "fake/judge")
    assert res.passed and res.judge_ran and res.judge_score == 0.95


@pytest.mark.asyncio
async def test_evaluate_yellow_judge_low_escalates(fake_models):
    fake_models({"fake/judge": '{"score": 0.2, "rationale": "missing things"}'})
    m = M.from_dict(_generate_task())
    res = await G.evaluate(m, "artifact", "yellow", "fake/exec", "fake/judge")
    assert not res.passed and res.escalate


@pytest.mark.asyncio
async def test_evaluate_collusion_flag(fake_models):
    fake_models({"same/model": '{"score": 0.95, "rationale": "ok"}'})
    m = M.from_dict(_generate_task(escalation_policy="on_low_confidence"))
    res = await G.evaluate(m, "artifact", "yellow", "same/model", "same/model")
    assert res.collusion_flag


# --------------------------------------------------------------------------- #
# orchestrator — generate end-to-end (fake models)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_orchestrator_generate_passes_end_to_end(offload_root, fake_models):
    fake_models({"fake/exec": "def slugify(s): return s.lower()",
                 "fake/judge": '{"score": 0.92, "rationale": "meets criteria"}'})
    out = await O.run_task(_generate_task(id="t-e2e"))
    assert out.status == "passed" and out.final_tier == "yellow"
    rows = L.read_all("default")
    row = next(r for r in rows if r["task_id"] == "t-e2e")
    assert row["planner_tokens_saved_estimate"] > 0 and row["local_completion_tokens"] > 0


@pytest.mark.asyncio
async def test_orchestrator_generate_escalates_on_low_judge(offload_root, fake_models):
    fake_models({"fake/exec": "bad code", "fake/judge": '{"score": 0.1, "rationale": "no"}'})
    out = await O.run_task(_generate_task(id="t-e2e-fail", budget={"max_iterations": 1}))
    assert out.status == "escalated" and out.escalate


# --------------------------------------------------------------------------- #
# API routes
# --------------------------------------------------------------------------- #

def test_routes_health_and_validate():
    import benny.api.offload_routes as RR
    assert asyncio.run(RR.health())["format"] == M.FORMAT
    bad = asyncio.run(RR.validate({"format": "x", "id": "y"}))
    assert bad["valid"] is False
    good = asyncio.run(RR.validate(_green_task(id="t-route-val")))
    assert good["valid"] and good["final_tier"] == "green"


def test_routes_submit_enqueue_and_queue(offload_root):
    import benny.api.offload_routes as RR
    resp = asyncio.run(RR.submit(_green_task(id="t-route-q"), wait=False))
    assert resp.mode == "enqueued" and resp.queued_path
    q = asyncio.run(RR.queue("default"))
    assert any("t-route-q" in p for p in q["pending"])


def test_routes_submit_wait_red(offload_root):
    import benny.api.offload_routes as RR
    resp = asyncio.run(RR.submit(_green_task(id="t-route-red", risk_tier="red"), wait=True))
    assert resp.mode == "sync" and resp.digest["status"] == "red-escalated"


def test_routes_result_and_ledger(offload_root):
    import benny.api.offload_routes as RR
    asyncio.run(O.run_task(_green_task(id="t-route-res")))
    res = asyncio.run(RR.result("default", "t-route-res", full=False))
    # default strips the heavy artifact and leaves a pointer
    assert "artifact_available_via" in res and res["executor"].get("artifact") is None
    led = asyncio.run(RR.ledger("default"))
    assert any(r["task_id"] == "t-route-res" for r in led["entries"])


def test_routes_result_missing_raises():
    import benny.api.offload_routes as RR
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(RR.result("default", "does-not-exist", full=False))
