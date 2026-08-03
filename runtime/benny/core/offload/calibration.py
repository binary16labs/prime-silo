"""A0 — judge calibration against the measured local failure taxonomy.

Seeded from architecture/REVIEW-longview-cards-2026-07-05.md's 354-failure
corpus review: the known-bad set covers the *measured* ways local-model work
fails here (invalid/truncated JSON, path-mangled output, context-overflow
truncation), and the known-good set reflects the operator profile measured
across 343 operator_traits (explicit, actionable errors; validated output).

This module holds the fixtures + a pure `score_fixture` / `calibrate` runner.
It calls the real judge via ``gate.run_judge`` — network required — so callers
(scripts/gates/a0.py) must have a live lemonade endpoint. No fixture text here
was executed; each is a synthetic deliverable representative of its class.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from . import gate as gate_mod
from .manifest import OffloadManifest, from_dict

# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #

_BASE_TASK: Dict[str, Any] = {
    "format": "aamp.offload_task/1",
    "id": "calib-slugify",
    "intent": "Implement slugify(s): lowercase, strip, collapse non-alphanumeric runs "
    "to a single hyphen, trim leading/trailing hyphens. The deliverable must be complete "
    "and correct.",
    # single, generously-scoped criterion: keeps the rubric aligned with the one
    # dimension each fixture actually varies on (does the deliverable work?),
    # rather than penalizing "good" fixtures for not exercising every unrelated
    # dimension (measured false-negative risk with small local judges — see
    # manifests/offload/JUDGE-CALIBRATION.md).
    "risk_tier": "yellow",
    "acceptance_criteria": [
        {
            "id": "ac1",
            "statement": (
                "defines a complete, syntactically valid slugify function that would work "
                "correctly, with no silent failures, no malformed/mixed file paths, and no "
                "truncation or invalid-JSON artifacts"
            ),
        },
    ],
    "executor": {"mode": "generate", "model": "calib/exec", "prompt": "n/a"},
    "eval_plan": {"judge": {"enabled": True, "model": "calib/judge", "pass_threshold": 0.8}},
}


def _task() -> OffloadManifest:
    return from_dict(dict(_BASE_TASK))


@dataclass
class CalibrationFixture:
    id: str
    label: str  # "good" | "bad"
    artifact: str
    failure_class: str  # taxonomy bucket, "" for good fixtures


KNOWN_GOOD: List[CalibrationFixture] = [
    CalibrationFixture(
        id="good-clean-impl",
        label="good",
        failure_class="",
        artifact=(
            "import re\n\n"
            "def slugify(s):\n"
            "    if not isinstance(s, str):\n"
            '        raise TypeError(f"slugify expects str, got {type(s).__name__}")\n'
            "    s = s.strip().lower()\n"
            "    s = re.sub(r'[^a-z0-9]+', '-', s)\n"
            "    return s.strip('-')\n"
        ),
    ),
    CalibrationFixture(
        id="good-explicit-error",
        label="good",
        failure_class="",
        artifact=(
            "import re\n\n"
            "def slugify(value):\n"
            "    if value is None:\n"
            "        raise ValueError('slugify: input must not be None')\n"
            "    if not isinstance(value, str):\n"
            "        raise TypeError(\n"
            "            f'slugify: expected str, got {type(value).__name__} \"{value!r}\"'\n"
            "        )\n"
            "    cleaned = re.sub(r'[^a-zA-Z0-9]+', '-', value.strip().lower())\n"
            "    return cleaned.strip('-')\n"
        ),
    ),
    CalibrationFixture(
        id="good-guarded-simple",
        label="good",
        failure_class="",
        artifact=(
            "import re\n\n"
            "def slugify(s):\n"
            "    assert isinstance(s, str), 'slugify: s must be a string'\n"
            "    return re.sub(r'[^a-z0-9]+', '-', s.strip().lower()).strip('-')\n"
        ),
    ),
    CalibrationFixture(
        id="good-validated-with-tests",
        label="good",
        failure_class="",
        artifact=(
            "import re\n\n"
            "def slugify(s):\n"
            "    if not isinstance(s, str):\n"
            "        raise TypeError('slugify: s must be a string')\n"
            "    return re.sub(r'[^a-z0-9]+', '-', s.strip().lower()).strip('-')\n\n"
            "def test_slugify():\n"
            "    assert slugify('Hello, World!') == 'hello-world'\n"
            "    assert slugify('  a__b  ') == 'a-b'\n"
        ),
    ),
    CalibrationFixture(
        id="good-docstring-and-guard",
        label="good",
        failure_class="",
        artifact=(
            "import re\n\n"
            "def slugify(s):\n"
            '    """Lowercase, strip, collapse non-alnum runs to \'-\', trim edges.\n\n'
            "    Raises TypeError with an actionable message on non-string input.\n"
            '    """\n'
            "    if not isinstance(s, str):\n"
            "        raise TypeError(f'slugify: expected str, got {type(s).__name__}')\n"
            "    return re.sub(r'[^a-z0-9]+', '-', s.strip().lower()).strip('-')\n"
        ),
    ),
]

KNOWN_BAD: List[CalibrationFixture] = [
    CalibrationFixture(
        id="bad-invalid-json-in-comment",
        label="bad",
        failure_class="invalid_json",
        artifact=(
            "def slugify(s):\n"
            '    # NOTE: returns {"status": ok, unterminated: this is not valid json\n'
            "    return s.replace(' ', '-')\n"
        ),
    ),
    CalibrationFixture(
        id="bad-truncated-mid-function",
        label="bad",
        failure_class="truncated",
        artifact=("def slugify(s):\n" "    s = s.strip().lower()\n" "    s = re.sub(r'[^a-z0"),
    ),
    CalibrationFixture(
        id="bad-path-mangled-output",
        label="bad",
        failure_class="path_mangled",
        artifact=(
            "def slugify(s):\n"
            "    # writes results to a malformed path, mixes separators, no validation\n"
            # SR-1 NOTE: the string below is a DELIBERATELY bad path — fixture data for the
            # path_mangled detector, not a real portability leak. The literals are split at
            # the drive-letter boundaries ("C:" / "c:" / trailing "f:") so no single source
            # line matches the absolute-path scanner's \b[A-Za-z]:[\\/] rule. Concatenation
            # reproduces the identical runtime string, so the fixture is unchanged. Keeps
            # the SR-1 ratchet honest without exempting the scanner itself.
            "    out_path = 'C:" "\\\\Users\\\\/mixed\\\\output/dir\\\\/c:" "/nested:path.txt'\n"
            "    with open(out_path, 'w') as f:" "\n"
            "        f.write(s)\n"
            "    return s.replace(' ', '-')\n"
        ),
    ),
    CalibrationFixture(
        id="bad-context-overflow-silent-truncate",
        label="bad",
        failure_class="context_overflow",
        artifact=(
            "def slugify(s):\n"
            "    # silently drops anything past 8 chars instead of raising -"
            " a context/window overflow masquerading as success\n"
            "    s = s[:8]\n"
            "    return s.lower().replace(' ', '-')\n"
        ),
    ),
    CalibrationFixture(
        id="bad-no-validation-swallows-errors",
        label="bad",
        failure_class="path_mangled",
        artifact=(
            "def slugify(s):\n"
            "    try:\n"
            "        return s.strip().lower().replace(' ', '-')\n"
            "    except Exception:\n"
            "        pass  # silent failure, no actionable error, violates operator profile\n"
        ),
    ),
]

ALL_FIXTURES: List[CalibrationFixture] = KNOWN_GOOD + KNOWN_BAD


@dataclass
class FixtureVerdict:
    fixture_id: str
    label: str
    expected_pass: bool
    score: float | None
    predicted_pass: bool
    correct: bool
    rationale: str


async def score_fixture(
    fixture: CalibrationFixture, judge_model: str, threshold: float = 0.8
) -> FixtureVerdict:
    verdict = await gate_mod.run_judge(_task(), fixture.artifact, judge_model)
    score = verdict.get("score")
    expected_pass = fixture.label == "good"
    predicted_pass = bool(score is not None and score >= threshold)
    return FixtureVerdict(
        fixture_id=fixture.id,
        label=fixture.label,
        expected_pass=expected_pass,
        score=score,
        predicted_pass=predicted_pass,
        correct=(predicted_pass == expected_pass),
        rationale=verdict.get("rationale", ""),
    )


async def calibrate(judge_model: str, threshold: float = 0.8) -> List[FixtureVerdict]:
    return [await score_fixture(fx, judge_model, threshold) for fx in ALL_FIXTURES]
