"""Pandas implementation of the pypes ``ExecutionEngine`` protocol.

Pandas is the portable default — it ships transitively in Benny's
dependency closure via arize-phoenix, so pypes works on a clean
install without adding new wheels. Performance-critical workloads
should switch ``engine`` to ``"polars"`` in the step spec.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from ..models import FormatType, SourceSpec


# SAFE_AGG is the allow-list for ``aggregate.metrics`` expressions. The parser
# rejects anything outside this set — agent-generated manifests should not be
# able to smuggle arbitrary Python through the ``expr`` field.
SAFE_AGG = {"sum", "mean", "avg", "count", "min", "max", "median", "std"}

# Same story for ``calc`` — numexpr-style but restricted to arithmetic.
_CALC_ALLOWED = re.compile(r"^[0-9A-Za-z_+\-*/().,\s]+$")


class PandasEngine:
    name = "pandas"
    fallback_from: Optional[str] = None

    # --- I/O ---------------------------------------------------------------

    def _resolve(self, uri: str, workspace_root: Optional[str]) -> Path:
        p = Path(uri)
        if p.is_absolute():
            return p
        if workspace_root:
            return Path(workspace_root) / uri
        return p

    def load(self, source: SourceSpec, workspace_root: Optional[str] = None) -> pd.DataFrame:
        fmt = source.format
        if fmt == FormatType.MEMORY:
            df = source.options.get("df")
            if df is None:
                raise ValueError("format=memory requires options.df to be set")
            return df.copy() if isinstance(df, pd.DataFrame) else pd.DataFrame(df)
        path = self._resolve(source.uri, workspace_root)
        if fmt == FormatType.PARQUET:
            return pd.read_parquet(path, **source.options)
        if fmt == FormatType.CSV:
            return pd.read_csv(path, **source.options)
        if fmt == FormatType.JSON:
            return pd.read_json(path, **source.options)
        raise ValueError(f"PandasEngine does not support format: {fmt}")

    def save(
        self,
        df: pd.DataFrame,
        destination: SourceSpec,
        workspace_root: Optional[str] = None,
    ) -> None:
        fmt = destination.format
        if fmt == FormatType.MEMORY:
            destination.options["result"] = df
            return
        path = self._resolve(destination.uri, workspace_root)
        path.parent.mkdir(parents=True, exist_ok=True)
        if fmt == FormatType.PARQUET:
            df.to_parquet(path, index=False)
        elif fmt == FormatType.CSV:
            df.to_csv(path, index=False)
        elif fmt == FormatType.JSON:
            df.to_json(path, orient="records", indent=2)
        else:
            raise ValueError(f"PandasEngine cannot save to format: {fmt}")

    # --- introspection -----------------------------------------------------

    def row_count(self, df: pd.DataFrame) -> int:
        return int(len(df))

    def columns(self, df: pd.DataFrame) -> List[str]:
        return [str(c) for c in df.columns]

    def fingerprint(self, df: pd.DataFrame) -> str:
        # Canonical payload = sorted columns + row-wise records. Deterministic
        # across runs for equal data.
        payload = json.dumps(
            {
                "columns": sorted(self.columns(df)),
                "rows": df.sort_index(axis=1)
                .astype(str)
                .to_dict(orient="records"),
            },
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def to_records(self, df: pd.DataFrame, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        frame = df.head(limit) if limit else df
        return json.loads(frame.to_json(orient="records"))

    # --- transformation primitives ----------------------------------------

    def add_column(self, df: pd.DataFrame, name: str, value: Any) -> pd.DataFrame:
        out = df.copy()
        out[name] = value
        return out

    def standardize(
        self,
        df: pd.DataFrame,
        columns: Optional[List[str]] = None,
        case: str = "upper",
    ) -> pd.DataFrame:
        out = df.copy()
        cols = columns or [c for c in out.columns if out[c].dtype == object]
        for c in cols:
            if c not in out.columns:
                continue
            s = out[c].astype("string")
            if case == "upper":
                out[c] = s.str.upper()
            elif case == "lower":
                out[c] = s.str.lower()
            elif case == "title":
                out[c] = s.str.title()
            elif case == "strip":
                out[c] = s.str.strip()
        return out

    def filter(
        self,
        df: pd.DataFrame,
        column: Optional[str] = None,
        op: str = "==",
        value: Any = None,
        expr: Optional[str] = None,
    ) -> pd.DataFrame:
        if expr is not None:
            # pandas query only permits safe column refs — anything risky raises.
            return df.query(expr)
        if column is None:
            raise ValueError("filter requires either 'expr' or 'column'")
        series = df[column]
        if op == "==":
            mask = series == value
        elif op == "!=":
            mask = series != value
        elif op == ">":
            mask = series > value
        elif op == ">=":
            mask = series >= value
        elif op == "<":
            mask = series < value
        elif op == "<=":
            mask = series <= value
        elif op == "in":
            mask = series.isin(list(value or []))
        elif op == "not_in":
            mask = ~series.isin(list(value or []))
        elif op == "is_null":
            mask = series.isna()
        elif op == "not_null":
            mask = series.notna()
        else:
            raise ValueError(f"Unsupported filter op: {op}")
        return df[mask].reset_index(drop=True)

    def select(self, df: pd.DataFrame, columns: List[str]) -> pd.DataFrame:
        return df.loc[:, columns].copy()

    def rename(self, df: pd.DataFrame, mapping: Dict[str, str]) -> pd.DataFrame:
        return df.rename(columns=mapping)

    def cast(self, df: pd.DataFrame, mapping: Dict[str, str]) -> pd.DataFrame:
        out = df.copy()
        for col, target in mapping.items():
            if col not in out.columns:
                continue
            if target == "date":
                out[col] = pd.to_datetime(out[col], errors="coerce").dt.date
            elif target == "datetime":
                out[col] = pd.to_datetime(out[col], errors="coerce")
            else:
                out[col] = out[col].astype(target, errors="ignore")
        return out

    def calc(self, df: pd.DataFrame, target: str, expr: str) -> pd.DataFrame:
        if not _CALC_ALLOWED.match(expr):
            raise ValueError(
                f"calc.expr='{expr}' contains disallowed characters; allowed: [A-Za-z0-9_+-*/().,\\s]"
            )
        out = df.copy()
        try:
            out[target] = out.eval(expr)
        except Exception as exc:  # give the manifest author a clear error
            raise ValueError(f"calc failed: expr='{expr}' -> {exc}") from exc
        return out

    def join(
        self,
        left: pd.DataFrame,
        right: pd.DataFrame,
        on: List[str],
        how: str = "inner",
    ) -> pd.DataFrame:
        return left.merge(right, on=on, how=how)

    def aggregate(
        self,
        df: pd.DataFrame,
        group_by: List[str],
        metrics: Dict[str, str],
    ) -> pd.DataFrame:
        agg_map: Dict[str, tuple[str, str]] = {}
        for out_name, expr in metrics.items():
            fn, col = _parse_agg(expr)
            agg_map[out_name] = (col, _alias_agg(fn))
        if not group_by:
            row = {
                name: df[col].agg(fn) if col in df.columns else None
                for name, (col, fn) in agg_map.items()
            }
            return pd.DataFrame([row])
        named = {out: pd.NamedAgg(column=col, aggfunc=fn) for out, (col, fn) in agg_map.items()}
        return df.groupby(group_by, as_index=False).agg(**named)

    def dedupe(
        self,
        df: pd.DataFrame,
        subset: Optional[List[str]] = None,
        keep: str = "first",
    ) -> pd.DataFrame:
        return df.drop_duplicates(subset=subset, keep=keep).reset_index(drop=True)

    def sort(self, df: pd.DataFrame, by: List[str], descending: bool = False) -> pd.DataFrame:
        return df.sort_values(by=by, ascending=not descending).reset_index(drop=True)

    def union(self, left: pd.DataFrame, right: pd.DataFrame) -> pd.DataFrame:
        return pd.concat([left, right], ignore_index=True)

    def mask_pii(self, df: pd.DataFrame, columns: List[str], hash_with: str = "sha256") -> pd.DataFrame:
        out = df.copy()

        def _hash(x: Any) -> Optional[str]:
            if x is None or (isinstance(x, float) and pd.isna(x)):
                return None
            return hashlib.new(hash_with, str(x).encode("utf-8")).hexdigest()[:16]

        for c in columns:
            if c in out.columns:
                out[c] = out[c].map(_hash)
        return out

    # --- validation helpers -----------------------------------------------

    def null_count(self, df: pd.DataFrame, column: str) -> int:
        if column not in df.columns:
            return 0
        return int(df[column].isna().sum())

    def duplicate_count(self, df: pd.DataFrame, columns: List[str]) -> int:
        cols = [c for c in columns if c in df.columns]
        if not cols:
            return 0
        return int(df.duplicated(subset=cols).sum())

    def min_max(self, df: pd.DataFrame, column: str) -> Dict[str, Any]:
        if column not in df.columns:
            return {"min": None, "max": None}
        s = df[column]
        try:
            return {"min": s.min(), "max": s.max()}
        except TypeError:
            return {"min": None, "max": None}

    def describe(self, df: pd.DataFrame, column: str) -> Dict[str, Any]:
        if column not in df.columns:
            return {}
        s = df[column].dropna()
        if s.empty:
            return {"count": 0}
        try:
            return {
                "count": int(s.count()),
                "mean": float(s.mean()),
                "std": float(s.std(ddof=0)) if s.count() > 1 else 0.0,
                "min": float(s.min()),
                "max": float(s.max()),
            }
        except TypeError:
            return {"count": int(s.count())}


def _parse_agg(expr: str) -> tuple[str, str]:
    """Parse ``'sum(notional)'`` → ``('sum', 'notional')``."""
    m = re.match(r"\s*([a-zA-Z_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*$", expr)
    if not m:
        raise ValueError(f"Unparseable aggregate expression: '{expr}'")
    fn, col = m.group(1).lower(), m.group(2)
    if fn not in SAFE_AGG:
        raise ValueError(f"Aggregate fn '{fn}' not in allow-list {sorted(SAFE_AGG)}")
    return fn, col


def _alias_agg(fn: str) -> str:
    if fn == "avg":
        return "mean"
    return fn
