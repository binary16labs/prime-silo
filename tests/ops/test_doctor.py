import pytest
import os
from unittest.mock import patch, MagicMock
from benny.ops.doctor import run_doctor, CheckResult
from benny.api.server import app
from fastapi.testclient import TestClient

@pytest.fixture
def client():
    return TestClient(app)

def setup_benny_home(tmp_path, monkeypatch):
    """Utility to set up a valid BENNY_HOME."""
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    for d in ["workflows", "runs", "logs", "bin"]:
        (tmp_path / d).mkdir()

@pytest.mark.asyncio
async def test_doctor_reports_all_green_when_services_up(tmp_path, monkeypatch):
    """Requirement 6.2.1: stub probes, assert status code 0."""
    setup_benny_home(tmp_path, monkeypatch)
    # Stub all probe logic in benny.ops.doctor
    with patch("benny.ops.doctor.probe_service", return_value=(True, "OK")):
        report = await run_doctor()
        assert report.status_code == 0
        assert all(c.status == "OK" for c in report.checks)

@pytest.mark.asyncio
async def test_doctor_flags_missing_home_dir(monkeypatch):
    """Requirement 6.2.2: point BENNY_HOME at invalid path."""
    monkeypatch.setenv("BENNY_HOME", "C:/non/existent/path/benny_test")
    report = await run_doctor()
    assert any(c.name == "BENNY_HOME" and c.status == "ERROR" for c in report.checks)
    assert report.status_code == 1

@pytest.mark.asyncio
async def test_doctor_warns_when_offline_and_cloud_default(tmp_path, monkeypatch):
    """Requirement 6.2.3: BENNY_OFFLINE=1 but default_model is cloud."""
    setup_benny_home(tmp_path, monkeypatch)
    monkeypatch.setenv("BENNY_OFFLINE", "1")
    # Stub workspace to return a cloud default model
    mock_manifest = MagicMock(default_model="openai/gpt-4")
    with patch("benny.ops.doctor.load_manifest", return_value=mock_manifest):
        with patch("benny.ops.doctor.probe_service", return_value=(True, "OK")):
            report = await run_doctor()
            assert any("cloud" in c.message.lower() and c.status == "WARN" for c in report.checks)
            # Should be 2 (WARN) because everything else is OK
            assert report.status_code == 2

@pytest.mark.asyncio
async def test_doctor_endpoint_serves_json(client, tmp_path, monkeypatch):
    """Requirement 6.2.4: API check."""
    setup_benny_home(tmp_path, monkeypatch)
    response = client.get("/api/ops/doctor")
    assert response.status_code == 200
    data = response.json()
    assert "checks" in data
    assert len(data["checks"]) > 0
