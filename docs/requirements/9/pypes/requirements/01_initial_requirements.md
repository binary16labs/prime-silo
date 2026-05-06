# Pypes: Enterprise-Grade Transformation Pipeline Engine

## Executive Summary
Pypes is a declarative, contract-driven data transformation engine designed for clean abstraction, AI agent interoperability, and robust data governance. It enables data engineers and AI agents to define transformations as JSON execution contracts that are dynamically processed by pydantic-based stateless services across multiple processing backends (Pandas, Polars, PySpark).

## Core Principles
1. **Design-First Meta-Model**: The entire data ecosystem (architecture, entities, components, and observability) is defined in a high-level manifest before a single line of code is executed.
2. **Contract Over Code**: Transformations are derived from the meta-model as JSON execution contracts.
3. **Data Virtualization (Denodo-Alternative)**: Leverage open-source virtualization (Trino/Dremio/Calcite) to query source systems in-place without heavy ETL, enabling "faster and easier" connections.
4. **Engine Agnostic**: Support for Pandas, Polars, and PySpark, with abstraction layers for each.
5. **Stateless execution**: Pure function services for easy scaling and AI-agent sandboxing.
6. **Built-in Quality & Observability**: Automated checks for completeness, correctness, and statistical anomalies (Move Analysis).

---

## Design-First Meta-Model
A "Meta-Model" manifest acts as the source of truth for the entire pipeline lifecycle.

```json
{
  "project": "Market Risk Aggregation",
  "architecture": {
    "nodes": [
      { "id": "FO_SYSTEM", "type": "OLTP", "description": "Front Office Trade Capture" },
      { "id": "REF_DATA", "type": "REFERENCE", "description": "Account & Counterparty Master" },
      { "id": "PYPES_ENGINE", "type": "TRANSFORMATION", "description": "Stateless Pypes Services" },
      { "id": "RISK_MART", "type": "OLAP", "description": "Market Risk Gold Layer" }
    ],
    "flows": [
      { "from": "FO_SYSTEM", "to": "PYPES_ENGINE", "contract": "ingest_trades" },
      { "from": "REF_DATA", "to": "PYPES_ENGINE", "contract": "lookup_accounts" }
    ]
  },
  "entities": [
    {
      "name": "Trade",
      "fields": [
        { "name": "trade_id", "type": "string", "required": true },
        { "name": "account_no", "type": "string", "required": true },
        { "name": "notional", "type": "float", "threshold": { "max": 100000000 } }
      ]
    }
  ],
  "observability": {
    "metrics": ["row_count", "latency", "schema_drift"],
    "alerts": { "on_threshold_breach": "critical" }
  }
}
```

---

## Virtual Database Research (Open Source)
To avoid the cost and complexity of proprietary tools like **Denodo**, Pypes integrates with open-source virtualization layers:

1. **Trino (Formerly PrestoSQL)**:
   - *Best for*: High-performance federated queries across diverse sources (SQL, NoSQL, Data Lake).
   - *Integration*: Pypes uses the Trino connector for "Gold" layer aggregations requiring cross-database joins.
2. **Dremio (Community Edition)**:
   - *Best for*: Providing a searchable "Semantic Layer" and automated query acceleration (Reflections).
   - *Integration*: Pypes leverages Dremio as the virtual metadata provider for AI agents to discover datasets.
3. **Apache Calcite**:
   - *Best for*: Building custom query optimizers and SQL parsers.
   - *Integration*: Pypes uses Calcite logic to parse complex "Business Rule" SQL into engine-specific operations.

---

## Technical Architecture

### 1. Execution Contract (JSON)
The contract specifies the data lineage through the Medallion architecture (Bronze -> Silver -> Gold).

```json
{
  "contract_name": "sales_daily_aggregation",
  "version": "1.0.0",
  "engine": "polars",
  "medallion_stage": "gold",
  "source": {
    "uri": "s3://silver-layer/sales/*.parquet",
    "format": "parquet"
  },
  "operations": [
    {
      "operation": "filter",
      "params": { "condition": "status == 'completed'" }
    },
    {
      "operation": "aggregate",
      "params": {
        "group_by": ["region", "date"],
        "metrics": {
          "total_revenue": "sum(amount)",
          "order_count": "count(id)"
        }
      }
    }
  ],
  "validations": {
    "completeness": ["region", "date"],
    "thresholds": [
      { "field": "total_revenue", "min": 0, "max": 1000000 }
    ],
    "move_analysis": {
      "field": "total_revenue",
      "comparison": "previous_run",
      "threshold_percent": 20
    }
  },
  "destination": {
    "uri": "s3://gold-layer/sales_summary/",
    "format": "delta"
  }
}
```

### 2. Pydantic-Based Infrastructure
- **Contract Models**: Strict Pydantic models to validate the incoming JSON contract.
- **Service Registry**: A dispatcher that routes operations to the appropriate engine implementation (e.g., `PolarsOperationService`).

### 3. Multi-Engine Support
- **Abstract Base Classes (ABCs)**: Define standard signatures for `filter`, `join`, `aggregate`, etc.
- **Implementations**:
    - `PandasBackend`: For small to medium local data.
    - `PolarsBackend`: For high-performance single-node memory-efficient processing.
    - `PySparkBackend`: For distributed large-scale workloads.

---

## Feature Requirements

### Medallion Pipeline Management
- **Bronze (Inbound)**: Raw data landing, schema enforcement, logging.
- **Silver (Cleanse)**: Deduplication, normalization, standardizing types.
- **Gold (Aggregate)**: Business-level views, OLAP readiness.

### Automated Data Validation
- **Check Correctness**: Type checking, regex pattern matching, enum validation.
- **Check Completeness**: Null counts, required keys, row count expectations.
- **Move Analysis**: Compare current run statistics against historical averages or previous runs.
- **Threshold Breaches**: Alerting on outliers or values exceeding business-defined limits.

### AI Agent Sandbox & Refinement
- **Sandbox Mode**: Execute contracts in a transient environment with mock data.
- **Refinement Cycle**:
    1. Agent generates a contract.
    2. Pypes runs "dry-run" validation.
    3. Agent inspects "transparency logs" (schema drifts, execution time).
    4. Agent modifies contract based on reusable function registry.

---

## User Review Required

> [!IMPORTANT]
> **Extensibility vs. Standardisation**
> How much "raw code" should we allow in the contract?
> - **Option A**: Strict JSON-only operations (Pure but limited).
> - **Option B**: JSON-wrapped UDFs (Flexible but harder for Agents to "reason" about).
> *I recommend Option A for the core, with a "Plugin" mechanism for complex logic.*

## Case Study: Investment Bank Market Risk
**Scenario**: Aggregating market risk exposure by counterparty by joining real-time Front Office trades with static account data.

### 1. Bronze Stage (OLTP Landing)
- **Source A**: FO System (REST API / Kafka) -> `raw_fo_trades`
- **Source B**: Static DB (JDBC via Trino) -> `raw_account_master`
- **Contract**: JSON specifies raw ingestion with timestamping and source-node tagging.

### 2. Silver Stage (Cleanse & Standardize)
- **Operations**: 
  - Standardize `account_no` (remove dashes, upper-case).
  - Convert `notional` currencies to USD base using a reusable `currency_converter` function.
  - **Validation**: Check for `null` account numbers or duplicate `trade_id`.

### 3. Gold Stage (OLAP Ready)
- **Operation**: Join `silver_trades` with `silver_accounts` on `account_no`.
- **Enrichment**: Sourcing `counterparty_id` and `legal_entity` from account master.
- **Aggregation**: Group by `counterparty_id`, summing `notional` as `total_exposure`.
- **Validation (Move Analysis)**: 
  - Compare `total_exposure` against yesterday's run.
  - Alert if a single counterparty's exposure increases by >30% (Potential threshold breach).

### 4. Consumption (Design-First Design)
- The resulting Gold dataset is published to a Star Schema in the Risk Mart, optimized for BI tools and Risk Engines.
- **Transparency**: AI agents can inspect the "Lineage Contract" to see exactly how a $100M trade influenced the final counterparty risk score.

---

## Implementation Roadmap

### Phase 1: Prototype (1-2 Weeks)
- Define Pydantic Contract schemas.
- Implement `Polars` backend for core operations (Select, Filter, Agg).
- Basic "Correctness" validation implementation.

### Phase 2: Multi-Engine & Medallion (3-4 Weeks)
- Add PySpark and Pandas wrappers.
- Implement Medallion stage decorators/handlers.
- "Move Analysis" historical tracking database (Local SQLite/DuckDB).

### Phase 3: Agentic Toolkit (5-6 Weeks)
- CLI/SDK for Sandboxing.
- Documentation generator for "Reusable Functions" to prime LLM prompts.
- Advanced Threshold Breach logic.
