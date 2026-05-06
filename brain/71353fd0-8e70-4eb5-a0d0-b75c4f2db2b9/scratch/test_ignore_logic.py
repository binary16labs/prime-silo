import sys
import os
from pathlib import Path

# Add project root
sys.path.append(r'c:\Users\nsdha\OneDrive\code\benny')

from benny.graph.code_analyzer import CodeGraphAnalyzer

def test_ignore():
    workspace_root = r'c:\Users\nsdha\OneDrive\code\benny'
    analyzer = CodeGraphAnalyzer(workspace_root)
    
    # Check if frontend/dist is ignored
    dist_path = os.path.join(workspace_root, "frontend", "dist")
    is_ignored = analyzer._should_ignore(dist_path)
    print(f"Is {dist_path} ignored? {is_ignored}")
    
    # Check if a .py file is NOT ignored
    py_path = os.path.join(workspace_root, "benny", "api", "graph_routes.py")
    is_ignored_py = analyzer._should_ignore(py_path)
    print(f"Is {py_path} ignored? {is_ignored_py}")

    # Check patterns
    print("Ignore patterns:", analyzer.ignore_patterns)

if __name__ == "__main__":
    test_ignore()
