"""AOS-COMP3 — Lineage graph completeness: no orphan edges.

Red tests — will fail until benny/governance/jsonld.py exposes
check_no_orphans().

AOS-COMP3: The lineage graph for a given run has no orphan edges —
every prov:used traces to a prov:Entity that exists in the run's
artefact store; every prov:generated traces to an emitted artefact.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.governance.jsonld import check_no_orphans, emit_provenance


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _put_fake_artifact(workspace_path: Path, sha: str) -> None:
    """Write a stub artifact file to the workspace artifact store."""
    art = workspace_path / "artifacts" / sha[:2] / sha[2:]
    art.parent.mkdir(parents=True, exist_ok=True)
    art.write_bytes(b"fake-artifact")


# ---------------------------------------------------------------------------
# AOS-COMP3 tests
# ---------------------------------------------------------------------------


def test_aos_comp3_no_orphans(tmp_path):
    """COMP3: no orphans when all prov:used SHAs exist in the artifact store."""
    sha_in = "e" * 64
    sha_out = "f" * 64

    _put_fake_artifact(tmp_path, sha_in)
    _put_fake_artifact(tmp_path, sha_out)

    emit_provenance(
        sha_out,
        workspace_path=tmp_path,
        run_id="r1",
        task_id="t1",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        inputs_shas=[sha_in],
        outputs_shas=[sha_out],
    )

    orphans = check_no_orphans(workspace_path=tmp_path)
    assert orphans == [], f"Unexpected orphans: {orphans}"


def test_aos_comp3_detects_missing_used_artifact(tmp_path):
    """COMP3: check_no_orphans detects a prov:used SHA missing from artifact store."""
    sha_out = "g" * 64
    missing_sha = "h" * 64

    # Write output artifact but NOT the input artifact
    _put_fake_artifact(tmp_path, sha_out)

    emit_provenance(
        sha_out,
        workspace_path=tmp_path,
        run_id="r2",
        task_id="t2",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        inputs_shas=[missing_sha],
        outputs_shas=[sha_out],
    )

    orphans = check_no_orphans(workspace_path=tmp_path)
    assert len(orphans) >= 1
    assert any(missing_sha in str(o) for o in orphans)


def test_aos_comp3_detects_missing_generated_artifact(tmp_path):
    """COMP3: check_no_orphans detects a prov:generated SHA missing from artifact store."""
    sha_in = "k" * 64
    sha_out_missing = "l" * 64

    _put_fake_artifact(tmp_path, sha_in)
    # Do NOT create sha_out_missing in the artifact store

    emit_provenance(
        sha_out_missing,
        workspace_path=tmp_path,
        run_id="r3",
        task_id="t3",
        persona="planner",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        inputs_shas=[sha_in],
        outputs_shas=[sha_out_missing],
    )

    orphans = check_no_orphans(workspace_path=tmp_path)
    assert len(orphans) >= 1
    assert any(sha_out_missing in str(o) for o in orphans)


def test_aos_comp3_empty_lineage_dir(tmp_path):
    """COMP3: check_no_orphans on empty workspace returns empty list."""
    orphans = check_no_orphans(workspace_path=tmp_path)
    assert orphans == []


def test_aos_comp3_no_orphans_no_inputs(tmp_path):
    """COMP3: record with no prov:used (root artifact) has no orphans."""
    sha_out = "m" * 64
    _put_fake_artifact(tmp_path, sha_out)

    emit_provenance(
        sha_out,
        workspace_path=tmp_path,
        run_id="r4",
        task_id="t4",
        persona="planner",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        inputs_shas=[],
        outputs_shas=[sha_out],
    )

    orphans = check_no_orphans(workspace_path=tmp_path)
    assert orphans == []


def test_aos_comp3_multiple_records(tmp_path):
    """COMP3: multi-record lineage graph passes when all artifacts exist."""
    shas = ["n" * 64, "o" * 64, "p" * 64]
    for sha in shas:
        _put_fake_artifact(tmp_path, sha)

    # Chain: shas[0] → shas[1] → shas[2]
    emit_provenance(
        shas[1],
        workspace_path=tmp_path,
        run_id="r5",
        task_id="t5a",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        inputs_shas=[shas[0]],
        outputs_shas=[shas[1]],
    )
    emit_provenance(
        shas[2],
        workspace_path=tmp_path,
        run_id="r5",
        task_id="t5b",
        persona="reviewer",
        model="lm",
        started_at="2026-01-01T00:00:01Z",
        ended_at="2026-01-01T00:00:02Z",
        inputs_shas=[shas[1]],
        outputs_shas=[shas[2]],
    )

    orphans = check_no_orphans(workspace_path=tmp_path)
    assert orphans == []
