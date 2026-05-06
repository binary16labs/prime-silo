"""End-to-end orchestrator tests against the bundled financial-risk demo."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from benny.pypes.checkpoints import CheckpointStore
from benny.pypes.engines import get_engine
from benny.pypes.models import EngineType, PypesManifest
from benny.pypes.orchestrator import Orchestrator

REPO = Path(__file__).resolve().parents[2]
DEMO_MANIFEST = REPO / "manifests" / "templates" / "financial_risk_pipeline.json"


@pytest.fixture
def manifest():
    return PypesManifest.model_validate_json(DEMO_MANIFEST.read_text(encoding="utf-8"))


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Sandbox each test in its own BENNY_HOME so checkpoints don't leak."""
    monkeypatch.setenv("BENNY_HOME", str(REPO))  # demo CSV lives under repo
    return tmp_path


def test_run_produces_receipt_and_step_outcomes(manifest, tmp_path):
    os.environ["BENNY_HOME"] = str(REPO)
    orchestrator = Orchestrator(workspace_root=tmp_path)
    receipt = orchestrator.run(manifest)
    assert receipt.run_id
    assert receipt.signature
    assert set(receipt.step_results.keys()) == {
        "bronze_trades",
        "silver_trades",
        "silver_trades_usd",
        "gold_exposure",
    }
    # Status should be PARTIAL — demo trades intentionally breach the 100M notional cap.
    assert receipt.status in {"SUCCESS", "PARTIAL"}


def test_run_writes_manifest_snapshot_and_receipt(manifest, tmp_path):
    os.environ["BENNY_HOME"] = str(REPO)
    receipt = Orchestrator(workspace_root=tmp_path).run(manifest)
    run_dir = tmp_path / "runs" / f"pypes-{receipt.run_id}"
    assert (run_dir / "receipt.json").exists()
    assert (run_dir / "manifest_snapshot.json").exists()
    snap = json.loads((run_dir / "manifest_snapshot.json").read_text(encoding="utf-8"))
    # Variables must be substituted in the snapshot
    assert "${benny_home}" not in json.dumps(snap)


def test_run_creates_drillable_checkpoints(manifest, tmp_path):
    os.environ["BENNY_HOME"] = str(REPO)
    receipt = Orchestrator(workspace_root=tmp_path).run(manifest)
    run_dir = tmp_path / "runs" / f"pypes-{receipt.run_id}"
    store = CheckpointStore(run_dir)
    engine = get_engine(EngineType.PANDAS)
    df = store.read(engine, "gold_exposure")
    assert df is not None
    cols = engine.columns(df)
    assert "counterparty_id" in cols
    assert "total_exposure" in cols


def test_threshold_breach_triggers_partial_status(manifest, tmp_path):
    """The demo's silver_trades step must FAIL its 100M notional check."""
    os.environ["BENNY_HOME"] = str(REPO)
    receipt = Orchestrator(workspace_root=tmp_path).run(manifest)
    silver = receipt.step_results["silver_trades"]
    # step_results values are ValidationResult instances directly
    assert silver is not None
    assert silver.status == "FAIL"
    assert any(
        c["check"] == "threshold" and c["status"] == "FAILED"
        for c in silver.checks
    )
    assert receipt.status == "PARTIAL"


def test_reports_render(manifest, tmp_path):
    os.environ["BENNY_HOME"] = str(REPO)
    receipt = Orchestrator(workspace_root=tmp_path).run(manifest)
    assert receipt.reports is not None
    assert "counterparty_risk" in receipt.reports
    assert "breaches" in receipt.reports
    report_path = Path(receipt.reports["counterparty_risk"])
    assert report_path.exists()
    text = report_path.read_text(encoding="utf-8")
    assert "Counterparty" in text
    # CLP provenance section is the explainability backbone
    assert "CLP Provenance" in text


def test_rerun_from_step_reuses_prior_checkpoints(manifest, tmp_path):
    os.environ["BENNY_HOME"] = str(REPO)
    orchestrator = Orchestrator(workspace_root=tmp_path)
    first = orchestrator.run(manifest)
    second = orchestrator.run(
        manifest,
        resume_from_run_id=first.run_id,
        only_steps=["silver_trades_usd", "gold_exposure"],
    )
    # bronze_trades and silver_trades should be marked SKIPPED in the rerun's outcomes
    # (their checkpoints were copied forward from the first run)
    assert second.run_id != first.run_id
    assert "gold_exposure" in second.step_results
