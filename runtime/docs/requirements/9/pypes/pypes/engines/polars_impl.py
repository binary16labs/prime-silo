import polars as pl
from typing import List, Any, Dict
from pypes.core.engine import ExecutionEngine
from pypes.contracts.models import SourceModel, OperationModel, ValidationModel

class PolarsEngine:
    """Polars-based high-performance execution engine."""

    def load(self, source: SourceModel) -> pl.DataFrame:
        """Load data into a Polars DataFrame."""
        if source.format == "parquet":
            return pl.read_parquet(source.uri, **source.options)
        elif source.format == "csv":
            return pl.read_csv(source.uri, **source.options)
        elif source.format == "memory":
            # Direct loading from object if passed in options
            return source.options.get("df")
        else:
            raise ValueError(f"PolarsEngine does not support format: {source.format}")

    def apply_operations(self, df: pl.DataFrame, operations: List[OperationModel]) -> pl.DataFrame:
        """Apply transformations using Polars API."""
        for op in operations:
            if op.operation == "load":
                # Source ID tagging
                df = df.with_columns(pl.lit(op.params.get("source_id")).alias("_pypes_source"))
            elif op.operation == "standardize":
                # Example: Title case all string columns
                string_cols = [c for c, t in zip(df.columns, df.dtypes) if t == pl.Utf8]
                df = df.with_columns([pl.col(c).str.to_uppercase() for c in string_cols])
            elif op.operation == "filter":
                condition = op.params.get("condition")
                # Simple example: field == value
                field = op.params.get("field")
                value = op.params.get("value")
                df = df.filter(pl.col(field) == value)
            elif op.operation == "aggregate":
                group_by = op.params.get("group_by", [])
                metrics = op.params.get("metrics", {})
                # Note: This is an simplified implementation for the prototype
                aggs = []
                for name, expr in metrics.items():
                    if "sum" in expr:
                        col = expr.split("(")[1].split(")")[0]
                        aggs.append(pl.col(col).sum().alias(name))
                df = df.group_by(group_by).agg(aggs)
                
        return df

    def validate(self, df: pl.DataFrame, rules: ValidationModel) -> Dict[str, Any]:
        """Perform data quality checks."""
        results = {"status": "PASS", "checks": []}
        
        if not rules:
            return results

        # Completeness Check
        for field in rules.completeness:
            null_count = df.select(pl.col(field).is_null().sum()).item()
            if null_count > 0:
                results["status"] = "FAIL"
                results["checks"].append({
                    "check": "completeness",
                    "field": field,
                    "count": null_count,
                    "status": "FAILED"
                })
            else:
                results["checks"].append({
                    "check": "completeness",
                    "field": field,
                    "status": "PASSED"
                })
        
        # Threshold Checks
        for threshold in rules.thresholds:
            field = threshold.get("field")
            max_val = threshold.get("max")
            if max_val:
                violations = df.filter(pl.col(field) > max_val).height
                if violations > 0:
                    results["status"] = "FAIL"
                    results["checks"].append({
                        "check": "threshold",
                        "field": field,
                        "violations": violations,
                        "status": "FAILED"
                    })

        return results

    def save(self, df: pl.DataFrame, destination: SourceModel) -> None:
        """Persist data."""
        if destination.format == "parquet":
            df.write_parquet(destination.uri)
        elif destination.format == "csv":
            df.write_csv(destination.uri)
        elif destination.format == "memory":
            # For testing, we might just store it in the options
            destination.options["result"] = df
        else:
            raise ValueError(f"PolarsEngine cannot save to format: {destination.format}")
