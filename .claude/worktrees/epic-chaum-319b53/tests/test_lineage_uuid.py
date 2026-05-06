import pytest
import uuid
from unittest.mock import patch, MagicMock
from benny.governance.lineage import BennyLineageClient, PRODUCER

@pytest.fixture
def lineage_client():
    with patch("benny.governance.lineage.OpenLineageClient") as mock_client:
        client = BennyLineageClient(marquez_url="http://mock-marquez", namespace="test")
        yield client

def test_uuid_mapping_with_invalid_guid(lineage_client):
    """Test that a non-UUID string is correctly mapped to a valid UUID"""
    benny_id = "run-test-12345"
    
    # 1. Test mapping generation
    ol_uuid = lineage_client._get_or_create_uuid(benny_id)
    
    # Verify it's a valid UUID
    uuid.UUID(ol_uuid) 
    assert ol_uuid != benny_id
    assert lineage_client._run_id_map[benny_id] == ol_uuid
    
    # 2. Test start_workflow
    with patch.object(lineage_client.client, 'emit') as mock_emit:
        lineage_client.start_workflow(
            workflow_id=benny_id,
            workflow_name="test_workflow",
            workspace="test_ws",
            inputs=["in1"],
            outputs=["out1"]
        )
        
        # Verify event was emitted with the valid UUID
        args, kwargs = mock_emit.call_args
        event = args[0]
        assert event.run.runId == ol_uuid
        assert event.run.facets["benny_context"].benny_run_id == benny_id

def test_uuid_lookup_for_nested_events(lineage_client):
    """Test that nested events (LLM calls) use the mapped parent UUID"""
    benny_id = "run-parent-slug"
    
    # Pre-map the ID
    ol_uuid = lineage_client._get_or_create_uuid(benny_id)
    
    with patch.object(lineage_client.client, 'emit') as mock_emit:
        lineage_client.emit_llm_call(
            parent_run_id=benny_id,
            model="test-model",
            provider="test-prov"
        )
        
        args, kwargs = mock_emit.call_args
        event = args[0]
        
        # Verify parent facet contains the valid UUID, not the slug
        assert event.run.facets["parent"].run["runId"] == ol_uuid

def test_valid_uuid_remains_unchanged(lineage_client):
    """Test that if a valid UUID is provided, it is used as is"""
    valid_uuid = str(uuid.uuid4())
    
    ol_uuid = lineage_client._get_or_create_uuid(valid_uuid)
    
    assert ol_uuid == valid_uuid
    assert valid_uuid not in lineage_client._run_id_map
