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
from benny.api.views_routes import router as views_router
from benny.api.views_signing import (
    ViewSignature,
    canonical_view_payload,
    sign_view,
    verify_view,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def app_under_test():
    app = FastAPI()
    app.add_middleware(AgentScopeMiddleware)
    app.include_router(views_router, prefix="/api/views")
    return app


@pytest.fixture
def client(app_under_test):
    return TestClient(app_under_test)


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
