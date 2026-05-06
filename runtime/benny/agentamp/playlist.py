"""AAMP-001 Phase 6 — Playlist data layer (AAMP-F11, AAMP-F12).

Public API
----------
  PlaylistEntry
      Lightweight view of a RunRecord shaped for the playlist panel display.
      Fields: run_id, manifest_id, workspace, status, started_at,
      completed_at, duration_ms, model, cost_usd.

  get_playlist(workspace, limit) -> List[PlaylistEntry]
      Read run history from :mod:`benny.persistence.run_store` and return
      playlist entries ordered newest-first.

  enqueue_manifest(manifest_dict, workspace, api_base, api_key) -> str
      POST a SwarmManifest dict to the existing ``POST /api/run`` endpoint
      and return the new ``run_id`` (AAMP-F12).  Requires the Benny backend
      to be running at *api_base*.

Requirements covered
--------------------
  F11   Playlist view reads benny runs history (get_playlist).
  F12   CLI enqueue dispatches via existing /api/run endpoint.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from ..persistence import run_store


# ---------------------------------------------------------------------------
# PlaylistEntry — lightweight run view
# ---------------------------------------------------------------------------


@dataclass
class PlaylistEntry:
    """Lightweight view of a RunRecord for the playlist panel (AAMP-F11).

    Attributes
    ----------
    run_id:        Unique run identifier.
    manifest_id:   ID of the manifest that was executed.
    workspace:     Workspace the run belongs to.
    status:        Run status string (``"pending"``, ``"running"``, …).
    started_at:    ISO-8601 start timestamp, or ``None``.
    completed_at:  ISO-8601 completion timestamp, or ``None``.
    duration_ms:   Wall-clock duration in milliseconds, or ``None``.
    model:         Model name from the manifest config, or ``None``.
    cost_usd:      Estimated cost in USD, or ``None`` (reserved for future).
    """

    run_id: str
    manifest_id: str
    workspace: str
    status: str
    started_at: Optional[str]
    completed_at: Optional[str]
    duration_ms: Optional[int]
    model: Optional[str]
    cost_usd: Optional[float]


# ---------------------------------------------------------------------------
# get_playlist — F11
# ---------------------------------------------------------------------------


def get_playlist(
    workspace: Optional[str] = None,
    limit: int = 50,
) -> List[PlaylistEntry]:
    """Return run history as playlist entries, newest-first.

    Reads directly from :mod:`benny.persistence.run_store`.  No HTTP call is
    needed; this function is called by the playlist API route which runs
    inside the same process as the run_store.

    Parameters
    ----------
    workspace:
        If provided, only runs for this workspace are returned.
    limit:
        Maximum number of entries to return.  Defaults to 50.
    """
    records = run_store.list_runs(workspace=workspace, limit=limit)
    entries: List[PlaylistEntry] = []
    for rec in records:
        # Pull model from the manifest snapshot config section
        snapshot: Dict[str, Any] = rec.manifest_snapshot or {}
        cfg = snapshot.get("config", {})
        model: Optional[str] = (
            cfg.get("model") if isinstance(cfg, dict) else None
        )
        status_str = (
            rec.status.value
            if hasattr(rec.status, "value")
            else str(rec.status)
        )
        entries.append(
            PlaylistEntry(
                run_id=rec.run_id,
                manifest_id=rec.manifest_id,
                workspace=rec.workspace,
                status=status_str,
                started_at=rec.started_at,
                completed_at=rec.completed_at,
                duration_ms=rec.duration_ms,
                model=model,
                cost_usd=None,  # reserved — not yet tracked in RunRecord
            )
        )
    return entries


# ---------------------------------------------------------------------------
# enqueue_manifest — F12
# ---------------------------------------------------------------------------


def enqueue_manifest(
    manifest_dict: Dict[str, Any],
    *,
    workspace: str = "default",
    api_base: str = "http://localhost:8000",
    api_key: str = "benny-mesh-2026-auth",
) -> str:
    """POST *manifest_dict* to ``POST /api/run`` and return the new run_id.

    AgentAmp does not implement scheduling itself — it dispatches via the
    existing run-orchestration endpoint (AAMP-F12).  Requires the Benny
    backend to be running at *api_base*.

    Parameters
    ----------
    manifest_dict:
        Plain-dict representation of a :class:`~benny.core.manifest.SwarmManifest`.
    workspace:
        Workspace to attach to the manifest before posting.
    api_base:
        Base URL of the Benny API server (default ``http://localhost:8000``).
    api_key:
        API key for the ``X-Benny-API-Key`` header.

    Returns
    -------
    str
        The ``run_id`` returned by the server.

    Raises
    ------
    urllib.error.URLError
        If the server is unreachable.
    ValueError
        If the server returns a non-200 response.
    """
    # Inject the requested workspace so the run is filed correctly
    payload = dict(manifest_dict)
    payload["workspace"] = workspace

    body = json.dumps(payload).encode("utf-8")
    url = f"{api_base.rstrip('/')}/api/run"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Benny-API-Key": api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_bytes = exc.read()
        raise ValueError(
            f"POST /api/run returned HTTP {exc.code}: {body_bytes.decode(errors='replace')}"
        ) from exc

    run_id: str = data.get("run_id") or data.get("id") or ""
    if not run_id:
        raise ValueError(f"Server response missing run_id: {data!r}")
    return run_id
