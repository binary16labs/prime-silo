"""P1 — the metric schema: unmeasured is not zero.

Red tests. They fail until `sandbox_runner` stops treating `hook=None` as consent to report zeros.

The single claim under test: **a metric this harness did not derive is `None`, never `0.0`**. Today
`run_multi_model(hook=None)` silently selects `_dry_run_stub`, which returns 0.0 for seven fields and
`1.0` for `constraint_adherence` — a perfect adherence score from a run that never happened. Every
test below is written so that coercing a `None` back to `0.0` turns it red.

This module deliberately does NOT import `bench_executor`: P1 is the schema and must stand alone
(the derivation is P6). Scenarios ↔ delivery/tasks/P1.md gherkin.
"""

from __future__ import annotations

import pytest

from benny.sdlc.sandbox_runner import (
    METRIC_FIELDS,
    SandboxResult,
    rank_subjects,
    run_multi_model,
    write_sandbox_report,
)


@pytest.fixture
def manifest(tmp_path):
    p = tmp_path / "m.json"
    p.write_text('{"id": "m"}', encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# hook=None RAISES rather than silently selecting the stub (R2, design D4)
# ---------------------------------------------------------------------------


def test_hook_none_raises_instead_of_silently_stubbing(manifest, tmp_path):
    with pytest.raises(ValueError) as exc:
        run_multi_model(manifest_path=manifest, models=["a"], workspace=tmp_path, hook=None)
    # The error must explain the defect, not merely refuse.
    assert "dry-run" in str(exc.value)


def test_omitting_hook_entirely_also_raises(manifest, tmp_path):
    """A default of None is the same defect wearing a different hat."""
    with pytest.raises(ValueError):
        run_multi_model(manifest_path=manifest, models=["a"], workspace=tmp_path)


def test_the_stub_is_still_available_but_must_be_asked_for_by_name(manifest, tmp_path):
    results = run_multi_model(
        manifest_path=manifest, models=["a"], workspace=tmp_path, hook="dry-run"
    )
    assert len(results) == 1
    # Zeros are permitted here — they were requested. But the row must SAY it is a dry run, so a
    # report can never present it as a measurement.
    assert results[0].status == "dry-run"


def test_a_non_callable_non_sentinel_hook_is_a_type_error(manifest, tmp_path):
    with pytest.raises(TypeError):
        run_multi_model(manifest_path=manifest, models=["a"], workspace=tmp_path, hook=42)


# ---------------------------------------------------------------------------
# Scenario: an underivable metric is never reported as zero (R1, R3)
# ---------------------------------------------------------------------------


def test_sandbox_result_defaults_every_metric_to_unmeasured():
    """The default must be 'I did not measure this', not 'I measured zero'."""
    r = SandboxResult(model="subject")
    for field in METRIC_FIELDS:
        assert getattr(r, field) is None, f"{field} defaults to a number instead of None"
    assert set(r.unmeasured) == set(METRIC_FIELDS)
    assert r.measured == ()


def test_measured_and_unmeasured_partition_the_eight_fields():
    r = SandboxResult(model="s", tool_efficiency=0.5, total_tokens=10)
    assert set(r.measured) == {"tool_efficiency", "total_tokens"}
    assert set(r.measured) | set(r.unmeasured) == set(METRIC_FIELDS)
    assert not set(r.measured) & set(r.unmeasured)


# ---------------------------------------------------------------------------
# Scenario: an unavailable subject does not abort the run (R2)
# ---------------------------------------------------------------------------


def test_unreachable_subject_is_unavailable_and_others_complete(manifest, tmp_path):
    def hook(subject, manifest_path, workspace):
        if subject == "gemma-split":
            raise RuntimeError("endpoint refused connection: 127.0.0.1:1234")
        return SandboxResult(model=subject, tool_selection_accuracy=0.8)

    results = run_multi_model(
        manifest_path=manifest,
        models=["incumbent", "gemma-split", "third"],
        workspace=tmp_path,
        hook=hook,
    )

    assert [r.model for r in results] == ["incumbent", "gemma-split", "third"]
    down = results[1]
    assert down.status == "unavailable"
    assert "refused connection" in down.unavailable_reason
    # An unavailable subject reports NO metrics. Zeros here would rank it last on merit rather than
    # excluding it — the exact confusion R3 forbids.
    for field in METRIC_FIELDS:
        assert getattr(down, field) is None, f"unavailable subject reported {field}"
    assert results[0].tool_selection_accuracy == 0.8
    assert results[2].tool_selection_accuracy == 0.8


def test_the_failure_reason_names_the_exception_type(manifest, tmp_path):
    def hook(subject, manifest_path, workspace):
        raise TimeoutError("no response in 30s")

    row = run_multi_model(
        manifest_path=manifest, models=["a"], workspace=tmp_path, hook=hook
    )[0]
    assert "TimeoutError" in row.unavailable_reason


# ---------------------------------------------------------------------------
# Ranking excludes what it could not measure (design D3 — no composite score)
# ---------------------------------------------------------------------------


def test_an_unavailable_subject_is_excluded_from_ranking_not_ranked_last():
    rows = [
        SandboxResult(model="a", tool_selection_accuracy=0.7),
        SandboxResult(model="down", status="unavailable", unavailable_reason="endpoint down"),
        SandboxResult(model="b", tool_selection_accuracy=0.9),
    ]
    out = rank_subjects(rows, primary_metric="tool_selection_accuracy")
    assert [r.model for r in out["ranked"]] == ["b", "a"]
    assert dict(out["excluded"])["down"] == "unavailable"


def test_a_subject_unmeasured_on_the_primary_metric_is_excluded_from_ranking():
    """Scenario: ...then that metric is unmeasured and excluded from ranking."""
    rows = [
        SandboxResult(model="a", tool_selection_accuracy=0.7),
        SandboxResult(model="no-tokens", tool_selection_accuracy=None, total_tokens=500),
    ]
    out = rank_subjects(rows, primary_metric="tool_selection_accuracy")
    assert [r.model for r in out["ranked"]] == ["a"]
    assert dict(out["excluded"])["no-tokens"] == "unmeasured"


def test_ranking_is_deterministic_when_two_subjects_tie():
    rows = [SandboxResult(model="b", tool_efficiency=0.5), SandboxResult(model="a", tool_efficiency=0.5)]
    assert [r.model for r in rank_subjects(rows, primary_metric="tool_efficiency")["ranked"]] == ["a", "b"]


def test_lower_is_better_metrics_can_be_ranked_the_other_way():
    rows = [
        SandboxResult(model="slow", iteration_latency_ms_p95=900.0),
        SandboxResult(model="fast", iteration_latency_ms_p95=100.0),
    ]
    out = rank_subjects(rows, primary_metric="iteration_latency_ms_p95", higher_is_better=False)
    assert [r.model for r in out["ranked"]] == ["fast", "slow"]


def test_ranking_an_unknown_metric_is_refused():
    with pytest.raises(ValueError):
        rank_subjects([], primary_metric="vibes")


# ---------------------------------------------------------------------------
# Report rendering — unmeasured must be legible as unmeasured
# ---------------------------------------------------------------------------


def test_report_renders_unmeasured_rather_than_a_blank_or_a_zero(tmp_path):
    rows = [
        SandboxResult(model="a", iteration_latency_ms_p95=340.0),
        SandboxResult(model="down", status="unavailable", unavailable_reason="endpoint down"),
    ]
    path = write_sandbox_report(rows, manifest_id="m", workspace_path=tmp_path)
    content = path.read_text(encoding="utf-8")
    assert "unmeasured" in content
    assert "unavailable" in content
    assert "endpoint down" in content
    # No stray zeros anywhere — a 0 in this report would read as a result.
    assert "0.0" not in content.replace("340.0", "")


def test_report_still_lists_every_model_and_metric_column(tmp_path):
    rows = [SandboxResult(model="alpha", tool_efficiency=0.5), SandboxResult(model="beta")]
    content = write_sandbox_report(
        rows, manifest_id="m2", workspace_path=tmp_path
    ).read_text(encoding="utf-8")
    assert "alpha" in content and "beta" in content
    for metric in METRIC_FIELDS:
        assert metric in content, f"report lost the {metric} column"


# ---------------------------------------------------------------------------
# R23 / AOS-NFR9 — statelessness survives the change
# ---------------------------------------------------------------------------


def test_ten_consecutive_runs_are_identical(manifest, tmp_path):
    def hook(subject, manifest_path, workspace):
        return SandboxResult(model=subject, tool_efficiency=0.5)

    seen = set()
    for _ in range(10):
        rows = run_multi_model(
            manifest_path=manifest, models=["a", "b"], workspace=tmp_path, hook=hook
        )
        seen.add(tuple((r.model, r.tool_efficiency, r.status) for r in rows))
    assert len(seen) == 1
