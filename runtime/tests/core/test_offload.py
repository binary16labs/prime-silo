"""ADR-004 — Local Offload Orchestrator tests.

Network-free: every test here exercises the routing, validation, deterministic
gate, orchestration control-flow, and ledger WITHOUT a running local model. The
LLM-judge / generate paths are covered by their contract (router escalation,
graceful "model unavailable") rather than by hitting a server.
"""

from __future__ import annotations

import json

import pytest

from benny.core.offload import manifest as M
from benny.core.offload import router as R
from benny.core.offload import gate as G
from benny.core.offload import ledger as L
from benny.core.offload import orchestrator as O


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
