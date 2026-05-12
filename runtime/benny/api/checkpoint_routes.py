"""ADR-001 Phase H — session checkpoint endpoints.

Two routers:

  ``sandbox_router``  (prefix: ``/api/agent_sandbox/checkpoints``)
      Draft operations — scoped behind ``AgentScopeMiddleware`` by virtue of
      the ``/api/agent_sandbox/`` prefix. Both agents and humans (with a scope
      header) may save, list, load, and delete draft checkpoints.

      POST   /save
      GET    /list/<ws>
      GET    /load/<ws>/<name>
      DELETE /delete/<ws>/<name>

  ``pinned_router``  (prefix: ``/api/checkpoints``)
      Pin / load-pinned / list-pinned — mounted **outside** the agent_sandbox
      prefix so ``AgentScopeMiddleware`` 403s every agent-scoped POST here.
      Pinning is a human-only operation (same policy as ``POST /api/views/pin``).
      Reads (GET) are unrestricted.

      POST   /pin
      GET    /list/<ws>
      GET    /load/<ws>/<name>

Security model (identical to Phase D3 / F2):
  - Agent-scoped writes go through the sandbox prefix (/api/agent_sandbox/).
  - PIN is human-only — middleware blocks X-Benny-Agent-Scope callers.
  - Reads are unrestricted (any authenticated caller).
  - Path traversal: resolved paths must stay inside the target directory;
    any resolution that escapes raises HTTP 400.

NF constraints:
  - History serialised > 2 MB → HTTP 413 (browser must compact first).
  - Name: ``[a-zA-Z0-9_\\-]`` only, max 80 chars, no leading dot.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, List, Literal, Optional
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..core.workspace import (
    get_checkpoint_draft_dir,
    get_checkpoint_pinned_dir,
)
from ..governance.audit import emit_governance_event
from .views_signing import (
    ViewSignature,
    canonical_view_payload,
    sign_view,
    verify_view,
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

sandbox_router = APIRouter()
pinned_router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHECKPOINT_SCHEMA = "aamp.checkpoint/1"
MAX_HISTORY_BYTES = 2 * 1024 * 1024  # 2 MB
_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,80}$")
_VALID_ROLES = frozenset({"system", "user", "assistant"})
_VALID_SOURCES = frozenset({"operator", "agent", "template"})


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class CheckpointHistoryMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = ""


class CheckpointTransientItem(BaseModel):
    path: str
    encoding: str = "utf8"


class CheckpointMetadata(BaseModel):
    description: str = ""
    source: str = "operator"
    fork_of: Optional[str] = None
    fork_index: Optional[int] = None
    pre_restore_of: Optional[str] = None


class CheckpointObject(BaseModel):
    schema_: str = Field(alias="schema", default=CHECKPOINT_SCHEMA)
    name: str
    workspace: str
    saved_at: str
    history: List[dict[str, Any]] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    transient_items: dict[str, Any] = Field(default_factory=dict)
    run_refs: List[str] = Field(default_factory=list)
    manifest_refs: List[str] = Field(default_factory=list)
    metadata: CheckpointMetadata = Field(default_factory=CheckpointMetadata)
    signature: Optional[dict[str, Any]] = None

    model_config = {"populate_by_name": True}


class SaveCheckpointRequest(BaseModel):
    workspace: str = Field(default="default")
    name: str
    checkpoint: dict[str, Any]


class SaveCheckpointResponse(BaseModel):
    saved: bool = True
    path: str
    bytes: int


class CheckpointSummary(BaseModel):
    name: str
    saved_at: str
    status: Literal["draft", "pinned"] = "draft"
    skill_count: int
    message_count: int
    run_refs: List[str] = Field(default_factory=list)
    manifest_refs: List[str] = Field(default_factory=list)
    source: str = "operator"
    fork_of: Optional[str] = None
    description: str = ""
    valid: Optional[bool] = None  # Only set for pinned checkpoints


class PinCheckpointRequest(BaseModel):
    workspace: str = Field(default="default")
    source_name: str
    pinned_by: str = Field(default="anonymous_human")
    target_name: Optional[str] = None


class PinCheckpointResponse(BaseModel):
    workspace: str
    source_relative_path: str
    pinned_relative_path: str
    bytes_written: int
    signature: ViewSignature


class LoadPinnedCheckpointResponse(BaseModel):
    workspace: str
    name: str
    relative_path: str
    bytes: int
    checkpoint: dict[str, Any]
    signature: Optional[ViewSignature] = None
    valid: bool


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _validate_checkpoint_name(name: str) -> None:
    """Validate a checkpoint name: alphanumeric + underscore + hyphen, 1-80 chars."""
    if not name:
        raise HTTPException(status_code=400, detail="Checkpoint name must not be empty.")
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid checkpoint name {name!r}. "
                "Names must match [a-zA-Z0-9_-] and be at most 80 characters."
            ),
        )


def _resolve_safe_draft(workspace: str, name: str) -> Path:
    """Resolve the draft path and verify it stays inside the draft dir."""
    draft_dir = get_checkpoint_draft_dir(workspace)
    target = (draft_dir / f"{name}.json").resolve()
    draft_dir_abs = draft_dir.resolve()
    try:
        common = os.path.commonpath([str(draft_dir_abs), str(target)])
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Resolved checkpoint path escapes the draft directory."
        )
    if common != str(draft_dir_abs):
        raise HTTPException(
            status_code=400, detail="Resolved checkpoint path escapes the draft directory."
        )
    return target


def _resolve_safe_pinned(workspace: str, name: str) -> Path:
    """Resolve the pinned path and verify it stays inside the pinned dir."""
    pinned_dir = get_checkpoint_pinned_dir(workspace)
    target = (pinned_dir / f"{name}.json").resolve()
    pinned_dir_abs = pinned_dir.resolve()
    try:
        common = os.path.commonpath([str(pinned_dir_abs), str(target)])
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Resolved checkpoint path escapes the pinned directory."
        )
    if common != str(pinned_dir_abs):
        raise HTTPException(
            status_code=400, detail="Resolved checkpoint path escapes the pinned directory."
        )
    return target


def _validate_checkpoint_object(cp: dict[str, Any]) -> None:
    """Validate the checkpoint object structure."""
    if not isinstance(cp, dict):
        raise HTTPException(status_code=400, detail="Checkpoint must be a JSON object.")
    schema = cp.get("schema")
    if schema != CHECKPOINT_SCHEMA:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported checkpoint schema {schema!r}. Expected {CHECKPOINT_SCHEMA!r}.",
        )
    history = cp.get("history", [])
    if not isinstance(history, list):
        raise HTTPException(status_code=400, detail="Checkpoint history must be an array.")
    for i, msg in enumerate(history):
        if not isinstance(msg, dict):
            raise HTTPException(
                status_code=400, detail=f"history[{i}] must be an object."
            )
        role = msg.get("role", "")
        if role not in _VALID_ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"history[{i}].role {role!r} is invalid. Expected one of {sorted(_VALID_ROLES)}.",
            )
    serialised = json.dumps(cp, ensure_ascii=False)
    if len(serialised.encode("utf-8")) > MAX_HISTORY_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "error": "history_too_large",
                "bytes": len(serialised.encode("utf-8")),
                "max_bytes": MAX_HISTORY_BYTES,
            },
        )


def _extract_summary(name: str, cp: dict[str, Any], status: str = "draft",
                     valid: Optional[bool] = None) -> CheckpointSummary:
    """Extract a summary row from a full checkpoint object."""
    meta = cp.get("metadata") or {}
    history = cp.get("history") or []
    return CheckpointSummary(
        name=name,
        saved_at=cp.get("saved_at", ""),
        status=status,  # type: ignore[arg-type]
        skill_count=len(cp.get("skills") or []),
        message_count=len(history),
        run_refs=cp.get("run_refs") or [],
        manifest_refs=cp.get("manifest_refs") or [],
        source=meta.get("source", "operator"),
        fork_of=meta.get("fork_of"),
        description=meta.get("description", ""),
        valid=valid,
    )


# ---------------------------------------------------------------------------
# sandbox_router — draft operations
# ---------------------------------------------------------------------------


@sandbox_router.post("/save", response_model=SaveCheckpointResponse)
async def save_checkpoint(req: SaveCheckpointRequest) -> SaveCheckpointResponse:
    """Save a named session checkpoint into ``agent_sandbox/checkpoints/``.

    Validation:
      - Name: ``[a-zA-Z0-9_-]``, max 80 chars.
      - ``checkpoint.schema`` must be ``aamp.checkpoint/1``.
      - History roles must be ``system | user | assistant``.
      - Total serialised size ≤ 2 MB; returns HTTP 413 otherwise so the
        browser can compact history first.
      - Path traversal: resolved path must stay inside the draft dir.

    Re-saving with the same name and identical content is a no-op (idempotent)
    with no audit event. Any diff triggers a full overwrite and a new
    ``CHECKPOINT_SAVED`` event.
    """
    _validate_checkpoint_name(req.name)
    _validate_checkpoint_object(req.checkpoint)

    draft_dir = get_checkpoint_draft_dir(req.workspace)
    draft_dir.mkdir(parents=True, exist_ok=True)
    target = _resolve_safe_draft(req.workspace, req.name)

    payload_str = json.dumps(req.checkpoint, sort_keys=True, indent=2, ensure_ascii=False)
    payload_bytes = payload_str.encode("utf-8")

    # Idempotent: skip write + audit if content is identical.
    if target.is_file():
        existing = target.read_bytes()
        existing_norm = json.dumps(
            json.loads(existing.decode("utf-8")), sort_keys=True, indent=2, ensure_ascii=False
        ).encode("utf-8")
        if existing_norm == payload_bytes:
            return SaveCheckpointResponse(
                saved=True,
                path=f"agent_sandbox/checkpoints/{req.name}.json",
                bytes=len(payload_bytes),
            )

    target.write_bytes(payload_bytes)

    meta = req.checkpoint.get("metadata") or {}
    emit_governance_event(
        event_type="CHECKPOINT_SAVED",
        data={
            "process": "checkpoint_save",
            "skill": meta.get("source", "unknown"),
            "data": f"agent_sandbox/checkpoints/{req.name}.json",
            "bytes_written": len(payload_bytes),
        },
        workspace_id=req.workspace,
    )

    return SaveCheckpointResponse(
        saved=True,
        path=f"agent_sandbox/checkpoints/{req.name}.json",
        bytes=len(payload_bytes),
    )


@sandbox_router.get("/list/{workspace}", response_model=List[CheckpointSummary])
async def list_checkpoints(workspace: str) -> List[CheckpointSummary]:
    """List all draft checkpoints in a workspace (metadata only, no history body).

    Sorted newest-first by ``saved_at`` field; falls back to file mtime when
    ``saved_at`` is absent.
    """
    draft_dir = get_checkpoint_draft_dir(workspace)
    if not draft_dir.exists():
        return []

    summaries: list[CheckpointSummary] = []
    for path in draft_dir.iterdir():
        if not path.is_file() or not path.name.endswith(".json"):
            continue
        name = path.stem
        try:
            cp = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(cp, dict):
            summaries.append(_extract_summary(name, cp, status="draft"))

    summaries.sort(key=lambda s: s.saved_at, reverse=True)
    return summaries


@sandbox_router.get("/load/{workspace}/{name}")
async def load_checkpoint(workspace: str, name: str) -> dict[str, Any]:
    """Return the full checkpoint body (history included).

    No ``AgentScopeMiddleware`` restriction on reads — any authenticated caller
    may read a draft checkpoint.
    """
    _validate_checkpoint_name(name)
    target = _resolve_safe_draft(workspace, name)
    if not target.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Checkpoint {name!r} does not exist in workspace {workspace!r}.",
        )
    raw = target.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Checkpoint file is not valid JSON: {exc.msg}",
        ) from exc


@sandbox_router.delete("/delete/{workspace}/{name}")
async def delete_checkpoint(workspace: str, name: str, force: bool = False) -> dict[str, Any]:
    """Delete a draft checkpoint.

    Returns 404 if the draft does not exist.
    Returns 409 when a pinned version of the same name exists and ``force``
    is not set — the pinned copy is untouched either way. Pass ``?force=true``
    to delete the draft even when a pinned sibling exists.
    """
    _validate_checkpoint_name(name)
    target = _resolve_safe_draft(workspace, name)
    if not target.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Checkpoint {name!r} does not exist in workspace {workspace!r}.",
        )

    # Check for a pinned sibling.
    pinned_dir = get_checkpoint_pinned_dir(workspace)
    pinned_sibling = pinned_dir / f"{name}.json"
    has_pinned = pinned_sibling.is_file()

    if has_pinned and not force:
        raise HTTPException(
            status_code=409,
            detail=(
                f"A pinned checkpoint named {name!r} also exists at "
                f"checkpoints/{name}.json. The draft can still be deleted "
                "but the pinned copy will be unaffected. "
                "Pass ?force=true to proceed."
            ),
        )

    target.unlink()
    return {
        "deleted": True,
        "name": name,
        "workspace": workspace,
        "pinned_sibling_exists": has_pinned,
    }


# ---------------------------------------------------------------------------
# pinned_router — pin / load-pinned / list-pinned
# ---------------------------------------------------------------------------


@pinned_router.post("/pin", response_model=PinCheckpointResponse)
async def pin_checkpoint(req: PinCheckpointRequest) -> PinCheckpointResponse:
    """Promote a draft checkpoint to a signed, canonical workspace location.

    Steps (in order; order matters for audit):
      1. Validate names.
      2. Read ``agent_sandbox/checkpoints/<source>.json``.
      3. Parse as JSON; reject non-object or non-JSON.
      4. Strip any pre-existing ``signature`` field (idempotent re-pin).
      5. Compute HMAC-SHA256 using :func:`benny.api.views_signing.sign_view`.
      6. Embed the signature inline under ``signature``.
      7. Write to ``$BENNY_HOME/workspaces/<ws>/checkpoints/<target>.json``.
      8. Emit ``CHECKPOINT_PINNED`` audit event.

    ``AgentScopeMiddleware`` is the sole gate keeping agents out — this endpoint
    never inspects ``X-Benny-Agent-Scope`` itself. An agent that reaches here
    is a middleware bug, not a runtime bug.
    """
    _validate_checkpoint_name(req.source_name)
    target_name = req.target_name or req.source_name
    _validate_checkpoint_name(target_name)

    # Read source draft.
    source_path = _resolve_safe_draft(req.workspace, req.source_name)
    if not source_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Draft checkpoint {req.source_name!r} does not exist.",
        )

    raw = source_path.read_text(encoding="utf-8")
    try:
        cp_dict = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Draft checkpoint is not valid JSON: {exc.msg}",
        ) from exc
    if not isinstance(cp_dict, dict):
        raise HTTPException(
            status_code=400,
            detail="Draft checkpoint must be a JSON object at the top level.",
        )

    # Sign (reuse views_signing — same HMAC-SHA256, same key, same canonical form).
    # The signing function strips the ``signature`` field before hashing so
    # re-pinning an already-pinned draft is idempotent.
    signature = sign_view(cp_dict)
    pinned = {**cp_dict, "signature": signature.model_dump()}
    pinned_payload = json.dumps(pinned, sort_keys=True, indent=2, ensure_ascii=False)

    # Write to canonical location.
    pinned_dir = get_checkpoint_pinned_dir(req.workspace)
    pinned_dir.mkdir(parents=True, exist_ok=True)
    pinned_target = _resolve_safe_pinned(req.workspace, target_name)
    pinned_target.write_text(pinned_payload, encoding="utf-8")
    bytes_written = len(pinned_payload.encode("utf-8"))

    source_relative = f"agent_sandbox/checkpoints/{req.source_name}.json"
    pinned_relative = f"checkpoints/{target_name}.json"

    emit_governance_event(
        event_type="CHECKPOINT_PINNED",
        data={
            "process": "checkpoint_pin",
            "skill": req.pinned_by,
            "data": pinned_relative,
            "source": source_relative,
            "signature_value": signature.value,
            "signed_at": signature.signed_at,
            "bytes_written": bytes_written,
        },
        workspace_id=req.workspace,
    )

    return PinCheckpointResponse(
        workspace=req.workspace,
        source_relative_path=source_relative,
        pinned_relative_path=pinned_relative,
        bytes_written=bytes_written,
        signature=signature,
    )


@pinned_router.get("/list/{workspace}", response_model=List[CheckpointSummary])
async def list_pinned_checkpoints(workspace: str) -> List[CheckpointSummary]:
    """List pinned checkpoints with HMAC validity status."""
    pinned_dir = get_checkpoint_pinned_dir(workspace)
    if not pinned_dir.exists():
        return []

    summaries: list[CheckpointSummary] = []
    for path in pinned_dir.iterdir():
        if not path.is_file() or not path.name.endswith(".json"):
            continue
        name = path.stem
        try:
            cp = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(cp, dict):
            continue

        # Verify inline signature.
        valid = False
        raw_sig = cp.get("signature")
        if isinstance(raw_sig, dict):
            try:
                sig_obj = ViewSignature(**raw_sig)
                valid = verify_view(cp, sig_obj)
            except Exception:
                valid = False

        summaries.append(_extract_summary(name, cp, status="pinned", valid=valid))

    summaries.sort(key=lambda s: s.saved_at, reverse=True)
    return summaries


@pinned_router.get("/load/{workspace}/{name}", response_model=LoadPinnedCheckpointResponse)
async def load_pinned_checkpoint(
    workspace: str, name: str
) -> LoadPinnedCheckpointResponse:
    """Read a pinned checkpoint and verify its embedded signature in one round-trip.

    Returns ``{checkpoint, signature, valid, …}``. A missing or malformed
    inline signature yields ``valid=False`` (not HTTP error) — the caller
    decides. Tampered body → ``valid=False``.

    Reads are unrestricted; agents can load pinned checkpoints even though they
    cannot create them.
    """
    _validate_checkpoint_name(name)
    pinned_target = _resolve_safe_pinned(workspace, name)

    if not pinned_target.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Pinned checkpoint {name!r} does not exist in workspace {workspace!r}.",
        )

    raw = pinned_target.read_text(encoding="utf-8")
    try:
        cp_dict = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Pinned checkpoint is not valid JSON: {exc.msg}",
        ) from exc
    if not isinstance(cp_dict, dict):
        raise HTTPException(
            status_code=400,
            detail="Pinned checkpoint must be a JSON object at the top level.",
        )

    signature_obj: Optional[ViewSignature] = None
    valid = False
    raw_sig = cp_dict.get("signature")
    if isinstance(raw_sig, dict):
        try:
            signature_obj = ViewSignature(**raw_sig)
        except Exception:
            signature_obj = None
        else:
            valid = verify_view(cp_dict, signature_obj)

    return LoadPinnedCheckpointResponse(
        workspace=workspace,
        name=name,
        relative_path=f"checkpoints/{name}.json",
        bytes=len(raw.encode("utf-8")),
        checkpoint=cp_dict,
        signature=signature_obj,
        valid=valid,
    )
