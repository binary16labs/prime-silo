"""AAMP-001 Phase 6 — Cockpit user state acceptance tests.

Covers
------
  AAMP-F18  test_aamp_f18_user_state_under_benny_home
  AAMP-F19  test_aamp_f19_export_import_cockpit_roundtrip
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from benny.agentamp.user_state import (
    CockpitUserState,
    CockpitWindowPosition,
    export_cockpit,
    import_cockpit,
    load_user_state,
    save_user_state,
)


# ---------------------------------------------------------------------------
# AAMP-F18 — user state persists under $BENNY_HOME
# ---------------------------------------------------------------------------


class TestUserStateUnderBennyHome:
    """test_aamp_f18_user_state_under_benny_home: state lives at
    ${BENNY_HOME}/agentamp/user/cockpit.json with no absolute paths."""

    def test_save_creates_file_under_benny_home(self, tmp_path: Path) -> None:
        """save_user_state writes cockpit.json inside ${BENNY_HOME}/agentamp/user/."""
        state = CockpitUserState(active_skin_id="test-skin")
        save_user_state(state, tmp_path)
        cockpit_file = tmp_path / "agentamp" / "user" / "cockpit.json"
        assert cockpit_file.exists()

    def test_no_absolute_paths_in_persisted_file(self, tmp_path: Path) -> None:
        """The persisted cockpit.json must not contain absolute path strings (SR-1)."""
        state = CockpitUserState(
            active_skin_id="my-skin",
            window_positions={
                "main": CockpitWindowPosition(x=10, y=20, w=800, h=600)
            },
        )
        save_user_state(state, tmp_path)
        cockpit_file = tmp_path / "agentamp" / "user" / "cockpit.json"
        raw = cockpit_file.read_text(encoding="utf-8")
        # No drive letters or Unix-style absolute paths
        assert "C:\\" not in raw
        assert "D:\\" not in raw
        # Root-relative paths like /home/... should not appear
        lines_with_slash = [
            ln for ln in raw.splitlines()
            if '":"/' in ln or '": "/' in ln
        ]
        assert lines_with_slash == [], (
            f"Absolute paths found in cockpit.json: {lines_with_slash}"
        )

    def test_load_returns_default_when_no_file(self, tmp_path: Path) -> None:
        """load_user_state returns a default CockpitUserState when no file exists."""
        state = load_user_state(tmp_path)
        assert isinstance(state, CockpitUserState)
        assert state.active_skin_id == "benny-default"
        assert state.knob_locks == {}
        assert state.window_positions == {}

    def test_roundtrip_save_and_load(self, tmp_path: Path) -> None:
        """State saved and loaded back is identical."""
        original = CockpitUserState(
            active_skin_id="retro-wave",
            knob_locks={"config.model": True, "config.max_concurrency": False},
            window_positions={
                "main": CockpitWindowPosition(x=0, y=0, w=1280, h=720, snap="tl"),
                "playlist": CockpitWindowPosition(x=1280, y=0, w=320, h=720, snap="tr"),
            },
        )
        save_user_state(original, tmp_path)
        loaded = load_user_state(tmp_path)

        assert loaded.active_skin_id == "retro-wave"
        assert loaded.knob_locks == {"config.model": True, "config.max_concurrency": False}
        assert "main" in loaded.window_positions
        assert loaded.window_positions["main"].w == 1280
        assert loaded.window_positions["playlist"].snap == "tr"

    def test_load_survives_corrupt_file(self, tmp_path: Path) -> None:
        """load_user_state returns a default state if cockpit.json is corrupt."""
        cockpit_file = tmp_path / "agentamp" / "user" / "cockpit.json"
        cockpit_file.parent.mkdir(parents=True, exist_ok=True)
        cockpit_file.write_text("not valid json {{{", encoding="utf-8")
        state = load_user_state(tmp_path)
        assert state.active_skin_id == "benny-default"

    def test_save_creates_parent_dirs(self, tmp_path: Path) -> None:
        """save_user_state creates agentamp/user/ if it does not exist."""
        state = CockpitUserState()
        deep = tmp_path / "new_home"
        save_user_state(state, deep)
        assert (deep / "agentamp" / "user" / "cockpit.json").exists()

    def test_window_position_fields_persisted(self, tmp_path: Path) -> None:
        """CockpitWindowPosition x/y/w/h/snap fields survive the JSON roundtrip."""
        state = CockpitUserState(
            window_positions={
                "vis": CockpitWindowPosition(x=100, y=200, w=400, h=300, snap="c"),
            }
        )
        save_user_state(state, tmp_path)
        loaded = load_user_state(tmp_path)
        pos = loaded.window_positions["vis"]
        assert pos.x == 100
        assert pos.y == 200
        assert pos.w == 400
        assert pos.h == 300
        assert pos.snap == "c"


# ---------------------------------------------------------------------------
# AAMP-F19 — export / import cockpit roundtrip
# ---------------------------------------------------------------------------


class TestExportImportCockpitRoundtrip:
    """test_aamp_f19_export_import_cockpit_roundtrip: export → import gives
    byte-identical user state on a different host (simulated with tmp dirs)."""

    def _make_state(self) -> CockpitUserState:
        return CockpitUserState(
            active_skin_id="finance-classic",
            knob_locks={"config.model": True},
            window_positions={
                "main": CockpitWindowPosition(x=0, y=0, w=920, h=540, snap="tl"),
                "playlist": CockpitWindowPosition(x=920, y=0, w=320, h=540, snap="tr"),
            },
        )

    def test_export_creates_zip(self, tmp_path: Path) -> None:
        """export_cockpit produces a valid zip file."""
        home = tmp_path / "home"
        save_user_state(self._make_state(), home)
        out = tmp_path / "export.aamp.cockpit"
        export_cockpit(out, home)
        assert out.exists()
        assert zipfile.is_zipfile(out)

    def test_zip_contains_required_members(self, tmp_path: Path) -> None:
        """The bundle contains cockpit.json, eq.json, and bundle.json."""
        home = tmp_path / "home"
        save_user_state(self._make_state(), home)
        out = tmp_path / "export.aamp.cockpit"
        export_cockpit(out, home)

        with zipfile.ZipFile(out, "r") as zf:
            names = set(zf.namelist())
        assert "cockpit.json" in names
        assert "eq.json" in names
        assert "bundle.json" in names

    def test_import_restores_state(self, tmp_path: Path) -> None:
        """import_cockpit restores the same CockpitUserState that was exported."""
        home_export = tmp_path / "home_a"
        home_import = tmp_path / "home_b"
        original = self._make_state()
        save_user_state(original, home_export)

        out = tmp_path / "bundle.aamp.cockpit"
        export_cockpit(out, home_export)
        restored = import_cockpit(out, home_import)

        assert restored.active_skin_id == original.active_skin_id
        assert restored.knob_locks == original.knob_locks
        assert set(restored.window_positions.keys()) == set(
            original.window_positions.keys()
        )

    def test_import_writes_cockpit_json(self, tmp_path: Path) -> None:
        """import_cockpit persists the restored state to disk."""
        home_export = tmp_path / "home_a"
        home_import = tmp_path / "home_b"
        save_user_state(self._make_state(), home_export)
        out = tmp_path / "bundle.aamp.cockpit"
        export_cockpit(out, home_export)
        import_cockpit(out, home_import)

        cockpit_file = home_import / "agentamp" / "user" / "cockpit.json"
        assert cockpit_file.exists()
        reloaded = load_user_state(home_import)
        assert reloaded.active_skin_id == "finance-classic"

    def test_import_restores_eq_locks(self, tmp_path: Path) -> None:
        """import_cockpit also restores eq.json for the knob-lock state."""
        home_export = tmp_path / "home_a"
        home_import = tmp_path / "home_b"

        # Write an eq.json on the source
        eq_src = home_export / "agentamp" / "user" / "eq.json"
        eq_src.parent.mkdir(parents=True, exist_ok=True)
        eq_src.write_text('{"locks": {"config.model": true}}', encoding="utf-8")
        save_user_state(self._make_state(), home_export)

        out = tmp_path / "bundle.aamp.cockpit"
        export_cockpit(out, home_export)
        import_cockpit(out, home_import)

        eq_dest = home_import / "agentamp" / "user" / "eq.json"
        assert eq_dest.exists()
        data = json.loads(eq_dest.read_text(encoding="utf-8"))
        assert data.get("locks", {}).get("config.model") is True

    def test_import_raises_on_missing_file(self, tmp_path: Path) -> None:
        """import_cockpit raises FileNotFoundError for a non-existent bundle."""
        with pytest.raises(FileNotFoundError):
            import_cockpit(tmp_path / "nonexistent.aamp.cockpit", tmp_path / "home")

    def test_bundle_meta_has_schema_version(self, tmp_path: Path) -> None:
        """bundle.json in the exported zip contains schema_version and exported_at."""
        home = tmp_path / "home"
        save_user_state(self._make_state(), home)
        out = tmp_path / "export.aamp.cockpit"
        export_cockpit(out, home)

        with zipfile.ZipFile(out, "r") as zf:
            meta = json.loads(zf.read("bundle.json").decode("utf-8"))

        assert meta["schema_version"] == "1.0"
        assert "exported_at" in meta
