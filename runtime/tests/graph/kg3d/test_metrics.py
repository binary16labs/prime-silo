
import pytest

from benny.graph.kg3d.cache import get_cached_metrics, init_cache, save_metrics_to_cache
from benny.graph.kg3d.metrics import compute_all, update_node_aot_layers
from benny.graph.kg3d.ontology import load_default_ontology


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

    from benny.graph.kg3d.metrics import BETWEENNESS_EXACT_MAX_NODES, compute_all
    from benny.graph.kg3d.ontology import Graph
    from benny.graph.kg3d.schema import Edge, EdgeKind, Node, NodeCategory, NodeMetrics

    n = BETWEENNESS_EXACT_MAX_NODES + 1500  # safely into the sampled regime
    zero = NodeMetrics(
        pagerank=0,
        degree=0,
        betweenness=0,
        descendant_ratio=0,
        prerequisite_ratio=0,
        reachability_ratio=0,
    )
    nodes = [
        Node(
            id=str(i),
            canonical_name=f"n{i}",
            display_name=f"n{i}",
            category=NodeCategory.CONCEPT,
            aot_layer=3,
            metrics=zero,
        )
        for i in range(n)
    ]
    # A connected-ish chain plus some fan-out so betweenness is non-trivial.
    edges = []
    for i in range(n - 1):
        edges.append(
            Edge(
                id=str(uuid.uuid4())[:8],
                source_id=str(i),
                target_id=str(i + 1),
                kind=EdgeKind.REFERENCES,
                weight=1.0,
            )
        )

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

    from collections import Counter

    from benny.graph.kg3d.schema import aot_layer_for

    for node in graph.nodes:
        assert 1 <= node.aot_layer <= 5

    # When the descendant-ratio bins are NOT degenerate, layers follow the spec.
    # (The fixture is a real hierarchy, so this branch is exercised.)
    spec = Counter(aot_layer_for(n.metrics.descendant_ratio) for n in graph.nodes)
    if graph.nodes and spec.most_common(1)[0][1] < 0.9 * len(graph.nodes):
        for node in graph.nodes:
            assert node.aot_layer == aot_layer_for(node.metrics.descendant_ratio)


@pytest.mark.asyncio
async def test_aot_layer_degenerate_fallback_spreads():
    """A flat/shallow graph (like extracted knowledge triples) collapses every
    node onto layer 5 under descendant_ratio; the fallback must spread nodes
    across layers by centrality instead of leaving them stacked on one level."""
    import uuid

    from benny.graph.kg3d.ontology import Graph
    from benny.graph.kg3d.schema import Edge, EdgeKind, Node, NodeCategory, NodeMetrics

    zero = NodeMetrics(
        pagerank=0.0,
        degree=0,
        betweenness=0.0,
        descendant_ratio=0.0,
        prerequisite_ratio=0.0,
        reachability_ratio=0.0,
    )
    n = 30
    nodes = [
        Node(
            id=str(i),
            canonical_name=f"n{i}",
            display_name=f"n{i}",
            category=NodeCategory.CONCEPT,
            aot_layer=3,
            metrics=zero,
        )
        for i in range(n)
    ]
    # Hub-and-spoke: everything points to node 0 (a sink). Out-reachability is
    # ~1/n for the spokes and 0 for the hub → all bin to layer 5 (degenerate).
    edges = [
        Edge(
            id=str(uuid.uuid4())[:8],
            source_id=str(i),
            target_id="0",
            kind=EdgeKind.REFERENCES,
            weight=1.0,
        )
        for i in range(1, n)
    ]
    graph = Graph(nodes=nodes, edges=edges)
    metrics = compute_all(graph)
    update_node_aot_layers(graph, metrics)

    layers = {node.aot_layer for node in graph.nodes}
    assert all(1 <= node.aot_layer <= 5 for node in graph.nodes)
    assert len(layers) > 1, "degenerate flat graph should spread across multiple layers"
