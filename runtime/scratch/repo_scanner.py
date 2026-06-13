import sys
import os
from pathlib import Path

# Add prime-silo/runtime to path to import benny
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benny.graph.code_analyzer import CodeGraphAnalyzer

def main():
    # Workspace root is two folders up from this scratch script
    repo_root = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    target_dir = repo_root / "benny"
    
    print(f"Scanning directory: {target_dir}")
    analyzer = CodeGraphAnalyzer(str(repo_root))
    
    # Run the tree-sitter AST scanner on the "benny" folder
    result = analyzer.analyze_workspace(sub_dir="benny", deep_scan=True)
    
    nodes = result["nodes"]
    edges = result["edges"]
    
    # Collate statistics
    node_counts = {}
    for n in nodes:
        node_counts[n["type"]] = node_counts.get(n["type"], 0) + 1
        
    edge_counts = {}
    for e in edges:
        edge_counts[e["type"]] = edge_counts.get(e["type"], 0) + 1
        
    print("\n" + "="*50)
    print("Scan Summary:")
    print(f"Total Nodes: {len(nodes)}")
    for node_type, count in sorted(node_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"  - {node_type:15} : {count}")
        
    print(f"\nTotal Edges: {len(edges)}")
    for edge_type, count in sorted(edge_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"  - {edge_type:15} : {count}")
    print("="*50)
    
    # Show a few sample nodes of each major type
    for major_type in ["Class", "Function", "File"]:
        type_nodes = [n["name"] for n in nodes if n["type"] == major_type]
        if type_nodes:
            print(f"\nSample {major_type}s (showing up to 5):")
            for name in type_nodes[:5]:
                print(f"  - {name}")
                
    print("\nScan completed successfully!")

if __name__ == "__main__":
    main()
