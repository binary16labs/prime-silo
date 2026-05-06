"""AOS-001 Phase 0 — shared contract types for the SDLC capability surface.

All types here are additive.  Importing this module has no side-effects and
makes no network calls.
"""

from __future__ import annotations

from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# TOGAF ADM phases A–D  (AOS-F2)
# ---------------------------------------------------------------------------

_TOGAF_LABELS: dict[str, str] = {
    "A": "Architecture Vision",
    "B": "Business Architecture",
    "C": "Information Systems Architecture",
    "D": "Technology Architecture",
}


class TogafPhase(str, Enum):
    """TOGAF ADM phases mapped to manifest waves."""

    A = "A"
    B = "B"
    C = "C"
    D = "D"

    @property
    def label(self) -> str:
        return _TOGAF_LABELS[self.value]


# ---------------------------------------------------------------------------
# Quality gates  (AOS-F3)
# ---------------------------------------------------------------------------


class QualityGate(BaseModel):
    kind: Literal["linter", "typechecker", "bdd", "schema", "custom"]
    command: str
    on_failure: Literal["halt", "retry", "escalate"] = "halt"
    timeout_s: int = 120


# ---------------------------------------------------------------------------
# BDD  (AOS-F20, AOS-F21)
# ---------------------------------------------------------------------------


class BddScenario(BaseModel):
    id: str
    given: str
    when: str
    then: str
    tags: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# ADR  (AOS-F4)
# ---------------------------------------------------------------------------


class Adr(BaseModel):
    id: str
    title: str
    togaf_phase: TogafPhase
    status: Literal["proposed", "accepted", "deprecated", "superseded"] = "proposed"
    context: str = ""
    decision: str = ""
    consequences: str = ""


# ---------------------------------------------------------------------------
# Pass-by-reference  (AOS-F5, AOS-F7)
# ---------------------------------------------------------------------------


class ArtifactRef(BaseModel):
    """Pointer to a content-addressed artifact in the artifact store."""

    uri: str  # artifact://<sha256>
    content_type: str = "application/octet-stream"
    byte_size: Optional[int] = None
    sha256: Optional[str] = None
    # ≤ 200-char human-readable preview (AOS-F6)
    summary: Optional[str] = None


# ---------------------------------------------------------------------------
# Progressive disclosure  (AOS-F8, AOS-F9, AOS-F10)
# ---------------------------------------------------------------------------


class DisclosureEntry(BaseModel):
    tool_name: str
    layer: Literal[1, 2, 3]
    token_count: int
    loaded_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Process metrics  (AOS-F28, requirement §11)
# ---------------------------------------------------------------------------


class ProcessMetric(BaseModel):
    run_id: str
    task_id: str
    wall_s: float
    cpu_s: float
    rss_mb: float
    tokens_in: int
    tokens_out: int
    cost_usd: float
    model: str


# ---------------------------------------------------------------------------
# SDLC manifest extension  (AOS-F1 v1.1 schema fields)
# ---------------------------------------------------------------------------


class SdlcConfig(BaseModel):
    """Embedded in SwarmManifest.sdlc for AOS-enabled runs."""

    togaf_phase: Optional[TogafPhase] = None
    quality_gates: List[QualityGate] = Field(default_factory=list)
    bdd_scenarios: List[BddScenario] = Field(default_factory=list)
    adrs: List[Adr] = Field(default_factory=list)


class PolicyConfig(BaseModel):
    """Embedded in SwarmManifest.policy."""

    mode: Literal["off", "warn", "enforce"] = "warn"
    # MUST remain False at release — hard gate GATE-AOS-POLICY-1
    auto_approve_writes: bool = False


class MemoryConfig(BaseModel):
    """Embedded in SwarmManifest.memory."""

    checkpoint_enabled: bool = True
    vector_store: Optional[str] = None
