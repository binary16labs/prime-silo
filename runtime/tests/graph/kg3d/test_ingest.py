import pytest
from benny.graph.kg3d.ingest import create_ingest_proposal

def test_create_ingest_proposal_logic():
    nodes_raw = [
        {
            "id": "transformer",
            "canonical_name": "Transformer Architecture",
            "category": "ai_deep_learning",
            "aot_layer": 2
        }
    ]
    edges_raw = []
    rationale = "New breakthrough in attention mechanisms."
    
    proposal = create_ingest_proposal(nodes_raw, edges_raw, rationale)
    
    assert len(proposal.nodes_upsert) == 1
    assert proposal.nodes_upsert[0].id == "transformer"
    assert proposal.nodes_upsert[0].aot_layer == 2
    assert proposal.rationale_md == rationale
    
    # Check default metrics integration
    assert proposal.nodes_upsert[0].metrics.pagerank == 0.0

@pytest.mark.asyncio
async def test_gcot_mock_logic():
    from benny.graph.kg3d.gcot import GCoTEngine
    from benny.graph.kg3d.schema import Node, NodeMetrics
    
    engine = GCoTEngine()
    n1 = Node(id="1", canonical_name="A", display_name="A", category="ai_deep_learning", aot_layer=1, metrics=NodeMetrics(pagerank=0, degree=0, betweenness=0, descendant_ratio=0, prerequisite_ratio=0, reachability_ratio=0))
    n2 = Node(id="2", canonical_name="B", display_name="B", category="llm_nlp", aot_layer=5, metrics=NodeMetrics(pagerank=0, degree=0, betweenness=0, descendant_ratio=0, prerequisite_ratio=0, reachability_ratio=0))
    
    reasoning = await engine.generate_rational(n1, n2, "prerequisite")
    assert "A" in reasoning
    assert "B" in reasoning
    assert "prerequisite" in reasoning
