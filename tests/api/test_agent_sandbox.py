"""ADR-001 — agent sandbox boundary + scope guard tests.

Covers:
* :func:`benny.core.workspace.get_agent_sandbox_path` rejects unknown subdirs
* :func:`benny.core.workspace.is_within_agent_sandbox` admits sandbox paths
  and rejects everything outside (including sibling workspace files)
* :func:`benny.core.workspace.ensure_workspace_structure` provisions the four
  declared sandbox subdirectories
* :class:`benny.api.agent_scope.AgentScopeMiddleware` allows GET regardless of
  scope, allows sandbox-scoped writes only to ``/api/agent_sandbox/``, and
  rejects ``read_only``-scoped writes everywhere
* The dedicated sandbox write route emits an ``AGENT_AUTHORSHIP`` audit event
  and refuses path-traversal attempts in the filename field
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from benny.api.agent_scope import AgentScopeMiddleware
from benny.api.agent_sandbox_routes import router as agent_sandbox_router
from benny.api.widget_routes import router as widget_router
from benny.core.workspace import (
    AGENT_SANDBOX_SUBDIRS,
    ensure_workspace_structure,
    get_agent_sandbox_path,
    get_workspace_path,
    is_within_agent_sandbox,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def clean_workspace_root(tmp_path, monkeypatch):
    root = (tmp_path / "workspace").resolve()
    root.mkdir()
    monkeypatch.setattr("benny.core.workspace.WORKSPACE_ROOT", root)
    return root


@pytest.fixture
def app_under_test():
    """Minimal FastAPI app wiring only the ADR-001 surface — keeps the test
    fast and isolated from the full server's import-time side effects."""
    app = FastAPI()
    app.add_middleware(AgentScopeMiddleware)
    app.include_router(agent_sandbox_router, prefix="/api/agent_sandbox")
    app.include_router(widget_router, prefix="/api/widgets")

    # Stand-in for a non-sandbox write endpoint. The middleware should reject
    # sandbox-scoped POSTs to this path.
    @app.post("/api/files/upload")
    async def fake_upload() -> dict:
        return {"status": "uploaded"}

    return app


@pytest.fixture
def client(app_under_test):
    return TestClient(app_under_test)


# ---------------------------------------------------------------------------
# get_agent_sandbox_path / is_within_agent_sandbox
# ---------------------------------------------------------------------------


def test_get_agent_sandbox_path_rejects_unknown_subdir(clean_workspace_root):
    with pytest.raises(ValueError):
        get_agent_sandbox_path("ws_a", subdir="not_a_real_subdir")


def test_get_agent_sandbox_path_returns_each_known_subdir(clean_workspace_root):
    base = get_agent_sandbox_path("ws_a").resolve()
    for subdir in AGENT_SANDBOX_SUBDIRS:
        target = get_agent_sandbox_path("ws_a", subdir).resolve()
        assert str(target).startswith(str(base))


def test_is_within_agent_sandbox_accepts_nested_paths(clean_workspace_root):
    sandbox = get_agent_sandbox_path("ws_a", "views")
    sandbox.mkdir(parents=True, exist_ok=True)
    candidate = sandbox / "deep" / "nested" / "view.json"
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text("{}", encoding="utf-8")
    assert is_within_agent_sandbox("ws_a", candidate)


def test_is_within_agent_sandbox_rejects_sibling_workspace_paths(clean_workspace_root):
    # data_in/ is a sibling of agent_sandbox/, not a child of it.
    sibling = get_workspace_path("ws_a", "data_in")
    sibling.mkdir(parents=True, exist_ok=True)
    intruder = sibling / "leak.txt"
    intruder.write_text("nope", encoding="utf-8")
    assert not is_within_agent_sandbox("ws_a", intruder)


def test_ensure_workspace_structure_provisions_sandbox(clean_workspace_root):
    ensure_workspace_structure("ws_a")
    base = get_agent_sandbox_path("ws_a")
    assert base.exists()
    for subdir in AGENT_SANDBOX_SUBDIRS:
        assert (base / subdir).exists(), f"agent_sandbox/{subdir} not created"


# ---------------------------------------------------------------------------
# AgentScopeMiddleware
# ---------------------------------------------------------------------------


def test_get_passes_through_without_scope_header(client):
    r = client.get("/api/agent_sandbox/health")
    assert r.status_code == 200


def test_get_passes_through_with_sandbox_scope(client):
    r = client.get(
        "/api/widgets",
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 200


def test_sandbox_scope_post_to_sandbox_prefix_is_allowed(client, clean_workspace_root):
    r = client.post(
        "/api/agent_sandbox/write",
        json={
            "workspace": "ws_a",
            "subdir": "notes",
            "filename": "hello.md",
            "content": "# hi",
            "agent_id": "test_agent",
        },
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "written"


def test_sandbox_scope_post_outside_sandbox_prefix_is_403(client):
    r = client.post(
        "/api/files/upload",
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 403
    assert "agent_sandbox" in r.json()["detail"]


def test_read_only_scope_rejects_all_writes(client):
    r = client.post(
        "/api/agent_sandbox/write",
        json={
            "workspace": "ws_a",
            "subdir": "notes",
            "filename": "hello.md",
            "content": "# hi",
        },
        headers={"X-Benny-Agent-Scope": "read_only"},
    )
    assert r.status_code == 403


def test_unknown_scope_value_is_treated_as_unscoped(client, clean_workspace_root):
    # Falls through to the route handler (no governance middleware in the
    # test app); the point is that the agent guard does not block it.
    r = client.post(
        "/api/agent_sandbox/write",
        json={
            "workspace": "ws_a",
            "subdir": "notes",
            "filename": "hello.md",
            "content": "# hi",
        },
        headers={"X-Benny-Agent-Scope": "garbage"},
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Sandbox write route
# ---------------------------------------------------------------------------


def test_write_sandbox_file_creates_file_and_emits_lineage(client, clean_workspace_root):
    with patch("benny.api.agent_sandbox_routes.emit_agent_authorship") as mock_emit:
        r = client.post(
            "/api/agent_sandbox/write",
            json={
                "workspace": "ws_a",
                "subdir": "drafts",
                "filename": "candidate.json",
                "content": "{}",
                "agent_id": "planner_v1",
            },
        )
    assert r.status_code == 200, r.text
    written = get_agent_sandbox_path("ws_a", "drafts") / "candidate.json"
    assert written.read_text(encoding="utf-8") == "{}"

    mock_emit.assert_called_once()
    kwargs = mock_emit.call_args.kwargs
    assert kwargs["workspace_id"] == "ws_a"
    assert kwargs["agent_id"] == "planner_v1"
    assert kwargs["sandbox_path"] == "agent_sandbox/drafts/candidate.json"
    assert kwargs["action"] == "write"


@pytest.mark.parametrize(
    "bad_filename",
    [
        "../escape.txt",
        "sub/dir.txt",
        "sub\\dir.txt",
        ".hidden",
        "",
    ],
)
def test_write_sandbox_file_rejects_path_traversal(client, clean_workspace_root, bad_filename):
    r = client.post(
        "/api/agent_sandbox/write",
        json={
            "workspace": "ws_a",
            "subdir": "notes",
            "filename": bad_filename,
            "content": "x",
        },
    )
    assert r.status_code == 400


def test_save_view_requires_views_subdir(client, clean_workspace_root):
    r = client.post(
        "/api/agent_sandbox/views/save",
        json={
            "workspace": "ws_a",
            "subdir": "notes",  # wrong subdir on purpose
            "filename": "v.aamp.view",
            "content": "{}",
        },
    )
    assert r.status_code == 400


def test_save_view_rejects_non_json_content(client, clean_workspace_root):
    r = client.post(
        "/api/agent_sandbox/views/save",
        json={
            "workspace": "ws_a",
            "subdir": "views",
            "filename": "v.aamp.view",
            "content": "not json",
        },
    )
    assert r.status_code == 400


def test_save_view_writes_into_views_dir(client, clean_workspace_root):
    r = client.post(
        "/api/agent_sandbox/views/save",
        json={
            "workspace": "ws_a",
            "subdir": "views",
            "filename": "exposure.aamp.view",
            "content": '{"id":"exposure"}',
        },
    )
    assert r.status_code == 200, r.text
    written = get_agent_sandbox_path("ws_a", "views") / "exposure.aamp.view"
    assert written.exists()


# ---------------------------------------------------------------------------
# Widget registry
# ---------------------------------------------------------------------------


def test_list_widgets_returns_registered_entries(client):
    r = client.get("/api/widgets")
    assert r.status_code == 200
    ids = {entry["id"] for entry in r.json()}
    assert {"kg3d.synoptic_web", "dag.canvas", "run.frame_inspector"} <= ids


def test_get_widget_unknown_returns_404(client):
    r = client.get("/api/widgets/does.not.exist")
    assert r.status_code == 404


def test_dag_canvas_is_deterministic_only(client):
    r = client.get("/api/widgets/dag.canvas")
    assert r.status_code == 200
    assert r.json()["authority"] == "deterministic_only"
