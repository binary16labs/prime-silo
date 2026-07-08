#!/usr/bin/env python3
"""Gate G0 — unified run-event stream (lineage native to telemetry).

Hermetic (temp PRIME_SILO_HOME; no live services needed): runs the full
runtime/tests/pypes/ package — schema, DAG-freeze, heartbeats,
non-blocking degrade, and the Marquez-down wall-time budget (test_events.py)
plus the pre-existing orchestrator/checkpoint/report suite, proving no
regression from the G0 wiring.

Exit 0 = gate green.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    cmd = [sys.executable, "-m", "pytest", "tests/pypes/", "-q"]
    print(f"[g0] {' '.join(cmd)}")
    p = subprocess.run(cmd, cwd=str(ROOT / "runtime"))
    print(f"[g0] GATE {'GREEN' if p.returncode == 0 else 'FAILED'}")
    return 0 if p.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
