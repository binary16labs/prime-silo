# Pypes: Dynamic Operation Dispatcher

The goal is to move beyond hardcoded `if/elif` blocks in the engine and create a unified, dynamic class that handles all manifest-defined operations (filter, group_by, math, etc.) while abstracting the underlying dataframe logic.

## User Review Required

> [!IMPORTANT]
> **Extensibility**
> By moving operations into a dedicated `OpRegistry` class, we enable "Custom Ops" to be added by the community without touching the core engine code.
>
> **Signature Standardisation**
> All operational functions will follow a standard signature: `(engine, df, **params) -> df`.

## Proposed Changes

### Core Logic
- **[NEW] [registry.py](file:///c:/Users/nsdha/OneDrive/code/pypes/pypes/core/registry.py)**: The `OperationRegistry` class. This will act as a central dispatcher. It will look up operations by name and execute them on the engine.
- **[MODIFY] [engine.py](file:///c:/Users/nsdha/OneDrive/code/pypes/pypes/core/engine.py)**: Add generic primitives for `filter`, `select`, `groupby`, and `compute` to the `ExecutionEngine` protocol.
- **[MODIFY] [polars_impl.py](file:///c:/Users/nsdha/OneDrive/code/pypes/pypes/engines/polars_impl.py)**: Implement the new protocol primitives.
- **[MODIFY] [pipeline.py](file:///c:/Users/nsdha/OneDrive/code/pypes/pypes/core/pipeline.py)**: Delegate transformation steps to the `OperationRegistry`.

### Detailed Class Design: `OperationRegistry`
```python
class OperationRegistry:
    def __init__(self):
        self._ops = {
            "filter": self._filter,
            "group_by": self._group_by,
            "add": self._add,
            "minus": self._minus,
            # ...
        }

    def execute(self, engine: ExecutionEngine, df: Any, op_name: str, params: dict) -> Any:
        handler = self._ops.get(op_name)
        if not handler:
            raise UnsupportedOperationError(op_name)
        return handler(engine, df, **params)
```

---

## Open Questions

1. **Math Granularity**: Should we have separate methods for `add`, `minus`, `multiply` or a single `calc` method that takes an expression (e.g., `notional * 1.2`)?
2. **Strict Validation**: Should each operation have its own Pydantic parameter model (e.g., `FilterArgs`), or should we use a dynamic dictionary?
3. **Custom Ops**: Should the registry be a singleton that allows third-party projects to `register_op("my_custom_op", func)`?

## Verification Plan

### Automated Tests
- Unit tests for the `OperationRegistry` dispatching logic.
- Integration test updating the Banking Demo to use the new "Add/Minus" operations.
