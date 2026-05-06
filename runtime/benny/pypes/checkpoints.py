"""Checkpoint store — persist each step's output for re-run and drill-down.

Every pypes run lives under ``$BENNY_HOME/workspace/<ws>/runs/pypes-<run_id>/``:

    checkpoints/
        <step_id>.parquet       (or .csv when pyarrow is absent)
    receipt.json                (signed RunReceipt)
    manifest_snapshot.json      (exact manifest that produced this run)
    reports/
        <report_id>.md

Re-run semantics:
    benny pypes rerun <run_id> --from <step_id>

    loads checkpoints for every step *before* ``from-step`` and re-executes
    from that point onward. Sub-manifests can be rerun independently.

Drill-down:
    benny pypes drilldown <run_id> <step_id> [--rows 50]

    reads the checkpointed parquet and prints a paginated view with the
    CLP mapping attached to each column — i.e. "this ``net_amt`` column
    realises ``CounterpartyExposure.net_counterparty_position``".
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .engine import ExecutionEngine
from .models import FormatType, RunCheckpoint, SourceSpec


class CheckpointStore:
    """File-backed checkpoint index for one pypes run."""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        self.checkpoint_dir = self.run_dir / "checkpoints"
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.checkpoint_dir / "_index.json"
        self._index: Dict[str, Dict[str, Any]] = {}
        if self.index_path.exists():
            try:
                self._index = json.loads(self.index_path.read_text(encoding="utf-8"))
            except Exception:
                self._index = {}

    # --- write ------------------------------------------------------------

    def write(
        self,
        engine: ExecutionEngine,
        step_id: str,
        run_id: str,
        df: Any,
        preferred_format: FormatType = FormatType.PARQUET,
    ) -> RunCheckpoint:
        ext = "parquet" if preferred_format == FormatType.PARQUET else "csv"
        path = self.checkpoint_dir / f"{step_id}.{ext}"
        dest = SourceSpec(uri=str(path), format=preferred_format)
        try:
            engine.save(df, dest)
        except Exception:
            # Parquet can fail on some typed columns; fall back to CSV.
            path = self.checkpoint_dir / f"{step_id}.csv"
            engine.save(df, SourceSpec(uri=str(path), format=FormatType.CSV))
            ext = "csv"

        cp = RunCheckpoint(
            step_id=step_id,
            run_id=run_id,
            path=str(path),
            format=FormatType.PARQUET if ext == "parquet" else FormatType.CSV,
            row_count=engine.row_count(df),
            column_count=len(engine.columns(df)),
            fingerprint=engine.fingerprint(df),
        )
        self._index[step_id] = cp.model_dump()
        self.index_path.write_text(json.dumps(self._index, indent=2), encoding="utf-8")
        return cp

    # --- read -------------------------------------------------------------

    def read(self, engine: ExecutionEngine, step_id: str) -> Optional[Any]:
        entry = self._index.get(step_id)
        if entry is None:
            return None
        path = Path(entry["path"])
        if not path.exists():
            return None
        fmt = FormatType(entry["format"])
        return engine.load(SourceSpec(uri=str(path), format=fmt))

    def has(self, step_id: str) -> bool:
        entry = self._index.get(step_id)
        return entry is not None and Path(entry["path"]).exists()

    def manifest(self) -> List[RunCheckpoint]:
        return [RunCheckpoint(**entry) for entry in self._index.values()]

    # --- discovery --------------------------------------------------------

    @staticmethod
    def for_run(workspace_root: Path, run_id: str) -> "CheckpointStore":
        run_dir = Path(workspace_root) / "runs" / f"pypes-{run_id}"
        return CheckpointStore(run_dir)

    @staticmethod
    def discover_baseline(
        workspace_root: Path, manifest_id: str, current_run_id: str, step_id: str
    ) -> Optional[Path]:
        """Return the most recent prior run's checkpoint for ``step_id``."""
        runs_root = Path(workspace_root) / "runs"
        if not runs_root.exists():
            return None
        candidates = sorted(runs_root.glob("pypes-*"), reverse=True)
        for run_dir in candidates:
            if run_dir.name == f"pypes-{current_run_id}":
                continue
            meta = run_dir / "manifest_snapshot.json"
            if not meta.exists():
                continue
            try:
                snap = json.loads(meta.read_text(encoding="utf-8"))
                if snap.get("id") != manifest_id:
                    continue
            except Exception:
                continue
            idx = run_dir / "checkpoints" / "_index.json"
            if not idx.exists():
                continue
            try:
                entries = json.loads(idx.read_text(encoding="utf-8"))
            except Exception:
                continue
            entry = entries.get(step_id)
            if entry and Path(entry["path"]).exists():
                return Path(entry["path"])
        return None
