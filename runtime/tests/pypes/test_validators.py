"""Tests for the engine-agnostic validation runner."""

from __future__ import annotations

import pandas as pd
import pytest

from benny.pypes.engines.pandas_impl import PandasEngine
from benny.pypes.models import ValidationSpec
from benny.pypes.validators import run_validations


@pytest.fixture
def engine():
    return PandasEngine()


@pytest.fixture
def trades_df():
    return pd.DataFrame(
        [
            {"trade_id": "T1", "notional": 1_000_000.0, "ccy": "USD"},
            {"trade_id": "T2", "notional": 250_000_000.0, "ccy": "USD"},
            {"trade_id": "T3", "notional": 5_000_000.0, "ccy": "USD"},
        ]
    )


def test_passes_when_no_spec(engine, trades_df):
    r = run_validations(engine, trades_df, None)
    assert r.status == "PASS"
    assert r.row_count == 3
    assert r.column_count == 3


def test_completeness_fails_on_nulls(engine):
    df = pd.DataFrame([{"trade_id": "T1", "notional": 100.0}, {"trade_id": None, "notional": 200.0}])
    spec = ValidationSpec(completeness=["trade_id"])
    r = run_validations(engine, df, spec)
    assert r.status == "FAIL"
    assert any(c["check"] == "completeness" and c["status"] == "FAILED" for c in r.checks)


def test_uniqueness_fails_on_duplicates(engine):
    df = pd.DataFrame([{"trade_id": "T1"}, {"trade_id": "T1"}])
    spec = ValidationSpec(uniqueness=["trade_id"])
    r = run_validations(engine, df, spec)
    assert r.status == "FAIL"
    assert any(c["check"] == "uniqueness" and c["status"] == "FAILED" for c in r.checks)


def test_threshold_max_breach(engine, trades_df):
    spec = ValidationSpec(thresholds=[{"field": "notional", "max": 100_000_000}])
    r = run_validations(engine, trades_df, spec)
    assert r.status == "FAIL"
    threshold_check = next(c for c in r.checks if c["check"] == "threshold")
    assert threshold_check["status"] == "FAILED"
    assert threshold_check["expected"] == {"max": 100_000_000}


def test_threshold_min_breach(engine):
    df = pd.DataFrame([{"value": -5}, {"value": 10}])
    spec = ValidationSpec(thresholds=[{"field": "value", "min": 0}])
    r = run_validations(engine, df, spec)
    assert r.status == "FAIL"


def test_threshold_within_range_passes(engine, trades_df):
    spec = ValidationSpec(thresholds=[{"field": "notional", "max": 1_000_000_000}])
    r = run_validations(engine, trades_df, spec)
    assert r.status == "PASS"


def test_fingerprint_is_stable_across_runs(engine, trades_df):
    r1 = run_validations(engine, trades_df, None)
    r2 = run_validations(engine, trades_df.copy(), None)
    assert r1.fingerprint == r2.fingerprint
