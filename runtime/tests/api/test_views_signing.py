"""ADR-001 Phase F — view signing helpers + endpoints.

Covers:
* canonical_view_payload is deterministic, strips ``signature``, ignores key order
* sign_view → verify_view round-trips
* tampered view fails verify_view
* algorithm mismatch fails verify_view
* /api/views/sign + /api/views/verify wire shapes
* AgentScopeMiddleware blocks agent-scoped POSTs to /api/views/*
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from benny.api.agent_scope import AgentScopeMiddleware
from benny.api.agent_sandbox_routes import router as agent_sandbox_router
from benny.api.views_routes import router as views_router
from benny.api.views_signing import (
    ViewSignature,
    canonical_view_payload,
    sign_view,
    verify_view,
)
from benny.core.workspace import (
    get_agent_sandbox_path,
    get_pinned_views_path,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def app_under_test():
    app = FastAPI()
    app.add_middleware(AgentScopeMiddleware)
    app.include_router(views_router, prefix="/api/views")
    app.include_router(agent_sandbox_router, prefix="/api/agent_sandbox")
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
# canonical_view_payload
# ---------------------------------------------------------------------------


def test_canonical_payload_is_key_order_independent():
    a = {"schema": "aamp.view/1", "panels": [{"widget": "text.markdown"}]}
    b = {"panels": [{"widget": "text.markdown"}], "schema": "aamp.view/1"}
    assert canonical_view_payload(a) == canonical_view_payload(b)


def test_canonical_payload_strips_signature_field():
    view = {"schema": "aamp.view/1", "panels": []}
    signed = {**view, "signature": {"algorithm": "HMAC-SHA256", "value": "deadbeef", "signed_at": "2026-01-01T00:00:00+00:00"}}
    assert canonical_view_payload(view) == canonical_view_payload(signed)


def test_canonical_payload_uses_compact_separators():
    payload = canonical_view_payload({"a": 1, "b": [2, 3]})
    assert ", " not in payload
    assert ": " not in payload
    assert json.loads(payload) == {"a": 1, "b": [2, 3]}


def test_canonical_payload_rejects_non_dict():
    with pytest.raises(TypeError):
        canonical_view_payload(["not", "a", "dict"])  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# sign_view / verify_view
# ---------------------------------------------------------------------------


def test_sign_then_verify_round_trips():
    view = {"schema": "aamp.view/1", "panels": [{"widget": "kg3d.synoptic_web"}]}
    sig = sign_view(view)
    assert sig.algorithm == "HMAC-SHA256"
    assert len(sig.value) == 64  # hex-encoded SHA-256
    assert verify_view(view, sig) is True


def test_verify_fails_on_tampered_payload():
    view = {"schema": "aamp.view/1", "panels": []}
    sig = sign_view(view)
    tampered = {"schema": "aamp.view/1", "panels": [{"widget": "text.markdown"}]}
    assert verify_view(tampered, sig) is False


def test_verify_ignores_inline_signature_field():
    """A pinned view embeds its signature under ``signature`` — verifying that
    inline-signed form must still succeed because canonical_view_payload
    strips the field."""
    view = {"schema": "aamp.view/1", "panels": []}
    sig = sign_view(view)
    inline_signed = {**view, "signature": sig.model_dump()}
    assert verify_view(inline_signed, sig) is True


def test_verify_rejects_unknown_algorithm():
    view = {"schema": "aamp.view/1", "panels": []}
    sig = sign_view(view)
    bad = ViewSignature(algorithm="NOPE", value=sig.value, signed_at=sig.signed_at)
    assert verify_view(view, bad) is False


# ---------------------------------------------------------------------------
# /api/views/sign + /api/views/verify
# ---------------------------------------------------------------------------


def test_sign_endpoint_returns_signature_and_canonical_payload(client):
    view = {"schema": "aamp.view/1", "panels": []}
    response = client.post("/api/views/sign", json={"view": view})
    assert response.status_code == 200
    body = response.json()
    assert body["signature"]["algorithm"] == "HMAC-SHA256"
    assert len(body["signature"]["value"]) == 64
    assert body["canonical_payload"] == canonical_view_payload(view)


def test_verify_endpoint_accepts_valid_signature(client):
    view = {"schema": "aamp.view/1", "panels": []}
    sign_response = client.post("/api/views/sign", json={"view": view})
    signature = sign_response.json()["signature"]

    verify_response = client.post(
        "/api/views/verify",
        json={"view": view, "signature": signature},
    )
    assert verify_response.status_code == 200
    assert verify_response.json() == {"valid": True}


def test_verify_endpoint_rejects_tampered_view(client):
    view = {"schema": "aamp.view/1", "panels": []}
    sign_response = client.post("/api/views/sign", json={"view": view})
    signature = sign_response.json()["signature"]

    tampered = {"schema": "aamp.view/1", "panels": [{"widget": "evil"}]}
    verify_response = client.post(
        "/api/views/verify",
        json={"view": tampered, "signature": signature},
    )
    assert verify_response.json() == {"valid": False}


# ---------------------------------------------------------------------------
# AgentScopeMiddleware boundary
# ---------------------------------------------------------------------------


def test_agent_sandbox_scope_cannot_pin(client):
    """A sandbox-scoped agent that tries to sign a view receives 403 from the
    middleware — pinning is a human action by policy, not by convention."""
    response = client.post(
        "/api/views/sign",
        json={"view": {"schema": "aamp.view/1", "panels": []}},
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert response.status_code == 403
    assert "agent_sandbox" in response.json()["detail"].lower()


def test_agent_read_only_scope_cannot_pin(client):
    response = client.post(
        "/api/views/sign",
        json={"view": {"schema": "aamp.view/1", "panels": []}},
        headers={"X-Benny-Agent-Scope": "read_only"},
    )
    assert response.status_code == 403
    assert "read_only" in response.json()["detail"].lower()


def test_human_unscoped_caller_can_sign(client):
    response = client.post(
        "/api/views/sign",
        json={"view": {"schema": "aamp.view/1", "panels": []}},
    )
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Phase F2 — /api/views/pin
# ---------------------------------------------------------------------------


def _seed_draft(workspace, filename, view_dict):
    """Drop a JSON draft into agent_sandbox/views/<filename>."""
    sandbox = get_agent_sandbox_path(workspace, "views")
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / filename).write_text(json.dumps(view_dict), encoding="utf-8")


def test_pin_writes_signed_view_to_canonical_location(client, clean_workspace_root):
    view = {"schema": "aamp.view/1", "panels": [{"widget": "kg3d.synoptic_web"}]}
    _seed_draft("default", "compose.aamp.view", view)

    response = client.post(
        "/api/views/pin",
        json={
            "workspace": "default",
            "source_filename": "compose.aamp.view",
            "pinned_by": "operator@binary16",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["workspace"] == "default"
    assert body["source_relative_path"] == "agent_sandbox/views/compose.aamp.view"
    assert body["pinned_relative_path"] == "views/compose.aamp.view"
    assert body["signature"]["algorithm"] == "HMAC-SHA256"
    assert len(body["signature"]["value"]) == 64

    pinned = get_pinned_views_path("default") / "compose.aamp.view"
    assert pinned.is_file()
    pinned_dict = json.loads(pinned.read_text(encoding="utf-8"))
    # Inline-signed: the signature is embedded so the file is self-describing.
    assert pinned_dict["signature"]["value"] == body["signature"]["value"]
    # Original payload preserved verbatim apart from the embedded signature.
    pinned_minus_sig = {k: v for k, v in pinned_dict.items() if k != "signature"}
    assert pinned_minus_sig == view


def test_pin_writes_to_explicit_target_filename(client, clean_workspace_root):
    _seed_draft("default", "draft.aamp.view", {"schema": "aamp.view/1", "panels": []})
    response = client.post(
        "/api/views/pin",
        json={
            "workspace": "default",
            "source_filename": "draft.aamp.view",
            "target_filename": "exposure_review.aamp.view",
        },
    )
    assert response.status_code == 200
    pinned = get_pinned_views_path("default") / "exposure_review.aamp.view"
    assert pinned.is_file()
    assert not (get_pinned_views_path("default") / "draft.aamp.view").exists()


def test_pin_inline_signed_round_trips_verify(client, clean_workspace_root):
    """The pinned file is self-verifying — re-reading it and posting it back to
    /api/views/verify with its inline signature must return valid: True. This
    is the load-time integrity check the shell will do on replay."""
    _seed_draft(
        "default",
        "v.aamp.view",
        {"schema": "aamp.view/1", "panels": [{"widget": "text.markdown"}]},
    )
    pin_response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "v.aamp.view"},
    )
    assert pin_response.status_code == 200

    pinned = get_pinned_views_path("default") / "v.aamp.view"
    pinned_dict = json.loads(pinned.read_text(encoding="utf-8"))
    signature = pinned_dict["signature"]

    verify_response = client.post(
        "/api/views/verify",
        json={"view": pinned_dict, "signature": signature},
    )
    assert verify_response.status_code == 200
    assert verify_response.json() == {"valid": True}


def test_pin_404_when_source_missing(client, clean_workspace_root):
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "nope.aamp.view"},
    )
    assert response.status_code == 404
    assert "does not exist" in response.json()["detail"]


def test_pin_400_when_source_is_not_json(client, clean_workspace_root):
    sandbox = get_agent_sandbox_path("default", "views")
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / "broken.aamp.view").write_text("not json {", encoding="utf-8")
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "broken.aamp.view"},
    )
    assert response.status_code == 400
    assert "not valid JSON" in response.json()["detail"]


def test_pin_rejects_path_separator_in_filename(client, clean_workspace_root):
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "subdir/evil.aamp.view"},
    )
    assert response.status_code == 400
    assert "path separator" in response.json()["detail"].lower()


def test_pin_rejects_dot_prefixed_filename(client, clean_workspace_root):
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "../etc/passwd"},
    )
    assert response.status_code == 400
    # Hits the dot-prefix check before the separator check — either rejection
    # is fine, but the response MUST be a 400 not a 200 with a sandbox escape.
    assert "must not" in response.json()["detail"].lower()


def test_pin_rejects_path_separator_in_target_filename(client, clean_workspace_root):
    _seed_draft("default", "ok.aamp.view", {"schema": "aamp.view/1"})
    response = client.post(
        "/api/views/pin",
        json={
            "workspace": "default",
            "source_filename": "ok.aamp.view",
            "target_filename": "subdir/evil.aamp.view",
        },
    )
    assert response.status_code == 400


def test_pin_rejects_non_object_top_level_json(client, clean_workspace_root):
    sandbox = get_agent_sandbox_path("default", "views")
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / "array.aamp.view").write_text("[1, 2, 3]", encoding="utf-8")
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "array.aamp.view"},
    )
    assert response.status_code == 400
    assert "JSON object" in response.json()["detail"]


def test_pin_403s_for_sandbox_agent(client, clean_workspace_root):
    """Defence in depth: even with a real draft on disk, an agent-scoped POST
    to /api/views/pin must be rejected by the middleware before the endpoint
    runs. Pinning is a human action by middleware policy."""
    _seed_draft("default", "v.aamp.view", {"schema": "aamp.view/1"})
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "v.aamp.view"},
        headers={"X-Benny-Agent-Scope": "sandbox"},
    )
    assert response.status_code == 403
    # And the canonical location stays empty — no write happened.
    assert not (get_pinned_views_path("default") / "v.aamp.view").exists()


def test_pin_403s_for_read_only_agent(client, clean_workspace_root):
    _seed_draft("default", "v.aamp.view", {"schema": "aamp.view/1"})
    response = client.post(
        "/api/views/pin",
        json={"workspace": "default", "source_filename": "v.aamp.view"},
        headers={"X-Benny-Agent-Scope": "read_only"},
    )
    assert response.status_code == 403
