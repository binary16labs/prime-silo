"""`$BENNY_HOME` layout, init, validate, and uninstall.

This module is the single authority for what a portable Benny install looks
like on disk. The layout is declared once, at the top, and every other piece
of the system resolves paths through a ``BennyHome`` instance.

See PBR-001 §4.1 for the declared shape.
"""
from __future__ import annotations

import dataclasses
import shutil
import sys
import uuid
from pathlib import Path
from typing import Iterable, Literal

Profile = Literal["app", "native"]

SCHEMA_VERSION = "1.0.0"

# Shared layout — present under both profiles.
SHARED_DIRS: tuple[str, ...] = (
    "bin",
    "config",
    "data",
    "data/runs",
    "data/lineage",
    "data/vector",
    "data/graph",
    "workspaces",
    "models",
    "logs",
    "tmp",
    "state",
)

# Profile-specific subtrees — mutually exclusive.
APP_DIRS: tuple[str, ...] = ("app",)
NATIVE_DIRS: tuple[str, ...] = ("runtime", "runtime/python", "runtime/node", "runtime/neo4j")

# Config files seeded on fresh init.
_BENNY_TOML_TEMPLATE = """# Portable Benny config (see PBR-001 §4.1).
# Paths declared here MUST be either relative or under this $BENNY_HOME root.
schema_version = "{schema_version}"
profile = "{profile}"

[runtime]
# Port assignments match benny/core/models.py LOCAL_PROVIDERS defaults.
lemonade_port = 13305
neo4j_bolt_port = 7687
neo4j_http_port = 7474
api_port = 8000
ui_port = 5173
"""

_VOICES_JSON = """{
  "_comment": "TTS voice registry; closes the hardcoded af_sky gap (PBR-001 §4.4).",
  "providers": {
    "lemonade": {
      "voices": ["af_sky", "bf_emma", "bm_george", "af_bella"],
      "default": "af_sky"
    }
  }
}
"""

_SERVER_OPS_ALLOWLIST_JSON = """{
  "_comment": "Allow-listed local-LLM server-ops targets (LC-2 scope).",
  "commands": ["status", "health", "start", "stop"],
  "services": ["lemonade", "ollama", "fastflowlm", "neo4j", "marquez"]
}
"""

# Portable launcher scripts (PBR-001 §4.3). Each launcher derives $BENNY_HOME
# from its own location so the SSD can be mounted at any drive letter or path.
# {python_exe} is substituted at seed time with the absolute path to the
# interpreter that ran `benny init`, ensuring launchers always use the venv.
_POSIX_LAUNCHER = """#!/usr/bin/env sh
# Portable Benny launcher (POSIX). Self-locates $BENNY_HOME.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export BENNY_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
exec {python_exe} -m benny_cli "$@"
"""

_WINDOWS_LAUNCHER = """@echo off
rem Portable Benny launcher (Windows). Self-locates %%BENNY_HOME%%.
rem Python path pinned to the venv that ran `benny init` — do not edit by hand;
rem re-run `benny init` if you recreate the venv.
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "BENNY_HOME=%%~fI"
"{python_exe}" -m benny_cli %*
"""

_POSIX_UI_LAUNCHER = """#!/usr/bin/env sh
# Starts the UI dev server.  Checks BENNY_FRONTEND_DIR first (dev installs),
# then $BENNY_HOME/app/ui (packaged installs), then $BENNY_HOME.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export BENNY_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -n "$BENNY_FRONTEND_DIR" ] && [ -d "$BENNY_FRONTEND_DIR" ]; then
    cd "$BENNY_FRONTEND_DIR"
elif [ -d "$BENNY_HOME/app/ui" ]; then
    cd "$BENNY_HOME/app/ui"
else
    cd "$BENNY_HOME"
fi
exec npm run dev -- "$@"
"""

_WINDOWS_UI_LAUNCHER = """@echo off
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "BENNY_HOME=%%~fI"
if defined BENNY_FRONTEND_DIR (
    cd /d "%BENNY_FRONTEND_DIR%"
) else if exist "%BENNY_HOME%\\app\\ui" (
    cd /d "%BENNY_HOME%\\app\\ui"
) else (
    cd /d "%BENNY_HOME%"
)
npm run dev -- %*
"""

_POSIX_LLM_LAUNCHER = """#!/usr/bin/env sh
# Starts the local LLM runtime (Lemonade). Placeholder until the bundled
# binary is side-loaded under models/ or app/; for now defers to PATH.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export BENNY_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
exec lemonade-server "$@"
"""

_WINDOWS_LLM_LAUNCHER = """@echo off
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "BENNY_HOME=%%~fI"
LemonadeServer.exe %*
"""

_POSIX_NEO4J_LAUNCHER = """#!/usr/bin/env sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export BENNY_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
exec neo4j "$@"
"""

_WINDOWS_NEO4J_LAUNCHER = """@echo off
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "BENNY_HOME=%%~fI"
neo4j.bat %*
"""

_LAUNCHERS: tuple[tuple[str, str, bool], ...] = (
    ("benny", _POSIX_LAUNCHER, True),
    ("benny.cmd", _WINDOWS_LAUNCHER, False),
    ("benny-ui", _POSIX_UI_LAUNCHER, True),
    ("benny-ui.cmd", _WINDOWS_UI_LAUNCHER, False),
    ("benny-llm", _POSIX_LLM_LAUNCHER, True),
    ("benny-llm.cmd", _WINDOWS_LLM_LAUNCHER, False),
    ("benny-neo4j", _POSIX_NEO4J_LAUNCHER, True),
    ("benny-neo4j.cmd", _WINDOWS_NEO4J_LAUNCHER, False),
    ("benny-mcp", _POSIX_LAUNCHER, True),   # mcp variant resolved in _seed_launchers
    ("benny-mcp.cmd", _WINDOWS_LAUNCHER, False),
)

# Project-root wrappers written next to benny_cli.py so `./benny` / `benny.bat`
# works from the project directory without activating the venv.
_PROJECT_POSIX_WRAPPER = """#!/usr/bin/env sh
# Quick-launch wrapper — run from the project root.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec {python_exe} "$SCRIPT_DIR/benny_cli.py" "$@"
"""

_PROJECT_WINDOWS_WRAPPER = """@echo off
rem Quick-launch wrapper — run from the project root without activating the venv.
set "SCRIPT_DIR=%~dp0"
"{python_exe}" "%SCRIPT_DIR%\\benny_cli.py" %*
"""

# Declarative compose manifest for the `app` profile (PBR-001 §4.3).
# Kept minimal and generic — the image tags are placeholders the app-profile
# builder pins at release time. Paths use relative-to-$BENNY_HOME forms only.
_COMPOSE_YML = """# Portable Benny — profile=app stack (see PBR-001 §4.3).
# This file is seeded on `benny init --profile app`. Paths MUST stay relative
# to the enclosing $BENNY_HOME; absolute host paths are rejected by SR-1.
version: "3.9"

services:
  neo4j:
    image: neo4j:5.20-community
    environment:
      NEO4J_AUTH: "neo4j/benny_local"
    ports:
      - "7474:7474"
      - "7687:7687"
    volumes:
      - ../data/graph:/data
      - ../logs:/logs

  api:
    image: benny-api:latest
    depends_on:
      - neo4j
    environment:
      BENNY_HOME: /benny-home
      NEO4J_URI: bolt://neo4j:7687
    ports:
      - "8000:8000"
    volumes:
      - ../:/benny-home

  ui:
    image: benny-ui:latest
    depends_on:
      - api
    ports:
      - "5173:5173"
"""


class PortableHomeError(RuntimeError):
    """Raised on illegal portable-home state transitions."""


@dataclasses.dataclass(frozen=True)
class BennyHome:
    root: Path
    profile: Profile

    @property
    def bin_dir(self) -> Path:
        return self.root / "bin"

    @property
    def config_dir(self) -> Path:
        return self.root / "config"

    @property
    def data_dir(self) -> Path:
        return self.root / "data"

    @property
    def workspaces_dir(self) -> Path:
        return self.root / "workspaces"

    @property
    def models_dir(self) -> Path:
        return self.root / "models"

    @property
    def state_dir(self) -> Path:
        return self.root / "state"

    @property
    def profile_subtree(self) -> Path:
        return self.root / ("app" if self.profile == "app" else "runtime")


@dataclasses.dataclass(frozen=True)
class ValidationReport:
    ok: bool
    problems: tuple[str, ...]


# ---- internals -------------------------------------------------------------


def _expected_dirs(profile: Profile) -> Iterable[str]:
    yield from SHARED_DIRS
    yield from (APP_DIRS if profile == "app" else NATIVE_DIRS)


def _read_existing_profile(root: Path) -> Profile | None:
    lock = root / "state" / "profile-lock"
    if not lock.is_file():
        return None
    value = lock.read_text(encoding="utf-8").strip()
    if value not in ("app", "native"):
        return None
    return value  # type: ignore[return-value]


def _seed_state(root: Path, profile: Profile) -> None:
    state = root / "state"
    state.mkdir(parents=True, exist_ok=True)

    device_id_path = state / "device-id"
    if not device_id_path.is_file():
        device_id_path.write_text(str(uuid.uuid4()), encoding="utf-8")

    (state / "schema-version").write_text(SCHEMA_VERSION, encoding="utf-8")
    (state / "profile-lock").write_text(profile, encoding="utf-8")


def _seed_launchers(root: Path, python_exe: str) -> None:
    """Write portable launcher scripts into ``<root>/bin/``.

    ``python_exe`` is the absolute path to the interpreter that ran
    ``benny init``; it is embedded directly in each launcher so that the
    correct venv Python is always used regardless of PATH.

    On POSIX we also chmod +x; on Windows the .cmd extension is what
    makes scripts runnable.
    """
    import os
    import stat

    bin_dir = root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)

    # Normalise path separators for cross-platform embedding.
    py = python_exe.replace("\\", "/")

    for name, template, executable in _LAUNCHERS:
        if name in ("benny-mcp", "benny-mcp.cmd"):
            # MCP variant: swap the module invocation.
            if name.endswith(".cmd"):
                content = template.format(python_exe=py).replace(
                    "-m benny_cli", "-m benny.mcp.server --stdio"
                )
            else:
                content = template.format(python_exe=py).replace(
                    'benny_cli "$@"', 'benny.mcp.server --stdio "$@"'
                )
        else:
            content = template.format(python_exe=py)

        path = bin_dir / name
        path.write_text(content, encoding="utf-8")
        if executable and os.name == "posix":
            mode = path.stat().st_mode
            path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # Record the Python path so `benny doctor` can verify it later.
    (root / "state").mkdir(parents=True, exist_ok=True)
    (root / "state" / "python-path").write_text(python_exe, encoding="utf-8")


def _seed_project_entry_points(project_root: Path, python_exe: str) -> None:
    """Write ``benny.bat`` / ``benny.sh`` next to ``benny_cli.py`` so users
    can launch Benny from the project directory without activating the venv.

    Uses ``benny.sh`` (not ``benny``) on POSIX to avoid a name collision with
    the ``benny/`` package directory that lives in the same project root.
    """
    import os
    import stat

    py = python_exe.replace("\\", "/")

    bat = project_root / "benny.bat"
    bat.write_text(_PROJECT_WINDOWS_WRAPPER.format(python_exe=py), encoding="utf-8")

    sh = project_root / "benny.sh"
    sh.write_text(_PROJECT_POSIX_WRAPPER.format(python_exe=py), encoding="utf-8")
    if os.name == "posix":
        mode = sh.stat().st_mode
        sh.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _seed_app_compose(root: Path) -> None:
    """Seed ``<root>/app/compose.yml`` for the `app` profile only."""
    compose = root / "app" / "compose.yml"
    compose.parent.mkdir(parents=True, exist_ok=True)
    if not compose.is_file():
        compose.write_text(_COMPOSE_YML, encoding="utf-8")


def _seed_config(root: Path, profile: Profile) -> None:
    config = root / "config"
    config.mkdir(parents=True, exist_ok=True)

    toml_path = config / "benny.toml"
    if not toml_path.is_file():
        toml_path.write_text(
            _BENNY_TOML_TEMPLATE.format(schema_version=SCHEMA_VERSION, profile=profile),
            encoding="utf-8",
        )

    (config / "profile").write_text(profile, encoding="utf-8")

    voices_path = config / "voices.json"
    if not voices_path.is_file():
        voices_path.write_text(_VOICES_JSON, encoding="utf-8")

    allow_path = config / "server_ops_allowlist.json"
    if not allow_path.is_file():
        allow_path.write_text(_SERVER_OPS_ALLOWLIST_JSON, encoding="utf-8")


# ---- public API ------------------------------------------------------------


def init(root: Path, *, profile: Profile) -> BennyHome:
    """Create or refresh a portable $BENNY_HOME. Idempotent within a profile.

    Raises ``PortableHomeError`` if the root was previously initialised with
    a different profile (cross-profile switching is handled by a future
    `benny migrate`, not init).
    """
    if profile not in ("app", "native"):
        raise PortableHomeError(f"unknown profile: {profile!r}")

    root = Path(root)
    existing = _read_existing_profile(root)
    if existing is not None and existing != profile:
        raise PortableHomeError(
            f"profile mismatch: $BENNY_HOME at {root} was initialised as "
            f"{existing!r}; refusing to switch to {profile!r}. "
            "Use `benny migrate` for cross-profile changes."
        )

    for rel in _expected_dirs(profile):
        (root / rel).mkdir(parents=True, exist_ok=True)

    python_exe = sys.executable
    _seed_state(root, profile)
    _seed_config(root, profile)
    _seed_launchers(root, python_exe)
    _seed_project_entry_points(Path(__file__).parent.parent.parent, python_exe)
    if profile == "app":
        _seed_app_compose(root)

    return BennyHome(root=root, profile=profile)


def validate(root: Path) -> ValidationReport:
    """FR-1 structural check. Returns a report; never raises for missing dirs."""
    root = Path(root)
    problems: list[str] = []

    profile = _read_existing_profile(root)
    if profile is None:
        return ValidationReport(ok=False, problems=("state/profile-lock missing or invalid",))

    for rel in _expected_dirs(profile):
        if not (root / rel).is_dir():
            problems.append(f"missing directory: {rel}")

    for rel in ("state/device-id", "state/schema-version", "config/benny.toml", "config/profile"):
        if not (root / rel).is_file():
            problems.append(f"missing file: {rel}")

    # Mutually-exclusive subtree invariant.
    if profile == "app" and (root / "runtime").exists():
        problems.append("profile=app but runtime/ exists")
    if profile == "native" and (root / "app").exists():
        problems.append("profile=native but app/ exists")

    return ValidationReport(ok=not problems, problems=tuple(problems))


def uninstall(root: Path, *, keep_data: bool) -> None:
    """Remove the app/runtime boundary. With ``keep_data=True``, workspaces,
    models, data, config, and state survive — only the disposable app layer
    is removed. With ``keep_data=False``, the entire tree is deleted.
    """
    root = Path(root)
    if not root.exists():
        return

    if not keep_data:
        shutil.rmtree(root)
        return

    for rel in APP_DIRS + NATIVE_DIRS:
        victim = root / rel
        if victim.exists():
            shutil.rmtree(victim)
    # `bin/` is part of the app layer under both profiles — remove it too,
    # it will be re-seeded on the next init.
    bin_dir = root / "bin"
    if bin_dir.exists():
        shutil.rmtree(bin_dir)
    # Profile-lock stays: the user's intent (app vs native) is preserved
    # across reinstall.
