#!/usr/bin/env python
"""Gate L12 — human-signed model promotion + rollback.

The served model changes ONLY by human signature (never an auto-swap on a passing number), and every
promotion is reversible (pin + rollback recorded). Includes the unsigned-promotion NEGATIVE case
(must refuse) and the rollback restoration, with the default engine proven unchanged (additive, R36).

Hermetic: no network, no served endpoint — a temp pointer file. Contract: delivery/tasks/L12.md
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # prime-silo/
RUNTIME = REPO / "runtime"
sys.path.insert(0, str(RUNTIME))


def red(reason: str, msg: str):
    print(f"[l12] reason={reason} — {msg}")
    print("[l12] GATE RED")
    sys.exit(1)


def main():
    for rel in ("benny/router/promotion.py", "benny/router/tuned_engine.py"):
        if not (RUNTIME / rel).exists():
            red("missing_artifact", f"required artifact missing: runtime/{rel}")

    # Structural (hermetic): an unsigned promotion must be refused and leave the served position alone.
    from benny.router import promotion as pr  # noqa: E402
    from benny.router import tuned_engine as te  # noqa: E402
    import tempfile
    import os

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "served.json")
        pr.promote(p, "house/model-a", human_signature="owner-sig")
        refused = pr.promote(p, "house/model-b", human_signature=None)
        if refused.get("ok") is not False:
            red("structure_fail", "an unsigned promotion was NOT refused")
        if pr.read_served(p)["served"] != "house/model-a":
            red("structure_fail", "an unsigned promotion changed the served position")
        # additive: with no pointer the router's served id is the default (default engine unchanged).
        if te.served_engine_id(pointer_path=os.path.join(d, "none.json"), default="qwen3_5_9b") != "qwen3_5_9b":
            red("structure_fail", "served_engine_id changed the default with no promotion pointer")

    # Router unit tests (pytest, per the T4 precedent).
    r = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/router/test_promotion.py", "-q"],
        cwd=str(RUNTIME),
    )
    if r.returncode != 0:
        red("unit_fail", "promotion unit tests failed")

    print("[l12] structural OK — unsigned promotion refused; served pointer records predecessor + "
          "rollback; default unchanged (additive); units pass")
    print("[l12] GATE GREEN")
    sys.exit(0)


if __name__ == "__main__":
    main()
