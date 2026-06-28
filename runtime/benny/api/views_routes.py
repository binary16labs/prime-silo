"""ADR-001 Phase F / F2 / F2b — `.aamp.view` signing + pinning + load endpoints.

Mounted at ``/api/views`` (intentionally NOT under ``/api/agent_sandbox/``).
:class:`benny.api.agent_scope.AgentScopeMiddleware` blocks every mutating
request from an agent-scoped caller that does not start with the sandbox
prefix, so the *mutating* endpoints here are human-only by middleware policy.
The 403 on agent calls is the security boundary; this router does not
re-check. Reads (``GET /load``) are unrestricted by design — pinned views
are deterministic-zone artefacts and replay must succeed under any caller,
including bound agent clients that want to read a previously-pinned layout.

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
  GET  /api/views/load/{workspace}/{filename}
                          — Phase F2b. Read a pinned view from
                            ``$BENNY_HOME/workspaces/<ws>/views/<filename>``,
                            extract the embedded signature, verify it
                            against the rest of the view's canonical payload,
                            and return the parsed view + signature + a
                            ``valid`` boolean in one round-trip. This is the
                            load-time integrity replay — a shell that
                            renders an unverified pinned view is doing the
                            wrong thing.
"""

from __future__ import annotations

import json
import os
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


# ---------------------------------------------------------------------------
# Phase F2b — load (read + verify a pinned view in one round-trip)
# ---------------------------------------------------------------------------


class LoadPinnedViewResponse(BaseModel):
    workspace: str
    filename: str
    relative_path: str = Field(
        description="The workspace-relative path of the loaded file, e.g. ``views/foo.aamp.view``.",
    )
    bytes: int = Field(description="Length of the raw UTF-8 file body.")
    view: dict[str, Any] = Field(
        description=(
            "The full pinned-view JSON object, signature included. The client "
            "decides whether to strip the signature before rendering; "
            ":func:`canonical_view_payload` round-trips with or without it."
        )
    )
    signature: Optional[ViewSignature] = Field(
        default=None,
        description=(
            "Signature envelope extracted from the embedded ``signature`` "
            "field. ``None`` when the file lacks an inline signature — that "
            "case forces ``valid=False`` and the caller should refuse to "
            "render the layout."
        ),
    )
    valid: bool = Field(
        description=(
            "True iff the inline signature validly signs the rest of the "
            "view's canonical payload. This is the load-time replay check; "
            "a False here means the file has been tampered with, the HMAC "
            "key rotated, or the file was written by an older build."
        )
    )


@router.get(
    "/load/{workspace}/{filename}",
    response_model=LoadPinnedViewResponse,
)
async def load_pinned_view_endpoint(workspace: str, filename: str) -> LoadPinnedViewResponse:
    """Read a pinned view and verify its embedded signature in one round-trip.

    The shell calls this on every pinned-view replay so the runtime — the
    only holder of ``BENNY_HMAC_KEY`` — gets to enforce integrity. The
    browser never sees the key and never re-signs, only consumes the
    ``valid`` flag.

    Flow:

      1. Validate filename (no separators, no dot-prefix).
      2. Resolve the path under ``$BENNY_HOME/workspaces/<ws>/views/`` and
         confirm the resolved path stays inside that subtree (defence
         against ``..`` smuggled through URL-decoding edge cases).
      3. 404 when the file does not exist; 400 when the body is not a JSON
         object.
      4. Strip the embedded ``signature`` field (if any), reconstruct it as
         a :class:`ViewSignature`, and call :func:`verify_view` against the
         full view dict. ``canonical_view_payload`` strips ``signature``
         before hashing so the inline form round-trips cleanly.
      5. Return ``{view, signature, valid, …}``. A missing or malformed
         inline signature yields ``valid=False`` (not an HTTP error) — the
         caller's branch on ``valid`` is the single decision point.

    No audit event: pinned-view *reads* are not privileged. The
    ``VIEW_PINNED`` event from the pin step records the artefact's birth;
    reads are routine.
    """
    _validate_filename(filename)

    pinned_dir = get_pinned_views_path(workspace)
    pinned_target = (pinned_dir / filename).resolve()
    pinned_dir_resolved = pinned_dir.resolve()
    # Belt-and-suspenders containment check. get_workspace_path already
    # rejects traversal, but a future refactor of the pinned-dir layout
    # shouldn't be able to silently weaken this.
    try:
        common = os.path.commonpath([str(pinned_dir_resolved), str(pinned_target)])
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Resolved path escapes the pinned-views directory.",
        )
    if common != str(pinned_dir_resolved):
        raise HTTPException(
            status_code=400,
            detail="Resolved path escapes the pinned-views directory.",
        )
    if not pinned_target.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"views/{filename} does not exist in workspace {workspace!r}.",
        )

    raw = pinned_target.read_text(encoding="utf-8")
    try:
        view_dict = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Pinned view is not valid JSON: {exc.msg}",
        ) from exc
    if not isinstance(view_dict, dict):
        raise HTTPException(
            status_code=400,
            detail="Pinned view must be a JSON object at the top level.",
        )

    signature_obj: Optional[ViewSignature] = None
    valid = False
    raw_signature = view_dict.get("signature")
    if isinstance(raw_signature, dict):
        try:
            signature_obj = ViewSignature(**raw_signature)
        except Exception:
            # A malformed envelope is a tamper signal — surface it as
            # valid=False rather than a 500.
            signature_obj = None
        else:
            valid = verify_view(view_dict, signature_obj)

    return LoadPinnedViewResponse(
        workspace=workspace,
        filename=filename,
        relative_path=f"views/{filename}",
        bytes=len(raw.encode("utf-8")),
        view=view_dict,
        signature=signature_obj,
        valid=valid,
    )
