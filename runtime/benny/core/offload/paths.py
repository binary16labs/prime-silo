"""Path resolution for the offload subsystem.

Two roots matter:

- **repo root** — where deterministic checks run (``pytest``, ``ruff``, ...).
  Resolved from ``$BENNY_REPO_ROOT``, else four parents up from this file
  (``offload -> core -> benny -> runtime -> <repo>``), else CWD.
- **offload scratch** — the only place the executor's *outputs* land. Lives
  under the workspace at ``$BENNY_HOME/workspaces/<ws>/offload/`` so it inherits
  the ADR-001 boundary: nothing here is the deterministic zone.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..workspace import get_workspace_path

# offload/ subdirs under the workspace
OFFLOAD_DIR = "offload"
INBOX = "inbox"  # submitted manifests awaiting execution (async lane)
OUTBOX = "outbox"  # result digests + proposed artifacts (human-promotable)
SCRATCH = "scratch"  # executor working files
LEDGER = "ledger"  # append-only JSONL instrumentation


def repo_root() -> Path:
    """Best-effort repository root for running deterministic checks."""
    env = os.environ.get("BENNY_REPO_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    # offload(0) core(1) benny(2) runtime(3) <repo>(4)
    if len(here.parents) >= 5:
        candidate = here.parents[4]
        if (candidate / "manifests").exists() or (candidate / "package.json").exists():
            return candidate
    return Path.cwd()


def router_matrix_path() -> Path:
    """Location of router.matrix.json (env override, else repo manifests/offload)."""
    env = os.environ.get("BENNY_OFFLOAD_ROUTER")
    if env:
        return Path(env).resolve()
    return repo_root() / "manifests" / "offload" / "router.matrix.json"


def offload_root(workspace: str = "default") -> Path:
    path = get_workspace_path(workspace, OFFLOAD_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def offload_subdir(workspace: str, sub: str) -> Path:
    path = offload_root(workspace) / sub
    path.mkdir(parents=True, exist_ok=True)
    return path
