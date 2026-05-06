"""AOS-F16 — Time-budget and iteration-budget escalation.

test_aos_f16_time_budget_escalates      — check_time_budget raises when elapsed ≥ budget
test_aos_f16_iteration_budget_escalates — check_iteration_budget raises when used ≥ limit
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from benny.sdlc.checkpoint import (
    IterationBudgetExceededError,
    RunCheckpoint,
    TimeBudgetExceededError,
    check_iteration_budget,
    check_time_budget,
)


# ---------------------------------------------------------------------------
# AOS-F16: time_budget_escalates
# ---------------------------------------------------------------------------


def test_aos_f16_time_budget_escalates():
    """check_time_budget raises TimeBudgetExceededError when elapsed ≥ budget."""
    started = (datetime.utcnow() - timedelta(seconds=120)).isoformat()
    ckpt = RunCheckpoint(
        run_id="run-f16-time",
        started_at=started,
        time_budget_s=60.0,   # 60 s budget; 120 s elapsed
    )
    with pytest.raises(TimeBudgetExceededError):
        check_time_budget(ckpt)


def test_f16_time_budget_ok_when_under():
    """check_time_budget does NOT raise when elapsed < budget."""
    started = (datetime.utcnow() - timedelta(seconds=10)).isoformat()
    ckpt = RunCheckpoint(
        run_id="run-f16-time-ok",
        started_at=started,
        time_budget_s=3600.0,  # 1-hour budget; only 10 s elapsed
    )
    check_time_budget(ckpt)   # must not raise


def test_f16_time_budget_no_budget_is_ok():
    """check_time_budget is a no-op when time_budget_s is None."""
    ckpt = RunCheckpoint(run_id="run-f16-nolimit")
    check_time_budget(ckpt)   # must not raise


def test_f16_time_budget_no_started_at_is_ok():
    """check_time_budget is a no-op when started_at is None (budget not yet active)."""
    ckpt = RunCheckpoint(run_id="run-f16-nostart", time_budget_s=60.0)
    check_time_budget(ckpt)   # must not raise


def test_f16_time_budget_error_message_contains_elapsed():
    """The error message should mention the elapsed time for operator diagnostics."""
    started = (datetime.utcnow() - timedelta(seconds=200)).isoformat()
    ckpt = RunCheckpoint(run_id="run-f16-msg", started_at=started, time_budget_s=100.0)
    with pytest.raises(TimeBudgetExceededError, match=r"\d+"):
        check_time_budget(ckpt)


# ---------------------------------------------------------------------------
# AOS-F16: iteration_budget_escalates
# ---------------------------------------------------------------------------


def test_aos_f16_iteration_budget_escalates():
    """check_iteration_budget raises IterationBudgetExceededError when used ≥ limit."""
    ckpt = RunCheckpoint(
        run_id="run-f16-iter",
        iteration_budget=5,
        iterations_used=5,
    )
    with pytest.raises(IterationBudgetExceededError):
        check_iteration_budget(ckpt)


def test_f16_iteration_budget_escalates_when_over():
    """Also raises when used > limit (overflow guard)."""
    ckpt = RunCheckpoint(
        run_id="run-f16-over",
        iteration_budget=3,
        iterations_used=99,
    )
    with pytest.raises(IterationBudgetExceededError):
        check_iteration_budget(ckpt)


def test_f16_iteration_budget_ok_when_under():
    """check_iteration_budget does NOT raise when used < limit."""
    ckpt = RunCheckpoint(
        run_id="run-f16-iter-ok",
        iteration_budget=10,
        iterations_used=4,
    )
    check_iteration_budget(ckpt)   # must not raise


def test_f16_iteration_budget_none_is_ok():
    """check_iteration_budget is a no-op when iteration_budget is None."""
    ckpt = RunCheckpoint(run_id="run-f16-iter-none", iterations_used=999)
    check_iteration_budget(ckpt)   # must not raise


def test_f16_iteration_budget_error_message_contains_counts():
    """Error message must mention used and limit for operator diagnostics."""
    ckpt = RunCheckpoint(run_id="run-f16-iter-msg", iteration_budget=5, iterations_used=5)
    with pytest.raises(IterationBudgetExceededError, match=r"5"):
        check_iteration_budget(ckpt)
