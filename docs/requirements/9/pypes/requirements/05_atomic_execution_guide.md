# Pypes: Atomic Execution Guide (Sprint 1)

This document provides concrete, TDD/BDD-aligned tasks for a junior model or developer to execute the vision of a regulatory-compliant data engine.

---

## Task 1.1: Pydantic CLP Meta-Models
**Goal**: Create a strict hierarchy of Business Concepts, Logical Attributes, and Physical Assets.

### BDD Acceptance Criteria (Gherkin)
- **Scenario**: Validate CLP Mapping
  - **Given** a `ConceptualModel` named "Counterparty"
  - **And** a `LogicalModel` with attribute "lei" linked to "Counterparty"
  - **And** a `PhysicalModel` mapping "lei" to "S3://ref/cp.parquet" column "LEI_CODE"
  - **When** the `MetaModel` is instantiated via Pydantic
  - **Then** the object should pass validation and store the full audit lineage.

### TDD Requirements
- **File**: `tests/test_clp_models.py`
- **Tests**:
  - `test_valid_clp_chain()`: Assert that a complete chain resolves correctly.
  - `test_invalid_logical_link()`: Assert `ValidationError` when a logical model refers to a missing conceptual entity.
  - `test_physical_orphan_check()`: Assert that physical mappings must have a logical parent.

---

## Task 1.2: Hamilton DAG Orchestrator
**Goal**: Integrate the Hamilton library to resolve step dependencies from the manifest.

### BDD Acceptance Criteria (Gherkin)
- **Scenario**: Resolve DAG from Step Metadata
  - **Given** a manifest with Step A (Output: `df_raw`) and Step B (Input: `df_raw`)
  - **When** the `PipelineOrchestrator` initializes the `HamiltonDriver`
  - **Then** a Directed Acyclic Graph should be formed where Step B depends on Step A.
  - **And** if Step B refers to a non-existent input, it should fail-fast during initialization.

### TDD Requirements
- **File**: `tests/test_hamilton_orchestration.py`
- **Tests**:
  - `test_dag_resolution()`: Verify `driver.graph` contains the expected nodes.
  - `test_cycle_detection()`: Assert `DAGValidationError` (custom) if a circular dependency is declared in the manifest steps.

---

## Task 1.3: Polymorphic Operation Dispatcher (Ibis)
**Goal**: Implement a registry that maps manifest operations (filter, group_by) to Ibis expressions.

### BDD Acceptance Criteria (Gherkin)
- **Scenario**: Execute Filter across Engines
  - **Given** a Polars Dataframe and a "filter" operation in the manifest
  - **When** the `EngineDispatcher` is called
  - **Then** it should return an Ibis expression optimized for the Polars backend.
  - **And** the same manifest should work if the backend is swapped to Pandas.

---

## Expected Output Format
For every task, the executor MUST:
1. Create the **Unit Test** first (TDD).
2. Implement the **Pydantic Model** or **Service Class**.
3. Verify against the **BDD Scenario**.
4. Emit a **Lineage Event** (Mocked for now).
