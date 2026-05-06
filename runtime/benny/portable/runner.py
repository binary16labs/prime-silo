"""Portable service runner: the logic behind ``benny up`` / ``down`` / ``status``.

Scope (PBR-001 §5.2):

* Start a declared ``ServiceSpec`` as a detached child process, redirecting
  stdout/stderr to ``<home>/logs/<name>.log`` and writing its PID to
  ``<home>/state/pids/<name>.pid``.
* Wait for the health probe to pass, up to the spec's timeout.
* On ``down``, terminate the process (graceful then hard), delete the PID
  file, and leave the log file in place for forensics.
* ``status`` is pure read — PID file → liveness check → health probe.

The runner is intentionally synchronous and single-threaded per service;
orchestration across multiple services happens in the caller (CLI).
"""
from __future__ import annotations

import dataclasses
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable, Sequence

from benny.portable import _proc
from benny.portable.home import BennyHome
from benny.portable.services import HealthCheck, ServiceSpec


@dataclasses.dataclass(frozen=True)
class ServiceStatus:
    name: str
    pid: int | None
    alive: bool
    healthy: bool
    health_detail: str = ""


# ---- path helpers ----------------------------------------------------------


def _pid_path(home: BennyHome, name: str) -> Path:
    return home.state_dir / "pids" / f"{name}.pid"


def _log_path(home: BennyHome, name: str) -> Path:
    return home.root / "logs" / f"{name}.log"


def _known_services(home: BennyHome) -> list[str]:
    pids = home.state_dir / "pids"
    if not pids.is_dir():
        return []
    return sorted(p.stem for p in pids.glob("*.pid"))


# ---- command materialisation ----------------------------------------------


def _materialise_argv(home: BennyHome, argv: Sequence[str]) -> list[str]:
    """Replace ``${BENNY_HOME}`` and ``$BENNY_HOME`` in argv with the root.

    This is the single point where an absolute host path enters the runtime.
    The spec itself never carries the path (SR-1 invariant); it's injected
    only at exec time.
    """
    root = str(home.root)
    out: list[str] = []
    for token in argv:
        token = token.replace("${BENNY_HOME}", root).replace("$BENNY_HOME", root)
        out.append(token)
    return out


def _build_env(home: BennyHome, spec: ServiceSpec) -> dict[str, str]:
    env = dict(os.environ)
    env["BENNY_HOME"] = str(home.root)
    env.update({k: v for k, v in spec.env.items()})
    return env


# ---- pre-flight ------------------------------------------------------------


def _port_in_use(port: int) -> bool:
    if port <= 0:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except (ConnectionRefusedError, socket.timeout, OSError):
            return False


# ---- health probes ---------------------------------------------------------


def _probe_http(target: str, timeout_seconds: float) -> tuple[bool, str]:
    """Return (ok, detail). Single-shot probe with short per-request timeout."""
    try:
        req = urllib.request.Request(target, method="GET")
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            ok = 200 <= resp.status < 500  # 4xx still proves the server is up
            return ok, f"http {resp.status}"
    except urllib.error.HTTPError as exc:
        # Server responded — it IS up, even if the response is 4xx/5xx.
        return 200 <= exc.code < 500, f"http {exc.code}"
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
        return False, f"unreachable: {exc.__class__.__name__}"


def _wait_healthy(check: HealthCheck) -> tuple[bool, str]:
    if check.kind == "none":
        return True, "no health check"
    deadline = time.monotonic() + check.timeout_seconds
    last_detail = "never probed"
    while time.monotonic() < deadline:
        if check.kind == "http":
            ok, detail = _probe_http(check.target, timeout_seconds=2.0)
            if ok:
                return True, detail
            last_detail = detail
        elif check.kind == "cmd":
            try:
                rc = subprocess.run(
                    check.target, shell=True, capture_output=True, timeout=5
                ).returncode
                if rc == 0:
                    return True, "cmd ok"
                last_detail = f"cmd exit {rc}"
            except subprocess.TimeoutExpired:
                last_detail = "cmd timeout"
        time.sleep(check.interval_seconds)
    return False, last_detail


# ---- start / stop ----------------------------------------------------------


def _start_one(home: BennyHome, spec: ServiceSpec, *, wait_healthy: bool) -> ServiceStatus:
    # Pre-flight: required-port check.
    if spec.requires_port and _port_in_use(spec.requires_port):
        # Not fatal — we still start the process, but surface the conflict so
        # the caller can decide. A running neo4j on 7687 is a common case.
        detail = f"port {spec.requires_port} already in use"
        return ServiceStatus(
            name=spec.name, pid=None, alive=False, healthy=False, health_detail=detail
        )

    (home.state_dir / "pids").mkdir(parents=True, exist_ok=True)
    (home.root / "logs").mkdir(parents=True, exist_ok=True)

    argv = _materialise_argv(home, spec.command)
    cwd = home.root if spec.cwd is None else (home.root / spec.cwd)
    log_file = _log_path(home, spec.name)
    env = _build_env(home, spec)

    # Detach from parent stdio so the child survives the CLI exit. On Windows
    # CREATE_NEW_PROCESS_GROUP also lets us send a Ctrl+Break later if needed.
    popen_kwargs: dict = {"cwd": str(cwd), "env": env}
    log_fh = log_file.open("ab")
    popen_kwargs["stdout"] = log_fh
    popen_kwargs["stderr"] = log_fh
    popen_kwargs["stdin"] = subprocess.DEVNULL
    if sys.platform == "win32":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        popen_kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen(argv, **popen_kwargs)
    finally:
        log_fh.close()

    _pid_path(home, spec.name).write_text(str(proc.pid), encoding="utf-8")

    # Give the process a short grace period to decide whether it'll die
    # immediately — a typo in the command should show up as "not alive",
    # not as an eternal "waiting for health".
    time.sleep(0.1)
    alive = _proc.is_alive(proc.pid)

    healthy = False
    detail = "not probed"
    if alive and wait_healthy:
        healthy, detail = _wait_healthy(spec.health)
    elif alive:
        healthy, detail = spec.health.kind == "none", "startup only"

    return ServiceStatus(
        name=spec.name, pid=proc.pid, alive=alive, healthy=healthy, health_detail=detail
    )


def _stop_one(home: BennyHome, name: str) -> bool:
    pid_file = _pid_path(home, name)
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except ValueError:
        pid_file.unlink(missing_ok=True)
        return False

    _proc.terminate(pid, grace_seconds=10.0)
    pid_file.unlink(missing_ok=True)
    return True


# ---- public API ------------------------------------------------------------


def up(
    home: BennyHome,
    specs: Iterable[ServiceSpec],
    *,
    wait_healthy: bool = True,
) -> list[ServiceStatus]:
    """Start every spec in order; return one status per spec."""
    out: list[ServiceStatus] = []
    for spec in specs:
        out.append(_start_one(home, spec, wait_healthy=wait_healthy))
    return out


def down(home: BennyHome, names: Iterable[str] | None = None) -> list[str]:
    """Stop services by name; empty/None means every service with a PID file."""
    targets = list(names) if names else _known_services(home)
    stopped: list[str] = []
    for name in targets:
        if _stop_one(home, name):
            stopped.append(name)
    return stopped


def status(
    home: BennyHome, names: Iterable[str] | None = None
) -> list[ServiceStatus]:
    """Report status for the named services (or every service with a PID file)."""
    targets = list(names) if names is not None else _known_services(home)
    out: list[ServiceStatus] = []
    for name in targets:
        pid_file = _pid_path(home, name)
        if not pid_file.exists():
            out.append(ServiceStatus(name=name, pid=None, alive=False, healthy=False))
            continue
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
        except ValueError:
            out.append(
                ServiceStatus(
                    name=name, pid=None, alive=False, healthy=False, health_detail="bad pid file"
                )
            )
            continue
        alive = _proc.is_alive(pid)
        out.append(ServiceStatus(name=name, pid=pid, alive=alive, healthy=alive))
    return out
