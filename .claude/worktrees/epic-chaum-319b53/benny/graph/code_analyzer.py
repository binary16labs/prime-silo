import os
from pathlib import Path
from typing import List, Dict, Any, Optional, Set
from tree_sitter import Language, Parser, QueryCursor
import tree_sitter_python as tspython
import tree_sitter_javascript as tsjavascript
import tree_sitter_typescript as ts_ts
import logging
import pathspec
from benny.core.workspace import load_manifest

logger = logging.getLogger(__name__)

# --- Language Setup ---
LANGUAGES = {
    ".py": Language(tspython.language()),
    ".js": Language(tsjavascript.language()),
    ".jsx": Language(tsjavascript.language()),
    ".ts": Language(ts_ts.language_typescript()),
    ".tsx": Language(ts_ts.language_tsx()),
}

DOC_EXTENSIONS = {".md", ".pdf", ".txt"}

# --- UML Pattern Queries ---
# These extract Classes, Functions, Inheritance, and Imports
QUERIES = {
    "python": """
        (class_definition
          name: (identifier) @class_name
          superclasses: (argument_list (identifier) @parent_name)? @parents
        ) @class

        (function_definition
          name: (identifier) @function_name
        ) @function

        (import_statement) @import
        (import_from_statement) @import
    """,
    "typescript": """
        (class_declaration
          name: (type_identifier) @class_name
          (class_heritage (_)? @parent_name)? @parents
        ) @class

        (function_declaration
          name: (identifier) @function_name
        ) @function

        (method_definition
          name: (property_identifier) @method_name
        ) @method

        (interface_declaration
          name: (type_identifier) @interface_name
        ) @interface

        (import_statement) @import
    """,
    "javascript": """
        (class_declaration
          name: (identifier) @class_name
          (class_heritage (_)? @parent_name)? @parents
        ) @class

        (function_declaration
          name: (identifier) @function_name
        ) @function

        (method_definition
          name: (property_identifier) @method_name
        ) @method

        (import_statement) @import
    """
}

class CodeNode:
    def __init__(self, id: str, name: str, type: str, file_path: str, metadata: Dict[str, Any] = None,
                 ast_range_start: Optional[list] = None, ast_range_end: Optional[list] = None):
        self.id = id
        self.name = name
        self.type = type  # File, Class, Function, Interface
        self.file_path = file_path
        self.metadata = metadata or {}
        self.ast_range_start = ast_range_start  # [line, col] from Tree-sitter
        self.ast_range_end   = ast_range_end    # [line, col] from Tree-sitter

class CodeEdge:
    def __init__(self, source: str, target: str, type: str, metadata: Dict[str, Any] = None):
        self.source = source
        self.target = target
        self.type = type # DEFINES, CALLS, INHERITS, DEPENDS_ON
        self.metadata = metadata or {}

class CodeGraphAnalyzer:
    def __init__(self, workspace_root: str):
        self.workspace_root = Path(workspace_root)
        self.nodes: Dict[str, CodeNode] = {}
        self.edges: List[CodeEdge] = []
        self.parsers: Dict[str, Parser] = {}
        
        for ext, lang in LANGUAGES.items():
            parser = Parser(lang)
            self.parsers[ext] = parser
            
        self.ignore_patterns = self._load_ignore_patterns()

    def _load_ignore_patterns(self) -> pathspec.PathSpec:
        """Load patterns from manifest and .gitignore into a PathSpec object"""
        patterns = [
            ".git", "node_modules", "__pycache__",
            "dist", "build", ".venv", "venv"
        ]
        
        # 1. Try to load from manifest
        try:
            # convention: workspace/ID/...
            parts = self.workspace_root.parts
            if "workspace" in parts:
                ws_idx = parts.index("workspace")
                if len(parts) > ws_idx + 1:
                    ws_id = parts[ws_idx + 1]
                    manifest = load_manifest(ws_id)
                    if hasattr(manifest, 'exclude_patterns'):
                        patterns.extend(manifest.exclude_patterns)
        except Exception:
            pass

        # 2. Try to load from .gitignore
        gitignore_path = self.workspace_root / ".gitignore"
        if gitignore_path.exists():
            try:
                with open(gitignore_path, "r") as f:
                    patterns.extend(f.readlines())
            except Exception:
                pass
                
        return pathspec.PathSpec.from_lines('gitwildmatch', patterns)

    def _should_ignore(self, file_path: str) -> bool:
        """Check if a path matches the pathspec ignore patterns"""
        rel_path = os.path.relpath(file_path, self.workspace_root).replace("\\", "/")
        return self.ignore_patterns.match_file(rel_path)

    def _get_node_id(self, file_path: str, name: str = None) -> str:
        rel_path = os.path.relpath(file_path, self.workspace_root)
        if name:
            return f"{rel_path}::{name}".replace("\\", "/")
        return rel_path.replace("\\", "/")

    def analyze_workspace(self, sub_dir: str = "", deep_scan: bool = True) -> Dict[str, Any]:
        """Recursively analyze the workspace starting from sub_dir"""
        start_path = self.workspace_root / sub_dir
        if not start_path.exists():
            raise ValueError(f"Path does not exist: {start_path}")

        for root, dirs, files in os.walk(start_path):
            # Dynamic Ignore Check for Directories
            dirs[:] = [d for d in dirs if not self._should_ignore(os.path.join(root, d))]

            # Create Folder Node for 'root'
            rel_root = os.path.relpath(root, self.workspace_root).replace("\\", "/")
            if rel_root != ".":
                if rel_root not in self.nodes:
                    self.nodes[rel_root] = CodeNode(rel_root, os.path.basename(root), "Folder", rel_root)
                
                # Link Parent Folder -> Current Folder
                parent_dir = os.path.dirname(rel_root)
                if parent_dir and parent_dir != ".":
                    if parent_dir not in self.nodes:
                        self.nodes[parent_dir] = CodeNode(parent_dir, os.path.basename(parent_dir), "Folder", parent_dir)
                    self.edges.append(CodeEdge(parent_dir, rel_root, "DEFINES"))

            for file in files:
                full_path = os.path.join(root, file)
                if self._should_ignore(full_path):
                    continue
                    
                ext = os.path.splitext(file)[1].lower()
                if ext in self.parsers:
                    file_node_id = self._analyze_file(full_path, ext, deep_scan=deep_scan)
                    # Link Folder -> File
                    if rel_root != "." and file_node_id:
                        self.edges.append(CodeEdge(rel_root, file_node_id, "DEFINES"))
                elif ext in DOC_EXTENSIONS:
                    file_node_id = self._get_node_id(full_path)
                    rel_path = os.path.relpath(full_path, self.workspace_root).replace("\\", "/")
                    if file_node_id not in self.nodes:
                        self.nodes[file_node_id] = CodeNode(file_node_id, os.path.basename(full_path), "Documentation", rel_path)
                    if rel_root != "." and file_node_id:
                        self.edges.append(CodeEdge(rel_root, file_node_id, "CONTAINS"))

        return {
            "nodes": [vars(n) for n in self.nodes.values()],
            "edges": [vars(e) for e in self.edges]
        }

    def _analyze_file(self, file_path: str, ext: str, deep_scan: bool = True) -> str:
        parser = self.parsers[ext]
        rel_path = os.path.relpath(file_path, self.workspace_root).replace("\\", "/")
        
        # Create File Node
        file_node_id = self._get_node_id(file_path)
        if file_node_id not in self.nodes:
            self.nodes[file_node_id] = CodeNode(file_node_id, os.path.basename(file_path), "File", rel_path)

        if not deep_scan:
            return file_node_id

        with open(file_path, "rb") as f:
            content = f.read()
            tree = parser.parse(content)

        lang_key = "python" if ext == ".py" else "typescript" if ext in [".ts", ".tsx"] else "javascript"
        query_str = QUERIES.get(lang_key)
        
        if not query_str:
            return file_node_id

        # Tree-sitter 0.25.2 requires Query constructor
        from tree_sitter import Query
        query = Query(LANGUAGES[ext], query_str)
        cursor = QueryCursor(query)
        # captures() returns a dictionary of lists in 0.25.2
        captures = cursor.captures(tree.root_node)
        
        # Process classes and functions
        current_class = None
        
        for tag, nodes in captures.items():
            for node in nodes:
                name = None
                node_type = None

                if tag in ["class_name", "interface_name"]:
                    name = content[node.start_byte:node.end_byte].decode("utf-8")
                    node_type = "Class" if tag == "class_name" else "Interface"
                    symbol_id = self._get_node_id(file_path, name)

                    if symbol_id not in self.nodes:
                        self.nodes[symbol_id] = CodeNode(
                            symbol_id, name, node_type, rel_path,
                            ast_range_start=list(node.start_point),
                            ast_range_end=list(node.end_point)
                        )
                        # Edge File -> Class
                        self.edges.append(CodeEdge(file_node_id, symbol_id, "DEFINES"))

                    current_class = symbol_id

                elif tag in ["function_name", "method_name"]:
                    name = content[node.start_byte:node.end_byte].decode("utf-8")
                    node_type = "Function"
                    symbol_id = self._get_node_id(file_path, name)

                    if symbol_id not in self.nodes:
                        self.nodes[symbol_id] = CodeNode(
                            symbol_id, name, node_type, rel_path,
                            ast_range_start=list(node.start_point),
                            ast_range_end=list(node.end_point)
                        )
                        # If inside a class, Class -> Method, else File -> Function
                        parent_id = current_class if current_class and tag == "method_name" else file_node_id
                        self.edges.append(CodeEdge(parent_id, symbol_id, "DEFINES"))

                elif tag == "parent_name":
                    parent_name = content[node.start_byte:node.end_byte].decode("utf-8")
                    if current_class:
                        # We don't know the exact file of the parent without full indexing
                        # but we create a virtual node for now or link and let Neo4j merge
                        target_id = f"virtual::{parent_name}"
                        self.edges.append(CodeEdge(current_class, target_id, "INHERITS"))
                        if target_id not in self.nodes:
                             self.nodes[target_id] = CodeNode(target_id, parent_name, "ExternalClass", "unknown")

                elif tag == "import":
                    # Very basic import dependency tracking
                    # A more thorough implementation would resolve these paths
                    self.edges.append(CodeEdge(file_node_id, "external_dependency", "DEPENDS_ON", {"raw": content[node.start_byte:node.end_byte].decode("utf-8")}))

    def save_to_neo4j(self, workspace: str, snapshot_id: str, name: Optional[str] = None):
        """Sync the analyzed graph to Neo4j as a unique snapshot"""
        from ..core.graph_db import write_session, create_code_scan
        
        # 1. Register the scan snapshot
        create_code_scan(snapshot_id, workspace, str(self.workspace_root), name)

        with write_session() as session:
            # 2. Add CodeEntity Nodes and link to Concepts
            for node in self.nodes.values():
                session.run("""
                    MERGE (n:CodeEntity {id: $id, workspace: $ws, snapshot_id: $snap})
                    ON CREATE SET n.name = $name, n.type = $type, n.file_path = $path,
                                  n.created_at = datetime(),
                                  n.ast_range_start = $ast_start,
                                  n.ast_range_end   = $ast_end
                    ON MATCH SET  n.name = $name, n.type = $type, n.file_path = $path,
                                  n.updated_at = datetime(),
                                  n.ast_range_start = $ast_start,
                                  n.ast_range_end   = $ast_end
                    WITH n
                    // Auto-align Documentation nodes to Document label for Knowledge Graph unify
                    FOREACH (ignoreMe IN CASE WHEN $type = 'Documentation' THEN [1] ELSE [] END | SET n:Document)

                    MERGE (c:Concept {name: $name, workspace: $ws})
                    ON CREATE SET c.node_type = 'Concept', c.created_at = datetime()
                    ON MATCH SET  c.updated_at = datetime()
                    MERGE (n)-[:REPRESENTS]->(c)
                """,
                    id=node.id, ws=workspace, name=node.name, type=node.type,
                    path=node.file_path, snap=snapshot_id,
                    ast_start=node.ast_range_start,
                    ast_end=node.ast_range_end
                )

            # 3. Add internal code relationships (DEFINES, CALLS, etc)
            for edge in self.edges:
                session.run("""
                    MATCH (s:CodeEntity {id: $src, workspace: $ws, snapshot_id: $snap})
                    MATCH (t:CodeEntity {id: $tgt, workspace: $ws, snapshot_id: $snap})
                    MERGE (s)-[r:CODE_REL {type: $rel_type}]->(t)
                    ON CREATE SET r.snapshot_id = $snap, r.created_at = datetime()
                    ON MATCH SET  r.snapshot_id = $snap, r.updated_at = datetime()
                """, src=edge.source, tgt=edge.target, ws=workspace, rel_type=edge.type, snap=snapshot_id)

def get_workspace_graph(workspace_id: str, snapshot_id: Optional[str] = None, path_filter: Optional[str] = None):
    """Fetch the code graph from Neo4j in a format suited for Three.js"""
    from ..core.graph_db import read_session
    
    with read_session() as session:
        # If no snapshot_id provided, find the most recent one for this workspace
        if not snapshot_id:
            latest_res = session.run("""
                MATCH (s:CodeScan {workspace: $ws})
                RETURN s.scan_id AS scan_id
                ORDER BY s.created_at DESC
                LIMIT 1
            """, ws=workspace_id)
            record = latest_res.single()
            if record:
                snapshot_id = record["scan_id"]
            else:
                return {"nodes": [], "edges": []}

        # Scoped query: n must match path, but m can be anything if linked from n
        query = """
            MATCH (n:CodeEntity {workspace: $ws, snapshot_id: $snap})
            WHERE ($path IS NULL OR n.file_path STARTS WITH $path)
            OPTIONAL MATCH (n)-[r:CODE_REL {snapshot_id: $snap}]->(m:CodeEntity {workspace: $ws, snapshot_id: $snap})
            RETURN n, r, m
        """
        
        result = session.run(query, ws=workspace_id, snap=snapshot_id, path=path_filter)
        
        nodes = {}
        edges = []
        
        for record in result:
            n = record["n"]
            if n.element_id not in nodes:
                nodes[n.element_id] = {
                    "id": n["id"],
                    "name": n["name"],
                    "type": n["type"],
                    "path": n["file_path"],
                    "elementId": n.element_id
                }
            
            r = record["r"]
            m = record["m"]
            if r and m:
                 edges.append({
                     "source": n["id"],
                     "target": m["id"],
                     "type": r["type"],
                     "metadata": dict(r)
                 })
                 
        return {"nodes": list(nodes.values()), "edges": edges}

def list_workspace_dirs(workspace_root: str) -> List[str]:
    """Helper to list directories for picker"""
    root = Path(workspace_root)
    dirs = ["/"]
    for p in root.rglob("*"):
        if p.is_dir() and not any(part.startswith('.') for part in p.parts) and "node_modules" not in p.parts:
            dirs.append(str(p.relative_to(root)).replace("\\", "/"))
    return sorted(dirs)
