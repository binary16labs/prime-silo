"""Declarative portable-service registry.

Each ``ServiceSpec`` is the full, reproducible recipe for one service that
``benny up`` knows how to start — command line, working directory, env,
dependencies, and how to tell whether it's healthy. The registry is pure
data; the runner (``benny.portable.runner``) is what turns it into live
processes.

The four first-class services in PBR-001 are ``neo4j``, ``lemonade``,
``api``, and ``ui``. Their default specs are derived from the loaded
``PortableConfig`` so that port assignments, host-independent paths, and
profile-specific launcher scripts stay in one place.
"""
from __future__ import annotations

import dataclasses
import sys
from pathlib import Path
from typing import Literal, Mapping

from benny.portable.config import PortableConfig

# On Windows, launcher scripts in bin/ are .cmd files; on POSIX they have no extension.
_BIN_EXT = ".cmd" if sys.platform == "win32" else ""

# Locate the frontend dev dir relative to this file (benny/portable/ -> project root -> frontend/).
# Only used when app/ui doesn't exist in $BENNY_HOME (i.e. dev installs).
_PROJECT_ROOT = Path(__file__).parent.parent.parent
_DEV_FRONTEND_DIR = _PROJECT_ROOT / "frontend"

HealthKind = Literal["http", "cmd", "none"]


@dataclasses.dataclass(frozen=True)
class HealthCheck:
    kind: HealthKind
    target: str  # URL for http, shell command for cmd, empty for none
    timeout_seconds: float = 30.0
    interval_seconds: float = 0.5


@dataclasses.dataclass(frozen=True)
class ServiceSpec:
    name: str
    command: tuple[str, ...]
    health: HealthCheck
    depends_on: tuple[str, ...] = ()
    cwd: str | None = None  # relative to $BENNY_HOME; None = home root
    env: Mapping[str, str] = dataclasses.field(default_factory=dict)
    requires_port: int | None = None  # pre-flight: this port must be free


def default_services(config: PortableConfig) -> dict[str, ServiceSpec]:
    """Canonical portable-stack specs, derived from the loaded config.

    These are declarative — actually finding the binaries on disk is the
    launcher's job (``bin/benny-llm`` etc.). Phase 1b ships the specs and
    the runner; Phase 1c wires them to bundled binaries.
    """
    # Commands intentionally reference the launcher scripts under `bin/`
    # (forwarded through shell). The runner substitutes $BENNY_HOME at run
    # time, so the specs never carry an absolute host path.
    neo4j = ServiceSpec(
        name="neo4j",
        command=(f"${{BENNY_HOME}}/bin/benny-neo4j{_BIN_EXT}", "start"),
        health=HealthCheck(
            kind="http",
            target=f"http://127.0.0.1:{config.neo4j_http_port}/",
            timeout_seconds=60.0,
        ),
        requires_port=config.neo4j_bolt_port,
    )
    lemonade = ServiceSpec(
        name="lemonade",
        command=(f"${{BENNY_HOME}}/bin/benny-llm{_BIN_EXT}", "start"),
        health=HealthCheck(
            kind="http",
            target=f"http://127.0.0.1:{config.lemonade_port}/api/v1/models",
            timeout_seconds=45.0,
        ),
        requires_port=config.lemonade_port,
    )
    api = ServiceSpec(
        name="api",
        command=(
            sys.executable,
            "-m",
            "uvicorn",
            "benny.api.server:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(config.api_port),
        ),
        health=HealthCheck(
            kind="http",
            target=f"http://127.0.0.1:{config.api_port}/",
            timeout_seconds=30.0,
        ),
        requires_port=config.api_port,
    )
    _ui_env: dict[str, str] = {}
    if _DEV_FRONTEND_DIR.is_dir():
        _ui_env["BENNY_FRONTEND_DIR"] = str(_DEV_FRONTEND_DIR)
    ui = ServiceSpec(
        name="ui",
        command=(f"${{BENNY_HOME}}/bin/benny-ui{_BIN_EXT}", "start"),
        env=_ui_env,
        health=HealthCheck(
            kind="http",
            target=f"http://localhost:{config.ui_port}/",
            timeout_seconds=30.0,
        ),
        depends_on=("api",),
        requires_port=config.ui_port,
    )
    return {s.name: s for s in (neo4j, lemonade, api, ui)}
