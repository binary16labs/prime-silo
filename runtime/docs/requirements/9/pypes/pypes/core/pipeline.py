from typing import Dict, Any, Type
from pypes.contracts.models import ExecutionContract, EngineType
from pypes.engines.polars_impl import PolarsEngine
from pypes.core.engine import ExecutionEngine

class PipelineOrchestrator:
    """The central orchestrator that binds contracts to stateless execution engines."""

    def __init__(self):
        # In a production app, these might be injected or loaded via plugins
        self._engines: Dict[EngineType, Any] = {
            EngineType.POLARS: PolarsEngine()
            # EngineType.PANDAS: PandasEngine() (Pending)
        }

    def run(self, contract: ExecutionContract) -> Dict[str, Any]:
        """Execute a single contract and return the validation and execution summary."""
        
        engine: ExecutionEngine = self._engines.get(contract.engine)
        if not engine:
            raise ValueError(f"Engine '{contract.engine}' is not supported in this version.")

        # Stage 1: Extraction (Load)
        data = engine.load(contract.source)

        # Stage 2: Transformation (Apply Operations)
        transformed_data = engine.apply_operations(data, contract.operations)

        # Stage 3: Validation (Data Quality)
        validation_report = engine.validate(transformed_data, contract.validations)

        # Stage 4: Load (Save to Destination)
        if contract.destination:
            engine.save(transformed_data, contract.destination)

        return {
            "contract_name": contract.contract_name,
            "engine": contract.engine,
            "status": "SUCCESS" if validation_report["status"] == "PASS" else "COMPLETED_WITH_ERRORS",
            "validation": validation_report
        }
