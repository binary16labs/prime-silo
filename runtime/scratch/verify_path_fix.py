from pathlib import Path
import os
import sys

# Add project root to path
sys.path.append(str(Path(__file__).parent.parent))

from benny.core.workspace import get_workspace_path

workspace = "c4_test"
files = ["staging/"]

# Replicating the fixed Step 0 from graph_routes.py
workspace_root = get_workspace_path(workspace)
data_in_path = workspace_root / "data_in"
staging_path = workspace_root / "staging"

to_process = []
for f in files:
    # Check path relative to workspace root first
    p = workspace_root / f
    if not p.exists():
        # Fallback to subdirectories if f is just a filename
        p = data_in_path / f
        if not p.exists():
            p = staging_path / f
    
    if not p.exists():
        print(f"FAILED: Path not found: {f}")
        continue
    
    if p.is_dir():
        print(f"Expanding directory: {f} -> {p}")
        for item in p.rglob("*"):
            if item.is_file() and item.suffix.lower() in ['.md', '.txt', '.pdf']:
                to_process.append(item)
    else:
        to_process.append(p)

print(f"Files found to process: {len(to_process)}")
for item in to_process:
    print(f"  - {item}")
