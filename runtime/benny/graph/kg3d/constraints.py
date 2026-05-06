from typing import List, Tuple
from .schema import Node, Edge, validate_node, validate_edge
from .ontology import Graph

def check_aot_coherence(graph: Graph) -> List[Tuple[str, str]]:
    """
    Enforces the 'Peircean Logic' constraint: no edges should point from 
    a more specific layer to a more abstract layer (KG3D-F6).
    Returns list of (source_id, target_id) pairs that violate this.
    """
    violations = []
    # Create a node_id to aot_layer map
    node_layers = {n.id: n.aot_layer for n in graph.nodes}
    
    for edge in graph.edges:
        src_layer = node_layers.get(edge.source_id)
        tgt_layer = node_layers.get(edge.target_id)
        
        if src_layer is not None and tgt_layer is not None:
            # abstract = 1, specific = 5
            # violation if src_layer > tgt_layer (more specific -> more abstract)
            if src_layer > tgt_layer:
                violations.append((edge.source_id, edge.target_id))
                
    return violations

def validate_full_graph(graph: Graph) -> List[str]:
    """Performs full structural validation of the Synoptic Web."""
    errors = []
    
    # 1. Individual node/edge invariants
    for node in graph.nodes:
        if not validate_node(node):
            errors.append(f"Node {node.id} invariant failure (AoT/Metrics mismatch)")
            
    for edge in graph.edges:
        if not validate_edge(edge):
            errors.append(f"Edge {edge.id} invariant failure (Self-loop)")

    # 2. AoT Coherence
    violations = check_aot_coherence(graph)
    for src, tgt in violations:
        errors.append(f"AoT Logic Violation: Edge points from lower layer to higher layer ({src} -> {tgt})")
        
    return errors
