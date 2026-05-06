import os

def test_ux_rec_recovery_artefacts_exist():
    """Assert that Phase 0 artifacts exist and are non-empty."""
    base_path = "C:/Users/nsdha/OneDrive/code/benny"
    patch_path = os.path.join(base_path, ".claude/recovery/UX-REC-001-diff.patch")
    untracked_path = os.path.join(base_path, ".claude/recovery/UX-REC-001-untracked.txt")
    
    assert os.path.exists(patch_path), f"Patch not found at {patch_path}"
    assert os.path.getsize(patch_path) > 0, "Patch file is empty"
    
    assert os.path.exists(untracked_path), f"Untracked list not found at {untracked_path}"
    # Untracked might be empty if there are no untracked files, but the plan implies non-empty.
    # Given the previous git status, it should definitely be non-empty.
    assert os.path.getsize(untracked_path) > 0, "Untracked file list is empty"

if __name__ == "__main__":
    test_ux_rec_recovery_artefacts_exist()
    print("Phase 0 Artefacts Verified.")
