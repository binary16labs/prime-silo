from pathlib import Path

workspace_root = Path(r"c:\Users\nsdha\OneDrive\code\benny\workspace\c4_test")
data_in_path = workspace_root / "data_in"
staging_path = workspace_root / "staging"

f = "staging/"

# Logic used in graph_routes.py:
p = data_in_path / f
print(f"data_in check: {p}")
if not p.exists():
    p = staging_path / f
    print(f"staging check: {p}")

if p.exists():
    print(f"Path exists: {p}")
else:
    print(f"Path does NOT exist: {p}")
