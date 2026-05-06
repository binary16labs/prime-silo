# Pypes Design Specifications

## 1. Feature Breakdown & Detailed Functions

### Component: Meta-Model Engine
**Objective**: Convert business-intent (Design-First) into technical execution contracts.

*   **`derive_contract(meta: MetaModel, stage: str) -> ExecutionContract`**:
    *   *Input*: Full project meta-model and the desired Medallion stage (Bronze/Silver/Gold).
    *   *Logic*: Maps Architecture Nodes to Source/Destinations and Entity Fields to Validation rules.
*   **`validate_meta_consistency(meta: MetaModel) -> bool`**:
    *   *Logic*: Ensures all Flows have corresponding Nodes and all Entities have required fields.

### Component: Stateless Transformation Service
**Objective**: Execute operations using engine-specific backends.

*   **`apply_operation(df: DataFrame, op: OperationModel) -> DataFrame`**:
    *   *Logic*: A dispatcher that routes to `engine.filter()`, `engine.aggregate()`, etc.
*   **`run_medallion_pipeline(contract: ExecutionContract) -> RunResult`**:
    *   *Logic*: Orchestrates the Load -> Transform -> Validate -> Save lifecycle.

### Component: Validation & Observability
**Objective**: Guarantee data quality and record statistical drift.

*   **`check_completeness(df: DataFrame, fields: List[str]) -> ValidationResult`**:
    *   *Logic*: Calculates null ratios and compares against metadata thresholds.
*   **`perform_move_analysis(new_df: DataFrame, baseline_df: DataFrame, config: MoveConfig) -> DriftReport`**:
    *   *Logic*: Computes statistical variance (e.g., Mean/StdDev) between runs for specific metrics.

---

## 2. Acceptance Criteria (BDD / Gherkin)

### Feature: Design-First Contract Generation
**Scenario**: Generating a Gold layer contract from an Investment Bank Meta-Model.
*   **Given** a Meta-Model defining a `FRONT_OFFICE` node and a `MARKET_RISK_GOLD` node.
*   **And** a data flow connecting them with a "Counterparty Aggregation" rule.
*   **When** the `derive_contract` function is called for the "Gold" stage.
*   **Then** the output should be a valid `ExecutionContract` JSON.
*   **And** the contract should include a `JOIN` operation on `account_no`.

### Feature: Threshold Breach Validation
**Scenario**: Triggering an alert when market exposure exceeds limits.
*   **Given** a Gold layer DataFrame where `total_exposure` for "CP_999" is $150M.
*   **And** a validation contract specifying a `max_threshold` of $100M.
*   **When** the `DataValidator` executes the threshold check.
*   **Then** the `ValidationResult.status` should be `FAILED`.
*   **And** the `ValidationResult.error_message` should contain "Threshold breach for CP_999".

### Feature: Engine Agnostic Execution
**Scenario**: Switching from Polars to Pandas for small local testing.
*   **Given** an Execution Contract with `engine: "pandas"`.
*   **When** the `PipelineOrchestrator` initializes the engine.
*   **Then** the `PandasEngine` implementation should be instantiated.
*   **And** all subsequent operations should utilize `pandas.DataFrame` objects.

---

## 3. TDD Strategy

1.  **Red**: Define a test case in `tests/features/banking.feature`.
2.  **Green**: Implement the minimal logic in `pypes/core` and `pypes/engines`.
3.  **Refactor**: Clean up the abstraction layer to ensure the engine remains "Stateless" and "Pure".

## 4. Development Workflow for Community Contribution

1.  **Contract-First**: First, publish the JSON Schema for the `MetaModel` so other tools can generate it.
2.  **Provider Pattern**: Use a pluggable architecture for engines, allowing the community to add `DuckDBEngine` or `RayEngine` easily.
3.  **Observability Hooks**: Provide standard OpenTelemetry hooks so observability data can be piped to Prometheus/Grafana.
