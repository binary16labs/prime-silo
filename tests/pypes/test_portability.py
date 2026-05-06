"""SR-1 portability — pypes manifests must not embed absolute paths."""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEMO = REPO / "manifests" / "templates" / "financial_risk_pipeline.json"

# Same auditor signature as tests/portability — Windows + POSIX absolute paths.
_ABS = re.compile(r"^(?:[A-Za-z]:[\\/]|/(?!\$\{)[A-Za-z])")


def _walk(value, path=""):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _walk(v, f"{path}[{i}]")
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _walk(v, f"{path}.{k}" if path else k)


def test_demo_manifest_has_no_absolute_paths():
    raw = json.loads(DEMO.read_text(encoding="utf-8"))
    offenders = []
    for path, value in _walk(raw):
        if _ABS.match(value):
            offenders.append((path, value))
    assert not offenders, f"absolute paths in pypes demo: {offenders}"


def test_demo_manifest_uses_benny_home_token():
    raw = json.loads(DEMO.read_text(encoding="utf-8"))
    text = json.dumps(raw)
    # The trades source must be parameterised, not hard-coded.
    assert "${benny_home}" in text or "${BENNY_HOME}" in text


def test_demo_data_csv_is_committed():
    csv = REPO / "manifests" / "templates" / "data" / "trades_sample.csv"
    assert csv.exists(), "demo csv missing — pipeline cannot run on a clean checkout"
    header = csv.read_text(encoding="utf-8").splitlines()[0]
    for col in ("trade_id", "counterparty_id", "notional", "ccy", "fx_rate", "status"):
        assert col in header
