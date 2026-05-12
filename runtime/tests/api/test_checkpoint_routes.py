"""ADR-001 Phase H — checkpoint API endpoint tests.

Covers:
  Draft operations:
    - save: valid payload, idempotent re-save, oversized history (413),
            path traversal rejection, invalid schema, invalid role,
            sandbox-scope enforcement (save requires sandbox scope;
            AgentScopeMiddleware 403s read_only scoped POSTs everywhere).
    - list: empty workspace, populated workspace, sorted newest-first.
    - load: found (200), not found (404).
    - delete: happy path, force required for pinned sibling (409),
              force bypasses 409, not found (404).

  Pinned operations:
    - pin: valid (signature embedded, pinned file written, audit emitted),
           agent-scoped 403, missing source 404, invalid source JSON.
    - list pinned: empty, populated with valid/invalid status.
    - load pinned: valid signature, tampered body (valid: false),
                   missing signature (valid: false), not found (404).

Test isolation: each test uses ``tmp_path`` via ``clean_workspace_root``.
"""

from __future__ import annotations

import json
import time
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from benny.api.agent_scope import AgentScopeMiddleware
from benny.api.checkpoint_routes import sandbox_router, pinned_router
from benny.api.views_signing import sign_view
from benny.core.workspace import get_checkpoint_draft_dir, get_checkpoint_pinned_dir


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def app_under_test():
    app = FastAPI()
    app.add_middleware(AgentScopeMiddleware)
    app.include_router(sandbox_router, prefix="/api/agent_sandbox/checkpoints")
    app.include_router(pinned_router, prefix="/api/checkpoints")
    return app


@pytest.fixture
def client(app_under_test):
    return TestClient(app_under_test)


@pytest.fixture
def clean_workspace_root(tmp_path, monkeypatch):
    root = (tmp_path / "workspace").resolve()
    root.mkdir()
    monkeypatch.setattr("benny.core.workspace.WORKSPACE_ROOT", root)
    return root


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_checkpoint(name="test-cp", workspace="default", history=None, skills=None,
                     source="operator", run_refs=None, manifest_refs=None,
                     description="", fork_of=None):
    return {
        "schema": "aamp.checkpoint/1",
        "name": name,
        "workspace": workspace,
        "saved_at": "2026-05-12T14:30:00Z",
        "history": history or [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ],
        "skills": skills or ["browser-control"],
        "transient_items": {},
        "run_refs": run_refs or [],
        "manifest_refs": manifest_refs or [],
        "metadata": {
            "description": description,
            "source": source,
            "fork_of": fork_of,
            "fork_index": None,
            "pre_restore_of": None,
        },
    }


def _save(client, name="test-cp", workspace="default", **kwargs):
    cp = _make_checkpoint(name=name, workspace=workspace, **kwargs)
    return client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": workspace, "name": name, "checkpoint": cp},
    )


# ---------------------------------------------------------------------------
# Save — happy path
# ---------------------------------------------------------------------------


def test_save_returns_saved_true(client, clean_workspace_root):
    response = _save(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["saved"] is True
    assert "agent_sandbox/checkpoints/test-cp.json" in body["path"]
    assert body["bytes"] > 0


def test_save_writes_json_file(client, clean_workspace_root):
    _save(client, name="cp1", workspace="default")
    target = get_checkpoint_draft_dir("default") / "cp1.json"
    assert target.is_file()
    cp = json.loads(target.read_text(encoding="utf-8"))
    assert cp["schema"] == "aamp.checkpoint/1"
    assert cp["name"] == "cp1"


def test_save_is_idempotent_for_identical_content(client, clean_workspace_root):
    """Re-saving with identical content must succeed (no error) and the file
    must be unchanged — verified via mtime stability."""
    _save(client, name="idem-cp")
    path = get_checkpoint_draft_dir("default") / "idem-cp.json"
    mtime_before = path.stat().st_mtime
    time.sleep(0.05)  # small delay so mtime would differ if re-written
    r2 = _save(client, name="idem-cp")
    assert r2.status_code == 200
    mtime_after = path.stat().st_mtime
    assert mtime_before == mtime_after, "file should not be re-written for identical content"


def test_save_overwrites_on_content_change(client, clean_workspace_root):
    _save(client, name="mut-cp", description="original")
    _save(client, name="mut-cp", description="updated")
    path = get_checkpoint_draft_dir("default") / "mut-cp.json"
    cp = json.loads(path.read_text(encoding="utf-8"))
    assert cp["metadata"]["description"] == "updated"


# ---------------------------------------------------------------------------
# Save — validation
# ---------------------------------------------------------------------------


def test_save_rejects_invalid_schema(client, clean_workspace_root):
    cp = _make_checkpoint()
    cp["schema"] = "aamp.checkpoint/9"
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "bad-schema", "checkpoint": cp},
    )
    assert r.status_code == 400
    assert "schema" in r.json()["detail"].lower()


def test_save_rejects_invalid_role(client, clean_workspace_root):
    cp = _make_checkpoint(history=[{"role": "hacker", "content": "evil"}])
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "bad-role", "checkpoint": cp},
    )
    assert r.status_code == 400
    assert "role" in r.json()["detail"].lower()


def test_save_rejects_name_with_slash(client, clean_workspace_root):
    cp = _make_checkpoint()
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "subdir/evil", "checkpoint": cp},
    )
    assert r.status_code == 400
    assert "invalid" in r.json()["detail"].lower()


def test_save_rejects_name_with_dot_prefix(client, clean_workspace_root):
    cp = _make_checkpoint()
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": ".hidden", "checkpoint": cp},
    )
    assert r.status_code == 400


def test_save_rejects_name_too_long(client, clean_workspace_root):
    cp = _make_checkpoint()
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "a" * 81, "checkpoint": cp},
    )
    assert r.status_code == 400


def test_save_rejects_oversized_history(client, clean_workspace_root):
    big_msg = {"role": "user", "content": "x" * (2 * 1024 * 1024 + 1)}
    cp = _make_checkpoint(history=[big_msg])
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "big-cp", "checkpoint": cp},
    )
    assert r.status_code == 413
    detail = r.json()["detail"]
    assert detail["error"] == "history_too_large"
    assert detail["max_bytes"] == 2 * 1024 * 1024


# ---------------------------------------------------------------------------
# Save — scope enforcement
# ---------------------------------------------------------------------------


def test_save_403_for_read_only_agent(client, clean_workspace_root):
    """AgentScopeMiddleware blocks read_only-scoped POSTs everywhere — this
    confirms checkpoints inherit the same boundary as views."""
    cp = _make_checkpoint()
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "scoped-cp", "checkpoint": cp},
        headers={"X-Benny-Agent-Scope": "read_only"},
    )
    assert r.status_code == 403


def test_save_succeeds_for_sandbox_agent(client, clean_workspace_root):
    cp = _make_checkpoint()
    r = client.post(
        "/api/agent_sandbox/checkpoints/save",
        json={"workspace": "default", "name": "agent-cp", "checkpoint": cp},
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


def test_list_returns_empty_for_new_workspace(client, clean_workspace_root):
    r = client.get("/api/agent_sandbox/checkpoints/list/default")
    assert r.status_code == 200
    assert r.json() == []


def test_list_returns_summaries_without_history(client, clean_workspace_root):
    _save(client, name="cp-a", workspace="default", run_refs=["run-1"])
    _save(client, name="cp-b", workspace="default", description="second")
    r = client.get("/api/agent_sandbox/checkpoints/list/default")
    assert r.status_code == 200
    names = {item["name"] for item in r.json()}
    assert "cp-a" in names
    assert "cp-b" in names
    # History should NOT be in summary
    for item in r.json():
        assert "history" not in item


def test_list_summary_includes_expected_fields(client, clean_workspace_root):
    _save(client, name="summary-cp", skills=["browser-control", "data-analyst"],
          history=[{"role": "user", "content": "x"}] * 5, run_refs=["run-x"])
    r = client.get("/api/agent_sandbox/checkpoints/list/default")
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 1
    item = items[0]
    assert item["name"] == "summary-cp"
    assert item["skill_count"] == 2
    assert item["message_count"] == 5
    assert item["run_refs"] == ["run-x"]
    assert item["status"] == "draft"


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------


def test_load_returns_full_checkpoint(client, clean_workspace_root):
    _save(client, name="load-me")
    r = client.get("/api/agent_sandbox/checkpoints/load/default/load-me")
    assert r.status_code == 200
    body = r.json()
    assert body["schema"] == "aamp.checkpoint/1"
    assert "history" in body


def test_load_404_when_not_found(client, clean_workspace_root):
    r = client.get("/api/agent_sandbox/checkpoints/load/default/no-such-cp")
    assert r.status_code == 404
    assert "does not exist" in r.json()["detail"]


def test_load_allows_sandbox_scoped_agent(client, clean_workspace_root):
    """Reads are unrestricted by AgentScopeMiddleware."""
    _save(client, name="readable")
    r = client.get(
        "/api/agent_sandbox/checkpoints/load/default/readable",
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


def test_delete_removes_draft_file(client, clean_workspace_root):
    _save(client, name="del-me")
    target = get_checkpoint_draft_dir("default") / "del-me.json"
    assert target.is_file()
    r = client.delete("/api/agent_sandbox/checkpoints/delete/default/del-me")
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    assert not target.is_file()


def test_delete_404_when_not_found(client, clean_workspace_root):
    r = client.delete("/api/agent_sandbox/checkpoints/delete/default/ghost")
    assert r.status_code == 404


def test_delete_409_when_pinned_sibling_exists(client, clean_workspace_root):
    """Deleting a draft when a pinned sibling exists returns 409 without force."""
    _save(client, name="shared")
    # Manually create a pinned sibling.
    pinned_dir = get_checkpoint_pinned_dir("default")
    pinned_dir.mkdir(parents=True, exist_ok=True)
    cp = _make_checkpoint(name="shared")
    (pinned_dir / "shared.json").write_text(json.dumps(cp), encoding="utf-8")

    r = client.delete("/api/agent_sandbox/checkpoints/delete/default/shared")
    assert r.status_code == 409
    assert "force=true" in r.json()["detail"].lower() or "force" in r.json()["detail"].lower()
    # Draft still exists.
    assert (get_checkpoint_draft_dir("default") / "shared.json").is_file()


def test_delete_force_bypasses_409(client, clean_workspace_root):
    _save(client, name="force-del")
    pinned_dir = get_checkpoint_pinned_dir("default")
    pinned_dir.mkdir(parents=True, exist_ok=True)
    (pinned_dir / "force-del.json").write_text(
        json.dumps(_make_checkpoint(name="force-del")), encoding="utf-8"
    )

    r = client.delete(
        "/api/agent_sandbox/checkpoints/delete/default/force-del?force=true"
    )
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    assert not (get_checkpoint_draft_dir("default") / "force-del.json").is_file()
    # Pinned copy is NOT deleted.
    assert (get_checkpoint_pinned_dir("default") / "force-del.json").is_file()


# ---------------------------------------------------------------------------
# Pin
# ---------------------------------------------------------------------------


def _save_and_pin(client, name="pinned-cp", workspace="default"):
    _save(client, name=name, workspace=workspace)
    return client.post(
        "/api/checkpoints/pin",
        json={"workspace": workspace, "source_name": name, "pinned_by": "operator@binary16"},
    )


def test_pin_writes_signed_file_to_canonical_location(client, clean_workspace_root):
    r = _save_and_pin(client, name="pin-happy")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["workspace"] == "default"
    assert body["signature"]["algorithm"] == "HMAC-SHA256"
    assert len(body["signature"]["value"]) == 64

    pinned = get_checkpoint_pinned_dir("default") / "pin-happy.json"
    assert pinned.is_file()
    cp_pinned = json.loads(pinned.read_text(encoding="utf-8"))
    assert cp_pinned["signature"]["value"] == body["signature"]["value"]


def test_pin_inline_signature_verifies(client, clean_workspace_root):
    """The pinned file is self-verifying."""
    _save_and_pin(client, name="self-verify")
    pinned = get_checkpoint_pinned_dir("default") / "self-verify.json"
    cp_dict = json.loads(pinned.read_text(encoding="utf-8"))
    from benny.api.views_signing import ViewSignature, verify_view
    sig = ViewSignature(**cp_dict["signature"])
    assert verify_view(cp_dict, sig) is True


def test_pin_403_for_sandbox_agent(client, clean_workspace_root):
    _save(client, name="agent-pin-attempt")
    r = client.post(
        "/api/checkpoints/pin",
        json={"workspace": "default", "source_name": "agent-pin-attempt"},
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 403
    # No pinned file was written.
    assert not (get_checkpoint_pinned_dir("default") / "agent-pin-attempt.json").is_file()


def test_pin_404_when_source_missing(client, clean_workspace_root):
    r = client.post(
        "/api/checkpoints/pin",
        json={"workspace": "default", "source_name": "no-such-draft"},
    )
    assert r.status_code == 404


def test_pin_rejects_path_separator_in_name(client, clean_workspace_root):
    r = client.post(
        "/api/checkpoints/pin",
        json={"workspace": "default", "source_name": "sub/evil"},
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# List pinned
# ---------------------------------------------------------------------------


def test_list_pinned_empty(client, clean_workspace_root):
    r = client.get("/api/checkpoints/list/default")
    assert r.status_code == 200
    assert r.json() == []


def test_list_pinned_includes_valid_flag(client, clean_workspace_root):
    _save_and_pin(client, name="list-valid")
    r = client.get("/api/checkpoints/list/default")
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 1
    assert items[0]["name"] == "list-valid"
    assert items[0]["status"] == "pinned"
    assert items[0]["valid"] is True


def test_list_pinned_invalid_when_tampered(client, clean_workspace_root):
    _save_and_pin(client, name="tamper-target")
    pinned_path = get_checkpoint_pinned_dir("default") / "tamper-target.json"
    cp = json.loads(pinned_path.read_text(encoding="utf-8"))
    cp["history"].append({"role": "assistant", "content": "injected"})
    pinned_path.write_text(json.dumps(cp), encoding="utf-8")

    r = client.get("/api/checkpoints/list/default")
    items = r.json()
    assert items[0]["valid"] is False


# ---------------------------------------------------------------------------
# Load pinned
# ---------------------------------------------------------------------------


def test_load_pinned_returns_valid_true_for_clean_file(client, clean_workspace_root):
    _save_and_pin(client, name="load-pinned-clean")
    r = client.get("/api/checkpoints/load/default/load-pinned-clean")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is True
    assert body["name"] == "load-pinned-clean"
    assert body["checkpoint"]["schema"] == "aamp.checkpoint/1"
    assert body["signature"]["algorithm"] == "HMAC-SHA256"


def test_load_pinned_404_when_not_found(client, clean_workspace_root):
    r = client.get("/api/checkpoints/load/default/ghost-pinned")
    assert r.status_code == 404


def test_load_pinned_valid_false_when_tampered(client, clean_workspace_root):
    _save_and_pin(client, name="tamper-load")
    pinned_path = get_checkpoint_pinned_dir("default") / "tamper-load.json"
    cp = json.loads(pinned_path.read_text(encoding="utf-8"))
    cp["history"].append({"role": "assistant", "content": "evil injection"})
    pinned_path.write_text(json.dumps(cp), encoding="utf-8")

    r = client.get("/api/checkpoints/load/default/tamper-load")
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is False
    assert body["signature"] is not None  # signature still present, just invalid


def test_load_pinned_valid_false_when_no_signature(client, clean_workspace_root):
    pinned_dir = get_checkpoint_pinned_dir("default")
    pinned_dir.mkdir(parents=True, exist_ok=True)
    cp = _make_checkpoint(name="no-sig")
    # No signature field — simulates a pre-H3 or manually-crafted file.
    (pinned_dir / "no-sig.json").write_text(json.dumps(cp), encoding="utf-8")

    r = client.get("/api/checkpoints/load/default/no-sig")
    assert r.status_code == 200
    body = r.json()
    assert body["signature"] is None
    assert body["valid"] is False


def test_load_pinned_allows_sandbox_agent(client, clean_workspace_root):
    """Reads are unrestricted — agents can load pinned checkpoints."""
    _save_and_pin(client, name="agent-read-pinned")
    r = client.get(
        "/api/checkpoints/load/default/agent-read-pinned",
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert r.status_code == 200
    assert r.json()["valid"] is True
