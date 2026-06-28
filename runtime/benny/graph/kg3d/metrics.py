import logging
from typing import Dict

import networkx as nx

from .ontology import Graph
from .schema import NodeMetrics, aot_layer_for

logger = logging.getLogger(__name__)

# Exact all-pairs betweenness is O(V*E) and on a multi-thousand-node graph takes
# tens of seconds — long enough to blow the HTTP timeout and surface as a 500.
# Above this node count we switch to a sampled approximation (Brandes over k
# pivots), which is ~15-20x faster and visually indistinguishable for layout.
BETWEENNESS_EXACT_MAX_NODES = 800
BETWEENNESS_SAMPLE_K = 400


def _safe_pagerank(G: nx.DiGraph) -> Dict[str, float]:
    """PageRank that degrades to zeros instead of raising (e.g. non-convergence)."""
    if len(G) == 0:
        return {}
    try:
        return nx.pagerank(G, weight="weight")
    except nx.PowerIterationFailedConvergence:
        try:
            return nx.pagerank(G, weight="weight", max_iter=500, tol=1e-4)
        except Exception as e:  # noqa: BLE001 - last-resort guard
            logger.warning("pagerank did not converge; defaulting to 0: %s", e)
            return {}
    except Exception as e:  # noqa: BLE001 - last-resort guard
        logger.warning("pagerank failed; defaulting to 0: %s", e)
        return {}


def _safe_betweenness(G: nx.DiGraph) -> Dict[str, float]:
    """Betweenness centrality, bounded so large graphs stay interactive."""
    n = len(G)
    if n == 0:
        return {}
    try:
        if n <= BETWEENNESS_EXACT_MAX_NODES:
            return nx.betweenness_centrality(G, weight="weight")
        k = min(BETWEENNESS_SAMPLE_K, n)
        logger.info("Graph has %d nodes; using sampled betweenness (k=%d)", n, k)
        # Unweighted + sampled: the dominant cost is the all-pairs shortest-path
        # sweep, so we cap it at k pivot nodes with a fixed seed for determinism.
        return nx.betweenness_centrality(G, k=k, seed=42)
    except Exception as e:  # noqa: BLE001 - last-resort guard
        logger.warning("betweenness failed; defaulting to 0: %s", e)
        return {}


def compute_all(graph: Graph) -> Dict[str, NodeMetrics]:
    """
    Computes all GC-centric graph metrics for the KG3D-001 requirement.
    Uses networkx for core algorithms. Every metric is guarded so a single
    failure degrades to zeros rather than 500-ing the ontology endpoint.
    """
    G = nx.DiGraph()
    for node in graph.nodes:
        G.add_node(node.id)
    for edge in graph.edges:
        G.add_edge(edge.source_id, edge.target_id, weight=edge.weight, kind=edge.kind)

    # 1. Pagerank
    pagerank = _safe_pagerank(G)

    # 2. Degree
    degree = dict(G.degree())

    # 3. Betweenness (bounded for large graphs)
    betweenness = _safe_betweenness(G)

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
        # Clamp to the schema's bounds (pagerank/betweenness >= 0; ratios in
        # [0, 1]) so a pathological value can never trip a NodeMetrics validator
        # and 500 the whole ontology response.
        dr = min(1.0, max(0.0, descendant_ratio.get(node_id, 0.0)))
        pr = min(1.0, max(0.0, prerequisite_ratio.get(node_id, 0.0)))
        metrics_map[node_id] = NodeMetrics(
            pagerank=max(0.0, pagerank.get(node_id, 0.0)),
            degree=degree.get(node_id, 0),
            betweenness=max(0.0, betweenness.get(node_id, 0.0)),
            descendant_ratio=dr,
            prerequisite_ratio=pr,
            reachability_ratio=dr,  # Mapping both to dr for simplicity
        )

    return metrics_map


def update_node_aot_layers(graph: Graph, metrics: Dict[str, NodeMetrics]):
    """Assign each node's ``aot_layer``.

    Primary model (KG3D-F13): bin by ``descendant_ratio`` (out-reachability),
    which works when the graph is a real abstraction DAG. But extracted
    knowledge graphs are frequently *shallow/flat* — concepts link to a source
    sink and to a few peers, so almost no node reaches >10% of the graph and
    every node collapses onto layer 5 (a flat, detached-looking hierarchy).

    When the descendant bins are degenerate (≥90% of nodes on one layer) we fall
    back to a centrality-quantile layering (PageRank, then degree as a tiebreak)
    so the hierarchy still spreads across all 5 layers — hubs/sources rise to
    layer 1, periphery sinks to layer 5.
    """
    for node in graph.nodes:
        if node.id in metrics:
            node.metrics = metrics[node.id]
            node.aot_layer = aot_layer_for(node.metrics.descendant_ratio)

    scored = [n for n in graph.nodes if n.id in metrics]
    if len(scored) < 5:
        return

    from collections import Counter

    dist = Counter(n.aot_layer for n in scored)
    _, top_count = dist.most_common(1)[0]
    if top_count < 0.9 * len(scored):
        return  # a real hierarchy is present — keep the spec layers

    # Degenerate: spread by centrality so the 3D layers aren't all stacked flat.
    ordered = sorted(
        scored,
        key=lambda n: (n.metrics.pagerank, n.metrics.degree),
        reverse=True,
    )
    total = len(ordered)
    for i, node in enumerate(ordered):
        node.aot_layer = min(5, max(1, 1 + (i * 5) // total))
