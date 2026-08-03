"""B2 — the `benny coord` CLI surface over the coordination ledger.

The ledger, its validator, and the wx lease protocol are JavaScript (B0/B1). Rather than fork the
protocol into a second language, this module shells out to the ONE client,
``coord_client.mjs``, and renders its JSON. That keeps `benny coord` and the prime-silo-nexus MCP
tools byte-identical in behaviour: same validator, same lease, same server-up/server-down rules.

Contract: delivery/tasks/B2.md
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

CLIENT = Path(__file__).resolve().parent / "coord_client.mjs"


class CoordError(RuntimeError):
    """The coordination client refused, or could not be run at all."""


def _run(verb: str, **flags: Optional[str]) -> Dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        raise CoordError("`benny coord` needs node on PATH — the coordination client is JS (B0/B1)")
    argv = [node, str(CLIENT), verb]
    for key, value in flags.items():
        if value is not None:
            argv += [f"--{key}", str(value)]
    proc = subprocess.run(argv, capture_output=True, text=True)
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        raise CoordError((proc.stderr or "").strip() or f"coord {verb}: no output")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:  # the client always prints one JSON line
        raise CoordError(f"coord {verb}: unparseable reply {lines[-1]!r}") from exc


def ls(*, dir=None, api=None):
    return _run("ls", dir=dir, api=api)


def claim(task, agent, *, dir=None, api=None):
    return _run("claim", task=task, agent=agent, dir=dir, api=api)


def progress(task, agent, *, text=None, dir=None, api=None):
    return _run("progress", task=task, agent=agent, text=text, dir=dir, api=api)


def done(task, agent, *, text=None, dir=None, api=None):
    return _run("done", task=task, agent=agent, text=text, dir=dir, api=api)


def note(agent, *, topic=None, text=None, dir=None, api=None):
    return _run("note", agent=agent, topic=topic, text=text, dir=dir, api=api)


def cmd_coord(args) -> int:
    """argparse entry point for `benny coord <verb>`."""
    verb = args.coord_cmd
    common = {"dir": getattr(args, "coord_dir", None), "api": getattr(args, "api", None)}
    try:
        if verb == "ls":
            result = ls(**common)
        elif verb == "claim":
            result = claim(args.task, args.agent, **common)
        elif verb == "progress":
            result = progress(args.task, args.agent, text=args.text, **common)
        elif verb == "done":
            result = done(args.task, args.agent, text=args.text, **common)
        else:
            result = note(args.agent, topic=args.topic, text=args.text, **common)
    except CoordError as exc:
        print(f"coord: {exc}")
        return 1

    if getattr(args, "json", False):
        print(json.dumps(result, indent=2))
    elif verb == "ls":
        print(f"[{result.get('mode')}] {len(result.get('tasks', []))} task(s)")
        for task in result.get("tasks", []):
            agent = task.get("agent") or "-"
            print(f"  {task['task_id']:<12} {task['state']:<9} {agent}")
    elif result.get("ok"):
        extra = " (takeover)" if result.get("takeover") else ""
        print(f"[{result.get('mode')}] {verb} ok{extra}")
    else:
        print(f"{verb} refused: {result.get('reason') or result.get('error')}")

    return 0 if result.get("ok", True) else 1
