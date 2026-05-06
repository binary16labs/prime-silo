"""AOS-001 Phase 7 — AOS-F3: Quality gate runner + AOS-OBS3: SSE event schemas.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/togaf.py
is implemented.

F3:   run_quality_gate() supports all 5 check kinds (linter, typechecker, bdd,
      schema, custom).  on_failure="halt" raises QualityGateError immediately.
      on_failure="retry"/"escalate" returns a QualityGateResult with the
      appropriate action field set.

OBS3: SSE event dicts emitted by build_quality_gate_event() contain all
      required fields: event, gate_kind, gate_command, exit_code, output,
      on_failure.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace
from typing import Any

import pytest

from benny.sdlc.contracts import QualityGate
from benny.sdlc.togaf import (
    QualityGateError,
    QualityGateResult,
    build_quality_gate_event,
    run_quality_gate,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ALL_KINDS = ("linter", "typechecker", "bdd", "schema", "custom")


def _fake_proc(returncode: int, stdout: str = "", stderr: str = "") -> Any:
    """Build a minimal subprocess.CompletedProcess-like object."""
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _patch_subprocess(monkeypatch, returncode: int, stdout: str = "", stderr: str = "") -> None:
    """Monkeypatch subprocess.run so no real commands are executed."""
    monkeypatch.setattr(
        "subprocess.run",
        lambda *args, **kwargs: _fake_proc(returncode, stdout, stderr),
    )


# ---------------------------------------------------------------------------
# AOS-F3: quality gate kinds
# ---------------------------------------------------------------------------


class TestQualityGateKinds:
    """AOS-F3: all 5 gate kinds are valid QualityGate instances."""

    def test_aos_f3_quality_gate_kinds(self):
        """F3 primary: QualityGate accepts all five required check kinds."""
        for kind in _ALL_KINDS:
            gate = QualityGate(kind=kind, command="echo check")
            assert gate.kind == kind

    def test_f3_default_on_failure_is_halt(self):
        """on_failure defaults to 'halt' (safest policy)."""
        gate = QualityGate(kind="linter", command="ruff check .")
        assert gate.on_failure == "halt"

    def test_f3_all_on_failure_values_valid(self):
        """on_failure accepts halt, retry, and escalate."""
        for policy in ("halt", "retry", "escalate"):
            gate = QualityGate(kind="custom", command="true", on_failure=policy)
            assert gate.on_failure == policy

    def test_f3_timeout_defaults_to_120s(self):
        """Default timeout is 120 seconds."""
        gate = QualityGate(kind="typechecker", command="pyright")
        assert gate.timeout_s == 120

    def test_f3_invalid_kind_rejected(self):
        """An unrecognised kind raises a ValidationError."""
        with pytest.raises(Exception):  # pydantic.ValidationError
            QualityGate(kind="unknown_kind", command="echo")


# ---------------------------------------------------------------------------
# AOS-F3: quality gate runner behaviour
# ---------------------------------------------------------------------------


class TestQualityGateRunner:
    """AOS-F3: run_quality_gate enforces on_failure policies."""

    def test_f3_pass_on_success(self, monkeypatch):
        """Gate passes when command exits with code 0."""
        _patch_subprocess(monkeypatch, returncode=0, stdout="All checks passed")
        gate = QualityGate(kind="linter", command="ruff check .")
        result = run_quality_gate(gate)
        assert result.passed is True
        assert result.exit_code == 0
        assert result.action == "pass"

    def test_aos_f3_halt_on_failure(self, monkeypatch):
        """F3 primary: on_failure='halt' raises QualityGateError on non-zero exit."""
        _patch_subprocess(monkeypatch, returncode=1, stderr="E: style violation")
        gate = QualityGate(kind="linter", command="ruff check .", on_failure="halt")
        with pytest.raises(QualityGateError):
            run_quality_gate(gate)

    def test_f3_retry_on_failure(self, monkeypatch):
        """on_failure='retry' returns result with action='retry', no exception."""
        _patch_subprocess(monkeypatch, returncode=1)
        gate = QualityGate(kind="typechecker", command="pyright", on_failure="retry")
        result = run_quality_gate(gate)
        assert result.passed is False
        assert result.action == "retry"

    def test_f3_escalate_on_failure(self, monkeypatch):
        """on_failure='escalate' returns result with action='escalate', no exception."""
        _patch_subprocess(monkeypatch, returncode=2)
        gate = QualityGate(kind="bdd", command="pytest -k bdd", on_failure="escalate")
        result = run_quality_gate(gate)
        assert result.passed is False
        assert result.action == "escalate"

    def test_f3_halt_error_message_mentions_command(self, monkeypatch):
        """QualityGateError message includes the gate command for debuggability."""
        _patch_subprocess(monkeypatch, returncode=1, stderr="oops")
        gate = QualityGate(kind="schema", command="jsonschema validate .", on_failure="halt")
        with pytest.raises(QualityGateError, match="jsonschema validate"):
            run_quality_gate(gate)

    def test_f3_result_carries_gate_reference(self, monkeypatch):
        """QualityGateResult.gate references the original QualityGate object."""
        _patch_subprocess(monkeypatch, returncode=0)
        gate = QualityGate(kind="custom", command="make check")
        result = run_quality_gate(gate)
        assert result.gate is gate

    def test_f3_all_kinds_run_without_error(self, monkeypatch):
        """All 5 gate kinds can be dispatched without raising on success."""
        _patch_subprocess(monkeypatch, returncode=0, stdout="ok")
        for kind in _ALL_KINDS:
            gate = QualityGate(kind=kind, command="echo ok")
            result = run_quality_gate(gate)
            assert result.passed is True, f"Kind {kind!r} failed unexpectedly"

    def test_f3_output_included_in_result(self, monkeypatch):
        """stdout and stderr are captured and available in result.output."""
        _patch_subprocess(monkeypatch, returncode=1, stdout="out line", stderr="err line")
        gate = QualityGate(kind="linter", command="ruff check .", on_failure="retry")
        result = run_quality_gate(gate)
        assert "out line" in result.output or "err line" in result.output

    def test_f3_timeout_expired_returns_failure(self, monkeypatch):
        """A TimeoutExpired exception from subprocess is handled gracefully."""
        def raise_timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="slow_cmd", timeout=1)

        monkeypatch.setattr("subprocess.run", raise_timeout)
        gate = QualityGate(kind="custom", command="slow_cmd", on_failure="escalate", timeout_s=1)
        result = run_quality_gate(gate)
        assert result.passed is False
        assert result.action == "escalate"


# ---------------------------------------------------------------------------
# AOS-OBS3: SSE event schemas
# ---------------------------------------------------------------------------


class TestSseEventSchemas:
    """AOS-OBS3: SSE events for quality gate violations have required fields."""

    def test_aos_obs3_sse_event_schemas(self):
        """OBS3 primary: quality_gate_violation event has all required schema fields."""
        gate = QualityGate(kind="linter", command="ruff check .", on_failure="escalate")
        event = build_quality_gate_event(
            "quality_gate_violation",
            gate,
            exit_code=1,
            output="E: style violation",
        )
        # Required schema fields
        assert event["event"] == "quality_gate_violation"
        assert event["gate_kind"] == "linter"
        assert event["gate_command"] == "ruff check ."
        assert event["exit_code"] == 1
        assert "output" in event
        assert event["on_failure"] == "escalate"

    def test_obs3_quality_gate_pass_event(self):
        """quality_gate_pass event has the correct schema."""
        gate = QualityGate(kind="bdd", command="pytest -k bdd")
        event = build_quality_gate_event("quality_gate_pass", gate, exit_code=0)
        assert event["event"] == "quality_gate_pass"
        assert event["exit_code"] == 0

    def test_obs3_all_required_fields_present(self):
        """All 6 required fields are present in every quality gate event."""
        required = {"event", "gate_kind", "gate_command", "exit_code", "output", "on_failure"}
        gate = QualityGate(kind="schema", command="jsonschema validate .")
        event = build_quality_gate_event("quality_gate_violation", gate, exit_code=1)
        missing = required - set(event.keys())
        assert not missing, f"Missing fields: {missing}"

    def test_obs3_long_output_is_truncated(self):
        """Output exceeding 2000 chars is truncated to prevent SSE payload bloat."""
        gate = QualityGate(kind="custom", command="make")
        long_output = "x" * 5000
        event = build_quality_gate_event("quality_gate_violation", gate, exit_code=1, output=long_output)
        assert len(event["output"]) <= 2000

    def test_obs3_gate_kind_matches_source(self):
        """Event gate_kind reflects the actual kind of the gate that ran."""
        for kind in _ALL_KINDS:
            gate = QualityGate(kind=kind, command="echo")
            event = build_quality_gate_event("quality_gate_pass", gate, exit_code=0)
            assert event["gate_kind"] == kind
