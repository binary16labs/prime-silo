# Pypes Project Plan: Regulatory-Compliant Data Engine

This document outlines the multi-phase roadmap for evolving Pypes into a next-generation data execution library.

> [!NOTE]
> For active session tracking and agent handoff protocols, refer to:
> 1. [project_plan.md](file:///C:/Users/nsdha/OneDrive/code/pypes/requirements/project_plan.md) - Live flight status and state.
> 2. [skills.md](file:///C:/Users/nsdha/OneDrive/code/pypes/requirements/skills.md) - Agent governance and operating protocols.


## Phase 1: Semantic Foundation & CLP Modeling
**Goal**: Establish the strict meta-model that binds business concepts to physical data.
- **Task 1.1**: implement Pydantic CLP (Conceptual, Logical, Physical) models.
- **Task 1.2**: Implement the `ContractMetadata` & Governance headers.
- **Task 1.3**: Implement `ValidationResultDF` structured exceptions.
- **Task 1.4**: Metadata discovery & Documentation generator.

## Phase 2: Polymorphic Execution Engine (Hamilton + Ibis)
**Goal**: Decouple transformation logic from infrastructure.
- **Task 2.1**: Ibis Registry (Polars, Pandas, PySpark polymorphic drivers).
- **Task 2.2**: Hamilton DAG Micro-Orchestration system.
- **Task 2.3**: Stateless Function Registry for common operations (filter, join, etc.).
- **Task 2.4**: Recursive/Nested Manifest execution support.

## Phase 3: Governance, Audit & Lineage
**Goal**: Achieve compliance-grade transparency.
- **Task 3.1**: OpenLineage Hamilton Adapter (START/COMPLETE events).
- **Task 3.2**: `AuditVault` & Cryptographic result signing.
- **Task 3.3**: Data Fingerprinting (SHA-256) services.
- **Task 3.4**: Cognitive Inquisitor (Triple Extraction & Rationale Articles).

## Phase 4: Sandboxing, Agentic AI & VoI
**Goal**: Proactive, self-healing, and low-risk deployment.
- **Task 4.1**: LakeFS Integration for Zero-Copy Branching.
- **Task 4.2**: Soft-Switch (Feature Flag) management in the UI context.
- **Task 4.3**: Agentic Manifest Generator (LLM prompt engineering).
- **Task 4.4**: Value of Information (VoI) tracking metrics.

---

## Acceptance Standards (Definition of Done)
- **TDD**: 100% unit test coverage for core models and engine logic.
- **BDD**: Every task must pass its corresponding Gherkin scenario.
- **Clean Code**: Strict adherence to PEP8, type hints, and "Rationale" documentation.
- **Lineage**: Every run must produce a valid OpenLineage JSON payload.
