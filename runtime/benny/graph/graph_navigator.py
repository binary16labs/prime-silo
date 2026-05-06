"""
Graph Navigator — Implements the Progressive Discovery Protocol.
Prevents context overload by providing layered, summarized access to the code graph.
"""

import logging
from typing import List, Dict, Any, Optional
from ..core.graph_db import run_cypher

logger = logging.getLogger(__name__)

class GraphNavigator:
    """Service for hierarchical exploration of the Neural Graph."""

    def __init__(self, workspace: str, snapshot_id: Optional[str] = None):
        self.workspace = workspace
        self.snapshot_id = snapshot_id

    def get_layers_summary(self) -> Dict[str, Any]:
        """Provides a high-level count of entities in each discovery layer."""
        query = """
        MATCH (n:CodeEntity {workspace: $workspace})
        WHERE ($snap IS NULL OR n.snapshot_id = $snap)
        RETURN n.type as type, count(n) as count
        """
        results = run_cypher(query, params={"snap": self.snapshot_id}, workspace=self.workspace)
        return {r['type']: r['count'] for r in results}

    def get_workspace_blueprint(self) -> List[Dict[str, Any]]:
        """Layer 0: Returns only File and Directory-level structure."""
        query = """
        MATCH (n:CodeEntity {workspace: $workspace, type: 'File'})
        WHERE ($snap IS NULL OR n.snapshot_id = $snap)
        OPTIONAL MATCH (n)-[r:CODE_REL {type: 'DEPENDS_ON'}]->(m:CodeEntity {type: 'File'})
        RETURN n.id as id, n.name as name, n.file_path as path, collect(m.id) as dependencies
        """
        return run_cypher(query, params={"snap": self.snapshot_id}, workspace=self.workspace)

    def explore_file(self, file_path: str) -> Dict[str, Any]:
        """Layer 1: Returns symbols (Classes, Functions) defined within a specific file."""
        query = """
        MATCH (f:CodeEntity {workspace: $workspace, file_path: $path})
        WHERE ($snap IS NULL OR f.snapshot_id = $snap)
        MATCH (f)-[:CODE_REL {type: 'DEFINES'}]->(s:CodeEntity)
        RETURN s.id as id, s.name as name, s.type as type, s.file_path as path
        """
        symbols = run_cypher(query, params={"path": file_path, "snap": self.snapshot_id}, workspace=self.workspace)
        return {
            "file": file_path,
            "symbols": symbols,
            "count": len(symbols)
        }

    def peek_symbol(self, symbol_id: str) -> Dict[str, Any]:
        """Layer 2: Returns the neighborhood of a symbol (references, definition details)."""
        query = """
        MATCH (s:CodeEntity {id: $id, workspace: $ws})
        WHERE ($snap IS NULL OR s.snapshot_id = $snap)
        OPTIONAL MATCH (s)-[r:CODE_REL]->(neighbor:CodeEntity)
        RETURN s.name as name, s.type as type, collect({target: neighbor.name, relation: r.type, target_type: neighbor.type}) as connections
        """
        results = run_cypher(query, id=symbol_id, ws=self.workspace, snap=self.snapshot_id)
        if not results:
            return {"error": f"Symbol '{symbol_id}' not found"}
        return results[0]

    def get_graph_schema(self) -> Dict[str, Any]:
        """Discovery: Returns the current labels and relationship types in the Nexus."""
        node_query = "MATCH (n) RETURN DISTINCT labels(n) as labels"
        rel_query = "MATCH ()-[r]->() RETURN DISTINCT type(r) as types"
        
        nodes = run_cypher(node_query)
        rels = run_cypher(rel_query)
        
        return {
            "node_labels": [n['labels'] for n in nodes],
            "relationship_types": [r['types'] for r in rels],
            "recommended_flow": "0: Blueprint -> 1: Explore File -> 2: Peek Symbol"
        }
