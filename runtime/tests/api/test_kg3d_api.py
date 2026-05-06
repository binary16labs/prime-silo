import pytest
from fastapi.testclient import TestClient
from benny.api.server import app
from benny.graph.kg3d.schema import Proposal, Node, NodeMetrics

client = TestClient(app)

def test_kg3d_api_ontology():
    # We must use the header since we are hitting /api/kg3d/ontology which is NOT in whitelist
    headers = {"X-Benny-API-Key": "benny-mesh-2026-auth"}
    response = client.get("/api/kg3d/ontology", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert "nodes" in data
    assert "edges" in data
    assert len(data["nodes"]) > 0

def test_kg3d_api_proposals():
    headers = {"X-Benny-API-Key": "benny-mesh-2026-auth"}
    
    # 1. List proposals (should be empty initially)
    response = client.get("/api/kg3d/proposals", headers=headers)
    assert response.status_code == 200
    assert response.json() == []

    # 2. Inject a test proposal (using internal helper for simplicity in Phase 3 test)
    from benny.api.kg3d import inject_test_proposal
    test_node = Node(
        id="new-node-1",
        canonical_name="New Node",
        display_name="New Node",
        category="ai_deep_learning",
        aot_layer=3,
        metrics=NodeMetrics(
            pagerank=0.1, degree=1, betweenness=0,
            descendant_ratio=0.3, prerequisite_ratio=0.1, reachability_ratio=0.1
        )
    )
    proposal = Proposal(nodes_upsert=[test_node], edges_upsert=[], rationale_md="Test")
    p_id = inject_test_proposal(proposal)

    # 3. Verify it shows up in API
    response = client.get("/api/kg3d/proposals", headers=headers)
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["id"] == p_id

    # 4. Approve it
    response = client.post(f"/api/kg3d/proposals/{p_id}/approve", headers=headers)
    assert response.status_code == 200
    
    # 5. Verify it's gone from pending
    response = client.get("/api/kg3d/proposals", headers=headers)
    assert response.status_code == 200
    assert response.json() == []

def test_kg3d_sse_whitelisted():
    # Stream endpoint should be whitelisted (no header needed)
    # We don't need to fully consume the stream, just check headers and start
    with client.stream("GET", "/api/kg3d/stream") as response:
        assert response.status_code == 200
        assert response.headers["content-type"] == "text/event-stream"
