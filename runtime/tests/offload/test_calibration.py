"""A0 — judge calibration fixture tests.

Network-free: a fake judge executor is injected via resolve_executor so no
real lemonade endpoint is required here. The real judge run (10/10 against
the live model) is performed by scripts/gates/a0.py against the real endpoint,
per the A0 contract ("judge is calibrated on measured failure modes").
"""

from __future__ import annotations

import json

import pytest

from benny.core.offload import calibration as C


@pytest.fixture
def fake_judge(monkeypatch):
    """Install a deterministic fake judge that scores fixtures the way a
    well-calibrated judge should: high for known-good, low for known-bad."""

    class _FakeExec:
        async def generate(self, prompt, system=None, **kwargs):
            # the calibration prompt embeds the artifact under "## Deliverable";
            # only look at that section so markers can't accidentally match the
            # task intent/acceptance-criteria text above it.
            deliverable = prompt.split("## Deliverable", 1)[-1]
            if "silent failure" in deliverable or "not valid json" in deliverable:
                return json.dumps(
                    {"score": 0.05, "rationale": "known-bad marker present"}
                )
            if "def slugify" not in deliverable or deliverable.count(
                "("
            ) != deliverable.count(")"):
                return json.dumps(
                    {"score": 0.1, "rationale": "incomplete/truncated deliverable"}
                )
            if "mixed\\\\output" in deliverable or "nested:path" in deliverable:
                return json.dumps({"score": 0.1, "rationale": "path-mangled output"})
            if (
                "silently drops" in deliverable
                or "context/window overflow" in deliverable
            ):
                return json.dumps({"score": 0.15, "rationale": "silent truncation"})
            if (
                "TypeError" in deliverable
                or "ValueError" in deliverable
                or "raise" in deliverable
            ):
                return json.dumps(
                    {"score": 0.9, "rationale": "explicit, actionable errors"}
                )
            return json.dumps({"score": 0.85, "rationale": "clean implementation"})

        def count_tokens(self, text):
            return len((text or "").split())

    def _resolve(model_str):
        if model_str == "calib/judge":
            return _FakeExec()
        return None

    monkeypatch.setattr("benny.core.local_executor.resolve_executor", _resolve)


def test_fixture_sets_are_five_and_five():
    assert len(C.KNOWN_GOOD) == 5
    assert len(C.KNOWN_BAD) == 5
    assert all(f.label == "good" for f in C.KNOWN_GOOD)
    assert all(f.label == "bad" for f in C.KNOWN_BAD)


def test_known_bad_covers_the_measured_failure_taxonomy():
    # architecture/REVIEW-longview-cards-2026-07-05.md: invalid/truncated JSON,
    # path-mangled output, context-overflow truncation must all be represented.
    classes = {f.failure_class for f in C.KNOWN_BAD}
    assert "invalid_json" in classes
    assert "truncated" in classes
    assert "path_mangled" in classes
    assert "context_overflow" in classes


@pytest.mark.asyncio
async def test_calibration_scores_all_ten_correctly(fake_judge):
    results = await C.calibrate("calib/judge", threshold=0.8)
    assert len(results) == 10
    incorrect = [r for r in results if not r.correct]
    assert (
        incorrect == []
    ), f"miscalibrated: {[(r.fixture_id, r.score) for r in incorrect]}"


@pytest.mark.asyncio
async def test_score_fixture_reports_expected_vs_predicted(fake_judge):
    good = next(f for f in C.KNOWN_GOOD if f.id == "good-explicit-error")
    v = await C.score_fixture(good, "calib/judge")
    assert v.expected_pass is True
    assert v.predicted_pass is True
    assert v.correct is True

    bad = next(f for f in C.KNOWN_BAD if f.id == "bad-invalid-json-in-comment")
    v2 = await C.score_fixture(bad, "calib/judge")
    assert v2.expected_pass is False
    assert v2.predicted_pass is False
    assert v2.correct is True


@pytest.mark.asyncio
async def test_judge_unavailable_is_honest_not_a_pass(monkeypatch):
    monkeypatch.setattr("benny.core.local_executor.resolve_executor", lambda m: None)
    good = C.KNOWN_GOOD[0]
    v = await C.score_fixture(good, "calib/missing")
    assert v.score is None
    assert v.predicted_pass is False
    assert v.correct is False  # honestly wrong, not silently treated as pass
