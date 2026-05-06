from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional, Dict, Literal
from pydantic import BaseModel, Field, field_validator
import math

# KG3D-001 Categorical Ontology
class NodeCategory(str, Enum):
    APPROXIMATIONS_EXPANSIONS = "approximations_expansions"
    AI_DEEP_LEARNING = "ai_deep_learning"
    CALC_VARIATIONS_CONTROL = "calc_variations_control"
    COMBINATORICS_NUMBER_THEORY = "combinatorics_number_theory"
    COMPUTER_VISION_PATTERN_RECOGNITION = "computer_vision_pattern_recognition"
    FUNCTIONAL_ANALYSIS_REAL_FUNCTIONS = "functional_analysis_real_functions"
    INFORMATION_COMMUNICATION_THEORY = "information_communication_theory"
    LLM_NLP = "llm_nlp"
    LINEAR_MULTILINEAR_ALGEBRA_MATRIX_THEORY = "linear_multilinear_algebra_matrix_theory"
    MEASURE_INTEGRATION = "measure_integration"
    NEURAL_EVOLUTIONARY_COMPUTING = "neural_evolutionary_computing"
    NUMERICAL_ANALYSIS_SIGNAL_PROCESSING = "numerical_analysis_signal_processing"
    OPS_RESEARCH_MATH_PROGRAMMING = "ops_research_math_programming"
    OPTIMISATION_REINFORCEMENT_LEARNING = "optimisation_reinforcement_learning"
    ODE_PDE = "ode_pde"
    PROBABILITY_STOCHASTIC_STATISTICS = "probability_stochastic_statistics"
    
    # Synthesized Categories
    PERSON = "person"
    THEORY = "theory"
    TECHNOLOGY = "technology"
    ORGANIZATION = "organization"
    LOCATION = "location"
    EVENT = "event"
    CONCEPT = "concept"
    DOCUMENTATION = "documentation"

class EdgeKind(str, Enum):
    PREREQUISITE = "prerequisite"
    REFERENCES = "references"
    CONTRADICTS = "contradicts"
    GENERALISES = "generalises"
    SPECIALISES = "specialises"

class NodeMetrics(BaseModel):
    pagerank: float = Field(ge=0)
    degree: int = Field(ge=0)
    betweenness: float = Field(ge=0)
    descendant_ratio: float = Field(ge=0, le=1)
    prerequisite_ratio: float = Field(ge=0, le=1)
    reachability_ratio: float = Field(ge=0, le=1)

    @field_validator("pagerank", "betweenness", "descendant_ratio", "prerequisite_ratio", "reachability_ratio")
    @classmethod
    def validate_finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("Metric must be finite")
        return v

class PositionHint(BaseModel):
    x: float
    y: float
    z: float

def aot_layer_for(descendant_ratio: float) -> int:
    """
    Derives the aot_layer from descendant_ratio per KG3D-F13.
    Exact bin thresholds: [0.8, 0.5, 0.25, 0.1]
    1 = most abstract (high descendant ratio)
    5 = most specific (low descendant ratio)
    """
    if descendant_ratio >= 0.8:
        return 1
    elif descendant_ratio >= 0.5:
        return 2
    elif descendant_ratio >= 0.25:
        return 3
    elif descendant_ratio >= 0.1:
        return 4
    return 5

class Node(BaseModel):
    id: str
    canonical_name: str
    display_name: str
    category: NodeCategory
    aot_layer: int = Field(ge=1, le=5)
    metrics: NodeMetrics
    position_hint: Optional[PositionHint] = None
    source_refs: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("aot_layer")
    @classmethod
    def validate_aot(cls, v: int, info) -> int:
        return v

class Edge(BaseModel):
    id: str
    source_id: str
    target_id: str
    kind: EdgeKind
    weight: float = Field(gt=0)
    evidence: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("target_id")
    @classmethod
    def validate_no_self_loop(cls, v: str, info) -> str:
        if "source_id" in info.data and v == info.data["source_id"]:
            raise ValueError("Self-loops are forbidden at ingest time")
        return v

class Proposal(BaseModel):
    nodes_upsert: List[Node]
    edges_upsert: List[Edge]
    rationale_md: str

class DeltaEvent(BaseModel):
    kind: Literal["upsert_node", "upsert_edge", "remove_node", "remove_edge", "metrics_refresh", "heartbeat"]
    payload: Optional[Dict] = None
    seq: int
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

def validate_node(node: Node) -> bool:
    """Enforces KG3D-001 node invariants."""
    expected_layer = aot_layer_for(node.metrics.descendant_ratio)
    if node.aot_layer != expected_layer:
        return False
    return True

def validate_edge(edge: Edge) -> bool:
    """Enforces KG3D-001 edge invariants."""
    if edge.source_id == edge.target_id:
        return False
    return True
