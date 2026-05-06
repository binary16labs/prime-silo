from enum import Enum
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

class NodeType(str, Enum):
    OLTP = "OLTP"
    REFERENCE = "REFERENCE"
    TRANSFORMATION = "TRANSFORMATION"
    OLAP = "OLAP"

class ArchitectureNode(BaseModel):
    id: str
    type: NodeType
    description: Optional[str] = None

class DataFlow(BaseModel):
    from_node: str = Field(alias="from")
    to_node: str = Field(alias="to")
    contract: str

class FieldMeta(BaseModel):
    name: str
    type: str
    required: bool = True
    threshold: Optional[Dict[str, Any]] = None

class EntityMeta(BaseModel):
    name: str
    fields: List[FieldMeta]

class ObservabilityMeta(BaseModel):
    metrics: List[str] = ["row_count", "latency"]
    alerts: Dict[str, str] = {"on_threshold_breach": "critical"}

class ArchitectureMeta(BaseModel):
    nodes: List[ArchitectureNode]
    flows: List[DataFlow]

class MetaModel(BaseModel):
    project: str
    architecture: ArchitectureMeta
    entities: List[EntityMeta]
    observability: Optional[ObservabilityMeta] = None
