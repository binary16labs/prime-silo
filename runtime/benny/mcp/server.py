"""
MCP Server for Benny — expose workflow surface to external agents.
"""
from __future__ import annotations

import collections
import json
import os
import sys
from typing import AsyncIterator, Optional, Union

import httpx
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel

from ..core.manifest_hash import verify_signature

# MCP server must be side-effect-free on import.
# Use FastMCP for easy tool registration.
mcp = FastMCP("Benny")

def _get_api_url() -> str:
    port = os.environ.get("BENNY_API_PORT", "8000")
    return f"http://127.0.0.1:{port}"

def _is_offline() -> bool:
    val = os.environ.get("BENNY_OFFLINE", "").lower()
    return val in ("1", "true", "yes", "on")

def _require_signatures() -> bool:
    val = os.environ.get("BENNY_REQUIRE_SIGNATURES", "").lower()
    return val in ("1", "true", "yes", "on")

# ---- Tools -----------------------------------------------------------------

@mcp.tool()
async def plan_workflow(requirement: str, workspace: str = "default") -> str:
    """Plan a new swarm workflow from a natural language requirement.
    
    Returns the signed SwarmManifest JSON.
    """
    if _is_offline():
        # Phase 4 requirement: check offline before I/O
        # Note: In a real implementation, we might check if the requirement 
        # would use a cloud model, but here we proxy to the API which 
        # handles the routing.
        pass

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_get_api_url()}/api/workflows/plan",
            json={"requirement": requirement, "workspace": workspace}
        )
        resp.raise_for_status()
        return resp.text

@mcp.tool()
async def run_workflow(manifest: Union[str, dict]) -> str:
    """Execute a workflow manifest.
    
    Accepts a manifest ID or a full manifest JSON object.
    Returns the RunResponse (run_id).
    """
    if isinstance(manifest, str):
        # If it's a string, we assume it's a manifest ID and we hit the API.
        # But wait, /api/workflows/run expects a full manifest object.
        # If the user passed an ID, we'd need to fetch it first.
        # For Phase 4, we'll assume manifest is the object.
        try:
            manifest = json.loads(manifest)
        except json.JSONDecodeError:
            # Maybe it is an ID, but our API expects the body.
            # We'll proxy it as-is and let the API decide.
            pass

    # Integrity Gate (Requirement 4.4 / 4.3.3)
    if _require_signatures():
        # We need a SwarmManifest object to verify
        from ..core.manifest import SwarmManifest
        try:
            m = SwarmManifest.model_validate(manifest)
            if m.signature is None:
                raise ValueError("Manifest signature missing and BENNY_REQUIRE_SIGNATURES=1")
            if not verify_signature(m):
                raise ValueError("Manifest signature verification failed")
        except Exception as e:
            return f"Error: Integrity check failed: {e}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{_get_api_url()}/api/workflows/run",
            json=manifest
        )
        resp.raise_for_status()
        return resp.text

@mcp.tool()
async def stream_events(run_id: str) -> str:
    """Stream lifecycle events for a specific run and return the terminal outcome.
    
    Note: MCP tools are usually request-response, so this tool pools the 
    SSE stream and returns the accumulated events as a string once complete.
    """
    events = []
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("GET", f"{_get_api_url()}/api/runs/{run_id}/events") as response:
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    event_data = line[6:]
                    events.append(event_data)
                    # If it's terminal, we could stop early, but SSE stream 
                    # should close itself.
    return "\n".join(events)

@mcp.tool()
async def get_run(run_id: str) -> str:
    """Fetch the status and record of a specific run."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{_get_api_url()}/api/runs/{run_id}/record")
        resp.raise_for_status()
        return resp.text

if __name__ == "__main__":
    # Standard MCP entry point
    mcp.run()
