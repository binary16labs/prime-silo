import pytest
import os
from unittest.mock import AsyncMock, patch
from benny.mcp.server import mcp
import httpx
import json

@pytest.mark.asyncio
async def test_plan_tool_registered():
    """Requirement 4.3.1: assert the four tool names are present."""
    # FastMCP.list_tools() returns a list of Tool objects
    tools = await mcp.list_tools()
    tool_names = [tool.name for tool in tools]
    assert "plan_workflow" in tool_names
    assert "run_workflow" in tool_names
    assert "stream_events" in tool_names
    assert "get_run" in tool_names

@pytest.mark.asyncio
async def test_plan_tool_proxies_to_api():
    """Requirement 4.3.2: assert it POSTs to /api/workflows/plan."""
    # httpx.Response needs a Request attached for raise_for_status() to work.
    mock_request = httpx.Request("POST", "http://test/api/workflows/plan")
    mock_response = httpx.Response(
        200, json={"id": "m-123", "status": "signed"}, request=mock_request
    )
    
    with patch("benny.mcp.server.httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.post.return_value = mock_response
        mock_client_class.return_value = mock_client
        
        # Call tool directly on the mcp instance
        result = await mcp.call_tool("plan_workflow", {"requirement": "test", "workspace": "default"})
        assert "m-123" in str(result)
        mock_client.post.assert_called()
        # Verify it called the correct endpoint
        args, kwargs = mock_client.post.call_args
        assert "/api/workflows/plan" in args[0]

@pytest.mark.asyncio
async def test_run_tool_rejects_missing_signature_when_strict_env_set(monkeypatch):
    """Requirement 4.3.3: BENNY_REQUIRE_SIGNATURES=1 should refuse unsigned manifests."""
    monkeypatch.setenv("BENNY_REQUIRE_SIGNATURES", "1")
    
    # An unsigned manifest (no signature field)
    # We pass it as a dict which the tool should validate
    unsigned_manifest = {"id": "m-unsigned", "requirement": "x", "plan": {"tasks": []}, "name": "test"}
    
    # The tool returns an error signal or raises an exception. 
    # In my implementation, I returned a string starting with "Error:".
    result = await mcp.call_tool("run_workflow", {"manifest": unsigned_manifest})
    # Since call_tool returns a list of Content objects (usually), we check the text.
    assert "Error: Integrity check failed" in str(result)

@pytest.mark.asyncio
async def test_stream_events_yields_then_terminates():
    """Requirement 4.3.4: patch streaming response to emit two SSE lines then EOF."""
    
    async def mock_aiter_lines():
        yield "data: {\"type\": \"workflow_started\"}"
        yield "data: {\"type\": \"workflow_completed\"}"

    mock_resp = AsyncMock()
    mock_resp.aiter_lines = mock_aiter_lines
    
    with patch("httpx.AsyncClient.stream", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_resp), __aexit__=AsyncMock())) as mock_req:
        result = await mcp.call_tool("stream_events", {"run_id": "run-123"})
        assert "workflow_started" in str(result)
        assert "workflow_completed" in str(result)
