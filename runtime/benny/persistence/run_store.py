"""
RunStore — file-backed persistence for manifests and run history.

Why a dedicated store:
    - `executions` in workflow_routes.py is in-memory only (lost on restart)
    - `TaskManager` tracks live runs but isn't durable
    - Manifest history needs to survive across processes so the UI's Runs panel
      and `benny runs ls` show meaningful state after a server restart

Layout on disk (under <repo_root>/workspace/manifests/):
    manifests/
      <manifest_id>.json          # SwarmManifest as authored
      runs/
        <run_id>.json             # one RunRecord per execution

This is deliberately simple — a SQLite-backed store is a straight upgrade
path once multi-user / indexed queries matter.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from ..core.manifest import RunRecord, RunStatus, SwarmManifest

_BASE = Path(__file__).resolve().parent.parent.parent
_STORE_ROOT = _BASE / "workspace" / "manifests"
_MANIFEST_DIR = _STORE_ROOT
_RUNS_DIR = _STORE_ROOT / "runs"

_lock = threading.Lock()


def _ensure_dirs() -> None:
    _MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    _RUNS_DIR.mkdir(parents=True, exist_ok=True)


def _manifest_path(manifest_id: str) -> Path:
    return _MANIFEST_DIR / f"{manifest_id}.json"


def _run_path(run_id: str) -> Path:
    return _RUNS_DIR / f"{run_id}.json"


# =============================================================================
# MANIFEST CRUD
# =============================================================================


def save_manifest(manifest: SwarmManifest) -> SwarmManifest:
    _ensure_dirs()
    manifest.touch()
    path = _manifest_path(manifest.id)
    with _lock:
        path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    return manifest


def get_manifest(manifest_id: str) -> Optional[SwarmManifest]:
    path = _manifest_path(manifest_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return SwarmManifest.model_validate(data)
    except Exception:
        return None


def list_manifests() -> List[SwarmManifest]:
    _ensure_dirs()
    out: List[SwarmManifest] = []
    for p in sorted(_MANIFEST_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            out.append(SwarmManifest.model_validate(data))
        except Exception:
            continue
    return out


def delete_manifest(manifest_id: str) -> bool:
    path = _manifest_path(manifest_id)
    if path.exists():
        path.unlink()
        return True
    return False


# =============================================================================
# RUN CRUD
# =============================================================================


def save_run(record: RunRecord) -> RunRecord:
    _ensure_dirs()
    path = _run_path(record.run_id)
    with _lock:
        path.write_text(record.model_dump_json(indent=2), encoding="utf-8")
    return record


def get_run(run_id: str) -> Optional[RunRecord]:
    path = _run_path(run_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return RunRecord.model_validate(data)
    except Exception:
        return None


def list_runs(
    manifest_id: Optional[str] = None,
    workspace: Optional[str] = None,
    limit: int = 100,
) -> List[RunRecord]:
    _ensure_dirs()
    out: List[RunRecord] = []
    for p in sorted(_RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            rec = RunRecord.model_validate(data)
        except Exception:
            continue
        if manifest_id and rec.manifest_id != manifest_id:
            continue
        if workspace and rec.workspace != workspace:
            continue
        out.append(rec)
        if len(out) >= limit:
            break
    return out


def update_run_status(
    run_id: str,
    status: RunStatus,
    errors: Optional[List[str]] = None,
    final_document: Optional[str] = None,
    artifact_paths: Optional[List[str]] = None,
    node_states: Optional[Dict[str, str]] = None,
    governance_url: Optional[str] = None,
) -> Optional[RunRecord]:
    """Patch a run record. No-op if run doesn't exist."""
    rec = get_run(run_id)
    if not rec:
        return None

    rec.status = status
    if status in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.PARTIAL_SUCCESS, RunStatus.CANCELLED):
        rec.completed_at = datetime.utcnow().isoformat()
        if rec.started_at:
            try:
                start = datetime.fromisoformat(rec.started_at)
                end = datetime.fromisoformat(rec.completed_at)
                rec.duration_ms = int((end - start).total_seconds() * 1000)
            except Exception:
                pass

    if errors is not None:
        rec.errors = list(errors)
    if final_document is not None:
        rec.final_document = final_document
    if artifact_paths is not None:
        rec.artifact_paths = list(artifact_paths)
    if node_states is not None:
        # Accept both str and TaskStatus values for convenience
        from ..core.manifest import TaskStatus

        normalized: Dict[str, TaskStatus] = {}
        for k, v in node_states.items():
            try:
                normalized[k] = TaskStatus(v) if isinstance(v, str) else v
            except ValueError:
                normalized[k] = TaskStatus.PENDING
        rec.node_states = normalized
    if governance_url is not None:
        rec.governance_url = governance_url

    return save_run(rec)


__all__ = [
    "save_manifest",
    "get_manifest",
    "list_manifests",
    "delete_manifest",
    "save_run",
    "get_run",
    "list_runs",
    "update_run_status",
]
