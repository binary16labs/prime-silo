"""Task execution — the part Benny actually runs locally.

``shell`` mode runs a command (codemods, scaffolds, formatters). ``generate``
mode asks the local model (via :func:`resolve_executor`) for an answer/patch
grounded on ``context_pointers``. Either way the *output* is returned to the
orchestrator as a proposed artifact — it is written into the offload outbox, not
into the deterministic zone (ADR-001).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from .manifest import OffloadManifest
from .paths import repo_root

logger = logging.getLogger(__name__)

_MAX_POINTER_BYTES = 20_000  # cap per-pointer context so we don't blow local ctx


@dataclass
class ExecResult:
    ok: bool
    artifact: str  # generated text/patch, or shell stdout
    mode: str
    detail: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    error: str = ""
    touched_paths: List[str] = field(default_factory=list)


async def _run_shell(cmd: str, cwd: Path, timeout: int) -> ExecResult:
    proc = await asyncio.create_subprocess_shell(
        cmd,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return ExecResult(
            ok=False, artifact="", mode="shell", error=f"timeout after {timeout}s", detail=cmd
        )
    text = (out or b"").decode("utf-8", "replace")
    return ExecResult(
        ok=(proc.returncode == 0),
        artifact=text,
        mode="shell",
        detail=cmd,
        error="" if proc.returncode == 0 else f"exit {proc.returncode}",
    )


def _resolve_pointer(ptr: str, root: Path) -> Optional[Path]:
    """Resolve a context pointer to a file. Accepts "path", "path:symbol", and
    "path:line". Tries the whole pointer first so a Windows drive-letter colon is
    never mistaken for a ``:symbol`` separator; only if that is not a file do we
    strip a trailing ``:suffix``."""
    candidate = root / ptr
    if candidate.is_file():
        return candidate
    if ":" in ptr:
        head = ptr.rsplit(":", 1)[0]
        stripped = root / head
        if stripped.is_file():
            return stripped
    return None


def _gather_context(manifest: OffloadManifest, root: Path) -> str:
    chunks: List[str] = []
    for ptr in manifest.context_pointers:
        fp = _resolve_pointer(ptr, root)
        if fp is not None:
            try:
                body = fp.read_text(encoding="utf-8", errors="replace")[:_MAX_POINTER_BYTES]
                chunks.append(f"### {ptr}\n```\n{body}\n```")
            except Exception as exc:  # pragma: no cover - defensive
                chunks.append(f"### {ptr}\n(could not read: {exc})")
        else:
            chunks.append(f"### {ptr}\n(pointer is not a local file; treat as reference)")
    return "\n\n".join(chunks)


async def _run_generate(
    manifest: OffloadManifest, model: str, root: Path, timeout: int
) -> ExecResult:
    from ..local_executor import (
        resolve_executor,  # deferred: avoids importing httpx/tiktoken until a generate task actually runs
    )

    executor = resolve_executor(model)
    if executor is None:
        return ExecResult(
            ok=False,
            artifact="",
            mode="generate",
            model=model,
            error=f"no local executor resolves model '{model}' " f"(is the local server running?)",
        )
    context = _gather_context(manifest, root)
    criteria = "\n".join(f"- [{c.id}] {c.statement}" for c in manifest.acceptance_criteria)
    base_prompt = manifest.executor.get("prompt") or "Complete the task described below."
    prompt = (
        f"{base_prompt}\n\n"
        f"## Intent\n{manifest.intent}\n\n"
        f"## Acceptance criteria (your output MUST satisfy every one)\n{criteria}\n\n"
        f"## Context\n{context or '(none provided)'}\n\n"
        f"Return only the deliverable (full updated file or unified diff). "
        f"Do not include commentary outside the deliverable."
    )
    system = (
        "You are Benny, a local execution agent. Produce correct, minimal output "
        "that satisfies every acceptance criterion. Stay within the allowed paths."
    )
    try:
        text = await asyncio.wait_for(
            executor.generate(prompt, system=system, temperature=0.2, max_tokens=4000),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        return ExecResult(
            ok=False,
            artifact="",
            mode="generate",
            model=model,
            error=f"generation timeout after {timeout}s",
        )
    except Exception as exc:
        return ExecResult(
            ok=False, artifact="", mode="generate", model=model, error=f"generation failed: {exc}"
        )
    return ExecResult(
        ok=bool(text.strip()),
        artifact=text,
        mode="generate",
        model=model,
        prompt_tokens=executor.count_tokens(prompt),
        completion_tokens=executor.count_tokens(text),
        error="" if text.strip() else "empty generation",
    )


async def execute(manifest: OffloadManifest, model: str) -> ExecResult:
    """Run the task once and return the proposed artifact."""
    root = repo_root()
    timeout = manifest.max_seconds
    if manifest.executor_mode == "shell":
        cmd = manifest.executor.get("command", "")
        return await _run_shell(cmd, root, timeout)
    return await _run_generate(manifest, model, root, timeout)
