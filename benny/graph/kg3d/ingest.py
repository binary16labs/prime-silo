import logging
from typing import List, Optional
from .schema import Node, Edge, Proposal, NodeMetrics
from .store import upsert_proposal_to_neo4j

logger = logging.getLogger(__name__)

def create_ingest_proposal(
    nodes_raw: List[dict],
    edges_raw: List[dict],
    rationale: str
) -> Proposal:
    """
    Transforms raw dictionary data (likely from an LLM) into a validated KG3D Proposal.
    Handles default metric assignment and basic mapping.
    """
    nodes = []
    for n in nodes_raw:
        # Assign baseline metrics if missing
        metrics = NodeMetrics(**n.get("metrics", {
            "pagerank": 0.0,
            "degree": 0,
            "betweenness": 0.0,
            "descendant_ratio": 0.0,
            "prerequisite_ratio": 0.0,
            "reachability_ratio": 0.0
        }))
        
        nodes.append(Node(
            id=n["id"],
            canonical_name=n["canonical_name"],
            display_name=n.get("display_name", n["canonical_name"]),
            category=n.get("category", "ai_deep_learning"),
            aot_layer=n.get("aot_layer", 5),
            metrics=metrics,
            metadata=n.get("metadata", {})
        ))
        
    edges = []
    for e in edges_raw:
        edges.append(Edge(
            id=e.get("id", f"{e['source_id']}_{e['target_id']}"),
            source_id=e["source_id"],
            target_id=e["target_id"],
            kind=e.get("kind", "references"),
            weight=e.get("weight", 0.5),
            metadata=e.get("metadata", {})
        ))
        
    return Proposal(
        nodes_upsert=nodes,
        edges_upsert=edges,
        rationale_md=rationale
    )

async def commit_proposal(proposal: Proposal):
    """
    Persists a confirmed proposal to the long-term Neo4j store.
    Used by the /approve endpoint.
    """
    try:
        success = await upsert_proposal_to_neo4j(proposal)
        if success:
            logger.info("Successfully committed KG3D proposal")
        return success
    except Exception as e:
        logger.error("Failed to commit KG3D proposal: %s", e)
        return False
