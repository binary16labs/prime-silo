"""ADR-001 Phase F — `.aamp.view` signing endpoints.

Mounted at ``/api/views`` (intentionally NOT under ``/api/agent_sandbox/``).
:class:`benny.api.agent_scope.AgentScopeMiddleware` blocks every mutating
request from an agent-scoped caller that does not start with the sandbox
prefix, so these endpoints are *human-only* by middleware policy. The 403
on agent calls is the security boundary; this router does not re-check.

Two endpoints, both POST so the request body can carry the full view JSON:

  POST /api/views/sign   — compute an HMAC-SHA256 signature over the canonical
                            payload of the supplied view. Stateless — does not
                            read or write disk.
  POST /api/views/verify — return ``{valid: bool}`` for a (view, signature)
                            pair. Stateless.

Why no `pin` endpoint here:
  Promoting a draft from ``agent_sandbox/views/`` to a canonical replayable
  location is a workspace-state mutation that needs lineage emission and a
  defined target path. That belongs in a follow-up phase that decides where
  pinned views live. Phase F ships only the cryptographic chokepoint so the
  signing technique is locked in before the persistence story is.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .views_signing import (
    ViewSignature,
    canonical_view_payload,
    sign_view,
    verify_view,
)

router = APIRouter()


class SignViewRequest(BaseModel):
    view: dict[str, Any] = Field(
        description=(
            "The full view object to sign. A pre-existing ``signature`` field "
            "is stripped before the canonical payload is computed, so signing "
            "is idempotent across re-sign loops."
        )
    )


class SignViewResponse(BaseModel):
    signature: ViewSignature
    canonical_payload: str = Field(
        description=(
            "The deterministic UTF-8 string the signature was computed over. "
            "Returned so callers can audit exactly what was signed."
        )
    )


class VerifyViewRequest(BaseModel):
    view: dict[str, Any]
    signature: ViewSignature


class VerifyViewResponse(BaseModel):
    valid: bool


@router.post("/sign", response_model=SignViewResponse)
async def sign_view_endpoint(req: SignViewRequest) -> SignViewResponse:
    """Sign a view object and return both the signature envelope and the
    canonical payload. Callers may embed the signature back into the view
    under a top-level ``signature`` field — :func:`canonical_view_payload`
    strips it before hashing so a re-sign of the embedded form produces the
    same tag."""
    signature = sign_view(req.view)
    payload = canonical_view_payload(req.view)
    return SignViewResponse(signature=signature, canonical_payload=payload)


@router.post("/verify", response_model=VerifyViewResponse)
async def verify_view_endpoint(req: VerifyViewRequest) -> VerifyViewResponse:
    """Constant-time verification of an HMAC-SHA256 signature over a view's
    canonical payload."""
    return VerifyViewResponse(valid=verify_view(req.view, req.signature))
