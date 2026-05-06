"""Execution engine implementations.

``PandasEngine`` is the always-available default. ``PolarsEngine`` is
imported lazily and only registered if the ``polars`` package is
installed — absence is not an error, just a missing capability.
"""

from __future__ import annotations

from typing import Dict

from ..engine import ExecutionEngine
from ..models import EngineType
from .pandas_impl import PandasEngine

_registry: Dict[EngineType, ExecutionEngine] = {EngineType.PANDAS: PandasEngine()}

try:  # polars is optional
    from .polars_impl import PolarsEngine  # noqa: WPS433

    _registry[EngineType.POLARS] = PolarsEngine()
except Exception:  # pragma: no cover — missing optional dep
    PolarsEngine = None  # type: ignore[assignment]


def get_engine(kind: EngineType) -> ExecutionEngine:
    """Return the engine for ``kind`` or raise ``ValueError``.

    Unknown or unavailable engines fall back to Pandas with a
    non-fatal notice — most pipelines do not actually need the
    backend they nominally request for small workspaces.
    """
    engine = _registry.get(kind)
    if engine is None:
        # Fall back to pandas but remember which backend was asked for.
        fallback = _registry[EngineType.PANDAS]
        fallback.fallback_from = kind.value  # type: ignore[attr-defined]
        return fallback
    return engine


def available_engines() -> list[str]:
    return [k.value for k in _registry]


__all__ = ["PandasEngine", "PolarsEngine", "get_engine", "available_engines"]
