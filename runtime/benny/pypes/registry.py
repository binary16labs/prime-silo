"""OperationRegistry — engine-agnostic dispatcher for pypes transformations.

Design goals:
  * A manifest says ``{"operation": "filter", "params": {...}}`` and the
    registry routes it to the engine's ``filter`` primitive without the
    orchestrator needing to know whether we're on Pandas, Polars, or
    something else.
  * Registering a custom operation is *one decorator call* and never
    touches the engine code.
  * Every registered op has a stable signature: ``(engine, df, **params) -> df``.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from .models import OperationSpec

OperationHandler = Callable[..., Any]


class OperationRegistry:
    """Central dispatcher for transformation operations."""

    def __init__(self) -> None:
        self._ops: Dict[str, OperationHandler] = {}

    def register(self, name: str, handler: OperationHandler) -> None:
        if name in self._ops:
            raise ValueError(f"Operation '{name}' is already registered")
        self._ops[name] = handler

    def register_decorator(self, name: str) -> Callable[[OperationHandler], OperationHandler]:
        def _wrap(fn: OperationHandler) -> OperationHandler:
            self.register(name, fn)
            return fn

        return _wrap

    def has(self, name: str) -> bool:
        return name in self._ops

    def execute(self, engine: Any, df: Any, op: OperationSpec) -> Any:
        handler = self._ops.get(op.operation)
        if handler is None:
            raise KeyError(
                f"Unknown operation '{op.operation}'. Registered: {sorted(self._ops)}"
            )
        return handler(engine, df, **op.params)

    def names(self) -> list[str]:
        return sorted(self._ops)


# =============================================================================
# DEFAULT REGISTRY — populated with pandas-first implementations of the
# primitives every pipeline is likely to need. Each handler is deliberately
# thin: it leans on the engine to do real work where possible.
# =============================================================================


default_registry = OperationRegistry()


@default_registry.register_decorator("load")
def _op_load(engine: Any, df: Any, source_id: Optional[str] = None, **_: Any) -> Any:
    """Tag rows with a source_id (provenance marker). Pass-through if None."""
    if df is None:
        return df
    if source_id is not None and hasattr(engine, "add_column"):
        return engine.add_column(df, "_pypes_source", source_id)
    return df


@default_registry.register_decorator("standardize")
def _op_standardize(engine: Any, df: Any, columns: Optional[list] = None, case: str = "upper", **_: Any) -> Any:
    return engine.standardize(df, columns=columns, case=case)


@default_registry.register_decorator("filter")
def _op_filter(engine: Any, df: Any, column: Optional[str] = None, op: str = "==", value: Any = None, expr: Optional[str] = None, **_: Any) -> Any:
    return engine.filter(df, column=column, op=op, value=value, expr=expr)


@default_registry.register_decorator("select")
def _op_select(engine: Any, df: Any, columns: list, **_: Any) -> Any:
    return engine.select(df, columns)


@default_registry.register_decorator("rename")
def _op_rename(engine: Any, df: Any, mapping: Dict[str, str], **_: Any) -> Any:
    return engine.rename(df, mapping)


@default_registry.register_decorator("cast")
def _op_cast(engine: Any, df: Any, mapping: Dict[str, str], **_: Any) -> Any:
    return engine.cast(df, mapping)


@default_registry.register_decorator("calc")
def _op_calc(engine: Any, df: Any, target: str, expr: str, **_: Any) -> Any:
    return engine.calc(df, target=target, expr=expr)


@default_registry.register_decorator("join")
def _op_join(engine: Any, df: Any, right: str, on: list, how: str = "inner", context: Optional[Dict[str, Any]] = None, **_: Any) -> Any:
    """``right`` refers to another step output carried in the context."""
    context = context or {}
    right_df = context.get(right)
    if right_df is None:
        raise KeyError(f"join.right='{right}' not found in pipeline context")
    return engine.join(df, right_df, on=on, how=how)


@default_registry.register_decorator("aggregate")
def _op_aggregate(engine: Any, df: Any, group_by: list, metrics: Dict[str, str], **_: Any) -> Any:
    return engine.aggregate(df, group_by=group_by, metrics=metrics)


@default_registry.register_decorator("dedupe")
def _op_dedupe(engine: Any, df: Any, subset: Optional[list] = None, keep: str = "first", **_: Any) -> Any:
    return engine.dedupe(df, subset=subset, keep=keep)


@default_registry.register_decorator("sort")
def _op_sort(engine: Any, df: Any, by: list, descending: bool = False, **_: Any) -> Any:
    return engine.sort(df, by=by, descending=descending)


@default_registry.register_decorator("union")
def _op_union(engine: Any, df: Any, right: str, context: Optional[Dict[str, Any]] = None, **_: Any) -> Any:
    context = context or {}
    right_df = context.get(right)
    if right_df is None:
        raise KeyError(f"union.right='{right}' not found in pipeline context")
    return engine.union(df, right_df)


@default_registry.register_decorator("mask_pii")
def _op_mask_pii(engine: Any, df: Any, columns: list, hash_with: str = "sha256", **_: Any) -> Any:
    return engine.mask_pii(df, columns=columns, hash_with=hash_with)
