"""ADR-001 Phase F / F2 — `.aamp.view` signing + pinning endpoints.

Mounted at ``/api/views`` (intentionally NOT under ``/api/agent_sandbox/``).
:class:`benny.api.agent_scope.AgentScopeMiddleware` blocks every mutating
request from an agent-scoped caller that does not start with the sandbox
prefix, so these endpoints are *human-only* by middleware policy. The 403
on agent calls is the security boundary; this router does not re-check.

Endpoints:

  POST /api/views/sign   — Phase F. Compute an HMAC-SHA256 signature over
                            the canonical payload of the supplied view.
                            Stateless — does not read or write disk.
  POST /api/views/verify — Phase F. Return ``{valid: bool}`` for a
                            (view, signature) pair. Stateless.
  POST /api/views/pin    — Phase F2. Promote an agent draft from
                            ``agent_sandbox/views/<src>`` to the canonical
                            ``views/<dst>`` workspace location. The runtime
                            re-reads the draft, parses as JSON, signs, embeds
                            the signature inline under ``signature``, and
                            writes the result outside the sandbox. Emits a
                            ``VIEW_PINNED`` audit event. Returns the relative
                            path and the signature envelope.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..core.workspace import (
    get_agent_sandbox_path,
    get_pinned_views_path,
    is_within_agent_sandbox,
)
from ..governance.audit import emit_governance_event
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


# ---------------------------------------------------------------------------
# Phase F2 — pin (promote sandbox draft to canonical signed view)
# ---------------------------------------------------------------------------


class PinViewRequest(BaseModel):
    workspace: str = Field(default="default")
    source_filename: str = Field(
        description=(
            "Filename of the agent-authored draft inside "
            "``agent_sandbox/views/``. Must not contain path separators."
        )
    )
    target_filename: Optional[str] = Field(
        default=None,
        description=(
            "Filename to write under the canonical ``views/`` directory. "
            "Defaults to ``source_filename`` so the pinned name matches the "
            "draft name unless the human chooses to rename on promotion."
        ),
    )
    pinned_by: str = Field(
        default="anonymous_human",
        description="Identifier of the human pinning the draft — recorded in lineage.",
    )


class PinViewResponse(BaseModel):
    workspace: str
    source_relative_path: str
    pinned_relative_path: str
    bytes_written: int
    signature: ViewSignature


@router.post("/pin", response_model=PinViewResponse)
async def pin_view_endpoint(req: PinViewRequest) -> PinViewResponse:
    """Promote an agent-drafted view to a signed, canonical workspace location.

    Steps (in this order; the order matters for the audit story):

      1. Validate filenames have no path separators.
      2. Resolve the source path inside ``agent_sandbox/views/`` and confirm
         the resolved path is still inside the sandbox subtree.
      3. Read the source UTF-8 and parse as JSON. A non-JSON draft is a 400
         (the sandbox saver enforces JSON for views, but be defensive).
      4. Compute the canonical signature.
      5. Embed the signature inline under ``signature`` so the pinned file
         is self-describing — `verify_view` round-trips an inline-signed
         view because :func:`canonical_view_payload` strips the field
         before hashing.
      6. Write to ``$BENNY_HOME/workspaces/<ws>/views/<target>``.
      7. Emit ``VIEW_PINNED`` for the workspace audit log.

    AgentScopeMiddleware is the sole gate keeping agents out — this
    endpoint never inspects ``X-Benny-Agent-Scope`` itself; an agent that
    reaches here is a middleware bug, not a runtime bug.
    """
    _validate_filename(req.source_filename)
    target_filename = req.target_filename or req.source_filename
    _validate_filename(target_filename)

    source_dir = get_agent_sandbox_path(req.workspace, "views")
    source_target = (source_dir / req.source_filename).resolve()
    if not is_within_agent_sandbox(req.workspace, source_target):
        raise HTTPException(
            status_code=400,
            detail="Resolved source path escapes the agent sandbox subtree.",
        )
    if not source_target.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"agent_sandbox/views/{req.source_filename} does not exist.",
        )

    raw = source_target.read_text(encoding="utf-8")
    try:
        view_dict = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Draft view is not valid JSON: {exc.msg}",
        ) from exc
    if not isinstance(view_dict, dict):
        raise HTTPException(
            status_code=400,
            detail="Draft view must be a JSON object at the top level.",
        )

    signature = sign_view(view_dict)
    pinned = {**view_dict, "signature": signature.model_dump()}
    pinned_payload = json.dumps(pinned, sort_keys=True, indent=2, ensure_ascii=False)

    pinned_dir = get_pinned_views_path(req.workspace)
    pinned_dir.mkdir(parents=True, exist_ok=True)
    pinned_target = pinned_dir / target_filename
    pinned_target.write_text(pinned_payload, encoding="utf-8")
    bytes_written = len(pinned_payload.encode("utf-8"))

    source_relative = f"agent_sandbox/views/{req.source_filename}"
    pinned_relative = f"views/{target_filename}"

    emit_governance_event(
        event_type="VIEW_PINNED",
        data={
            "process": "view_pin",
            "skill": req.pinned_by,
            "data": pinned_relative,
            "source": source_relative,
            "signature_value": signature.value,
            "signed_at": signature.signed_at,
            "bytes_written": bytes_written,
        },
        workspace_id=req.workspace,
    )

    return PinViewResponse(
        workspace=req.workspace,
        source_relative_path=source_relative,
        pinned_relative_path=pinned_relative,
        bytes_written=bytes_written,
        signature=signature,
    )


def _validate_filename(filename: str) -> None:
    if not filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Filename must not be empty or start with '.'")
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Filename must not contain path separators.")
    if Path(filename).name != filename:
        # Catches edge cases like 'foo/../bar' that survive the separator check on some OSes.
        raise HTTPException(status_code=400, detail="Filename must be a single path component.")
