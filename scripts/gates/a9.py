#!/usr/bin/env python3
"""Gate A9 — server-side call deadlines: a task may fail, but may never freeze.

Hermetic: mocked hung awaits, no live services.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    p = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/synthesis/test_call_deadlines.py", "-q"],
        cwd=str(ROOT / "runtime"),
    )
    print(f"[a9] {'GATE GREEN' if p.returncode == 0 else 'GATE FAILED'}")
    return p.returncode


if __name__ == "__main__":
    sys.exit(main())
