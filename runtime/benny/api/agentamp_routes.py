"""AAMP-001 Phase 5 + Phase 6 — AgentAmp API routes.

Endpoints
---------
  PUT /agentamp/eq
      Apply equalizer knobs to a SwarmManifest.  Validates allow-list,
      evaluates policy, signs the updated manifest, records a ledger entry,
      and returns the result (AAMP-F9, AAMP-F10, AAMP-SEC5, AAMP-COMP1,
      AAMP-COMP2).

  GET  /agentamp/playlist
      Return run history as playlist entries (AAMP-F11).

  POST /agentamp/enqueue
      Enqueue a manifest for execution via the existing run infrastructure
      (AAMP-F12).

  GET  /agentamp/user-state
      Read current cockpit user state (AAMP-F18).

  PUT  /agentamp/user-state
      Persist cockpit user state (AAMP-F18).

  POST /agentamp/layout/apply
      Apply Layout DSL to a list of windows and return resolved positions
      (AAMP-F20).

Requirements covered
--------------------
  F9     PUT /agentamp/eq — path validation + sign + persist.
  F10    per-task picker via task_ids; knob locks via eq.json.
  SEC5   policy.evaluate(aamp.eq_write) called before any mutation.
  COMP1  ledger entry recorded on every write.
  COMP2  previous_signatures returned in response.
  F11    GET /agentamp/playlist — reads runs from run_store.
  F12    POST /agentamp/enqueue — dispatches via existing run infrastructure.
  F18    GET/PUT /agentamp/user-state — user customisation persistence.
  F20    POST /agentamp/layout/apply — snap zones + clamping.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from ..agentamp.equalizer import (
    EqKnob,
    EqWriteResult,
    apply_eq_write,
)
from ..agentamp.playlist import PlaylistEntry, get_playlist
from ..agentamp.user_state import (
    CockpitUserState,
    CockpitWindowPosition,
    load_user_state,
    save_user_state,
)
from ..agentamp.layout import SNAP_ZONES, LayoutResult, apply_layout
from ..governance.policy import PolicyDeniedError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agentamp", tags=["agentamp"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class EqWriteRequest(BaseModel):
    """PUT /agentamp/eq request body (AAMP-F9, AAMP-F10)."""

    manifest: Dict[str, Any] = Field(
        ...,
        description="The SwarmManifest dict to edit.",
    )
    knobs: List[EqKnob] = Field(
        ...,
        description="List of equalizer knobs to apply.",
    )
    workspace: str = Field(default="default")
    persona: str = Field(
        default="aamp:user",
        description="Persona making the edit — forwarded to policy evaluation.",
    )
    task_ids: Optional[List[str]] = Field(
        default=None,
        description=(
            "When knobs include tasks[*].* paths, only these task IDs are "
            "updated (per-task picker — AAMP-F10)."
        ),
    )


class EqWriteResponse(BaseModel):
    """PUT /agentamp/eq response body."""

    updated_manifest: Dict[str, Any]
    new_signature: Dict[str, Any]
    previous_signatures: List[Dict[str, Any]]
    ledger_seq: int


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.put("/eq", response_model=EqWriteResponse, summary="Apply equalizer knobs (AAMP-F9)")
async def put_eq(body: EqWriteRequest) -> EqWriteResponse:
    """Apply equalizer knobs to a SwarmManifest.

    Validates each knob path against the allow-list, evaluates
    ``aamp.eq_write`` policy, signs the updated manifest, records a ledger
    entry, and returns the result with preserved previous signatures.

    Returns 422 if any knob path is not allow-listed.
    Returns 403 if policy denies the write.
    """
    benny_home = Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))

    try:
        result: EqWriteResult = apply_eq_write(
            body.manifest,
            body.knobs,
            workspace=body.workspace,
            benny_home=benny_home,
            persona=body.persona,
            task_ids=body.task_ids,
        )
    except ValueError as exc:
        # EqPathNotAllowed is a ValueError subclass
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except PolicyDeniedError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Unexpected error in PUT /agentamp/eq")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return EqWriteResponse(
        updated_manifest=result.updated_manifest,
        new_signature=result.new_signature,
        previous_signatures=result.previous_signatures,
        ledger_seq=result.ledger_seq,
    )


# ---------------------------------------------------------------------------
# Playlist — AAMP-F11
# ---------------------------------------------------------------------------


class PlaylistEntryResponse(BaseModel):
    """Playlist entry as returned by GET /agentamp/playlist (AAMP-F11)."""

    run_id: str
    manifest_id: str
    workspace: str
    status: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None
    model: Optional[str] = None
    cost_usd: Optional[float] = None


@router.get(
    "/playlist",
    response_model=List[PlaylistEntryResponse],
    summary="List run history as playlist entries (AAMP-F11)",
)
async def get_playlist_view(
    workspace: Optional[str] = None,
    limit: int = 50,
) -> List[PlaylistEntryResponse]:
    """Return run history as playlist entries, newest-first.

    Reads directly from the run_store; no scheduling is performed.
    """
    entries: List[PlaylistEntry] = get_playlist(workspace=workspace, limit=limit)
    return [
        PlaylistEntryResponse(
            run_id=e.run_id,
            manifest_id=e.manifest_id,
            workspace=e.workspace,
            status=e.status,
            started_at=e.started_at,
            completed_at=e.completed_at,
            duration_ms=e.duration_ms,
            model=e.model,
            cost_usd=e.cost_usd,
        )
        for e in entries
    ]


# ---------------------------------------------------------------------------
# Enqueue — AAMP-F12
# ---------------------------------------------------------------------------


class EnqueueRequest(BaseModel):
    """POST /agentamp/enqueue request body (AAMP-F12)."""

    manifest: Dict[str, Any] = Field(
        ...,
        description="The SwarmManifest dict to enqueue.",
    )
    workspace: str = Field(default="default")


class EnqueueResponse(BaseModel):
    """POST /agentamp/enqueue response body."""

    run_id: str
    manifest_id: str
    status: str


@router.post(
    "/enqueue",
    response_model=EnqueueResponse,
    summary="Enqueue a manifest for execution (AAMP-F12)",
)
async def enqueue_run(
    body: EnqueueRequest,
    background_tasks: BackgroundTasks,
) -> EnqueueResponse:
    """Enqueue a manifest for execution via the existing run infrastructure.

    AgentAmp does no scheduling itself — it uses the existing manifest
    runner and run_store (AAMP-F12).
    """
    from ..core.manifest import RunRecord, RunStatus, SwarmManifest
    from ..graph.manifest_runner import execute_manifest
    from ..persistence import run_store

    manifest_dict = dict(body.manifest)
    manifest_dict["workspace"] = body.workspace

    # Parse or create a SwarmManifest
    try:
        manifest = SwarmManifest.model_validate(manifest_dict)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid manifest: {exc}") from exc

    run_store.save_manifest(manifest)

    run_id = f"run-{uuid.uuid4().hex[:12]}"
    pending = RunRecord(
        run_id=run_id,
        manifest_id=manifest.id,
        workspace=manifest.workspace,
        status=RunStatus.PENDING,
        started_at=datetime.utcnow().isoformat(),
        manifest_snapshot=manifest.model_dump(),
    )
    run_store.save_run(pending)

    async def _run(m: SwarmManifest, rid: str) -> None:
        from ..core.manifest import RunStatus
        try:
            await execute_manifest(m, run_id=rid)
        except Exception as exc:  # noqa: BLE001
            logger.error("enqueue run %s failed: %s", rid, exc)

    background_tasks.add_task(_run, manifest, run_id)

    return EnqueueResponse(
        run_id=run_id,
        manifest_id=manifest.id,
        status="pending",
    )


# ---------------------------------------------------------------------------
# User state — AAMP-F18
# ---------------------------------------------------------------------------


@router.get(
    "/user-state",
    response_model=CockpitUserState,
    summary="Read cockpit user state (AAMP-F18)",
)
async def get_user_state_endpoint() -> CockpitUserState:
    """Return the current cockpit user customisation from BENNY_HOME."""
    benny_home = Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))
    return load_user_state(benny_home)


@router.put(
    "/user-state",
    response_model=CockpitUserState,
    summary="Persist cockpit user state (AAMP-F18)",
)
async def put_user_state_endpoint(body: CockpitUserState) -> CockpitUserState:
    """Save cockpit user customisation to BENNY_HOME."""
    benny_home = Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))
    save_user_state(body, benny_home)
    return body


# ---------------------------------------------------------------------------
# Layout DSL apply — AAMP-F20
# ---------------------------------------------------------------------------


class LayoutWindowInput(BaseModel):
    """Input window for the layout DSL apply endpoint."""

    id: str
    x: int = 0
    y: int = 0
    w: int = 400
    h: int = 300
    z: int = 0
    snap: Optional[str] = None
    min_w: int = 0
    min_h: int = 0


class LayoutApplyRequest(BaseModel):
    """POST /agentamp/layout/apply request body (AAMP-F20)."""

    windows: List[LayoutWindowInput]
    viewport_w: int = Field(..., gt=0, description="Viewport width in pixels")
    viewport_h: int = Field(..., gt=0, description="Viewport height in pixels")


class LayoutResultResponse(BaseModel):
    """Resolved window geometry (AAMP-F20)."""

    window_id: str
    x: int
    y: int
    w: int
    h: int
    snap: Optional[str] = None


@router.post(
    "/layout/apply",
    response_model=List[LayoutResultResponse],
    summary="Apply Layout DSL snap + clamp (AAMP-F20)",
)
async def apply_layout_endpoint(body: LayoutApplyRequest) -> List[LayoutResultResponse]:
    """Apply snap zones and viewport clamping to the supplied window list.

    Returns one resolved geometry per window in the same order.
    Snap zones: ``tl`` | ``tr`` | ``bl`` | ``br`` | ``c``.
    """
    from ..agentamp.contracts import SkinLayout, SkinWindow

    windows = [
        SkinWindow(
            id=w.id,
            x=w.x,
            y=w.y,
            w=w.w,
            h=w.h,
            z=w.z,
            snap=w.snap,
            min_w=w.min_w,
            min_h=w.min_h,
        )
        for w in body.windows
    ]
    skin_layout = SkinLayout(windows=windows)

    try:
        results: List[LayoutResult] = apply_layout(
            skin_layout, body.viewport_w, body.viewport_h
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return [
        LayoutResultResponse(
            window_id=r.window_id,
            x=r.x,
            y=r.y,
            w=r.w,
            h=r.h,
            snap=r.snap,
        )
        for r in results
    ]
