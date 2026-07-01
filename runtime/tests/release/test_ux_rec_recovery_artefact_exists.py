from pathlib import Path

# Repo-relative: tests/release/ -> runtime/ project root.
BASE = Path(__file__).resolve().parents[2]


def test_ux_rec_recovery_artefacts_exist():
    """Assert that Phase 0 recovery artifacts exist and are non-empty."""
    patch_path = BASE / ".claude" / "recovery" / "UX-REC-001-diff.patch"
    untracked_path = BASE / ".claude" / "recovery" / "UX-REC-001-untracked.txt"

    assert patch_path.exists(), f"Patch not found at {patch_path}"
    assert patch_path.stat().st_size > 0, "Patch file is empty"

    assert untracked_path.exists(), f"Untracked list not found at {untracked_path}"
    assert untracked_path.stat().st_size > 0, "Untracked file list is empty"


if __name__ == "__main__":
    test_ux_rec_recovery_artefacts_exist()
    print("Phase 0 Artefacts Verified.")
