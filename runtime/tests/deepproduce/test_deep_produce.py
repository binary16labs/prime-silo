"""Deep-produce orchestrator — decompose → fan-out → aggregate → review.

Drives the full loop against a stubbed ``call_model`` (no real model) inside an
isolated ``$BENNY_HOME`` with an in-memory run store. Asserts: the goal is
decomposed into N panels, one worker call fires per panel, the aggregator emits
a valid multi-panel ``.aamp.view``, the run is recorded as completed, and
per-stage NODE_EXECUTION_STATE events (with the run_id + reasoning_trace the
Bridge Runs widgets consume) are emitted.

The run store is injected via ``producer._run_store`` so the test does not pull
in benny.persistence (and its LangGraph checkpointer) — mirroring the lazy
import the producer uses for the same layering reason.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from benny.deepproduce import producer


class _FakeStore:
    """Minimal stand-in for benny.persistence.run_store."""

    def __init__(self):
        self.runs = {}

    def save_run(self, record):
        self.runs[record.run_id] = record
        return record

    def get_run(self, run_id):
        return self.runs.get(run_id)

    def update_run_status(self, run_id, status, errors=None, final_document=None,
                          artifact_paths=None, node_states=None, governance_url=None):
        rec = self.runs.get(run_id)
        if not rec:
            return None
        rec.status = status
        if errors is not None:
            rec.errors = list(errors)
        if final_document is not None:
            rec.final_document = final_document
        if artifact_paths is not None:
            rec.artifact_paths = list(artifact_paths)
        return rec


@pytest.fixture
def store(monkeypatch):
    fake = _FakeStore()
    monkeypatch.setattr(producer, "_run_store", lambda: fake)
    return fake


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    from benny.core import workspace as ws
    monkeypatch.setattr(ws, "WORKSPACE_ROOT", tmp_path / "workspaces", raising=False)
    return tmp_path


@pytest.fixture
def captured_events(monkeypatch):
    events = []
    monkeypatch.setattr(producer, "emit_governance_event",
                        lambda event_type, data, workspace_id="global", **_: events.append(
                            {"event_type": event_type, "data": data, "workspace_id": workspace_id}))
    return events


def _stub_call_model(monkeypatch, panel_titles):
    calls = []

    async def fake_call_model(model, messages, **kwargs):
        prompt = messages[0]["content"]
        calls.append({"model": model, "prompt": prompt, "run_id": kwargs.get("run_id")})
        if "multi-panel dashboard that thoroughly" in prompt:
            panels = [{"title": t, "focus": f"focus for {t}"} for t in panel_titles]
            return json.dumps({"title": "Test Dashboard", "panels": panels})
        if "Critique this multi-panel dashboard" in prompt:
            return "- Coverage looks complete\n- No major overlap"
        return f"Markdown body for prompt slice: {prompt[:24]}"

    monkeypatch.setattr(producer, "call_model", fake_call_model)

    async def fake_active_model(*a, **k):
        return "local_lemonade"
    monkeypatch.setattr(producer, "get_active_model", fake_active_model)
    return calls


def test_deep_produce_full_loop(isolated_home, store, captured_events, monkeypatch):
    titles = ["Overview", "Details", "Risks"]
    calls = _stub_call_model(monkeypatch, titles)

    result = asyncio.run(producer.deep_produce(
        goal="Explain the system architecture", workspace="default", panel_count=3))

    assert result["status"] == "completed"
    view = result["view"]
    assert view["format"] == "aamp.view/1"
    assert view["title"] == "Test Dashboard"
    assert [p["title"] for p in view["panels"]] == titles
    assert all(p["type"] == "markdown" and p["markdown"] for p in view["panels"])
    assert view["review"].startswith("- Coverage")

    # 1 decompose + 3 panels + 1 review = 5 model calls, all under one run_id.
    assert len(calls) == 5
    assert all(c["run_id"] == result["run_id"] for c in calls)

    # The view artifact was written under the workspace and is reloadable.
    view_path = isolated_home / "workspaces" / "default" / result["view_path"]
    assert view_path.is_file()
    assert json.loads(view_path.read_text(encoding="utf-8"))["title"] == "Test Dashboard"

    # The run was recorded and completed with the artifact attached.
    rec = store.get_run(result["run_id"])
    assert rec is not None and rec.status.value == "completed"
    assert result["view_path"] in rec.artifact_paths


def test_emits_trace_events_for_runs_widgets(isolated_home, store, captured_events, monkeypatch):
    titles = ["A", "B"]
    _stub_call_model(monkeypatch, titles)

    result = asyncio.run(producer.deep_produce(goal="Goal", workspace="default", panel_count=2))
    run_id = result["run_id"]

    node_events = [e for e in captured_events if e["event_type"] == "NODE_EXECUTION_STATE"]
    node_ids = [e["data"]["node_id"] for e in node_events]
    assert "decompose" in node_ids
    assert "review" in node_ids
    assert sum(1 for n in node_ids if n.startswith("panel:")) == 2

    # Every event carries the run_id (so /governance/events?run_id= filters) and
    # a non-empty reasoning_trace (so the reasoning_trace widget renders a card).
    for e in node_events:
        assert e["data"]["run_id"] == run_id
        assert isinstance(e["data"]["outputs"]["reasoning_trace"], str)
        assert e["data"]["outputs"]["reasoning_trace"].strip()


def test_decompose_falls_back_on_bad_json(isolated_home, store, captured_events, monkeypatch):
    async def fake_call_model(model, messages, **kwargs):
        prompt = messages[0]["content"]
        if "multi-panel dashboard that thoroughly" in prompt:
            return "sorry, I cannot do JSON today"  # unparseable
        if "Critique" in prompt:
            return "ok"
        return "panel body"
    monkeypatch.setattr(producer, "call_model", fake_call_model)

    async def fake_active_model(*a, **k):
        return "local_lemonade"
    monkeypatch.setattr(producer, "get_active_model", fake_active_model)

    result = asyncio.run(producer.deep_produce(goal="Resilient goal", workspace="default", panel_count=4))
    assert result["status"] == "completed"
    # Fallback still produces the requested number of panels.
    assert len(result["view"]["panels"]) == 4


def test_parallel_fanout_when_pool_configured(isolated_home, store, captured_events, monkeypatch):
    # A two-machine pool for the lemonade provider → panels fan out concurrently.
    monkeypatch.setenv("BENNY_LEMONADE_ENDPOINTS",
                       "http://ryzen.local:13305/api/v1,http://t480.local:13305/api/v1")
    from benny.core import endpoints
    endpoints.reset()

    titles = ["A", "B", "C"]
    _stub_call_model(monkeypatch, titles)

    # local_lemonade resolves to provider 'lemonade', which now has a 2-machine
    # pool → concurrency 2 (clamped to panel count).
    assert producer._fanout_concurrency("local_lemonade", 3) == 2

    result = asyncio.run(producer.deep_produce(goal="Goal", workspace="default",
                                               model="local_lemonade", panel_count=3))
    assert result["status"] == "completed"
    # Order is preserved even though production was concurrent.
    assert [p["title"] for p in result["view"]["panels"]] == titles
    endpoints.reset()


def test_empty_goal_rejected(isolated_home, store, monkeypatch):
    async def fake_active_model(*a, **k):
        return "local_lemonade"
    monkeypatch.setattr(producer, "get_active_model", fake_active_model)
    with pytest.raises(ValueError):
        asyncio.run(producer.deep_produce(goal="   ", workspace="default"))
