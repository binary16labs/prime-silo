from typing import List
from pypes.meta.models import MetaModel
from pypes.contracts.models import ExecutionContract, SourceModel, OperationModel, EngineType, ValidationModel

class ContractGenerator:
    """Logic to derive technical execution contracts from design-first meta-models."""

    @staticmethod
    def derive_contracts(meta: MetaModel) -> List[ExecutionContract]:
        contracts = []
        
        for flow in meta.architecture.flows:
            # Locate the entity definition for this flow if it exists
            entity = next((e for e in meta.entities if e.name.lower() in flow.contract.lower()), None)
            
            # Build baseline validation from Entity meta
            validations = None
            if entity:
                completeness_fields = [f.name for f in entity.fields if f.required]
                thresholds = [f.threshold for f in entity.fields if f.threshold]
                
                validations = ValidationModel(
                    completeness=completeness_fields,
                    thresholds=thresholds,
                    move_analysis=None # To be configured per-stage
                )

            contract = ExecutionContract(
                contract_name=flow.contract,
                engine=EngineType.POLARS, # Default
                source=SourceModel(uri=f"data/bronze/{flow.from_node.lower()}", format="parquet"),
                operations=[
                    OperationModel(operation="load", params={"source_id": flow.from_node}),
                    OperationModel(operation="standardize", params={"entity": entity.name if entity else "unknown"})
                ],
                validations=validations,
                destination=SourceModel(uri=f"data/silver/{flow.contract.lower()}", format="parquet")
            )
            contracts.append(contract)
            
        return contracts
