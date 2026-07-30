"""ADR-001 Phase C — governance events read path.

Tests for :func:`benny.governance.audit.read_audit_events` and the
``GET /api/governance/events`` route that the ``run.lineage_timeline``
widget consumes.

The audit log is plain JSON-lines on disk; tests seed a fixture log under
the workspace's ``runs/audit.log`` and exercise filtering + ordering.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from benny.api.governance_routes import router as governance_router
from benny.governance.audit import read_audit_events


@pytest.fixture
def clean_workspace_root(tmp_path, monkeypatch):
    root = (tmp_path / "workspace").resolve()
    root.mkdir()
    monkeypatch.setattr("benny.core.workspace.WORKSPACE_ROOT", root)
    return root


def _seed_audit_log(workspace_root: Path, workspace: str, events: list[dict]) -> Path:
    runs_dir = workspace_root / workspace / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    log_path = runs_dir / "audit.log"
    with log_path.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")
    return log_path


def _event(ts: str, event_type: str, **data) -> dict:
    return {
        "timestamp": ts,
        "event_type": event_type,
        "workspace": "ws_a",
        "data": data,
    }


# ---------------------------------------------------------------------------
# read_audit_events helper
# ---------------------------------------------------------------------------


def test_read_audit_events_returns_empty_when_log_missing(clean_workspace_root):
    assert read_audit_events("ws_a") == []


def test_read_audit_events_returns_newest_first(clean_workspace_root):
    _seed_audit_log(
        clean_workspace_root,
        "ws_a",
        [
            _event("2026-05-01T00:00:00Z", "TEST", run_id="r1"),
            _event("2026-05-03T00:00:00Z", "TEST", run_id="r1"),
            _event("2026-05-02T00:00:00Z", "TEST", run_id="r1"),
        ],
    )
    events = read_audit_events("ws_a")
    assert [e["timestamp"] for e in events] == [
        "2026-05-03T00:00:00Z",
        "2026-05-02T00:00:00Z",
        "2026-05-01T00:00:00Z",
    ]


def test_read_audit_events_filters_by_run_id(clean_workspace_root):
    _seed_audit_log(
        clean_workspace_root,
        "ws_a",
        [
            _event("2026-05-01T00:00:00Z", "TEST", run_id="r1"),
            _event("2026-05-02T00:00:00Z", "TEST", run_id="r2"),
            _event(
                "2026-05-03T00:00:00Z",
                "AGENT_AUTHORSHIP",
                process="agent_authorship",
                details={"run_id": "r1"},
            ),
            _event("2026-05-04T00:00:00Z", "OTHER", parent_run_id="r1"),
        ],
    )
    events = read_audit_events("ws_a", run_id="r1")
    assert len(events) == 3
    assert all(
        e.get("data", {}).get("run_id") == "r1"
        or e.get("data", {}).get("parent_run_id") == "r1"
        or e.get("data", {}).get("details", {}).get("run_id") == "r1"
        for e in events
    )


def test_read_audit_events_filters_by_event_type(clean_workspace_root):
    _seed_audit_log(
        clean_workspace_root,
        "ws_a",
        [
            _event("2026-05-01T00:00:00Z", "AGENT_AUTHORSHIP", process="agent_authorship"),
            _event("2026-05-02T00:00:00Z", "OTHER"),
        ],
    )
    events = read_audit_events("ws_a", event_type="AGENT_AUTHORSHIP")
    assert len(events) == 1
    assert events[0]["event_type"] == "AGENT_AUTHORSHIP"


def test_read_audit_events_skips_malformed_lines(clean_workspace_root):
    runs_dir = clean_workspace_root / "ws_a" / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    log = runs_dir / "audit.log"
    log.write_text(
        json.dumps(_event("2026-05-01T00:00:00Z", "TEST")) + "\n"
        + "not-json\n"
        + json.dumps(_event("2026-05-02T00:00:00Z", "TEST")) + "\n",
        encoding="utf-8",
    )
    events = read_audit_events("ws_a")
    assert len(events) == 2


def test_read_audit_events_respects_limit(clean_workspace_root):
    _seed_audit_log(
        clean_workspace_root,
        "ws_a",
        [_event(f"2026-05-{day:02d}T00:00:00Z", "TEST") for day in range(1, 11)],
    )
    events = read_audit_events("ws_a", limit=3)
    assert len(events) == 3
    # Newest first.
    assert events[0]["timestamp"] == "2026-05-10T00:00:00Z"


def test_read_audit_events_negative_limit_returns_empty(clean_workspace_root):
    _seed_audit_log(clean_workspace_root, "ws_a", [_event("2026-05-01T00:00:00Z", "TEST")])
    assert read_audit_events("ws_a", limit=0) == []


# ---------------------------------------------------------------------------
# GET /api/governance/events route
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(governance_router, prefix="/api/governance")
    return TestClient(app)


def test_events_route_returns_filtered_events(client, clean_workspace_root):
    _seed_audit_log(
        clean_workspace_root,
        "ws_a",
        [
            _event("2026-05-01T00:00:00Z", "AGENT_AUTHORSHIP", details={"run_id": "r1"}),
            _event("2026-05-02T00:00:00Z", "AGENT_AUTHORSHIP", details={"run_id": "r2"}),
            _event("2026-05-03T00:00:00Z", "TEST", run_id="r1"),
        ],
    )

    r = client.get(
        "/api/governance/events",
        params={"workspace": "ws_a", "run_id": "r1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["workspace"] == "ws_a"
    assert body["run_id"] == "r1"
    assert body["count"] == 2
    assert len(body["events"]) == 2
    # Newest first.
    assert body["events"][0]["timestamp"] == "2026-05-03T00:00:00Z"


def test_events_route_returns_empty_for_unknown_workspace(client, clean_workspace_root):
    r = client.get("/api/governance/events", params={"workspace": "no_such_ws"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert body["events"] == []


def test_events_route_rejects_invalid_limit(client, clean_workspace_root):
    r = client.get("/api/governance/events", params={"workspace": "ws_a", "limit": 0})
    assert r.status_code == 422


def test_events_route_supports_event_type_filter(client, clean_workspace_root):
    _seed_audit_log(
        clean_workspace_root,
        "ws_a",
        [
            _event("2026-05-01T00:00:00Z", "AGENT_AUTHORSHIP"),
            _event("2026-05-02T00:00:00Z", "OTHER"),
        ],
    )
    r = client.get(
        "/api/governance/events",
        params={"workspace": "ws_a", "event_type": "AGENT_AUTHORSHIP"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 1
    assert body["events"][0]["event_type"] == "AGENT_AUTHORSHIP"
