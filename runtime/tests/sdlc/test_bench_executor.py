"""P6 — the executor hook: where the zeros end.

Red tests. They fail until `benny/sdlc/bench_executor.py` exists.

P1 established the schema (`unmeasured` is `None`, never `0.0`). This module has to fill it in
honestly: derive what the G0 run-event stream actually supports and admit everything else. Every
test below is written so that inventing a number — a partial sum presented as a total, a `1.0`
adherence score from zero evaluations — turns it red.

Scenarios ↔ delivery/tasks/P6.md gherkin.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.sdlc.bench_executor import (
    PERSONAS,
    SubjectUnavailable,
    derive_metrics,
    events_path,
    make_bench_hook,
    percentile,
    read_events,
    resolve_assignment,
    subject_model_for,
)
from benny.sdlc.sandbox_runner import METRIC_FIELDS, run_multi_model

# ---------------------------------------------------------------------------
# Fixtures — a roster shaped exactly like SOLUTION-model-plurality.md 5.1
# ---------------------------------------------------------------------------

ROSTER = {
    "schema_version": "1.0",
    "kind": "model_roster",
    "id": "roster-test",
    "models": [
        {"label": "qwen-house-v3", "id": "house/qwen2.5-coder-tuned",
         "tier": ["planner", "architect", "implementer", "reviewer"]},
        {"label": "gemma-e4b", "id": "lemonade/Gemma-4-E4B-it-GGUF",
         "tier": ["reviewer", "judge"]},
        {"label": "gemma-12b", "id": "lemonade/gemma-4-12b",
         "tier": ["implementer", "architect"]},
    ],
    "subjects": [
        {"label": "incumbent", "assign": {"*": "qwen-house-v3"}},
        {"label": "gemma-split", "assign": {
            "implementer": "gemma-12b", "architect": "gemma-12b",
            "reviewer": "gemma-e4b", "planner": "qwen-house-v3"}},
    ],
    "primary_metric": "tool_selection_accuracy",
}


def _orchestrator_events():
    """Exactly what pypes/orchestrator.py emits TODAY. Not a contrived fixture — a transcription
    of its `_safe_emit(events.node_finished, node_id=..., attempt=1, duration_ms=...)` call, which
    passes no tokens_in, no tokens_out and no model."""
    return [
        {"event": "run_started", "run_id": "r1", "manifest_id": "m", "nodes": ["a", "b"]},
        {"event": "node_started", "run_id": "r1", "node_id": "a", "attempt": 1},
        {"event": "node_finished", "run_id": "r1", "node_id": "a", "attempt": 1, "duration_ms": 120},
        {"event": "node_started", "run_id": "r1", "node_id": "b", "attempt": 1},
        {"event": "node_finished", "run_id": "r1", "node_id": "b", "attempt": 1, "duration_ms": 340},
        {"event": "run_finished", "run_id": "r1", "status": "ok", "duration_ms": 460},
    ]


def _events_with_tokens():
    ev = _orchestrator_events()
    for e in ev:
        if e["event"] == "node_finished":
            e["tokens_in"], e["tokens_out"] = 400, 100
    return ev


# ---------------------------------------------------------------------------
# THE HONEST CLAIM: two of eight, against the orchestrator as it stands
# ---------------------------------------------------------------------------


def test_against_todays_orchestrator_exactly_two_of_eight_metrics_are_derivable():
    """The contract requires this asserted, not papered over. If this starts failing because MORE
    is measured, that is good news and the number here should rise — but it must never rise because
    something began inventing values."""
    m = derive_metrics(_orchestrator_events())
    measured = {k for k, v in m.items() if v is not None}
    assert measured == {"iteration_latency_ms_p95", "loop_count_p95"}, measured
    assert len(METRIC_FIELDS) - len(measured) == 6


def test_the_orchestrator_really_does_omit_token_fields():
    """Guard the premise itself. If the orchestrator starts emitting tokens this test fails, and
    whoever changed it is told to widen the derivation rather than leave free metrics on the floor."""
    src = Path(__file__).resolve().parents[2] / "benny" / "pypes" / "orchestrator.py"
    text = src.read_text(encoding="utf-8")
    assert "events.node_finished" in text, "the orchestrator no longer emits node_finished"
    call = text[text.index("events.node_finished"):][:200]
    assert "tokens_in" not in call, "orchestrator now emits tokens — widen derive_metrics"


# ---------------------------------------------------------------------------
# Scenario: partial token reporting is unmeasured, not a partial sum
# ---------------------------------------------------------------------------


def test_partial_token_reporting_is_unmeasured_not_a_partial_sum():
    """A sum over the subset that happened to report, presented as the run total, is a smaller lie
    rather than a truth."""
    ev = _events_with_tokens()
    del ev[2]["tokens_in"]  # one node stops reporting
    assert derive_metrics(ev)["total_tokens"] is None


def test_tokens_are_summed_when_every_node_reports_them():
    assert derive_metrics(_events_with_tokens())["total_tokens"] == 1000  # (400+100) * 2


def test_token_dependent_metrics_are_unmeasured_when_tokens_are():
    m = derive_metrics(_orchestrator_events())
    for field in ("total_tokens", "context_efficiency", "total_cost"):
        assert m[field] is None, f"{field} was fabricated as {m[field]!r}"


def test_cost_needs_a_price_book_and_is_unmeasured_without_one():
    """Local inference has no meaningful per-token price. Inventing one would put a fabricated
    number into a governance record."""
    assert derive_metrics(_events_with_tokens())["total_cost"] is None
    ev = _events_with_tokens()
    for e in ev:
        if e["event"] == "node_finished":
            e["model"] = "house/qwen"
    priced = derive_metrics(ev, price_book={"house/qwen": 2.0})
    assert priced["total_cost"] == pytest.approx(2.0)  # 1000 tokens / 1000 * 2.0


def test_cost_is_unmeasured_when_only_some_nodes_have_a_price():
    ev = _events_with_tokens()
    ev[2]["model"] = "house/qwen"  # only one of the two finished nodes is priced
    assert derive_metrics(ev, price_book={"house/qwen": 2.0})["total_cost"] is None


# ---------------------------------------------------------------------------
# Absence of evidence is not evidence of compliance
# ---------------------------------------------------------------------------


def test_zero_gate_evaluations_is_unmeasured_not_perfect_adherence():
    """_dry_run_stub reported constraint_adherence=1.0 — a perfect score from zero evidence."""
    assert derive_metrics(_orchestrator_events())["constraint_adherence"] is None


def test_constraint_adherence_is_derived_when_gates_actually_ran():
    ev = _orchestrator_events() + [
        {"event": "node_progress", "run_id": "r1", "node_id": "a",
         "detail": {"gate_evaluations": 8, "gate_rejections": 2}},
    ]
    assert derive_metrics(ev)["constraint_adherence"] == pytest.approx(0.75)


def test_an_empty_event_stream_measures_nothing_at_all():
    m = derive_metrics([])
    assert all(m[f] is None for f in METRIC_FIELDS), m


def test_latency_and_loops_come_from_the_stream_not_from_a_default():
    m = derive_metrics(_orchestrator_events())
    assert m["iteration_latency_ms_p95"] == 340.0
    assert m["loop_count_p95"] == 1
    retried = _orchestrator_events() + [
        {"event": "node_retried", "run_id": "r1", "node_id": "a", "attempt": 3}
    ]
    assert derive_metrics(retried)["loop_count_p95"] == 3


# ---------------------------------------------------------------------------
# Tool metrics need a frozen rubric — there is nothing to be accurate against
# ---------------------------------------------------------------------------


def test_tool_metrics_need_a_rubric_and_are_unmeasured_without_one():
    ev = _orchestrator_events() + [
        {"event": "node_progress", "run_id": "r1", "node_id": "a", "detail": {"tool": "write_file"}},
        {"event": "node_progress", "run_id": "r1", "node_id": "b", "detail": {"tool": "read_file"}},
    ]
    assert derive_metrics(ev)["tool_selection_accuracy"] is None
    scored = derive_metrics(
        ev, rubric={"expected_ops": {"a": "write_file", "b": "grep"}, "min_steps": 2}
    )
    assert scored["tool_selection_accuracy"] == pytest.approx(0.5)
    assert scored["tool_efficiency"] == pytest.approx(1.0)


def test_a_rubric_with_no_matching_nodes_leaves_accuracy_unmeasured():
    ev = _orchestrator_events() + [
        {"event": "node_progress", "run_id": "r1", "node_id": "a", "detail": {"tool": "write_file"}},
    ]
    assert derive_metrics(ev, rubric={"expected_ops": {"zzz": "grep"}})["tool_selection_accuracy"] is None


# ---------------------------------------------------------------------------
# Roster resolution — through resolve_model(), never a second resolver
# ---------------------------------------------------------------------------


def test_wildcard_subject_assigns_one_model_to_every_persona():
    assign = resolve_assignment(ROSTER, "incumbent")
    assert set(assign.values()) == {"house/qwen2.5-coder-tuned"}
    assert set(assign) >= set(PERSONAS)


def test_split_subject_maps_each_persona_to_its_own_model():
    """Scenario: a heterogeneous subject resolves per persona."""
    assign = resolve_assignment(ROSTER, "gemma-split")
    assert assign["implementer"] == "lemonade/gemma-4-12b"
    assert assign["reviewer"] == "lemonade/Gemma-4-E4B-it-GGUF"
    assert assign["planner"] == "house/qwen2.5-coder-tuned"


def test_subject_model_goes_through_the_existing_resolver():
    assert subject_model_for(ROSTER, "gemma-split", "reviewer") == "lemonade/Gemma-4-E4B-it-GGUF"


def test_unknown_subject_and_unknown_model_label_are_both_refused():
    with pytest.raises(KeyError):
        resolve_assignment(ROSTER, "no-such-subject")
    broken = {"models": [], "subjects": [{"label": "s", "assign": {"*": "ghost"}}]}
    with pytest.raises(KeyError):
        resolve_assignment(broken, "s")


# ---------------------------------------------------------------------------
# The hook end-to-end, with an injected driver
# ---------------------------------------------------------------------------


def test_bench_hook_produces_a_real_result_from_a_real_event_stream(tmp_path):
    run_dir = tmp_path / "runs" / "run-1"
    run_dir.mkdir(parents=True)
    (run_dir / "events.jsonl").write_text(
        "\n".join(json.dumps(e) for e in _events_with_tokens()), encoding="utf-8"
    )

    seen = {}

    def drive(subject, assignment, manifest_path, workspace):
        seen[subject] = assignment
        return "run-1"

    hook = make_bench_hook(ROSTER, drive=drive, runs_root=tmp_path)
    result = hook("gemma-split", tmp_path / "m.json", tmp_path)

    assert result.model == "gemma-split"
    assert result.run_id == "run-1"
    assert result.total_tokens == 1000
    assert result.iteration_latency_ms_p95 == 340.0
    # the driver was handed the resolved per-persona assignment, not a bare label
    assert seen["gemma-split"]["implementer"] == "lemonade/gemma-4-12b"


def test_the_hook_plugs_into_run_multi_model_with_no_signature_change(tmp_path):
    """Design D2 — the existing `models: List[str]` carries subject labels."""
    manifest = tmp_path / "m.json"
    manifest.write_text('{"id": "m"}', encoding="utf-8")
    hook = make_bench_hook(ROSTER, drive=lambda s, a, m, w: None, runs_root=tmp_path)
    rows = run_multi_model(
        manifest_path=manifest,
        models=["incumbent", "gemma-split"],
        workspace=tmp_path,
        hook=hook,
    )
    assert [r.model for r in rows] == ["incumbent", "gemma-split"]
    assert all(r.status == "ok" for r in rows)
    assert all(set(r.unmeasured) == set(METRIC_FIELDS) for r in rows)


def test_an_unreachable_subject_propagates_for_the_runner_to_record(tmp_path):
    def drive(subject, assignment, manifest_path, workspace):
        raise SubjectUnavailable("no engine on 127.0.0.1:1234")

    hook = make_bench_hook(ROSTER, drive=drive, runs_root=tmp_path)
    with pytest.raises(SubjectUnavailable):
        hook("incumbent", tmp_path / "m.json", tmp_path)


def test_a_missing_event_stream_measures_nothing_rather_than_zero(tmp_path):
    hook = make_bench_hook(
        ROSTER, drive=lambda s, a, m, w: "run-that-never-wrote", runs_root=tmp_path
    )
    result = hook("incumbent", tmp_path / "m.json", tmp_path)
    for field in METRIC_FIELDS:
        assert getattr(result, field) is None, f"{field} invented from a missing stream"


# ---------------------------------------------------------------------------
# Stream reading and the percentile primitive
# ---------------------------------------------------------------------------


def test_a_torn_final_line_is_skipped_not_fatal(tmp_path):
    run_dir = tmp_path / "runs" / "torn"
    run_dir.mkdir(parents=True)
    good = "\n".join(json.dumps(e) for e in _events_with_tokens())
    (run_dir / "events.jsonl").write_text(good + '\n{"event": "node_fin', encoding="utf-8")
    assert len(read_events(run_dir / "events.jsonl")) == 6


def test_a_missing_stream_reads_as_empty_not_as_an_error(tmp_path):
    assert read_events(tmp_path / "nope.jsonl") == []


def test_events_path_matches_where_RunEventStream_writes(tmp_path):
    assert events_path("abc", tmp_path) == tmp_path / "runs" / "abc" / "events.jsonl"


def test_percentile_is_nearest_rank_and_deterministic():
    assert percentile([10, 20, 30, 40, 50], 95.0) == 50
    assert percentile([5], 95.0) == 5
    assert percentile([], 95.0) is None
    assert percentile([3, 1, 2], 50.0) == 2


def test_percentile_of_nothing_is_not_zero():
    """p95 of an empty sample is unmeasured. Returning 0.0 here is the whole defect in miniature."""
    assert percentile([]) is None
