import sys
import os
from pathlib import Path

# Add the project root to sys.path so we can import benny
sys.path.append(r'c:\Users\nsdha\OneDrive\code\benny')

from benny.graph.code_analyzer import CodeGraphAnalyzer

def validate():
    workspace_root = r'c:\Users\nsdha\OneDrive\code\benny'
    analyzer = CodeGraphAnalyzer(workspace_root)
    # Analyze a small part or the whole thing
    print(f"Scanning {workspace_root}...")
    result = analyzer.analyze_workspace(".")
    
    nodes = result['nodes']
    edges = result['edges']
    
    print(f"Found {len(nodes)} nodes and {len(edges)} edges.")
    
    # Analyze node types and names
    type_counts = {}
    short_names = []
    
    for node in nodes:
        t = node['type']
        name = node['name']
        type_counts[t] = type_counts.get(t, 0) + 1
        if t == 'Function' and len(name) <= 2:
            short_names.append(name)
            
    print("\nNode Type Breakdown:")
    for t, count in type_counts.items():
        print(f"  {t}: {count}")
        
    if short_names:
        print("Sample short names and their paths:")
        short_node_samples = [n for n in nodes if n['type'] == 'Function' and len(n['name']) <= 2][:10]
        for sn in short_node_samples:
            print(f"  {sn['name']} in {sn['file_path']}")

if __name__ == "__main__":
    validate()
