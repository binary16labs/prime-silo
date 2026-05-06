"""AOS-F24 — Pypes silver/gold steps emit column-level lineage.

Red tests — will fail until benny/pypes/lineage.py is extended with
emit_column_lineage().

AOS-F24: Pypes silver/gold steps emit a column-level lineage block
         (prov:used / prov:generated) referencing CDEs declared in the
         pypes manifest.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.pypes.lineage import emit_column_lineage


# ---------------------------------------------------------------------------
# AOS-F24 — column-level lineage block
# ---------------------------------------------------------------------------


def test_aos_f24_pypes_column_lineage():
    """F24: emit_column_lineage returns prov:used / prov:generated block."""
    block = emit_column_lineage(
        step_id="silver_trades",
        stage="silver",
        columns_used=["raw.trade_id", "raw.notional"],
        columns_generated=["silver.trade_id", "silver.notional_usd"],
        run_id="run-001",
        manifest_id="fin-risk-001",
    )
    assert block is not None
    assert "prov:used" in block
    assert "prov:generated" in block
    assert "raw.trade_id" in block["prov:used"]
    assert "silver.notional_usd" in block["prov:generated"]


def test_aos_f24_gold_step_lineage():
    """F24: gold steps also emit column lineage."""
    block = emit_column_lineage(
        step_id="gold_exposure",
        stage="gold",
        columns_used=["silver.notional_usd", "silver.trade_id"],
        columns_generated=["gold.exposure_usd"],
        run_id="run-002",
        manifest_id="fin-risk-001",
    )
    assert "prov:used" in block
    assert "silver.notional_usd" in block["prov:used"]
    assert "gold.exposure_usd" in block["prov:generated"]


def test_aos_f24_cde_refs_in_lineage():
    """F24: CDE refs are included in column lineage block (COMP2 bridge)."""
    block = emit_column_lineage(
        step_id="gold_exposure",
        stage="gold",
        columns_used=["silver.notional_usd"],
        columns_generated=["gold.exposure"],
        run_id="run-003",
        manifest_id="fin-risk-001",
        cde_refs=["trade.notional", "trade.counterparty_id"],
    )
    assert "benny:cde_refs" in block
    assert "trade.notional" in block["benny:cde_refs"]
    assert "trade.counterparty_id" in block["benny:cde_refs"]


def test_aos_f24_writes_jsonld_sidecar(tmp_path):
    """F24: when workspace_path is given, a .jsonld sidecar is written."""
    emit_column_lineage(
        step_id="silver_trades",
        stage="silver",
        columns_used=["raw.x"],
        columns_generated=["silver.x"],
        run_id="run-004",
        manifest_id="m1",
        workspace_path=tmp_path,
    )
    lineage_dir = tmp_path / "data_out" / "lineage"
    sidecars = list(lineage_dir.glob("pypes_*.jsonld"))
    assert len(sidecars) >= 1

    doc = json.loads(sidecars[0].read_text(encoding="utf-8"))
    assert "prov:used" in doc
    assert "prov:generated" in doc


def test_aos_f24_sidecar_contains_manifest_id(tmp_path):
    """F24: pypes sidecar carries the manifest_id for traceability."""
    emit_column_lineage(
        step_id="silver_abc",
        stage="silver",
        columns_used=["raw.a"],
        columns_generated=["silver.a"],
        run_id="run-005",
        manifest_id="my-manifest-42",
        workspace_path=tmp_path,
    )
    lineage_dir = tmp_path / "data_out" / "lineage"
    sidecars = list(lineage_dir.glob("pypes_*.jsonld"))
    doc = json.loads(sidecars[0].read_text(encoding="utf-8"))
    assert doc.get("benny:manifest_id") == "my-manifest-42"


def test_aos_f24_bronze_not_emitted():
    """F24: bronze steps return None — column lineage only on silver/gold."""
    block = emit_column_lineage(
        step_id="bronze_raw",
        stage="bronze",
        columns_used=[],
        columns_generated=["raw.trade_id"],
        run_id="run-006",
        manifest_id="m1",
    )
    # bronze stage: no column-level lineage
    assert block is None or block == {}


def test_aos_f24_multiple_steps_separate_sidecars(tmp_path):
    """F24: two different steps produce two separate sidecar files."""
    emit_column_lineage(
        step_id="silver_step_a",
        stage="silver",
        columns_used=["raw.a"],
        columns_generated=["silver.a"],
        run_id="run-007",
        manifest_id="m1",
        workspace_path=tmp_path,
    )
    emit_column_lineage(
        step_id="silver_step_b",
        stage="silver",
        columns_used=["raw.b"],
        columns_generated=["silver.b"],
        run_id="run-007",
        manifest_id="m1",
        workspace_path=tmp_path,
    )
    lineage_dir = tmp_path / "data_out" / "lineage"
    sidecars = list(lineage_dir.glob("pypes_*.jsonld"))
    assert len(sidecars) == 2
