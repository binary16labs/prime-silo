from typing import Any, List, Protocol, runtime_checkable

from pypes.contracts.models import OperationModel, SourceModel, ValidationModel


@runtime_checkable
class ExecutionEngine(Protocol):
    """Abstract protocol defining the required interface for all Pypes backend engines."""

    def load(self, source: SourceModel) -> Any:
        """Load data from a source into the engine's internal representation (e.g., DataFrame)."""
        ...

    def apply_operations(self, data: Any, operations: List[OperationModel]) -> Any:
        """Apply a sequence of transformations to the data."""
        ...

    def validate(self, data: Any, rules: ValidationModel) -> Any:
        """Execute data quality and statistical validation checks."""
        ...

    def save(self, data: Any, destination: SourceModel) -> None:
        """Persist the transformed data to the target destination."""
        ...
