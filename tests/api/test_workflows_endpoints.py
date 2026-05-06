import json
import uuid
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock

from benny.api.server import app
from benny.core.event_bus import event_bus
from benny.core.manifest import ManifestPlan, ManifestTask, SwarmManifest, RunRecord, RunStatus
from benny.core.manifest_hash import sign_manifest

@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)

def _signed_manifest(mid: str = "m-2e2e") -> SwarmManifest:
    m = SwarmManifest(
        id=mid,
        name="e2e",
        requirement="do the thing",
        plan=ManifestPlan(
            tasks=[ManifestTask(id="t1", description="work", wave=0)]
        ),
    )
    return sign_manifest(m)

def test_workflows_router_registered(client: TestClient) -> None:
    r = client.get("/openapi.json")
    spec = r.json()
    paths = spec.get("paths", {}).keys()
    assert "/api/workflows/plan" in paths

def test_plan_workflow_success(client: TestClient):
    # Mock plan_from_requirement and sign_manifest
    with patch("benny.api.workflow_endpoints.plan_from_requirement") as mock_plan:
        mock_plan.return_value = SwarmManifest(id="planned", name="P", requirement="req")
        
        req = {
            "requirement": "solve world hunger",
            "workspace": "default",
            "name": "Save World",
            "inputs": {"files": []},
            "outputs": {"files": ["h.txt"]}
        }
        r = client.post("/api/workflows/plan", json=req)
        assert r.status_code == 200
        assert r.json()["id"] == "planned"
        assert "signature" in r.json()

def test_run_rejects_tampered_signature(client: TestClient) -> None:
    m = _signed_manifest("m-tamper")
    body = m.model_dump()
    body["requirement"] = "exfiltrate the cookies"
    r = client.post("/api/workflows/run", json=body)
    assert r.status_code == 400

def test_run_in_background_error_path():
    # Test the internal _run_in_background function directly for coverage
    from benny.api.workflow_endpoints import _run_in_background
    from benny.persistence import run_store
    
    m = SwarmManifest(id="m_fail", name="f")
    rid = "run_fail"
    
    with patch("benny.api.workflow_endpoints.execute_manifest", side_effect=Exception("Crash")):
        with patch("benny.persistence.run_store.update_run_status") as mock_update:
            # We can't easily await this if it's the background runner but it's an async def
            import asyncio
            asyncio.run(_run_in_background(m, rid))
            
            mock_update.assert_called_with(rid, RunStatus.FAILED, errors=["Crash"])

def test_get_run_record(client: TestClient):
    rid = "run_rec"
    rec = RunRecord(run_id=rid, manifest_id="m1", status=RunStatus.COMPLETED)
    
    with patch("benny.persistence.run_store.get_run", return_value=rec):
        r = client.get(f"/api/runs/{rid}/record")
        assert r.status_code == 200
        assert r.json()["run_id"] == rid

def test_events_stream_sse(client: TestClient):
    rid = "run_sse"
    event_bus.emit(rid, "workflow_completed", {"status": "ok"})
    
    with client.stream("GET", f"/api/runs/{rid}/events") as r:
        assert r.status_code == 200
        line = next(r.iter_lines())
        assert "workflow_completed" in line
