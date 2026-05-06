"""SR-1 gate: no absolute host paths in persisted artifacts.

Covers acceptance criteria AC-FR1..5-b and AC-SR1-a from PBR-001.
The scanner under test is `benny.governance.portability.absolute_path_scanner`.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from benny.governance.portability import absolute_path_scanner as scanner


@pytest.fixture
def offending_samples() -> list[str]:
    return [
        r"C:\Users\alice\project\file.py",
        "/home/alice/project/file.py",
        "/Users/alice/project/file.py",
        r'path = "D:\\data\\runs\\abc"',
        "see /mnt/ssd/benny for details",
    ]


@pytest.fixture
def clean_samples() -> list[str]:
    return [
        "<SSD_ROOT>/data/runs/abc",
        "data/runs/abc",
        "./relative/path",
        "https://example.com/Users/api",  # URL, not a filesystem path
        "D:/optimus/data/runs",  # allow-listed: this IS the SSD root
    ]


def test_scan_finds_offending_paths(offending_samples: list[str]) -> None:
    for line in offending_samples:
        hits = scanner.scan_text(line)
        assert hits, f"scanner missed absolute-path in: {line!r}"


def test_scan_clean_samples_are_silent(clean_samples: list[str]) -> None:
    for line in clean_samples:
        hits = scanner.scan_text(line, ssd_root="D:/optimus")
        assert not hits, f"false positive on clean sample: {line!r} -> {hits}"


def test_scan_finds_none_in_portable_scope(repo_root: Path) -> None:
    """AC-FR1..5-b (Phase 0 scope) — the files that must be clean today are clean.

    Phase 0 only enforces cleanliness on the new portable-install surface
    (the scanner modules themselves and the PBR-001 requirements doc). The
    repo-wide sweep is the subject of `test_repo_wide_sweep_is_ratcheting`
    below, and full cleanup is a Phase 1 deliverable.
    """
    violations = scanner.scan_tree(
        repo_root,
        include_globs=(
            "benny/governance/portability/**/*.py",
            "docs/requirements/PORTABLE_BENNY_REQUIREMENTS.md",
        ),
        exclude_globs=("**/__pycache__/**",),
        ssd_root="D:/optimus",
    )
    assert violations == [], (
        "Portable-scope files must be absolute-path clean:\n"
        + "\n".join(f"  {v.path}:{v.line_no}: {v.snippet}" for v in violations)
    )


def test_repo_wide_sweep_is_ratcheting(repo_root: Path) -> None:
    """Ratchet: record today's baseline count; future runs must not exceed it.

    The baseline file lives next to this test. When Phase 1 cleanup work lands,
    lower the baseline. CI fails if the count *rises*. This is how we drive
    the repo to zero without blocking Phase 0 on existing debt.
    """
    import json

    baseline_path = Path(__file__).parent / "absolute_paths_baseline.json"
    violations = scanner.scan_tree(
        repo_root,
        include_globs=("benny/**/*.py", "*.toml", "*.yaml", "*.yml", "docs/**/*.md"),
        exclude_globs=(
            "tests/**",
            "**/__pycache__/**",
            ".claude/worktrees/**",  # sibling worktrees mirror the same files
        ),
        ssd_root="D:/optimus",
    )
    current = len(violations)
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))["count"]
    assert current <= baseline, (
        f"Absolute-path violations rose: was {baseline}, now {current}. "
        "A new leak was introduced — fix it before merging."
    )


def test_cli_entrypoint_returns_nonzero_on_violations(tmp_path: Path) -> None:
    bad = tmp_path / "bad.txt"
    bad.write_text("C:\\Users\\alice\\leak.txt\n", encoding="utf-8")
    rc = scanner.main([str(tmp_path)])
    assert rc != 0


def test_cli_entrypoint_returns_zero_on_clean_tree(tmp_path: Path) -> None:
    good = tmp_path / "good.txt"
    good.write_text("relative/path only\n", encoding="utf-8")
    rc = scanner.main([str(tmp_path)])
    assert rc == 0
