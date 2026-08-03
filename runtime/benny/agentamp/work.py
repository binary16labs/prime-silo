"""B2/W1 — the `benny work` CLI surface over the delivery loop.

Same shape as ``coord.py`` and for the same reason: the selector, the lease protocol and the
ledger are JavaScript, so this shells out to the ONE implementation
(``server/coordination/lib/work_loop.mjs``) rather than forking the protocol into a second
language. `benny work` and the prime-silo-nexus MCP tools therefore cannot drift.

Contract: delivery/tasks/W1.md · Decisions: architecture/SOLUTION-W1-work-next.md section 9
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

# runtime/benny/agentamp/work.py -> repo root -> server/coordination/lib/work_loop.mjs
REPO_ROOT = Path(__file__).resolve().parents[3]
LOOP = REPO_ROOT / "server" / "coordination" / "lib" / "work_loop.mjs"


class WorkError(RuntimeError):
    """The delivery loop refused, or could not be run at all."""


def _run(verb: str, **flags: Optional[str]) -> Dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        raise WorkError("`benny work` needs node on PATH — the delivery loop is JS (B0/B1/W1)")
    argv = [node, str(LOOP), verb, "--repo", str(REPO_ROOT)]
    for key, value in flags.items():
        if value is not None:
            argv += [f"--{key}", str(value)]
    proc = subprocess.run(argv, capture_output=True, text=True, cwd=str(REPO_ROOT))
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        raise WorkError((proc.stderr or "").strip() or f"work {verb}: no output")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise WorkError(f"work {verb}: unparseable reply {lines[-1]!r}") from exc


def cmd_work(args) -> int:
    """argparse entry point for `benny work <verb>`."""
    verb = args.work_cmd
    common = {"dir": getattr(args, "coord_dir", None), "api": getattr(args, "api", None)}
    try:
        if verb == "next":
            result = _run("next", agent=args.agent, **common)
        elif verb == "verify":
            result = _run("verify", task=args.task)
        elif verb == "verified":
            result = _run("verified", task=args.task, agent=args.agent, **common)
        else:
            result = _run("blocked", task=args.task, agent=args.agent, reason=args.reason, **common)
    except WorkError as exc:
        print(f"work: {exc}")
        return 1

    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    elif verb == "next":
        if result.get("item"):
            print(f"next: {result['item']}" + (" (takeover)" if result.get("takeover") else ""))
        else:
            print(f"next: nothing — {result.get('reason')}")
            if result.get("holding"):
                print(f"  you already hold {result['holding']} (WIP limit 1)")
        # D1/D2 are reported, never silently dropped: the operator must see WHY work was withheld.
        for item in result.get("awaitingSignature") or []:
            print(f"  awaiting owner signature: {item}")
        for c in result.get("conflicts") or []:
            print(f"  CONFLICT {c['id']}: board={c['board']} ledger={c['ledger']} — skipped")
    elif result.get("ok"):
        print(f"{verb}: ok")
    else:
        print(f"{verb} refused: {result.get('reason') or result.get('error')}")

    return 0 if result.get("ok", True) else 1
