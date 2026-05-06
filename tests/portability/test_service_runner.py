"""Phase 1b — `benny up` / `benny down` / `benny status` process lifecycle.

Covers PBR-001 §5.2: the portable runner must start declared services, track
them by PID under ``<home>/state/pids/``, stream logs to ``<home>/logs/``,
wait for health, and shut down cleanly on ``down``.

Tests use stub commands (the current Python interpreter running a sleep loop)
and a local stdlib HTTP stub for the health probe, so nothing here requires
Neo4j, Lemonade, or any real external binary.
"""
from __future__ import annotations

import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from benny.portable import home as home_mod
from benny.portable import runner as runner_mod
from benny.portable import services as services_mod


# ---- fixtures --------------------------------------------------------------


@pytest.fixture
def fresh_home(tmp_path: Path) -> home_mod.BennyHome:
    return home_mod.init(tmp_path / "optimus", profile="native")


def _long_running_argv(tag: str = "svc") -> tuple[str, ...]:
    """A stub service that prints a heartbeat then sleeps."""
    script = (
        "import time, sys\n"
        f"sys.stdout.write('{tag} up\\n'); sys.stdout.flush()\n"
        "time.sleep(60)\n"
    )
    return (sys.executable, "-c", script)


def _exit_quickly_argv(code: int) -> tuple[str, ...]:
    return (sys.executable, "-c", f"import sys; sys.exit({code})")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args, **kwargs) -> None:  # pragma: no cover - silence
        pass


@pytest.fixture
def http_stub():
    port = _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


# ---- spec construction -----------------------------------------------------


def test_default_services_declared_for_portable_stack(fresh_home: home_mod.BennyHome) -> None:
    """The portable stack — neo4j, lemonade, api, ui — is declared up front."""
    from benny.portable import config as cfg_mod

    cfg = cfg_mod.load(fresh_home.root)
    specs = services_mod.default_services(cfg)
    names = {s.name for s in specs.values()}
    assert {"neo4j", "lemonade", "api", "ui"}.issubset(names)
    # Each spec must carry a health check (even if 'none' is explicit).
    for spec in specs.values():
        assert spec.health is not None, f"{spec.name} has no health check"


# ---- AC-UP-1 ---------------------------------------------------------------


def test_up_starts_service_and_writes_pid(fresh_home: home_mod.BennyHome) -> None:
    spec = services_mod.ServiceSpec(
        name="stub",
        command=_long_running_argv("stub"),
        health=services_mod.HealthCheck(kind="none", target=""),
    )
    results = runner_mod.up(fresh_home, [spec], wait_healthy=False)
    try:
        assert len(results) == 1
        res = results[0]
        assert res.alive, f"service not alive: {res}"
        assert res.pid and res.pid > 0

        pid_file = fresh_home.state_dir / "pids" / "stub.pid"
        assert pid_file.is_file()
        assert int(pid_file.read_text(encoding="utf-8").strip()) == res.pid

        log_file = fresh_home.root / "logs" / "stub.log"
        assert log_file.is_file()
    finally:
        runner_mod.down(fresh_home, ["stub"])


def test_up_waits_for_http_health(fresh_home: home_mod.BennyHome, http_stub: int) -> None:
    spec = services_mod.ServiceSpec(
        name="stubweb",
        command=_long_running_argv("stubweb"),
        health=services_mod.HealthCheck(
            kind="http",
            target=f"http://127.0.0.1:{http_stub}/health",
            timeout_seconds=5.0,
        ),
    )
    results = runner_mod.up(fresh_home, [spec], wait_healthy=True)
    try:
        assert results[0].healthy, f"expected healthy, got {results[0]}"
        assert results[0].alive
    finally:
        runner_mod.down(fresh_home, ["stubweb"])


def test_up_reports_unhealthy_when_health_fails(fresh_home: home_mod.BennyHome) -> None:
    bad_port = _free_port()  # nothing listening here
    spec = services_mod.ServiceSpec(
        name="stubfail",
        command=_long_running_argv("stubfail"),
        health=services_mod.HealthCheck(
            kind="http",
            target=f"http://127.0.0.1:{bad_port}/health",
            timeout_seconds=1.5,
        ),
    )
    results = runner_mod.up(fresh_home, [spec], wait_healthy=True)
    try:
        assert results[0].alive, "process should still be alive"
        assert not results[0].healthy, "health must fail"
    finally:
        runner_mod.down(fresh_home, ["stubfail"])


# ---- AC-DOWN-1 -------------------------------------------------------------


def test_down_terminates_and_cleans_pids(fresh_home: home_mod.BennyHome) -> None:
    spec = services_mod.ServiceSpec(
        name="stub2",
        command=_long_running_argv("stub2"),
        health=services_mod.HealthCheck(kind="none", target=""),
    )
    runner_mod.up(fresh_home, [spec], wait_healthy=False)
    pid_file = fresh_home.state_dir / "pids" / "stub2.pid"
    assert pid_file.is_file(), "precondition: pid file written"

    stopped = runner_mod.down(fresh_home, ["stub2"])
    assert "stub2" in stopped
    assert not pid_file.exists(), "pid file must be removed after down"

    # Status after down: not alive.
    statuses = runner_mod.status(fresh_home, ["stub2"])
    assert len(statuses) == 1
    assert not statuses[0].alive


def test_down_is_safe_when_nothing_running(fresh_home: home_mod.BennyHome) -> None:
    # No pid files exist yet; down must be a no-op, not an error.
    stopped = runner_mod.down(fresh_home, ["stub-never-started"])
    assert stopped == []


def test_down_all_stops_every_known_service(fresh_home: home_mod.BennyHome) -> None:
    specs = [
        services_mod.ServiceSpec(
            name=f"s{i}",
            command=_long_running_argv(f"s{i}"),
            health=services_mod.HealthCheck(kind="none", target=""),
        )
        for i in range(3)
    ]
    runner_mod.up(fresh_home, specs, wait_healthy=False)
    stopped = runner_mod.down(fresh_home)  # no names = stop everything
    assert set(stopped) == {"s0", "s1", "s2"}
    for name in ("s0", "s1", "s2"):
        assert not (fresh_home.state_dir / "pids" / f"{name}.pid").exists()


# ---- AC-STATUS-1 -----------------------------------------------------------


def test_status_reports_not_running_when_no_pid(fresh_home: home_mod.BennyHome) -> None:
    statuses = runner_mod.status(fresh_home, ["ghost"])
    assert len(statuses) == 1
    assert statuses[0].name == "ghost"
    assert statuses[0].pid is None
    assert not statuses[0].alive


def test_status_detects_dead_process_from_stale_pid(fresh_home: home_mod.BennyHome) -> None:
    """If a service crashes, its pid file goes stale; status must notice."""
    pids = fresh_home.state_dir / "pids"
    pids.mkdir(parents=True, exist_ok=True)
    # Pick a PID that is almost certainly not ours. 2**31 - 2 is safe.
    (pids / "ghost.pid").write_text("2147483646", encoding="utf-8")

    statuses = runner_mod.status(fresh_home, ["ghost"])
    assert statuses[0].pid == 2147483646
    assert not statuses[0].alive


# ---- AC-FR1..5-e — port conflict detection ---------------------------------


def test_up_refuses_when_port_already_bound(fresh_home: home_mod.BennyHome) -> None:
    """If a declared HTTP health target is already serving, the pre-flight
    check must flag it — we must not start a second copy on top of a running
    instance."""
    # Take a port, then declare a service whose health target would point at it
    # *before* starting. This is the classic 'neo4j already running' scenario.
    blocking = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocking.bind(("127.0.0.1", 0))
    blocking.listen(1)
    port = blocking.getsockname()[1]
    try:
        spec = services_mod.ServiceSpec(
            name="conflict",
            command=_long_running_argv("conflict"),
            health=services_mod.HealthCheck(
                kind="http",
                target=f"http://127.0.0.1:{port}/health",
                timeout_seconds=1.0,
            ),
            requires_port=port,
        )
        results = runner_mod.up(fresh_home, [spec], wait_healthy=False)
        try:
            # Either refused to start, or flagged port conflict in the status.
            assert results[0].health_detail and "port" in results[0].health_detail.lower()
        finally:
            runner_mod.down(fresh_home, ["conflict"])
    finally:
        blocking.close()
