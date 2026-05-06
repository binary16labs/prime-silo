import logging
from typing import Any
from .ontology import Graph
from .schema import Proposal
from ...core.graph_db import get_driver

logger = logging.getLogger(__name__)

def upsert_graph(driver, graph: Graph):
    """
    Upserts the entire graph into Neo4j using parameterised MERGE.
    KG3D-F3 requirement: idempotent and no string interpolation.
    """
    with driver.session() as session:
        # 1. Upsert Nodes
        nodes_batch = [n.model_dump(mode="json") for n in graph.nodes]
        session.run("""
            UNWIND $nodes AS n
            MERGE (c:MLConcept {canonical_name: n.canonical_name})
            SET c += {
                id: n.id,
                display_name: n.display_name,
                category: n.category,
                aot_layer: n.aot_layer,
                pagerank: n.metrics.pagerank,
                degree: n.metrics.degree,
                betweenness: n.metrics.betweenness,
                descendant_ratio: n.metrics.descendant_ratio,
                prerequisite_ratio: n.metrics.prerequisite_ratio,
                reachability_ratio: n.metrics.reachability_ratio,
                updated_at: datetime(n.updated_at)
            }
        """, nodes=nodes_batch)

        # 2. Upsert Edges
        # We need to look up IDs since MERGE works on properties
        edges_batch = [e.model_dump(mode="json") for e in graph.edges]
        session.run("""
            UNWIND $edges AS e
            MATCH (source:MLConcept {id: e.source_id})
            MATCH (target:MLConcept {id: e.target_id})
            MERGE (source)-[r:KG3D_REL {id: e.id}]->(target)
            SET r += {
                kind: e.kind,
                weight: e.weight,
                evidence: e.evidence,
                created_at: datetime(e.created_at)
            }
        """, edges=edges_batch)

    logger.info("KG3D: Upserted %d nodes and %d edges", len(graph.nodes), len(graph.edges))

async def upsert_proposal_to_neo4j(proposal: Proposal) -> bool:
    """
    Specifically upserts a Proposal's contents into Neo4j.
    Used for confirmating human-in-the-loop ingestion.
    """
    driver = get_driver()
    if not driver:
        return False
        
    try:
        # We can reuse upsert_graph by wrapping proposal into a temporary Graph object
        temp_graph = Graph(nodes=proposal.nodes_upsert, edges=proposal.edges_upsert)
        upsert_graph(driver, temp_graph)
        return True
    except Exception as e:
        logger.error("KG3D Proposal commit failed: %s", e)
        return False
