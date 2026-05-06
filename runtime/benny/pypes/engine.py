"""Execution engine protocol — the boundary between pypes and DataFrame libs.

Every engine implements the same small set of primitives. The
``OperationRegistry`` routes manifest-level operations to these
primitives, so a new backend (Polars, Ibis, PySpark) is a new
implementation of this protocol — not a fork of the orchestrator.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

from .models import SourceSpec


@runtime_checkable
class ExecutionEngine(Protocol):
    """Stateless primitive set required by the pypes operation registry."""

    name: str

    def load(self, source: SourceSpec, workspace_root: Optional[str] = None) -> Any: ...

    def save(self, df: Any, destination: SourceSpec, workspace_root: Optional[str] = None) -> None: ...

    def row_count(self, df: Any) -> int: ...

    def columns(self, df: Any) -> List[str]: ...

    def fingerprint(self, df: Any) -> str: ...

    # --- transformation primitives ------------------------------------------

    def add_column(self, df: Any, name: str, value: Any) -> Any: ...

    def standardize(self, df: Any, columns: Optional[List[str]] = None, case: str = "upper") -> Any: ...

    def filter(
        self,
        df: Any,
        column: Optional[str] = None,
        op: str = "==",
        value: Any = None,
        expr: Optional[str] = None,
    ) -> Any: ...

    def select(self, df: Any, columns: List[str]) -> Any: ...

    def rename(self, df: Any, mapping: Dict[str, str]) -> Any: ...

    def cast(self, df: Any, mapping: Dict[str, str]) -> Any: ...

    def calc(self, df: Any, target: str, expr: str) -> Any: ...

    def join(self, left: Any, right: Any, on: List[str], how: str = "inner") -> Any: ...

    def aggregate(self, df: Any, group_by: List[str], metrics: Dict[str, str]) -> Any: ...

    def dedupe(self, df: Any, subset: Optional[List[str]] = None, keep: str = "first") -> Any: ...

    def sort(self, df: Any, by: List[str], descending: bool = False) -> Any: ...

    def union(self, left: Any, right: Any) -> Any: ...

    def mask_pii(self, df: Any, columns: List[str], hash_with: str = "sha256") -> Any: ...

    # --- validation helpers --------------------------------------------------

    def null_count(self, df: Any, column: str) -> int: ...

    def duplicate_count(self, df: Any, columns: List[str]) -> int: ...

    def min_max(self, df: Any, column: str) -> Dict[str, Any]: ...

    def describe(self, df: Any, column: str) -> Dict[str, Any]: ...

    def to_records(self, df: Any, limit: Optional[int] = None) -> List[Dict[str, Any]]: ...
