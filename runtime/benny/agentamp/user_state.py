"""AAMP-001 Phase 6 — Cockpit user state persistence (AAMP-F18, AAMP-F19).

User customisation (active skin, knob locks, window positions) is stored under
``${BENNY_HOME}/agentamp/user/cockpit.json`` so it persists across restarts and
can be moved between machines via the export/import roundtrip.

Public API
----------
  CockpitWindowPosition
      Per-window position entry in the user state.

  CockpitUserState
      Pydantic model for the full cockpit user customisation:
      active skin id, knob locks, window positions.

  load_user_state(benny_home) -> CockpitUserState
      Load (or create a default) user state from *benny_home*.

  save_user_state(state, benny_home) -> None
      Persist *state* to ``${benny_home}/agentamp/user/cockpit.json``.

  export_cockpit(benny_home, out_path) -> None
      Write a ``.aamp.cockpit`` zip bundle containing:
        cockpit.json — CockpitUserState
        eq.json      — EqLock (knob-lock state from the equalizer)

  import_cockpit(in_path, benny_home) -> CockpitUserState
      Extract and restore the bundle written by :func:`export_cockpit`.
      Returns the restored :class:`CockpitUserState`.

Requirements covered
--------------------
  F18   User customisation persists under ${BENNY_HOME}/agentamp/user/.
        No absolute paths.
  F19   export-cockpit / import-cockpit roundtrip.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Dict, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class CockpitWindowPosition(BaseModel):
    """Persisted window position entry (AAMP-F18).

    Attributes
    ----------
    x, y:
        Top-left corner coordinates (pixels).
    w, h:
        Width and height (pixels).
    snap:
        Last applied snap zone (``"tl"``, ``"tr"``, ``"bl"``, ``"br"``,
        ``"c"``), or ``None`` if the window was placed by the user.
    """

    x: int = 0
    y: int = 0
    w: int = 400
    h: int = 300
    snap: Optional[str] = None


class CockpitUserState(BaseModel):
    """Full cockpit user customisation (AAMP-F18).

    Persisted as ``${BENNY_HOME}/agentamp/user/cockpit.json``.

    Attributes
    ----------
    active_skin_id:
        The ``id`` of the currently active skin pack.  Defaults to
        ``"benny-default"`` (the bundled reference skin).
    knob_locks:
        Map of equalizer path → locked bool.  Mirrors :class:`~benny.agentamp
        .equalizer.EqLock` so that a single export carries full state.
    window_positions:
        Map of window id → :class:`CockpitWindowPosition`.  Keyed by the
        ``id`` field from the skin's layout DSL.
    """

    active_skin_id: str = "benny-default"
    knob_locks: Dict[str, bool] = Field(default_factory=dict)
    window_positions: Dict[str, CockpitWindowPosition] = Field(
        default_factory=dict
    )


# ---------------------------------------------------------------------------
# Internal path helpers
# ---------------------------------------------------------------------------

_COCKPIT_USER_FILE = "agentamp/user/cockpit.json"
_EQ_USER_FILE = "agentamp/user/eq.json"


def _resolve_benny_home(benny_home: Optional[Path]) -> Path:
    import os

    if benny_home is not None:
        return benny_home
    return Path(os.environ.get("BENNY_HOME", Path.home() / ".benny"))


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------


def load_user_state(benny_home: Optional[Path] = None) -> CockpitUserState:
    """Load cockpit user state from *benny_home*.

    Returns a default :class:`CockpitUserState` if no file exists yet.
    Never raises; parsing errors are swallowed and a fresh state is returned.
    """
    home = _resolve_benny_home(benny_home)
    p = home / _COCKPIT_USER_FILE
    if p.exists():
        try:
            return CockpitUserState.model_validate_json(
                p.read_text(encoding="utf-8")
            )
        except Exception:
            pass  # corrupt file — return fresh state
    return CockpitUserState()


def save_user_state(
    state: CockpitUserState,
    benny_home: Optional[Path] = None,
) -> None:
    """Persist *state* to ``${benny_home}/agentamp/user/cockpit.json``.

    Creates parent directories if they do not exist (AAMP-F18).
    """
    home = _resolve_benny_home(benny_home)
    p = home / _COCKPIT_USER_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(state.model_dump_json(indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Export / Import roundtrip (AAMP-F19)
# ---------------------------------------------------------------------------

_COCKPIT_BUNDLE_COCKPIT_MEMBER = "cockpit.json"
_COCKPIT_BUNDLE_EQ_MEMBER = "eq.json"
_COCKPIT_BUNDLE_META_MEMBER = "bundle.json"


def export_cockpit(
    out_path: Path,
    benny_home: Optional[Path] = None,
) -> None:
    """Write a ``.aamp.cockpit`` zip bundle from the current user state.

    Bundle contents (AAMP-F19)
    --------------------------
    ``cockpit.json``
        The :class:`CockpitUserState` (active skin, positions, knob-locks).
    ``eq.json``
        The raw equalizer lock state from
        ``${BENNY_HOME}/agentamp/user/eq.json``.
    ``bundle.json``
        Metadata: ``{"schema_version": "1.0", "exported_at": "<ISO-8601>"}``

    Parameters
    ----------
    out_path:
        Destination path for the ``.aamp.cockpit`` file.
    benny_home:
        Path to ``$BENNY_HOME``.  Defaults to the env var or ``~/.benny``.
    """
    from datetime import datetime, timezone

    home = _resolve_benny_home(benny_home)
    state = load_user_state(home)

    # Read eq.json if it exists (best-effort)
    eq_path = home / _EQ_USER_FILE
    eq_raw: str = "{}"
    if eq_path.exists():
        try:
            eq_raw = eq_path.read_text(encoding="utf-8")
        except OSError:
            pass

    meta = json.dumps(
        {
            "schema_version": "1.0",
            "exported_at": datetime.now(tz=timezone.utc).isoformat(),
        },
        indent=2,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(_COCKPIT_BUNDLE_COCKPIT_MEMBER, state.model_dump_json(indent=2))
        zf.writestr(_COCKPIT_BUNDLE_EQ_MEMBER, eq_raw)
        zf.writestr(_COCKPIT_BUNDLE_META_MEMBER, meta)


def import_cockpit(
    in_path: Path,
    benny_home: Optional[Path] = None,
) -> CockpitUserState:
    """Restore cockpit state from a ``.aamp.cockpit`` bundle.

    Extracts ``cockpit.json`` and ``eq.json`` from the bundle, writes them to
    ``${BENNY_HOME}/agentamp/user/``, and returns the restored state.

    Parameters
    ----------
    in_path:
        Path to the ``.aamp.cockpit`` zip file.
    benny_home:
        Path to ``$BENNY_HOME``.  Defaults to the env var or ``~/.benny``.

    Returns
    -------
    CockpitUserState
        The restored user state (already persisted to disk).

    Raises
    ------
    FileNotFoundError
        If *in_path* does not exist.
    KeyError
        If the bundle is missing the required ``cockpit.json`` member.
    """
    home = _resolve_benny_home(benny_home)

    if not in_path.exists():
        raise FileNotFoundError(f"Cockpit bundle not found: {in_path}")

    with zipfile.ZipFile(in_path, "r") as zf:
        cockpit_raw = zf.read(_COCKPIT_BUNDLE_COCKPIT_MEMBER).decode("utf-8")
        try:
            eq_raw = zf.read(_COCKPIT_BUNDLE_EQ_MEMBER).decode("utf-8")
        except KeyError:
            eq_raw = "{}"

    # Restore cockpit state
    state = CockpitUserState.model_validate_json(cockpit_raw)
    save_user_state(state, home)

    # Restore eq.json
    eq_dest = home / _EQ_USER_FILE
    eq_dest.parent.mkdir(parents=True, exist_ok=True)
    eq_dest.write_text(eq_raw, encoding="utf-8")

    return state
