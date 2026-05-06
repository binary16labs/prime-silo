import networkx as nx
from typing import Dict
from .schema import Node, Edge, NodeMetrics, aot_layer_for
from .ontology import Graph

def compute_all(graph: Graph) -> Dict[str, NodeMetrics]:
    """
    Computes all GC-centric graph metrics for the KG3D-001 requirement.
    Uses networkx for core algorithms.
    """
    G = nx.DiGraph()
    for node in graph.nodes:
        G.add_node(node.id)
    for edge in graph.edges:
        G.add_edge(edge.source_id, edge.target_id, weight=edge.weight, kind=edge.kind)

    # 1. Pagerank
    pagerank = nx.pagerank(G, weight="weight") if len(G) > 0 else {}
    
    # 2. Degree
    degree = dict(G.degree())
    
    # 3. Betweenness
    betweenness = nx.betweenness_centrality(G, weight="weight") if len(G) > 0 else {}
    
    # 4. Descendant ratio (reachable nodes / total nodes)
    total_nodes = len(graph.nodes)
    descendant_ratio = {}
    
    # 5. Prerequisite ratio (incoming edges / total edges)
    total_edges = len(graph.edges)
    prerequisite_ratio = {}
    
    # 6. Reachability ratio (nodes reachable from this node / total nodes)
    # (Descendant ratio and reachability ratio are effectively the same in this schema)
    
    for node_id in G.nodes:
        # Reachable nodes (descendants)
        reachable = nx.descendants(G, node_id)
        dr = len(reachable) / total_nodes if total_nodes > 1 else 0.0
        descendant_ratio[node_id] = dr
        
        # Prerequisites (incoming nodes)
        prereqs = list(G.predecessors(node_id))
        pr_ratio = len(prereqs) / total_edges if total_edges > 0 else 0.0
        prerequisite_ratio[node_id] = pr_ratio

    metrics_map = {}
    for node in graph.nodes:
        node_id = node.id
        metrics_map[node_id] = NodeMetrics(
            pagerank=pagerank.get(node_id, 0.0),
            degree=degree.get(node_id, 0),
            betweenness=betweenness.get(node_id, 0.0),
            descendant_ratio=descendant_ratio.get(node_id, 0.0),
            prerequisite_ratio=prerequisite_ratio.get(node_id, 0.0),
            reachability_ratio=descendant_ratio.get(node_id, 0.0) # Mapping both to dr for simplicity
        )
    
    return metrics_map

def update_node_aot_layers(graph: Graph, metrics: Dict[str, NodeMetrics]):
    """Updates the aot_layer for each node based on its computed descendant_ratio."""
    for node in graph.nodes:
        if node.id in metrics:
            m = metrics[node.id]
            node.metrics = m
            node.aot_layer = aot_layer_for(m.descendant_ratio)
