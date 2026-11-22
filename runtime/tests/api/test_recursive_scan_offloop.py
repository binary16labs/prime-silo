"""T-010: /api/files/recursive-scan must not block the event loop.

Runs under pytest, or directly:  python tests/api/test_recursive_scan_offloop.py
(the bundled runtime Python has FastAPI + httpx but no pytest).

Checks:
  1. a slow walk (2 s, blocking) does not delay a concurrent /ping (done < 1 s after the scan began);
  2. `subdirs=data_in,staging` returns only those folders;
  3. `subdirs` that escape the workspace are refused with 400;
  4. a missing workspace is 404 (the old handler turned it into 500).
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="t010-home-")
os.environ["BENNY_HOME"] = _TMP  # must be set before benny is imported
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from benny.api import file_routes  # noqa: E402
from benny.core.workspace import WORKSPACE_ROOT  # noqa: E402


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(file_routes.router, prefix="/api/files")

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    return app


def _seed() -> None:
    ws = WORKSPACE_ROOT / "t010"
    for rel in ("data_in/a.pdf", "data_in/staging/b.md", "staging/c.txt", "data_out/big/d.json",
                "chromadb/e.bin"):
        p = ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x", encoding="utf-8")


async def _slow_scan_does_not_block() -> float:
    real = file_routes._scan_workspace

    def slow(*a, **k):
        time.sleep(2.0)  # blocking, like os.walk over a huge workspace
        return real(*a, **k)

    file_routes._scan_workspace = slow
    try:
        transport = httpx.ASGITransport(app=_make_app())
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            # Time from the scan's start, not from the ping's: a blocked loop
            # would also delay the sleep below, hiding the stall.
            t0 = time.perf_counter()
            scan = asyncio.create_task(c.get("/api/files/recursive-scan", params={"workspace": "t010"}))
            await asyncio.sleep(0.2)  # let the scan start
            r = await c.get("/ping")
            ping_s = time.perf_counter() - t0
            assert r.status_code == 200
            rs = await scan
            assert rs.status_code == 200, rs.text
            assert rs.json()["total"] == 5
            return ping_s
    finally:
        file_routes._scan_workspace = real


async def _subdirs_and_errors() -> None:
    transport = httpx.ASGITransport(app=_make_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/api/files/recursive-scan",
                        params={"workspace": "t010", "subdirs": "data_in,staging"})
        assert r.status_code == 200, r.text
        paths = sorted(f["path"].replace("\\", "/") for f in r.json()["files"])
        assert paths == ["data_in/a.pdf", "data_in/staging/b.md", "staging/c.txt"], paths

        for bad in ("../other", "data_in/../../x", "C:/Windows", "/etc"):
            r = await c.get("/api/files/recursive-scan", params={"workspace": "t010", "subdirs": bad})
            assert r.status_code == 400, (bad, r.status_code, r.text)

        r = await c.get("/api/files/recursive-scan", params={"workspace": "no_such_ws"})
        assert r.status_code == 404, (r.status_code, r.text)


def test_recursive_scan_offloop():
    _seed()
    ping_s = asyncio.run(_slow_scan_does_not_block())
    # The scan blocks for 2 s; /ping must finish well inside that window.
    assert ping_s < 1.0, f"/ping finished {ping_s:.2f}s after the scan began: event loop blocked"
    asyncio.run(_subdirs_and_errors())


if __name__ == "__main__":
    test_recursive_scan_offloop()
    print("PASS test_recursive_scan_offloop")
