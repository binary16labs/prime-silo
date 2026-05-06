"""AOS-NFR3 — benny req end-to-end latency ≤ 2.5 s p95 (LLM mocked).

Red tests — will fail with ModuleNotFoundError until benny/sdlc/requirements.py
is implemented.

NFR3: generate_prd() with a mocked LLM completes in ≤ 2.5 s p95.
      The LLM is mocked via monkeypatch so no network call is made.
"""

from __future__ import annotations

import json
import time

import pytest

from benny.sdlc.requirements import generate_prd

_ITERATIONS = 20
_BUDGET_S = 2.5

_MOCK_PRD: dict = {
    "id": "PRD-LAT-001",
    "title": "Latency Test PRD",
    "features": [
        {
            "id": "F-LAT-001",
            "title": "Latency feature",
            "description": "A feature for the NFR3 latency test",
            "bdd_scenarios": [
                {
                    "id": "BDD-LAT-001",
                    "given": "the system is ready",
                    "when": "a request is submitted",
                    "then": "the response arrives promptly",
                }
            ],
        }
    ],
}

_MOCK_JSON = json.dumps(_MOCK_PRD)


def _mock_caller(model: str, messages: list) -> str:
    """Instant synchronous LLM mock — returns a pre-built PRD JSON."""
    return _MOCK_JSON


# ---------------------------------------------------------------------------
# AOS-NFR3: p95 ≤ 2.5 s
# ---------------------------------------------------------------------------


def test_aos_nfr3_req_p95(monkeypatch):
    """NFR3 primary: generate_prd p95 latency ≤ 2.5 s with mocked LLM (20 iterations)."""
    monkeypatch.setattr("benny.sdlc.requirements._do_call_model", _mock_caller)
    latencies: list[float] = []

    for _ in range(_ITERATIONS):
        t0 = time.perf_counter()
        generate_prd("Build a latency-test widget factory")
        latencies.append(time.perf_counter() - t0)

    latencies.sort()
    p95_idx = max(0, int(len(latencies) * 0.95) - 1)
    p95 = latencies[p95_idx]

    assert p95 < _BUDGET_S, (
        f"AOS-NFR3: p95 latency {p95 * 1000:.1f} ms exceeds "
        f"{_BUDGET_S * 1000:.0f} ms budget"
    )


def test_nfr3_single_call_well_under_budget(monkeypatch):
    """Single generate_prd call with mocked LLM completes well under 2.5 s."""
    monkeypatch.setattr("benny.sdlc.requirements._do_call_model", _mock_caller)

    t0 = time.perf_counter()
    generate_prd("Single latency check")
    elapsed = time.perf_counter() - t0

    assert elapsed < _BUDGET_S, (
        f"Single call took {elapsed * 1000:.1f} ms (budget: {_BUDGET_S * 1000:.0f} ms)"
    )


def test_nfr3_median_latency_under_100ms(monkeypatch):
    """Median latency of generate_prd with mocked LLM must be < 100 ms (sanity check)."""
    monkeypatch.setattr("benny.sdlc.requirements._do_call_model", _mock_caller)
    latencies: list[float] = []

    for _ in range(_ITERATIONS):
        t0 = time.perf_counter()
        generate_prd("Median latency check")
        latencies.append(time.perf_counter() - t0)

    latencies.sort()
    median = latencies[len(latencies) // 2]
    assert median < 0.1, (
        f"Median latency {median * 1000:.1f} ms exceeds 100 ms (mocked LLM — should be near-zero)"
    )
