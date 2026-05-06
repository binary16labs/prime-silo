"""Portable config loader.

Reads ``<root>/config/benny.toml`` and enforces FR-2: any absolute path in
the config must point inside the configured ``$BENNY_HOME``. Relative paths
are fine. Anything else is a load-time error.
"""
from __future__ import annotations

import dataclasses
import tomllib
from pathlib import Path
from typing import Any

from benny.governance.portability import absolute_path_scanner as _path_scanner


class PortableConfigError(ValueError):
    """Raised when a portable config violates FR-2 or is structurally bad."""


@dataclasses.dataclass(frozen=True)
class PortableConfig:
    schema_version: str
    profile: str
    lemonade_port: int
    neo4j_bolt_port: int
    neo4j_http_port: int
    api_port: int
    ui_port: int
    llm_timeout_seconds: int
    extra_data_dir: str | None


def _flatten(data: dict[str, Any], prefix: str = "") -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for k, v in data.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.extend(_flatten(v, key))
        else:
            out.append((key, v))
    return out


def _assert_no_foreign_absolute_paths(data: dict[str, Any], ssd_root: Path) -> None:
    ssd_root_str = ssd_root.as_posix()
    for key, value in _flatten(data):
        if not isinstance(value, str):
            continue
        hits = _path_scanner.scan_text(value, ssd_root=ssd_root_str)
        if hits:
            raise PortableConfigError(
                f"config value {key!r} contains an absolute host path outside "
                f"$BENNY_HOME: {value!r}"
            )


def load(root: Path) -> PortableConfig:
    """Load ``<root>/config/benny.toml``, enforcing FR-2."""
    root = Path(root)
    toml_path = root / "config" / "benny.toml"
    if not toml_path.is_file():
        raise PortableConfigError(f"missing config: {toml_path}")

    with toml_path.open("rb") as fh:
        data = tomllib.load(fh)

    _assert_no_foreign_absolute_paths(data, ssd_root=root)

    runtime = data.get("runtime", {})
    try:
        return PortableConfig(
            schema_version=str(data["schema_version"]),
            profile=str(data["profile"]),
            lemonade_port=int(runtime.get("lemonade_port", 13305)),
            neo4j_bolt_port=int(runtime.get("neo4j_bolt_port", 7687)),
            neo4j_http_port=int(runtime.get("neo4j_http_port", 7474)),
            api_port=int(runtime.get("api_port", 8000)),
            ui_port=int(runtime.get("ui_port", 5173)),
            llm_timeout_seconds=int(runtime.get("llm_timeout_seconds", 300)),
            extra_data_dir=data.get("extra_data_dir") or runtime.get("extra_data_dir"),
        )
    except KeyError as exc:
        raise PortableConfigError(f"missing required key: {exc.args[0]!r}") from exc
