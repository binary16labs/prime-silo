"""The unified run-event stream (G0).

One append-only ``events.jsonl`` per run, written only by the pypes
orchestrator. The first line freezes the DAG (``run_started``); every
subsequent event carries progress + telemetry; lineage is derived by
folding ``artifact_*`` events — never a second write path. See
``architecture/SPEC-run-events.md`` for full design rationale.

Non-blocking guarantee: every emitter method never raises for I/O
reasons — a write failure is logged once and the stream degrades to a
no-op for the rest of the run (mirrors ``runtime/benny/pypes/lineage.py``).
DAG-freeze violations (``UnknownNodeError``) are a schema contract, not
an I/O failure, and DO propagate.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

log = logging.getLogger(__name__)

_HEARTBEAT_PHASES = {"prefill", "generating", "assembling"}
# Event types scoped to a node_id; checked against the frozen DAG header.
_NODE_EVENTS = {
    "node_started",
    "node_progress",
    "node_heartbeat",
    "node_finished",
    "node_failed",
    "node_retried",
    "artifact_produced",
    "artifact_consumed",
}


class UnknownNodeError(ValueError):
    """Event references a node_id not in the frozen DAG header."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_runs_root(root: Optional[Path] = None) -> Path:
    """``PRIME_SILO_HOME`` > ``BENNY_HOME`` > cwd (matches server/api/home.js)."""
    if root is not None:
        return Path(root)
    for var in ("PRIME_SILO_HOME", "BENNY_HOME"):
        value = os.environ.get(var)
        if value:
            return Path(value)
    return Path.cwd()


class RunEventStream:
    """Single-writer, append-only event stream: ``<root>/runs/<run_id>/events.jsonl``."""

    def __init__(self, run_id: str, root: Optional[Path] = None) -> None:
        self.run_id = run_id
        self._path = resolve_runs_root(root) / "runs" / run_id / "events.jsonl"
        self._nodes: Optional[set] = None
        self._degraded = False

    def _emit(self, event: str, node_id: Optional[str] = None, **fields: Any) -> None:
        if event in _NODE_EVENTS and self._nodes is not None and node_id not in self._nodes:
            raise UnknownNodeError(
                f"event '{event}' references node_id '{node_id}' not in the "
                f"run_started header — the DAG is frozen at run start"
            )
        payload: Dict[str, Any] = {"event": event, "run_id": self.run_id, "ts": _now()}
        if node_id is not None:
            payload["node_id"] = node_id
        payload.update({k: v for k, v in fields.items() if v is not None})
        self._write(payload)

    # ------------------------------------------------------------ header

    def run_started(
        self,
        *,
        manifest_id: str,
        manifest_hash: str,
        nodes: Sequence[str],
        edges: Sequence[Tuple[str, str]] = (),
    ) -> None:
        """Write the freezing header event. Must precede any other event."""
        self._nodes = set(nodes)
        self._emit(
            "run_started",
            manifest_id=manifest_id,
            manifest_hash=manifest_hash,
            nodes=list(nodes),
            edges=[list(e) for e in edges],
        )

    # -------------------------------------------------------- node events

    def node_started(self, *, node_id: str, attempt: int = 1) -> None:
        self._emit("node_started", node_id, attempt=attempt)

    def node_progress(
        self, *, node_id: str, attempt: int = 1, detail: Optional[Dict[str, Any]] = None
    ) -> None:
        self._emit("node_progress", node_id, attempt=attempt, detail=detail)

    def node_heartbeat(
        self,
        *,
        node_id: str,
        attempt: int = 1,
        phase: str,
        tokens_so_far: Optional[int] = None,
        compute_busy: Optional[bool] = None,
    ) -> None:
        """Liveness signal for an in-flight node (``phase``:
        prefill|generating|assembling) — lets a tailing consumer tell
        alive-but-silent from stalled."""
        if phase not in _HEARTBEAT_PHASES:
            log.warning(
                "pypes.events: unexpected heartbeat phase '%s' for node '%s'", phase, node_id
            )
        self._emit(
            "node_heartbeat",
            node_id,
            attempt=attempt,
            phase=phase,
            tokens_so_far=tokens_so_far,
            compute_busy=compute_busy,
        )

    def node_finished(
        self,
        *,
        node_id: str,
        attempt: int = 1,
        duration_ms: Optional[int] = None,
        tokens_in: Optional[int] = None,
        tokens_out: Optional[int] = None,
        model: Optional[str] = None,
        endpoint: Optional[str] = None,
    ) -> None:
        self._emit(
            "node_finished",
            node_id,
            attempt=attempt,
            duration_ms=duration_ms,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            model=model,
            endpoint=endpoint,
        )

    def node_failed(
        self, *, node_id: str, attempt: int = 1, error: str, duration_ms: Optional[int] = None
    ) -> None:
        self._emit("node_failed", node_id, attempt=attempt, error=error, duration_ms=duration_ms)

    def node_retried(self, *, node_id: str, attempt: int) -> None:
        self._emit("node_retried", node_id, attempt=attempt)

    # ---------------------------------------------------- artifact events

    def artifact_produced(
        self,
        *,
        node_id: str,
        artifact: str,
        uri: Optional[str] = None,
        content_hash: Optional[str] = None,
    ) -> None:
        self._emit(
            "artifact_produced", node_id, artifact=artifact, uri=uri, content_hash=content_hash
        )

    def artifact_consumed(self, *, node_id: str, artifact: str, uri: Optional[str] = None) -> None:
        self._emit("artifact_consumed", node_id, artifact=artifact, uri=uri)

    # --------------------------------------------------------- run close

    def run_finished(self, *, status: str, duration_ms: Optional[int] = None) -> None:
        self._emit("run_finished", status=status, duration_ms=duration_ms)

    def run_failed(self, *, status: str, error: str, duration_ms: Optional[int] = None) -> None:
        self._emit("run_failed", status=status, error=error, duration_ms=duration_ms)

    # ------------------------------------------------------------- write

    def _write(self, payload: Dict[str, Any]) -> None:
        """Append one JSON line. Never raises for I/O reasons — degrades and logs."""
        if self._degraded:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(payload) + "\n")
        except Exception as exc:  # noqa: BLE001 - intentionally broad, never fail a step
            log.warning("pypes.events: write to events.jsonl failed, degrading stream: %s", exc)
            self._degraded = True


def fold_lineage(events: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Fold ``artifact_produced``/``artifact_consumed`` events into
    ``{artifact_name: {"produced_by": node_id, "consumed_by": [node_id, ...]}}``.
    The only lineage derivation for the G0 stream — no second write path.
    ``runtime/benny/governance/lineage.py`` and ``runtime/benny/pypes/lineage.py``
    remain optional tail-adapters that can translate this fold into
    OpenLineage RunEvents out of band.
    """
    lineage: Dict[str, Dict[str, Any]] = {}
    for event in events:
        etype = event.get("event")
        if etype not in ("artifact_produced", "artifact_consumed"):
            continue
        entry = lineage.setdefault(event["artifact"], {"produced_by": None, "consumed_by": []})
        if etype == "artifact_produced":
            entry["produced_by"] = event["node_id"]
        else:
            entry["consumed_by"].append(event["node_id"])
    return lineage
