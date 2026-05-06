import pytest
from benny.graph.kg3d.ontology import Graph
from benny.graph.kg3d.schema import Node, Edge, NodeMetrics
from benny.graph.kg3d.constraints import check_aot_coherence, validate_full_graph

def test_aot_coherence_violation():
    # Node 1: Layer 1 (Abstract)
    # Node 2: Layer 5 (Specific)
    n1 = Node(
        id="n1", canonical_name="Abstract", display_name="Abstract", 
        category="ai_deep_learning", aot_layer=1,
        metrics=NodeMetrics(pagerank=0.1, degree=1, betweenness=0, descendant_ratio=0.9, prerequisite_ratio=0, reachability_ratio=0)
    )
    n2 = Node(
        id="n2", canonical_name="Specific", display_name="Specific", 
        category="ai_deep_learning", aot_layer=5,
        metrics=NodeMetrics(pagerank=0.1, degree=1, betweenness=0, descendant_ratio=0.05, prerequisite_ratio=0, reachability_ratio=0)
    )
    
    # 1. Valid edge: n1 -> n2 (Abstract -> Specific)
    e_valid = Edge(id="e1", source_id="n1", target_id="n2", kind="specialises", weight=1.0)
    graph_valid = Graph(nodes=[n1, n2], edges=[e_valid])
    assert len(check_aot_coherence(graph_valid)) == 0

    # 2. Invalid edge: n2 -> n1 (Specific -> Abstract)
    e_invalid = Edge(id="e2", source_id="n2", target_id="n1", kind="generalises", weight=1.0)
    graph_invalid = Graph(nodes=[n1, n2], edges=[e_invalid])
    violations = check_aot_coherence(graph_invalid)
    assert len(violations) == 1
    assert violations[0] == ("n2", "n1")

def test_full_graph_validation():
    n1 = Node(
        id="n1", canonical_name="A", display_name="A", 
        category="ai_deep_learning", aot_layer=1,
        metrics=NodeMetrics(pagerank=0.1, degree=1, betweenness=0, descendant_ratio=0.9, prerequisite_ratio=0, reachability_ratio=0)
    )
    # n2 has invalid aot_layer (should be 5 for 0.05 dr)
    n2 = Node(
        id="n2", canonical_name="B", display_name="B", 
        category="ai_deep_learning", aot_layer=1, 
        metrics=NodeMetrics(pagerank=0.1, degree=1, betweenness=0, descendant_ratio=0.05, prerequisite_ratio=0, reachability_ratio=0)
    )
    graph = Graph(nodes=[n1, n2], edges=[])
    errors = validate_full_graph(graph)
    assert any("invariant failure" in e for e in errors)
