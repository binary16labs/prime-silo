import os
import json
import sys
from pathlib import Path
from typing import Dict, Any, List

# Add project root to sys.path
sys.path.append(os.getcwd())

from tree_sitter import Language, Parser, Node
import tree_sitter_python as tspython
import tree_sitter_javascript as tsjavascript
import tree_sitter_typescript as ts_ts

# --- Language Setup ---
LANGUAGES = {
    ".py": Language(tspython.language()),
    ".js": Language(tsjavascript.language()),
    ".jsx": Language(tsjavascript.language()),
    ".ts": Language(ts_ts.language_typescript()),
    ".tsx": Language(ts_ts.language_tsx()),
}

def serialize_node(node: Node, source: bytes) -> Dict[str, Any]:
    """Recursively converts a Tree-sitter Node to a serializable dictionary."""
    # Capture the text of the node
    text = source[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
    
    # Base properties
    res = {
        "type": node.type,
        "start_point": node.start_point,
        "end_point": node.end_point,
        "start_byte": node.start_byte,
        "end_byte": node.end_byte,
        "is_named": node.is_named,
    }
    
    # Only include text for leaf segments or small nodes to avoid massive redundant strings
    if node.child_count == 0:
        res["text"] = text
        
    # Children
    if node.child_count > 0:
        children = []
        for i in range(node.child_count):
            child = node.child(i)
            # We can also capture field names if they exist
            field_name = node.field_name_for_child(i)
            child_dict = serialize_node(child, source)
            if field_name:
                child_dict["field"] = field_name
            children.append(child_dict)
        res["children"] = children
        
    return res

def run_project_ast_extraction():
    root_path = Path(os.getcwd())
    output_path = root_path / "architecture" / "RAW_AST_BENNY.json"
    
    # We'll scan benny and frontend
    targets = ["benny", "frontend"]
    project_ast = {}
    
    parsers = {ext: Parser(lang) for ext, lang in LANGUAGES.items()}
    
    print("Starting Project-Wide AST Extraction...")
    
    file_count = 0
    for target in targets:
        target_dir = root_path / target
        if not target_dir.exists():
            print(f"Skipping {target}: Directory not found.")
            continue
            
        for root, _, files in os.walk(target_dir):
            if "node_modules" in root or "__pycache__" in root or ".git" in root:
                continue
                
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext in parsers:
                    file_path = Path(root) / file
                    rel_path = str(file_path.relative_to(root_path)).replace("\\", "/")
                    
                    try:
                        with open(file_path, "rb") as f:
                            content = f.read()
                            
                        parser = parsers[ext]
                        tree = parser.parse(content)
                        
                        print(f"Parsing: {rel_path}")
                        project_ast[rel_path] = {
                            "language": ext,
                            "ast": serialize_node(tree.root_node, content)
                        }
                        file_count += 1
                    except Exception as e:
                        print(f"Failed to parse {rel_path}: {e}")
                        
    print(f"Processed {file_count} files. Saving to {output_path}...")
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(project_ast, f, indent=2)
        
    print("Extraction Complete.")

if __name__ == "__main__":
    run_project_ast_extraction()
