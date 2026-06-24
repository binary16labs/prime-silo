import pytest
import os
from benny.graph.kg3d.ontology import load_default_ontology
from benny.graph.kg3d.metrics import compute_all, update_node_aot_layers
from benny.graph.kg3d.cache import init_cache, get_cached_metrics, save_metrics_to_cache

@pytest.mark.asyncio
async def test_kg3d_f2_metrics_contract():
    graph = await load_default_ontology()
    metrics = compute_all(graph)

    assert len(metrics) == len(graph.nodes)
    for node_id, m in metrics.items():
        assert m.pagerank >= 0
        assert m.degree >= 0
        assert m.betweenness >= 0
        assert 0 <= m.descendant_ratio <= 1

@pytest.mark.asyncio
async def test_metrics_cache_invalidation():
    init_cache()
    graph = await load_default_ontology()
    metrics = compute_all(graph)

    save_metrics_to_cache(graph, metrics)
    # The content hash must be stable across reads so the cache actually hits —
    # otherwise compute_all re-runs on every request (the /kg3d/ontology 500).
    cached = get_cached_metrics(graph)
    assert cached is not None
    assert len(cached) == len(metrics)

    # Modify graph content (mock change) — the hash must change so stale metrics
    # are not served.
    graph.nodes[0].canonical_name = "Modified Name"
    cached_missing = get_cached_metrics(graph)
    assert cached_missing is None

def test_large_graph_metrics_are_bounded():
    """
    Regression for the /kg3d/ontology 500: on a graph well above the exact
    betweenness threshold, compute_all must use the sampled approximation and
    finish quickly instead of running an O(V*E) sweep that blows the HTTP
    timeout. Builds a synthetic graph in-process (no Neo4j).
    """
    import time
    import uuid
    from benny.graph.kg3d.ontology import Graph
    from benny.graph.kg3d.schema import Node, Edge, NodeMetrics, NodeCategory, EdgeKind
    from benny.graph.kg3d.metrics import compute_all, BETWEENNESS_EXACT_MAX_NODES

    n = BETWEENNESS_EXACT_MAX_NODES + 1500  # safely into the sampled regime
    zero = NodeMetrics(pagerank=0, degree=0, betweenness=0, descendant_ratio=0,
                       prerequisite_ratio=0, reachability_ratio=0)
    nodes = [
        Node(id=str(i), canonical_name=f"n{i}", display_name=f"n{i}",
             category=NodeCategory.CONCEPT, aot_layer=3, metrics=zero)
        for i in range(n)
    ]
    # A connected-ish chain plus some fan-out so betweenness is non-trivial.
    edges = []
    for i in range(n - 1):
        edges.append(Edge(id=str(uuid.uuid4())[:8], source_id=str(i),
                          target_id=str(i + 1), kind=EdgeKind.REFERENCES, weight=1.0))

    start = time.time()
    metrics = compute_all(Graph(nodes=nodes, edges=edges))
    elapsed = time.time() - start

    assert len(metrics) == n
    # Generous bound: exact weighted betweenness on this size takes tens of
    # seconds; the sampled path is a few seconds even on slow CI.
    assert elapsed < 15, f"compute_all too slow for a large graph: {elapsed:.1f}s"
    for m in metrics.values():
        assert m.betweenness >= 0
        assert 0 <= m.descendant_ratio <= 1


@pytest.mark.asyncio
async def test_aot_layer_update():
    graph = await load_default_ontology()
    metrics = compute_all(graph)
    update_node_aot_layers(graph, metrics)

    for node in graph.nodes:
        assert 1 <= node.aot_layer <= 5
        # Ensure it matches the metric
        from benny.graph.kg3d.schema import aot_layer_for
        assert node.aot_layer == aot_layer_for(node.metrics.descendant_ratio)
