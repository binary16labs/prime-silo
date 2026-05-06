"""Phase 1a — AC-FR1..5-a: move the SSD to a second host; layout still validates.

The simulation moves the entire `$BENNY_HOME` tree to a new tmp location and
asserts that `validate()` returns OK without any rewrites or config edits.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from benny.portable import config as cfg
from benny.portable import home as home_mod


def test_move_ssd_to_second_host(tmp_path: Path) -> None:
    host_a_root = tmp_path / "host_a" / "optimus"
    host_b_root = tmp_path / "host_b" / "optimus"
    host_b_root.parent.mkdir(parents=True)

    # Host A: initialize.
    home_mod.init(host_a_root, profile="native")
    # Simulate some accumulated state.
    (host_a_root / "workspaces" / "demo").mkdir()
    (host_a_root / "workspaces" / "demo" / "manifest.yaml").write_text(
        "version: '1.0.0'\n", encoding="utf-8"
    )

    # Unplug + plug into host B: move the tree verbatim.
    shutil.move(str(host_a_root), str(host_b_root))

    # Host B: validate without edits.
    report = home_mod.validate(host_b_root)
    assert report.ok, f"post-move validate should be clean: {report.problems}"

    # Config still loads without any path rewriting.
    loaded = cfg.load(host_b_root)
    assert loaded.profile == "native"

    # Workspace data survived the move.
    assert (host_b_root / "workspaces" / "demo" / "manifest.yaml").is_file()
