"""
Benny Python SDK — synchronous convenience wrappers for the workflow API.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional

import httpx

from ..core.manifest import RunRecord, SwarmManifest


class BennyClient:
    """Synchronous client for Benny workflow operations."""

    def __init__(self, base_url: str = "http://127.0.0.1:8000"):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(timeout=60.0)

    def plan(self, requirement: str, workspace: str = "default", **kwargs) -> SwarmManifest:
        """Plan a workflow from a requirement.
        
        Args:
            requirement: Natural language requirement.
            workspace: Target workspace.
            **kwargs: Additional PlanRequest fields (model, max_concurrency, etc.)
            
        Returns:
            A signed SwarmManifest.
        """
        body = {"requirement": requirement, "workspace": workspace, **kwargs}
        resp = self.client.post(f"{self.base_url}/api/workflows/plan", json=body)
        resp.raise_for_status()
        return SwarmManifest.model_validate(resp.json())

    def run(self, manifest: SwarmManifest) -> Dict[str, Any]:
        """Execute a manifest.
        
        Returns:
            RunResponse dict (run_id, manifest_id, status).
        """
        resp = self.client.post(f"{self.base_url}/api/workflows/run", json=manifest.model_dump())
        resp.raise_for_status()
        return resp.json()

    def stream(self, run_id: str) -> Iterable[Dict[str, Any]]:
        """Stream events for a specific run (SSE)."""
        with self.client.stream("GET", f"{self.base_url}/api/runs/{run_id}/events") as response:
            for line in response.iter_lines():
                if line.startswith("data: "):
                    yield json.loads(line[6:])

    def get_record(self, run_id: str) -> Optional[RunRecord]:
        """Fetch the full record for a specific run."""
        resp = self.client.get(f"{self.base_url}/api/runs/{run_id}/record")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return RunRecord.model_validate(resp.json())

    def close(self):
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
