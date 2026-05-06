import pytest
import json
import os
from benny.graph.kg3d.schema import Node, Edge, validate_node, aot_layer_for

FIXTURE_PATH = "C:/Users/nsdha/OneDrive/code/benny/tests/fixtures/kg3d/ml_knowledge_graph_v1.json"

def test_kg3d_schema_validation():
    # Valid node
    node_data = {
        "id": "test-1",
        "canonical_name": "Test Node",
        "display_name": "Test Node",
        "category": "ai_deep_learning",
        "aot_layer": 3,
        "metrics": {
            "pagerank": 0.5,
            "degree": 10,
            "betweenness": 0.1,
            "descendant_ratio": 0.3, # Should be layer 3
            "prerequisite_ratio": 0.5,
            "reachability_ratio": 0.5
        }
    }
    node = Node(**node_data)
    assert validate_node(node) is True
    assert node.aot_layer == 3

def test_kg3d_aot_bins():
    assert aot_layer_for(0.9) == 1
    assert aot_layer_for(0.6) == 2
    assert aot_layer_for(0.3) == 3
    assert aot_layer_for(0.15) == 4
    assert aot_layer_for(0.05) == 5

def test_kg3d_reject_self_loop():
    with pytest.raises(ValueError, match="Self-loops are forbidden"):
        Edge(
            id="e1",
            source_id="n1",
            target_id="n1",
            kind="prerequisite",
            weight=1.0
        )

def test_fixture_loading():
    assert os.path.exists(FIXTURE_PATH)
    with open(FIXTURE_PATH, "r") as f:
        data = json.load(f)
    
    assert "nodes" in data
    assert "edges" in data
    # In Phase 0, we check if we can parse them into models
    for n in data["nodes"]:
        Node(**n)
    for e in data["edges"]:
        Edge(**e)
