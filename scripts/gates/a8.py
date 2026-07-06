#!/usr/bin/env python3
"""Gate A8 — model-routing hygiene + ingest resilience.

Hermetic (mocked providers; no live services needed):
  1. pytest runtime/tests/core/test_model_affinity.py — affinity order,
     loaded-model preference, loud+sticky roulette.
  2. node tests/longview_ingest_state_test.mjs — task stall detection,
     wiki-evidence reconcile (retry processes exactly the remainder).

Exit 0 = gate green.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(label: str, cmd: list, cwd: Path) -> bool:
    print(f"[a8] {label}: {' '.join(cmd)}")
    p = subprocess.run(cmd, cwd=str(cwd))
    print(f"[a8] {label}: {'PASS' if p.returncode == 0 else 'FAIL'}")
    return p.returncode == 0


def main() -> int:
    ok = True
    ok &= run(
        "python affinity/roulette tests",
        [sys.executable, "-m", "pytest", "tests/core/test_model_affinity.py", "-q"],
        ROOT / "runtime",
    )
    ok &= run(
        "node ingest-state tests",
        ["node", "tests/longview_ingest_state_test.mjs"],
        ROOT,
    )
    if not ok:
        print("[a8] GATE FAILED")
        return 1
    print("[a8] GATE GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
