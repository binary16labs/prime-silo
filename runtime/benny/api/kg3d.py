import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator, Dict, List, Optional
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from ..graph.kg3d.ontology import load_default_ontology
from ..graph.kg3d.metrics import compute_all, update_node_aot_layers
from ..graph.kg3d.cache import get_cached_metrics, save_metrics_to_cache
from ..graph.kg3d.schema import Node, Edge, Proposal, DeltaEvent

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/kg3d", tags=["kg3d"])

# In-memory storage for pending proposals and delta sequence
pending_proposals: Dict[str, Proposal] = {}
delta_seq = 0
delta_queue: asyncio.Queue = asyncio.Queue()

@router.get("/ontology")
async def get_ontology(workspace: str = "default"):
    """Returns the full graph as JSON with computed metrics."""
    # Load from Neo4j if workspace provided, otherwise fallback to fixture
    graph = await load_default_ontology(workspace=workspace)
    
    metrics = get_cached_metrics(graph)
    
    if not metrics:
        metrics = compute_all(graph)
        save_metrics_to_cache(graph, metrics)
    
    update_node_aot_layers(graph, metrics)
    
    return {
        "nodes": [n.model_dump(mode="json") for n in graph.nodes],
        "edges": [e.model_dump(mode="json") for e in graph.edges]
    }

@router.get("/stream")
async def stream_deltas():
    """SSE endpoint for graph updates."""
    async def event_generator() -> AsyncGenerator[str, None]:
        global delta_seq
        while True:
            try:
                # Wait for an event or send a heartbeat every 10s
                try:
                    event = await asyncio.wait_for(delta_queue.get(), timeout=10.0)
                except asyncio.TimeoutError:
                    event = DeltaEvent(kind="heartbeat", seq=delta_seq, ts=datetime.now(timezone.utc))
                
                yield f"data: {event.model_dump_json()}\n\n"
                delta_seq += 1
            except Exception as e:
                logger.error("SSE stream error: %s", e)
                break
                
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@router.get("/proposals")
async def list_proposals():
    """List pending ingest proposals."""
    return [{"id": k, "proposal": v.model_dump(mode="json")} for k, v in pending_proposals.items()]

@router.post("/proposals/{proposal_id}/approve")
async def approve_proposal(proposal_id: str, background_tasks: BackgroundTasks):
    """Approves a proposal and emits deltas."""
    if proposal_id not in pending_proposals:
        raise HTTPException(status_code=404, detail="Proposal not found")
    
    proposal = pending_proposals.pop(proposal_id)
    
    # In a real impl, we'd persist to Neo4j here (Phase 8)
    # For Phase 3, we just emit the deltas
    for node in proposal.nodes_upsert:
        await delta_queue.put(DeltaEvent(kind="upsert_node", payload=node.model_dump(mode="json"), seq=delta_seq))
    for edge in proposal.edges_upsert:
        await delta_queue.put(DeltaEvent(kind="upsert_edge", payload=edge.model_dump(mode="json"), seq=delta_seq))
        
    return {"status": "approved"}

@router.post("/proposals/{proposal_id}/reject")
async def reject_proposal(proposal_id: str):
    """Rejects a proposal."""
    if proposal_id not in pending_proposals:
        raise HTTPException(status_code=404, detail="Proposal not found")
    
    pending_proposals.pop(proposal_id)
    return {"status": "rejected"}

# Helper to "inject" a proposal for testing Phase 3
def inject_test_proposal(proposal: Proposal) -> str:
    p_id = str(uuid.uuid4())
    pending_proposals[p_id] = proposal
    return p_id

@router.get("/status")
async def get_kg_status(workspace: str = "default"):
    """Returns high-level graph health and density metrics for the workspace."""
    try:
        from ..core.graph_db import get_driver
        driver = get_driver()
        
        with driver.session() as session:
            # Count by labels
            labels_res = session.run("""
                MATCH (n {workspace: $workspace})
                UNWIND labels(n) as label
                RETURN label, count(n) as count
            """, workspace=workspace)
            node_counts = {record["label"]: record["count"] for record in labels_res}
            
            # Count edges by type
            edges_res = session.run("""
                MATCH (n {workspace: $workspace})-[r]->(m {workspace: $workspace})
                RETURN type(r) as kind, count(r) as count
            """, workspace=workspace)
            edge_counts = {record["kind"]: record["count"] for record in edges_res}
            
            # Source check
            sources_res = session.run("""
                MATCH (s:Source {workspace: $workspace})
                RETURN s.name as name
            """, workspace=workspace)
            sources = [r["name"] for r in sources_res]

        return {
            "workspace": workspace,
            "node_counts": node_counts,
            "edge_counts": edge_counts,
            "sources": sources,
            "total_nodes": sum(node_counts.values()),
            "total_edges": sum(edge_counts.values())
        }
    except Exception as e:
        raise HTTPException(500, f"Status check failed: {str(e)}")
