"""
Benny Doctor — Automated health probes for the portable stack.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import List, Tuple

import httpx
from benny.core.models import LOCAL_PROVIDERS, is_local_model, _offline_enabled
from benny.core.manifest import SwarmManifest, MANIFEST_SCHEMA_VERSION
from benny.core.workspace import load_manifest

from pydantic import BaseModel


class CheckResult(BaseModel):
    name: str
    status: str  # "OK", "WARN", "ERROR"
    message: str


class DoctorReport(BaseModel):
    checks: List[CheckResult]

    @property
    def status_code(self) -> int:
        """Exit code: 0 (OK), 1 (ERROR), 2 (WARN only)."""
        if any(c.status == "ERROR" for c in self.checks):
            return 1
        if any(c.status == "WARN" for c in self.checks):
            return 2
        return 0


def _home() -> Path | None:
    h = os.environ.get("BENNY_HOME")
    return Path(h) if h else None


def check_home_dir() -> CheckResult:
    home = _home()
    if not home:
        return CheckResult(name="BENNY_HOME", status="ERROR", message="Environment variable not set.")
    if not home.exists():
        return CheckResult(name="BENNY_HOME", status="ERROR", message=f"Path does not exist: {home}")
    try:
        test_file = home / ".doctor_write_test"
        test_file.write_text("ok")
        test_file.unlink()
        return CheckResult(name="BENNY_HOME", status="OK", message=f"Valid and writable: {home}")
    except Exception as e:
        return CheckResult(name="BENNY_HOME", status="ERROR", message=f"Path not writable: {e}")


def check_structure() -> CheckResult:
    home = _home()
    if not home:
        return CheckResult(name="Structure", status="ERROR", message="BENNY_HOME not set; cannot check.")

    required = ["bin", "config", "workspaces", "logs", "state", "data", "models", "tmp"]
    missing = [d for d in required if not (home / d).is_dir()]

    if not missing:
        return CheckResult(name="Structure", status="OK", message="All required directories present.")
    return CheckResult(name="Structure", status="ERROR", message=f"Missing directories: {', '.join(missing)}")


def check_python() -> CheckResult:
    """Verify Python version and that the running interpreter matches the pinned venv."""
    vi = sys.version_info
    version_str = f"{vi.major}.{vi.minor}.{vi.micro}"

    if vi < (3, 9):
        return CheckResult(
            name="Python",
            status="ERROR",
            message=f"Python {version_str} is too old — Benny requires 3.9+.",
        )

    home = _home()
    if home:
        pinned_path = home / "state" / "python-path"
        if pinned_path.is_file():
            pinned = pinned_path.read_text(encoding="utf-8").strip()
            current = sys.executable
            if Path(pinned).resolve() != Path(current).resolve():
                return CheckResult(
                    name="Python",
                    status="WARN",
                    message=(
                        f"Running Python ({current}) differs from the pinned venv "
                        f"({pinned}). Re-run `benny init` from the correct venv to update."
                    ),
                )
            return CheckResult(name="Python", status="OK", message=f"{version_str}  {current}")

    return CheckResult(name="Python", status="OK", message=f"{version_str}  {sys.executable}")


def check_launchers() -> CheckResult:
    """Verify that the bin/ launcher scripts exist."""
    home = _home()
    if not home:
        return CheckResult(name="Launchers", status="WARN", message="BENNY_HOME not set; skipping.")

    bin_dir = home / "bin"
    expected = (
        ["benny.cmd", "benny-ui.cmd", "benny-llm.cmd", "benny-neo4j.cmd"]
        if sys.platform == "win32"
        else ["benny", "benny-ui", "benny-llm", "benny-neo4j"]
    )
    missing = [f for f in expected if not (bin_dir / f).is_file()]
    if missing:
        return CheckResult(
            name="Launchers",
            status="ERROR",
            message=f"Missing launcher scripts: {', '.join(missing)}. Re-run `benny init`.",
        )

    # Spot-check: the main launcher must reference a real Python executable.
    launcher_file = bin_dir / ("benny.cmd" if sys.platform == "win32" else "benny")
    content = launcher_file.read_text(encoding="utf-8")
    pinned_path = home / "state" / "python-path"
    if pinned_path.is_file():
        pinned = pinned_path.read_text(encoding="utf-8").strip()
        # Normalise separators before comparing (launcher uses forward slashes).
        pinned_normalised = pinned.replace("\\", "/")
        if pinned_normalised not in content:
            return CheckResult(
                name="Launchers",
                status="WARN",
                message="Launcher may reference a stale Python path. Re-run `benny init` to refresh.",
            )

    return CheckResult(name="Launchers", status="OK", message=f"{bin_dir}")


def check_config() -> CheckResult:
    """Verify benny.toml is present and loadable."""
    home = _home()
    if not home:
        return CheckResult(name="Config", status="WARN", message="BENNY_HOME not set; skipping.")

    toml = home / "config" / "benny.toml"
    if not toml.is_file():
        return CheckResult(
            name="Config",
            status="ERROR",
            message=f"config/benny.toml missing. Re-run `benny init --home {home}`.",
        )
    try:
        from benny.portable.config import load
        load(home)
        return CheckResult(name="Config", status="OK", message=str(toml))
    except Exception as exc:
        return CheckResult(name="Config", status="ERROR", message=f"benny.toml unreadable: {exc}")


async def probe_service(name: str, url: str) -> Tuple[bool, str]:
    async with httpx.AsyncClient(timeout=2.0) as client:
        try:
            resp = await client.get(url)
            if resp.status_code < 500:
                return True, f"HTTP {resp.status_code}"
            return False, f"HTTP {resp.status_code}"
        except Exception as e:
            msg = str(e) or type(e).__name__
            return False, f"unreachable ({msg})"


async def check_services() -> List[CheckResult]:
    results = []

    for p_id, p_info in LOCAL_PROVIDERS.items():
        name = p_info.get("name", p_id)
        url = p_info.get("check_url")
        if not url:
            results.append(CheckResult(name=f"Service: {name}", status="OK", message="Static library (no probe)"))
            continue
        ok, msg = await probe_service(name, url)
        results.append(CheckResult(name=f"Service: {name}", status="OK" if ok else "WARN", message=msg))

    # Derive API port from benny.toml when possible.
    api_port = 8000
    home = _home()
    if home:
        try:
            from benny.portable.config import load
            cfg = load(home)
            api_port = cfg.api_port
        except Exception:
            pass

    ok, msg = await probe_service("Backend API", f"http://127.0.0.1:{api_port}/")
    results.append(CheckResult(name="Backend API", status="OK" if ok else "WARN", message=msg))

    return results


def check_offline_policy() -> CheckResult:
    offline = _offline_enabled()
    try:
        manifest = load_manifest("default")
        default_model = manifest.default_model
        if offline and default_model and not is_local_model(default_model):
            return CheckResult(
                name="Offline Policy",
                status="WARN",
                message=(
                    f"BENNY_OFFLINE=1 but default_model '{default_model}' is cloud-based. "
                    "Tasks will fail until a local model is set."
                ),
            )
    except Exception:
        pass
    return CheckResult(
        name="Offline Policy",
        status="OK",
        message="Compliant" if offline else "Offline mode disabled.",
    )


def check_hardware_clock() -> CheckResult:
    current_year = time.gmtime().tm_year
    if current_year < 2024:
        return CheckResult(
            name="Hardware Clock",
            status="ERROR",
            message=f"System year ({current_year}) is suspiciously in the past. Check CMOS battery.",
        )
    return CheckResult(
        name="Hardware Clock",
        status="OK",
        message=f"System time verified: {time.strftime('%Y-%m-%d')}",
    )


def check_kg3d_stack() -> List[CheckResult]:
    results = []
    home = _home()
    if home:
        cache_path = home / "data" / "kg3d_metrics.db"
        if cache_path.exists():
            results.append(CheckResult(name="KG3D: Metrics Cache", status="OK", message="Database exists."))
        else:
            results.append(CheckResult(name="KG3D: Metrics Cache", status="WARN", message="Will be created on first run."))
    return results


async def run_doctor() -> DoctorReport:
    checks: List[CheckResult] = []
    checks.append(check_home_dir())
    checks.append(check_python())
    checks.append(check_launchers())
    checks.append(check_config())
    checks.append(check_structure())
    checks.append(check_hardware_clock())
    checks.append(check_offline_policy())

    service_checks = await check_services()
    checks.extend(service_checks)

    checks.append(CheckResult(name="Manifest Schema", status="OK", message=f"v{MANIFEST_SCHEMA_VERSION}"))
    checks.extend(check_kg3d_stack())

    return DoctorReport(checks=checks)
