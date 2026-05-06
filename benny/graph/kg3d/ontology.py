import json
import hashlib
import uuid
from typing import Dict, List, Any, Optional
from pathlib import Path
from ...core.graph_db import get_full_graph
from .schema import Node, Edge, NodeMetrics, NodeCategory, EdgeKind

FIXTURE_PATH = Path(__file__).parent.parent.parent.parent / "tests" / "fixtures" / "kg3d" / "ml_knowledge_graph_v1.json"

class Graph:
    def __init__(self, nodes: List[Node], edges: List[Edge]):
        self.nodes = nodes
        self.edges = edges

async def load_default_ontology(workspace: Optional[str] = None) -> Graph:
    """
    Loads the ontology. 
    If a workspace is provided, it attempts to fetch live data from Neo4j.
    Otherwise, it falls back to the canonical ML ontology fixture.
    """
    if workspace:
        try:
            raw_data = get_full_graph(workspace=workspace)
            
            if raw_data.get("nodes"):
                nodes = []
                # Map Neo4j nodes to KG3D Node schema
                for n in raw_data["nodes"]:
                    # Determine category based on labels and properties
                    label_list = n.get("labels", [])
                    main_label = label_list[0] if label_list else "Concept"
                    
                    category = NodeCategory.CONCEPT
                    if "Source" in label_list:
                        category = NodeCategory.DOCUMENTATION
                    elif n.get("node_type"):
                        try:
                            category = NodeCategory(n["node_type"].lower())
                        except ValueError:
                            category = NodeCategory.CONCEPT

                    # Create minimal metrics (will be recalculated by metrics.py)
                    metrics = NodeMetrics(
                        pagerank=0.0,
                        degree=0,
                        betweenness=0.0,
                        descendant_ratio=0.0,
                        prerequisite_ratio=0.0,
                        reachability_ratio=0.0
                    )

                    nodes.append(Node(
                        id=str(n["id"]),
                        canonical_name=n.get("name", "Unknown"),
                        display_name=n.get("name", "Unknown"),
                        category=category,
                        aot_layer=3, # Default, metrics.py will update this
                        metrics=metrics,
                        source_refs=[n.get("source_doc")] if n.get("source_doc") else []
                    ))

                edges = []
                for e in raw_data.get("edges", []):
                    # Map edge type to EdgeKind
                    kind = EdgeKind.REFERENCES
                    if e.get("type") == "PREREQUISITE_FOR":
                        kind = EdgeKind.PREREQUISITE
                    elif e.get("type") == "CONFLICTS_WITH":
                        kind = EdgeKind.CONTRADICTS
                    
                    edges.append(Edge(
                        id=str(uuid.uuid4())[:8],
                        source_id=str(e["source"]),
                        target_id=str(e["target"]),
                        kind=kind,
                        weight=e.get("confidence", 1.0)
                    ))
                
                return Graph(nodes=nodes, edges=edges)
        except Exception as e:
            print(f"FAILED TO LOAD LIVE ONTOLOGY FOR WORKSPACE {workspace}: {e}")
            # Fallback to fixture if Neo4j fails or is empty

    # Fallback to fixture
    if not FIXTURE_PATH.exists():
        return Graph(nodes=[], edges=[]) # Total empty if fixture missing too
    
    with open(FIXTURE_PATH, "r") as f:
        data = json.load(f)
    
    nodes = [Node(**n) for n in data.get("nodes", [])]
    edges = [Edge(**e) for e in data.get("edges", [])]
    
    return Graph(nodes=nodes, edges=edges)

def content_hash(graph: Graph) -> str:
    """Returns a stable SHA-256 hash of the graph content."""
    # Canonicalize by sorting nodes and edges by ID
    nodes_data = sorted([n.model_dump(mode="json") for n in graph.nodes], key=lambda x: x["id"])
    edges_data = sorted([e.model_dump(mode="json") for e in graph.edges], key=lambda x: x["id"])
    
    combined = json.dumps({"nodes": nodes_data, "edges": edges_data}, sort_keys=True)
    return hashlib.sha256(combined.encode()).hexdigest()
