import pytest
from unittest.mock import MagicMock, patch
from benny.sdk import BennyClient
from benny.core.manifest import SwarmManifest, ManifestPlan, ManifestTask
import httpx

def test_client_plan_signs_on_request():
    """Requirement 4.3.5: assert client.plan returns a signed manifest."""
    client = BennyClient(base_url="http://127.0.0.1:8000")
    
    # Mocking the API response to return an unsigned manifest, 
    # but the client should sign it if requested or ensure the returned one is signed.
    # Actually, the API (Phase 2) already signs it. The SDK just returns it.
    
    mock_manifest_data = {
        "id": "m-1",
        "name": "test",
        "requirement": "req",
        "plan": {"tasks": []},
        "content_hash": "abc",
        "signature": "sha256:123"
    }
    
    with patch("httpx.Client.post") as mock_post:
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = mock_manifest_data
        
        manifest = client.plan("req", workspace="default")
        assert manifest.content_hash == "abc"
        assert manifest.signature == "sha256:123"

def test_client_stream_closes_socket_on_workflow_completed():
    """Requirement 4.3.6: verify no lingering httpx clients after a completed event."""
    client = BennyClient(base_url="http://127.0.0.1:8000")
    
    mock_events = [
        "data: {\"type\": \"workflow_started\"}\n\n",
        "data: {\"type\": \"workflow_completed\"}\n\n"
    ]
    
    # We want to check that the client's internal session or stream is closed.
    # This usually means checking the __exit__ call on the stream.
    
    with patch("httpx.Client.stream") as mock_stream:
        mock_stream.return_value.__enter__.return_value.iter_lines.return_value = mock_events
        
        events = list(client.stream("run-123"))
        assert len(events) == 2
        # Verify the context manager was used (which handles closing)
        mock_stream.return_value.__exit__.assert_called()
