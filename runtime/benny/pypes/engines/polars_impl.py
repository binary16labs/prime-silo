"""Polars implementation of the pypes ``ExecutionEngine`` protocol (optional).

Only imported when ``polars`` is available. The public surface matches
``PandasEngine`` exactly, so switching backends is a one-line manifest
change.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import polars as pl

from ..models import FormatType, SourceSpec

_SAFE_AGG = {"sum", "mean", "avg", "count", "min", "max", "median", "std"}
_CALC_ALLOWED = re.compile(r"^[0-9A-Za-z_+\-*/().,\s]+$")


class PolarsEngine:
    name = "polars"
    fallback_from: Optional[str] = None

    def _resolve(self, uri: str, workspace_root: Optional[str]) -> Path:
        p = Path(uri)
        if p.is_absolute():
            return p
        if workspace_root:
            return Path(workspace_root) / uri
        return p

    def load(self, source: SourceSpec, workspace_root: Optional[str] = None) -> pl.DataFrame:
        fmt = source.format
        if fmt == FormatType.MEMORY:
            df = source.options.get("df")
            if df is None:
                raise ValueError("format=memory requires options.df")
            return df if isinstance(df, pl.DataFrame) else pl.DataFrame(df)
        path = self._resolve(source.uri, workspace_root)
        if fmt == FormatType.PARQUET:
            return pl.read_parquet(path, **source.options)
        if fmt == FormatType.CSV:
            return pl.read_csv(path, **source.options)
        if fmt == FormatType.JSON:
            return pl.read_json(path, **source.options)
        raise ValueError(f"PolarsEngine does not support format: {fmt}")

    def save(
        self,
        df: pl.DataFrame,
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
            df.write_parquet(path)
        elif fmt == FormatType.CSV:
            df.write_csv(path)
        elif fmt == FormatType.JSON:
            df.write_json(path)
        else:
            raise ValueError(f"PolarsEngine cannot save to format: {fmt}")

    def row_count(self, df: pl.DataFrame) -> int:
        return int(df.height)

    def columns(self, df: pl.DataFrame) -> List[str]:
        return list(df.columns)

    def fingerprint(self, df: pl.DataFrame) -> str:
        payload = json.dumps(
            {
                "columns": sorted(df.columns),
                "rows": df.sort(df.columns).to_dicts(),
            },
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def to_records(self, df: pl.DataFrame, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        frame = df.head(limit) if limit else df
        return frame.to_dicts()

    def add_column(self, df: pl.DataFrame, name: str, value: Any) -> pl.DataFrame:
        return df.with_columns(pl.lit(value).alias(name))

    def standardize(
        self,
        df: pl.DataFrame,
        columns: Optional[List[str]] = None,
        case: str = "upper",
    ) -> pl.DataFrame:
        cols = columns or [c for c, t in zip(df.columns, df.dtypes) if t == pl.Utf8]
        ops = []
        for c in cols:
            if c not in df.columns:
                continue
            expr = pl.col(c).cast(pl.Utf8)
            if case == "upper":
                ops.append(expr.str.to_uppercase())
            elif case == "lower":
                ops.append(expr.str.to_lowercase())
            elif case == "title":
                ops.append(expr.str.to_titlecase())
            elif case == "strip":
                ops.append(expr.str.strip_chars())
        return df.with_columns(ops) if ops else df

    def filter(
        self,
        df: pl.DataFrame,
        column: Optional[str] = None,
        op: str = "==",
        value: Any = None,
        expr: Optional[str] = None,
    ) -> pl.DataFrame:
        if expr is not None:
            raise ValueError("PolarsEngine.filter does not support raw `expr` — use column/op/value")
        if column is None:
            raise ValueError("filter requires a 'column'")
        c = pl.col(column)
        if op == "==":
            return df.filter(c == value)
        if op == "!=":
            return df.filter(c != value)
        if op == ">":
            return df.filter(c > value)
        if op == ">=":
            return df.filter(c >= value)
        if op == "<":
            return df.filter(c < value)
        if op == "<=":
            return df.filter(c <= value)
        if op == "in":
            return df.filter(c.is_in(list(value or [])))
        if op == "not_in":
            return df.filter(~c.is_in(list(value or [])))
        if op == "is_null":
            return df.filter(c.is_null())
        if op == "not_null":
            return df.filter(c.is_not_null())
        raise ValueError(f"Unsupported filter op: {op}")

    def select(self, df: pl.DataFrame, columns: List[str]) -> pl.DataFrame:
        return df.select(columns)

    def rename(self, df: pl.DataFrame, mapping: Dict[str, str]) -> pl.DataFrame:
        return df.rename(mapping)

    def cast(self, df: pl.DataFrame, mapping: Dict[str, str]) -> pl.DataFrame:
        type_map = {
            "int": pl.Int64,
            "int64": pl.Int64,
            "float": pl.Float64,
            "float64": pl.Float64,
            "string": pl.Utf8,
            "str": pl.Utf8,
            "bool": pl.Boolean,
            "date": pl.Date,
            "datetime": pl.Datetime,
        }
        exprs = []
        for col, target in mapping.items():
            if col not in df.columns:
                continue
            pl_t = type_map.get(target.lower())
            if pl_t is None:
                continue
            exprs.append(pl.col(col).cast(pl_t, strict=False))
        return df.with_columns(exprs) if exprs else df

    def calc(self, df: pl.DataFrame, target: str, expr: str) -> pl.DataFrame:
        if not _CALC_ALLOWED.match(expr):
            raise ValueError(f"calc.expr='{expr}' contains disallowed characters")
        # Evaluate via pandas-style eval on the underlying pyarrow view.
        # Simpler: fall back to a manual parser supporting column names +
        # basic arithmetic by converting to pandas for this op only.
        pdf = df.to_pandas()
        pdf[target] = pdf.eval(expr)
        return pl.from_pandas(pdf)

    def join(
        self,
        left: pl.DataFrame,
        right: pl.DataFrame,
        on: List[str],
        how: str = "inner",
    ) -> pl.DataFrame:
        return left.join(right, on=on, how=how)

    def aggregate(
        self,
        df: pl.DataFrame,
        group_by: List[str],
        metrics: Dict[str, str],
    ) -> pl.DataFrame:
        aggs = []
        for name, expr in metrics.items():
            fn, col = _parse_agg(expr)
            polars_col = pl.col(col)
            if fn == "sum":
                aggs.append(polars_col.sum().alias(name))
            elif fn in ("mean", "avg"):
                aggs.append(polars_col.mean().alias(name))
            elif fn == "count":
                aggs.append(polars_col.count().alias(name))
            elif fn == "min":
                aggs.append(polars_col.min().alias(name))
            elif fn == "max":
                aggs.append(polars_col.max().alias(name))
            elif fn == "median":
                aggs.append(polars_col.median().alias(name))
            elif fn == "std":
                aggs.append(polars_col.std().alias(name))
        if not group_by:
            return df.select(aggs)
        return df.group_by(group_by).agg(aggs)

    def dedupe(
        self,
        df: pl.DataFrame,
        subset: Optional[List[str]] = None,
        keep: str = "first",
    ) -> pl.DataFrame:
        return df.unique(subset=subset, keep=keep)

    def sort(self, df: pl.DataFrame, by: List[str], descending: bool = False) -> pl.DataFrame:
        return df.sort(by=by, descending=descending)

    def union(self, left: pl.DataFrame, right: pl.DataFrame) -> pl.DataFrame:
        return pl.concat([left, right], how="diagonal_relaxed")

    def mask_pii(self, df: pl.DataFrame, columns: List[str], hash_with: str = "sha256") -> pl.DataFrame:
        def _hash(x: Any) -> Optional[str]:
            if x is None:
                return None
            return hashlib.new(hash_with, str(x).encode("utf-8")).hexdigest()[:16]

        ops = [
            pl.col(c).map_elements(_hash, return_dtype=pl.Utf8).alias(c)
            for c in columns
            if c in df.columns
        ]
        return df.with_columns(ops) if ops else df

    def null_count(self, df: pl.DataFrame, column: str) -> int:
        if column not in df.columns:
            return 0
        return int(df.select(pl.col(column).is_null().sum()).item())

    def duplicate_count(self, df: pl.DataFrame, columns: List[str]) -> int:
        cols = [c for c in columns if c in df.columns]
        if not cols:
            return 0
        return int(df.height - df.unique(subset=cols).height)

    def min_max(self, df: pl.DataFrame, column: str) -> Dict[str, Any]:
        if column not in df.columns:
            return {"min": None, "max": None}
        try:
            m = df.select(pl.col(column).min()).item()
            M = df.select(pl.col(column).max()).item()
            return {"min": m, "max": M}
        except Exception:
            return {"min": None, "max": None}

    def describe(self, df: pl.DataFrame, column: str) -> Dict[str, Any]:
        if column not in df.columns:
            return {}
        try:
            stats = df.select(
                pl.col(column).count().alias("count"),
                pl.col(column).mean().alias("mean"),
                pl.col(column).std().alias("std"),
                pl.col(column).min().alias("min"),
                pl.col(column).max().alias("max"),
            ).to_dicts()[0]
            return {k: (float(v) if isinstance(v, (int, float)) else v) for k, v in stats.items()}
        except Exception:
            return {}


def _parse_agg(expr: str) -> tuple[str, str]:
    m = re.match(r"\s*([a-zA-Z_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*$", expr)
    if not m:
        raise ValueError(f"Unparseable aggregate expression: '{expr}'")
    fn, col = m.group(1).lower(), m.group(2)
    if fn not in _SAFE_AGG:
        raise ValueError(f"Aggregate fn '{fn}' not in allow-list {sorted(_SAFE_AGG)}")
    return fn, col
