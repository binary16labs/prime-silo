import pytest
import os
from benny.graph.kg3d.ontology import load_default_ontology
from benny.graph.kg3d.metrics import compute_all, update_node_aot_layers
from benny.graph.kg3d.cache import init_cache, get_cached_metrics, save_metrics_to_cache

def test_kg3d_f2_metrics_contract():
    graph = load_default_ontology()
    metrics = compute_all(graph)
    
    assert len(metrics) == len(graph.nodes)
    for node_id, m in metrics.items():
        assert m.pagerank >= 0
        assert m.degree >= 0
        assert m.betweenness >= 0
        assert 0 <= m.descendant_ratio <= 1

def test_metrics_cache_invalidation():
    init_cache()
    graph = load_default_ontology()
    metrics = compute_all(graph)
    
    save_metrics_to_cache(graph, metrics)
    cached = get_cached_metrics(graph)
    assert cached is not None
    assert len(cached) == len(metrics)
    
    # Modify graph slightly (mock change)
    graph.nodes[0].canonical_name = "Modified Name"
    cached_missing = get_cached_metrics(graph)
    assert cached_missing is None

def test_aot_layer_update():
    graph = load_default_ontology()
    metrics = compute_all(graph)
    update_node_aot_layers(graph, metrics)
    
    for node in graph.nodes:
        assert 1 <= node.aot_layer <= 5
        # Ensure it matches the metric
        from benny.graph.kg3d.schema import aot_layer_for
        assert node.aot_layer == aot_layer_for(node.metrics.descendant_ratio)
