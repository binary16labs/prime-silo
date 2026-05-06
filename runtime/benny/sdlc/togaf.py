"""AOS-001 Phase 7 — TOGAF ADM phase mapping + ADR emission + quality gate runner.

Public API
----------
  map_waves_to_phases(wave_count, phase_map=None) → dict[int, TogafPhase]
      Maps manifest wave indices (0-based) to TOGAF ADM phases A–D.
      Unmapped waves default to TogafPhase.D (Technology Architecture).

  next_adr_seq(adr_dir) → int
      Returns the next monotonic ADR sequence number for a workspace (1-based).

  emit_adr(adr, workspace_path) → Path
      Writes an ADR markdown file to <workspace>/data_out/adr/ADR-{seq:03d}.md.
      Sequence numbers are monotonic per workspace (AOS-F4).

  run_quality_gate(gate, *, cwd=None) → QualityGateResult
      Executes a QualityGate's command and returns the result (AOS-F3):
        on_failure="halt"     → raises QualityGateError immediately.
        on_failure="retry"    → returns result with action="retry".
        on_failure="escalate" → returns result with action="escalate".

  build_quality_gate_event(event_type, gate, *, exit_code, output="") → dict
      Builds an SSE event payload for a quality gate event (AOS-OBS3).

  build_adr_event(adr_id, *, phase, path) → dict
      Builds an SSE event payload for an ADR emission (AOS-OBS3).

  phoenix_quality_gate_attrs(gate, *, exit_code, passed) → dict
      Returns OTLP span attributes for a quality gate execution (AOS-OBS4).

  phoenix_adr_attrs(adr_id, *, phase, seq) → dict
      Returns OTLP span attributes for an ADR emission (AOS-OBS4).

  QualityGateError
      Raised when a gate fails with on_failure="halt" (AOS-F3).

  QualityGateResult
      Dataclass: gate, passed, exit_code, output, action.

AOS requirements covered
------------------------
  F3    run_quality_gate(): 5 gate kinds; halt/retry/escalate on_failure.
  F4    emit_adr(): monotonic ADR-{seq}.md per workspace.
  OBS3  build_quality_gate_event() + build_adr_event(): required SSE schemas.
  OBS4  phoenix_quality_gate_attrs() + phoenix_adr_attrs(): aos.* OTLP attrs.
  NFR8  All components are stdlib-only — no network calls; offline-safe.

Placement note
--------------
Module lives in benny/sdlc/ (not benny/graph/) because benny/graph/__init__.py
eagerly imports langgraph (not installed in the test environment).

Dependencies: stdlib only (subprocess, dataclasses, pathlib).
No new top-level dependency is introduced.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from benny.sdlc.contracts import Adr, QualityGate, TogafPhase


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class QualityGateError(RuntimeError):
    """Raised when a QualityGate with on_failure='halt' fails (AOS-F3).

    Contains the gate kind, command, exit code, and output so the caller
    can surface a meaningful error to the user or the SSE event bus.
    """


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class QualityGateResult:
    """Result of executing a :class:`~benny.sdlc.contracts.QualityGate` check.

    Attributes
    ----------
    gate:
        The original :class:`~benny.sdlc.contracts.QualityGate` that was run.
    passed:
        ``True`` when the command exited with code 0.
    exit_code:
        The raw process exit code (0 = success, non-zero = failure, -1 = timeout).
    output:
        Combined stdout + stderr from the command (may be empty).
    action:
        One of ``"pass"`` / ``"halt"`` / ``"retry"`` / ``"escalate"``.
        ``"halt"`` never appears here because :func:`run_quality_gate` raises
        :class:`QualityGateError` instead of returning when the policy is halt.
    """

    gate: QualityGate
    passed: bool
    exit_code: int
    output: str
    action: str


# ---------------------------------------------------------------------------
# TOGAF wave-to-phase mapping (AOS-F2 / AOS-F3)
# ---------------------------------------------------------------------------


def map_waves_to_phases(
    wave_count: int,
    phase_map: Optional[dict[str, str]] = None,
) -> dict[int, TogafPhase]:
    """Map manifest wave indices (0-based) to TOGAF ADM phases.

    Parameters
    ----------
    wave_count:
        Total number of waves in the manifest (result will contain keys
        ``0 .. wave_count - 1``).
    phase_map:
        Optional dict mapping ``"wave_{i}"`` keys to :class:`TogafPhase`
        values (``"A"``, ``"B"``, ``"C"``, or ``"D"``).
        Unmapped waves default to :data:`TogafPhase.D` (Technology
        Architecture), per the AOS-F2 specification.
        Extra keys referencing wave indices that exceed ``wave_count - 1``
        are silently ignored.

    Returns
    -------
    dict[int, TogafPhase]
        Complete mapping ``{wave_index: TogafPhase}`` for all waves
        ``0 .. wave_count - 1``.  The dict is ordered by wave index.

    Examples
    --------
    >>> m = map_waves_to_phases(4, {"wave_0": "A", "wave_2": "C"})
    >>> m[0]
    <TogafPhase.A: 'A'>
    >>> m[1]  # unmapped → default D
    <TogafPhase.D: 'D'>
    """
    resolved: dict[str, str] = phase_map or {}
    result: dict[int, TogafPhase] = {}

    for i in range(wave_count):
        key = f"wave_{i}"
        if key in resolved:
            result[i] = TogafPhase(resolved[key])
        else:
            result[i] = TogafPhase.D  # AOS-F2: unmapped → technology

    return result


# ---------------------------------------------------------------------------
# ADR sequence management (AOS-F4)
# ---------------------------------------------------------------------------


def next_adr_seq(adr_dir: Path) -> int:
    """Return the next monotonic ADR sequence number for *adr_dir* (1-based).

    Scans *adr_dir* for existing ``ADR-{seq}.md`` files and returns
    ``max(seq) + 1``.  If the directory is empty (or does not yet contain
    any ADR files), returns 1.

    The directory is created automatically if it does not exist.

    Parameters
    ----------
    adr_dir:
        Path to the ``data_out/adr/`` directory inside a workspace.

    Returns
    -------
    int
        The next available sequence number (≥ 1, monotonically increasing).
    """
    adr_dir.mkdir(parents=True, exist_ok=True)

    seqs: list[int] = []
    for f in adr_dir.glob("ADR-*.md"):
        stem = f.stem  # e.g. "ADR-003"
        try:
            seqs.append(int(stem.split("-")[1]))
        except (IndexError, ValueError):
            pass  # skip malformed filenames

    return (max(seqs) + 1) if seqs else 1


def emit_adr(adr: Adr, workspace_path: Path) -> Path:
    """Write an ADR to ``<workspace>/data_out/adr/ADR-{seq:03d}.md`` (AOS-F4).

    The sequence number is automatically assigned from :func:`next_adr_seq`
    applied to the workspace's ADR directory.  Sequence numbers are monotonic
    per workspace — calling ``emit_adr`` N times produces ``ADR-001.md``
    through ``ADR-{N:03d}.md`` with no gaps (assuming no concurrent writers).

    Parameters
    ----------
    adr:
        The :class:`~benny.sdlc.contracts.Adr` to serialise as markdown.
    workspace_path:
        Root path of the target workspace (e.g. ``$BENNY_HOME/workspaces/c5_test``).

    Returns
    -------
    Path
        Absolute path to the created ``ADR-{seq:03d}.md`` file.
    """
    adr_dir = workspace_path / "data_out" / "adr"
    adr_dir.mkdir(parents=True, exist_ok=True)

    seq = next_adr_seq(adr_dir)
    filename = f"ADR-{seq:03d}.md"
    adr_path = adr_dir / filename

    content_lines: list[str] = [
        f"# {filename}: {adr.title}",
        "",
        f"**ID:** {adr.id}",
        f"**TOGAF Phase:** {adr.togaf_phase.value} — {adr.togaf_phase.label}",
        f"**Status:** {adr.status}",
        "",
        "## Context",
        "",
        adr.context or "(not specified)",
        "",
        "## Decision",
        "",
        adr.decision or "(not specified)",
        "",
        "## Consequences",
        "",
        adr.consequences or "(not specified)",
        "",
    ]

    adr_path.write_text("\n".join(content_lines), encoding="utf-8")
    return adr_path


# ---------------------------------------------------------------------------
# Quality gate runner (AOS-F3)
# ---------------------------------------------------------------------------


def run_quality_gate(
    gate: QualityGate,
    *,
    cwd: Optional[Path] = None,
) -> QualityGateResult:
    """Execute a :class:`~benny.sdlc.contracts.QualityGate` command (AOS-F3).

    On-failure policies
    ~~~~~~~~~~~~~~~~~~~
    - ``"halt"``     — raises :class:`QualityGateError` immediately on failure;
      no result is returned.
    - ``"retry"``    — returns :class:`QualityGateResult` with
      ``action="retry"``; the caller is responsible for re-scheduling.
    - ``"escalate"`` — returns :class:`QualityGateResult` with
      ``action="escalate"``; the caller should pause for HITL review.

    On success (exit code 0), returns a result with ``action="pass"``.

    Timeout handling
    ~~~~~~~~~~~~~~~~
    If the command exceeds ``gate.timeout_s``, a :exc:`subprocess.TimeoutExpired`
    is caught and translated to a failure result (``exit_code=-1``).

    Parameters
    ----------
    gate:
        The quality gate to execute.
    cwd:
        Optional working directory for the subprocess.  Defaults to the
        current working directory.

    Returns
    -------
    QualityGateResult

    Raises
    ------
    QualityGateError
        When the command fails and ``gate.on_failure == "halt"``.
    """
    output: str = ""
    exit_code: int = 0
    passed: bool = False

    try:
        proc = subprocess.run(
            gate.command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=gate.timeout_s,
            cwd=str(cwd) if cwd else None,
        )
        exit_code = proc.returncode
        output = (proc.stdout + proc.stderr).strip()
        passed = exit_code == 0

    except subprocess.TimeoutExpired:
        exit_code = -1
        output = f"Command timed out after {gate.timeout_s}s: {gate.command}"
        passed = False

    except Exception as exc:  # pragma: no cover — defensive catch
        exit_code = -1
        output = f"Command execution error: {exc}"
        passed = False

    if not passed:
        if gate.on_failure == "halt":
            raise QualityGateError(
                f"Quality gate [{gate.kind}] failed (exit={exit_code}): "
                f"{gate.command}\n{output}"
            )
        action: str = gate.on_failure   # "retry" or "escalate"
    else:
        action = "pass"

    return QualityGateResult(
        gate=gate,
        passed=passed,
        exit_code=exit_code,
        output=output,
        action=action,
    )


# ---------------------------------------------------------------------------
# SSE event builders (AOS-OBS3)
# ---------------------------------------------------------------------------


def build_quality_gate_event(
    event_type: str,
    gate: QualityGate,
    *,
    exit_code: int,
    output: str = "",
) -> dict[str, Any]:
    """Build an SSE event payload for a quality gate event (AOS-OBS3).

    Schema (all fields required by the SSE consumer)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    ===========================  ====  ==========================================
    Field                        Type  Description
    ===========================  ====  ==========================================
    ``event``                    str   Event type (e.g. ``quality_gate_pass``).
    ``gate_kind``                str   One of the 5 gate check kinds.
    ``gate_command``             str   The command string that was executed.
    ``exit_code``                int   Process exit code (0 = success).
    ``output``                   str   Combined stdout+stderr (≤ 2000 chars).
    ``on_failure``               str   ``"halt"`` | ``"retry"`` | ``"escalate"``.
    ===========================  ====  ==========================================

    Parameters
    ----------
    event_type:
        SSE event name, e.g. ``"quality_gate_violation"`` or
        ``"quality_gate_pass"``.
    gate:
        The :class:`~benny.sdlc.contracts.QualityGate` that was executed.
    exit_code:
        Process exit code.
    output:
        Combined stdout+stderr from the command.

    Returns
    -------
    dict[str, Any]
        SSE-ready event payload dict.
    """
    return {
        "event": event_type,
        "gate_kind": gate.kind,
        "gate_command": gate.command,
        "exit_code": exit_code,
        "output": output[:2000],    # truncate to prevent payload bloat
        "on_failure": gate.on_failure,
    }


def build_adr_event(
    adr_id: str,
    *,
    phase: TogafPhase,
    path: str,
) -> dict[str, Any]:
    """Build an SSE event payload for an ADR emission (AOS-OBS3).

    Schema (all fields required)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    ===========================  ====  ==========================================
    Field                        Type  Description
    ===========================  ====  ==========================================
    ``event``                    str   Always ``"adr_emitted"``.
    ``adr_id``                   str   ADR identifier (e.g. ``"ADR-001"``).
    ``togaf_phase``              str   TOGAF phase value (``"A"``–``"D"``).
    ``togaf_label``              str   Human-readable phase label.
    ``path``                     str   Path to the emitted ``.md`` file.
    ===========================  ====  ==========================================

    Parameters
    ----------
    adr_id:
        ADR identifier string (e.g. ``"ADR-001"``).
    phase:
        The :class:`~benny.sdlc.contracts.TogafPhase` associated with the ADR.
    path:
        Path (string) to the written ``.md`` file.

    Returns
    -------
    dict[str, Any]
        SSE-ready event payload dict.
    """
    return {
        "event": "adr_emitted",
        "adr_id": adr_id,
        "togaf_phase": phase.value,
        "togaf_label": phase.label,
        "path": path,
    }


# ---------------------------------------------------------------------------
# Phoenix OTLP attribute builders (AOS-OBS4)
# ---------------------------------------------------------------------------


def phoenix_quality_gate_attrs(
    gate: QualityGate,
    *,
    exit_code: int,
    passed: bool,
) -> dict[str, Any]:
    """Return OTLP span attributes for a quality gate execution (AOS-OBS4).

    All attribute keys are in the ``aos.quality_gate.*`` namespace to avoid
    collisions with existing Phoenix / OpenTelemetry attributes.

    Parameters
    ----------
    gate:
        The quality gate that was executed.
    exit_code:
        Process exit code.
    passed:
        ``True`` when the gate passed (exit code 0).

    Returns
    -------
    dict[str, Any]
        OTLP attribute dict ready to be attached to a Phoenix span.
    """
    return {
        "aos.quality_gate.kind": gate.kind,
        "aos.quality_gate.command": gate.command,
        "aos.quality_gate.exit_code": exit_code,
        "aos.quality_gate.passed": passed,
        "aos.quality_gate.on_failure": gate.on_failure,
    }


def phoenix_adr_attrs(
    adr_id: str,
    *,
    phase: TogafPhase,
    seq: int,
) -> dict[str, Any]:
    """Return OTLP span attributes for an ADR emission (AOS-OBS4).

    All attribute keys are in the ``aos.adr.*`` namespace.

    Parameters
    ----------
    adr_id:
        ADR identifier string (e.g. ``"ADR-001"``).
    phase:
        The :class:`~benny.sdlc.contracts.TogafPhase` associated with the ADR.
    seq:
        The monotonic sequence number used in the filename.

    Returns
    -------
    dict[str, Any]
        OTLP attribute dict ready to be attached to a Phoenix span.
    """
    return {
        "aos.adr.id": adr_id,
        "aos.adr.seq": seq,
        "aos.adr.togaf_phase": phase.value,
        "aos.adr.togaf_label": phase.label,
    }
