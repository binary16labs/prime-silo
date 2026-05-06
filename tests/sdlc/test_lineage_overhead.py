"""AOS-F23, AOS-COMP2, AOS-NFR11 — JSON-LD provenance per artifact.

Red tests — will fail with ModuleNotFoundError until
benny/governance/jsonld.py is implemented.

AOS-F23: Every artefact persisted by artifact_store.put triggers a JSON-LD
         record at data_out/lineage/{artifact_sha}.jsonld per §4.4.
AOS-COMP2: Every CDE referenced in a pypes manifest carries a JSON-LD
           lineage record connecting source columns to destination columns.
AOS-NFR11: JSON-LD lineage emission adds ≤ 5 ms p95 per task.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pytest

from benny.governance.jsonld import emit_provenance


# ---------------------------------------------------------------------------
# AOS-F23 — JSON-LD sidecar per artifact
# ---------------------------------------------------------------------------


def test_aos_f23_jsonld_per_artifact(tmp_path):
    """F23: emit_provenance creates .jsonld at data_out/lineage/{sha}.jsonld"""
    sha = "a" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="run-001",
        task_id="task_0_vision",
        persona="architect",
        model="local_lemonade",
        started_at="2026-04-27T10:00:00Z",
        ended_at="2026-04-27T10:00:01Z",
    )
    assert path.exists()
    assert path.name == f"{sha}.jsonld"
    assert path.parent == tmp_path / "data_out" / "lineage"

    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["@type"] == "prov:Activity"
    assert doc["@id"] == "urn:benny:run:run-001:task:task_0_vision"
    assert doc["prov:startedAtTime"] == "2026-04-27T10:00:00Z"
    assert doc["prov:endedAtTime"] == "2026-04-27T10:00:01Z"


def test_aos_f23_jsonld_context_contains_prov(tmp_path):
    """F23: @context is set and contains the prov prefix."""
    sha = "b" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r1",
        task_id="t1",
        persona="planner",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert "@context" in doc
    ctx = doc["@context"]
    # Context may be a URL string or a dict — either way 'prov' must be present
    ctx_str = json.dumps(ctx)
    assert "prov" in ctx_str


def test_aos_f23_jsonld_agent_block(tmp_path):
    """F23: prov:wasAssociatedWith carries model identifier."""
    sha = "c" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r2",
        task_id="t2",
        persona="implementer",
        model="lemonade/qwen3-coder-30b",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    agent = doc["prov:wasAssociatedWith"]
    assert "implementer" in agent["@id"]
    assert agent["model"] == "lemonade/qwen3-coder-30b"


def test_aos_f23_jsonld_used_and_generated(tmp_path):
    """F23: prov:used and prov:generated populated when sha lists provided."""
    sha_in = "d" * 64
    sha_out = "e" * 64
    path = emit_provenance(
        sha_out,
        workspace_path=tmp_path,
        run_id="r3",
        task_id="t3",
        persona="reviewer",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        inputs_shas=[sha_in],
        outputs_shas=[sha_out],
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert len(doc["prov:used"]) >= 1
    assert len(doc["prov:generated"]) >= 1
    assert f"artifact://{sha_in}" in doc["prov:used"]
    assert f"artifact://{sha_out}" in doc["prov:generated"]


def test_aos_f23_idempotent(tmp_path):
    """F23: calling emit_provenance twice on the same sha is idempotent."""
    sha = "f" * 64
    kwargs = dict(
        workspace_path=tmp_path,
        run_id="r4",
        task_id="t4",
        persona="planner",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
    )
    path1 = emit_provenance(sha, **kwargs)
    path2 = emit_provenance(sha, **kwargs)
    assert path1 == path2
    assert path1.exists()


def test_aos_f23_vendor_context_rewrite(tmp_path):
    """F23/OQ-3: when benny_home is set, @context is rewritten to file:// URI."""
    sha = "g" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r5",
        task_id="t5",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        benny_home=tmp_path,
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    ctx = doc["@context"]
    # With benny_home set, context should be a file:// path
    assert str(ctx).startswith("file://") or "prov-o" in str(ctx)


# ---------------------------------------------------------------------------
# AOS-COMP2 — CDE lineage records
# ---------------------------------------------------------------------------


def test_aos_comp2_cde_lineage_present(tmp_path):
    """COMP2: CDE refs appear in the JSON-LD lineage record."""
    sha = "h" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r6",
        task_id="t6",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        cde_refs=["trade.notional", "trade.counterparty_id"],
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert "benny:cde_refs" in doc
    assert "trade.notional" in doc["benny:cde_refs"]
    assert "trade.counterparty_id" in doc["benny:cde_refs"]


def test_aos_comp2_policy_decision_field(tmp_path):
    """COMP2: policy_decision field is recorded in provenance."""
    sha = "i" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r7",
        task_id="t7",
        persona="planner",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        policy_decision="approved",
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["benny:policy_decision"] == "approved"


def test_aos_comp2_prompt_and_reasoning_hashes(tmp_path):
    """COMP2: prompt_hash and reasoning_hash are stored if provided."""
    sha = "j" * 64
    path = emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r8",
        task_id="t8",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
        prompt_hash="sha256:abc",
        reasoning_hash="sha256:def",
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["benny:prompt_hash"] == "sha256:abc"
    assert doc["benny:reasoning_hash"] == "sha256:def"


# ---------------------------------------------------------------------------
# AOS-NFR11 — emission overhead ≤ 5 ms p95
# ---------------------------------------------------------------------------


def test_aos_nfr11_lineage_overhead_p95(tmp_path):
    """NFR11: emit_provenance p95 ≤ 5 ms over 30 calls."""
    timings: list[float] = []
    for i in range(30):
        sha = hashlib.sha256(str(i).encode()).hexdigest()
        t0 = time.perf_counter()
        emit_provenance(
            sha,
            workspace_path=tmp_path,
            run_id=f"r{i}",
            task_id=f"t{i}",
            persona="architect",
            model="lm",
            started_at="2026-01-01T00:00:00Z",
            ended_at="2026-01-01T00:00:01Z",
        )
        timings.append((time.perf_counter() - t0) * 1000)

    timings.sort()
    p95 = timings[int(len(timings) * 0.95)]
    assert p95 <= 5.0, f"p95 lineage overhead {p95:.2f} ms exceeds 5 ms budget"
