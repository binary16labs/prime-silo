import os
import sys
from pathlib import Path

# Add project root to sys.path
sys.path.append(os.getcwd())

from benny.graph.code_analyzer import CodeGraphAnalyzer

def run_live_scan():
    workspace_path = os.getcwd()
    analyzer = CodeGraphAnalyzer(workspace_path)
    
    print(f"Scanning workspace: {workspace_path}")
    result = analyzer.analyze_workspace()
    
    nodes = result["nodes"]
    edges = result["edges"]
    
    # Analyze distribution
    types = {}
    for n in nodes:
        t = n.get("type", "Unknown")
        types[t] = types.get(t, 0) + 1
        
    rel_types = {}
    for e in edges:
        t = e.get("type", "Unknown")
        rel_types[t] = rel_types.get(t, 0) + 1
        
    # Update GRAPH_SCHEMA.md
    schema_path = Path("architecture/GRAPH_SCHEMA.md")
    if schema_path.exists():
        with open(schema_path, "a") as f:
            f.write("\n## 4. Observed Instance Stats (Live Scan)\n")
            f.write(f"**Workspace**: {workspace_path}\n")
            f.write(f"**Total Entities**: {len(nodes)}\n")
            f.write(f"**Total Relationships**: {len(edges)}\n\n")
            f.write("| Entity Type | Count |\n| :--- | :--- |\n")
            for t, count in sorted(types.items(), key=lambda x: x[1], reverse=True):
                f.write(f"| {t} | {count} |\n")
            
            f.write("\n| Relationship Type | Count |\n| :--- | :--- |\n")
            for t, count in sorted(rel_types.items(), key=lambda x: x[1], reverse=True):
                f.write(f"| {t} | {count} |\n")
                
    print(f"Index complete. {len(nodes)} nodes, {len(edges)} edges. Stats appended to GRAPH_SCHEMA.md")

if __name__ == "__main__":
    run_live_scan()
