from enum import Enum
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

class EngineType(str, Enum):
    POLARS = "polars"
    PANDAS = "pandas"
    PYSPARK = "pyspark"
    TRINO = "trino"

class SourceModel(BaseModel):
    uri: str
    format: str = "parquet"
    options: Dict[str, Any] = {}

class OperationModel(BaseModel):
    operation: str
    params: Dict[str, Any]

class ValidationModel(BaseModel):
    completeness: List[str] = []
    thresholds: List[Dict[str, Any]] = []
    move_analysis: Optional[Dict[str, Any]] = None

class ExecutionContract(BaseModel):
    contract_name: str
    version: str = "1.0.0"
    engine: EngineType = EngineType.POLARS
    source: SourceModel
    operations: List[OperationModel]
    validations: Optional[ValidationModel] = None
    destination: Optional[SourceModel] = None
