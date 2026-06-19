"""
opencode execution tool — delegate coding tasks to opencode (sst/opencode).

Open-Studio Phase 3. Rather than grow its own coding agent, Benny delegates *coding*
to opencode: it runs headless (`opencode run <prompt> -m provider/model`) inside a
sandbox working directory and returns its stdout plus any git diff it produced, so the
run is captured as an artifact.

ADR-001 determinism boundary: opencode must run only in the review/sandbox zone (a
workspace working directory), never the deterministic L1/L2 zone. The caller passes an
explicit cwd that the route confines to the workspace root.

opencode also writes to its own session store, so memo-ray ingests every run
(Open-Studio Phase 1) — Benny-dispatched coding is auto-lineage-tracked there too.

Stdlib-only (asyncio, shutil, pathlib) so it imports without the rest of the runtime.
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional


def opencode_available() -> bool:
    """True when the opencode CLI is resolvable on PATH."""
    return shutil.which("opencode") is not None


async def _run(cmd: List[str], cwd: str, timeout: float) -> Dict[str, Any]:
    """Run a subprocess, capturing stdout/stderr with a hard timeout."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return {"ok": False, "timed_out": True, "stdout": "", "stderr": f"timed out after {timeout}s", "returncode": None}
    return {
        "ok": proc.returncode == 0,
        "timed_out": False,
        "stdout": out.decode("utf-8", "replace"),
        "stderr": err.decode("utf-8", "replace"),
        "returncode": proc.returncode,
    }


async def _git(cwd: str, *args: str) -> str:
    res = await _run(["git", *args], cwd, timeout=30.0)
    return res["stdout"] if res.get("ok") else ""


async def run_opencode_task(
    prompt: str,
    cwd: str,
    model: Optional[str] = None,
    agent: Optional[str] = None,
    timeout: float = 600.0,
) -> Dict[str, Any]:
    """
    Run a single non-interactive opencode session in ``cwd`` and capture results.

    Returns a dict with ok / output / stderr / returncode and, when ``cwd`` is a git
    repo, a ``git`` block with the diff and changed-file list opencode produced.
    """
    if not opencode_available():
        return {"ok": False, "error": "opencode CLI not found on PATH"}
    work = Path(cwd)
    if not work.is_dir():
        return {"ok": False, "error": f"cwd does not exist: {cwd}"}

    is_git = (work / ".git").exists()
    before_status = await _git(cwd, "status", "--porcelain") if is_git else ""

    cmd: List[str] = ["opencode", "run", prompt]
    if model:
        cmd += ["-m", model]
    if agent:
        cmd += ["--agent", agent]

    result = await _run(cmd, cwd, timeout)

    diff = ""
    changed: List[str] = []
    if is_git:
        after_status = await _git(cwd, "status", "--porcelain")
        diff = await _git(cwd, "diff")
        changed = sorted({line[3:].strip() for line in after_status.splitlines() if line.strip()})

    return {
        "ok": bool(result.get("ok")) and not result.get("timed_out"),
        "timed_out": result.get("timed_out", False),
        "returncode": result.get("returncode"),
        "output": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "git": {
            "is_repo": is_git,
            "diff": diff,
            "changed_files": changed,
            "was_dirty_before": bool(before_status.strip()),
        },
        "cwd": str(work),
        "model": model,
    }
