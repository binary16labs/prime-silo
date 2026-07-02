"""Append-only instrumentation ledger (Phase 4).

Records the honest components of every task so savings can be *measured*, not
asserted (the memo-ray token-audit lesson). We deliberately do NOT invent a
single hero "tokens saved" number — we store the raw components and a clearly
labelled *estimate*, and let ``scripts/offload-report.mjs`` aggregate them:

- ``local_prompt_tokens`` / ``local_completion_tokens`` — work moved onto Benny.
- ``digest_chars`` — what the planner actually reads back (the cost that remains).
- ``artifact_chars`` — what the planner would have read if it did the work itself.
- ``planner_tokens_saved_estimate`` — ``local_completion_tokens`` (the deliverable
  the planner did NOT have to generate). An ESTIMATE: the true figure depends on
  the planner's own verbosity. Labelled as such everywhere.
- ``escalated`` — whether the planner had to engage after all.

The number that matters for the project goal is *planner-tokens-per-completed-task*,
tracked as ``digest_chars`` (read-back cost) against ``escalated`` (engagement rate).
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .paths import LEDGER, offload_subdir


@dataclass
class LedgerEntry:
    task_id: str
    workspace: str
    ts: str
    declared_tier: str
    final_tier: str
    upgraded: bool
    status: str  # passed | failed | escalated | red-escalated
    escalated: bool
    iterations: int
    local_model: str
    judge_model: str
    local_prompt_tokens: int
    local_completion_tokens: int
    judge_score: Optional[float]
    collusion_flag: bool
    digest_chars: int
    artifact_chars: int
    duration_ms: int
    planner_tokens_saved_estimate: int
    note: str = ""


def _ledger_file(workspace: str) -> Path:
    return offload_subdir(workspace, LEDGER) / "offload.jsonl"


def record(entry: LedgerEntry) -> Path:
    path = _ledger_file(entry.workspace)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")
    return path


def read_all(workspace: str) -> list[Dict[str, Any]]:
    path = _ledger_file(workspace)
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
