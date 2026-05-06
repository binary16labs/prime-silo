# Master Hand-off Prompt: Benny Studio Full Review & 6-Sigma Refactor

**To the Higher-Level Agent/Principal Architect:**

You are tasked with generating a **Comprehensive 6-Sigma Execution Plan** to finalize the Benny Studio "Neural Nexus" for delivery. This plan must be broken down into atomic, foolproof tasks suitable for execution by a specialized Sub-Agent (Lower Model). 

## 1. Primary Context & Resources
Refer to the following artifacts in the `architecture/` directory to ground your logic:
- **Strategic Blueprint**: `architecture/SAD.md` (System Topology).
- **Technical Projection**: `architecture/GRAPH_SCHEMA.md` (AST-to-Graph projection and live metrics).
- **Source Truth**: `architecture/RAW_AST_BENNY.json` (Full 141-file AST dump).
- **Agent Guidelines**: `architecture/AGENT_ONBOARDING_PROMPT.md` (Onboarding primer).
- **Strategic Roadmap**: `architecture/PAIN_POINTS_AND_VISION.md` (Pain points and 3D vision).

## 2. Mandatory Refactor Workstreams

### Workstream A: The "Tonight" Delivery (Tactical Fixes)
1. **Schema-Aware Correlation**: Refactor `benny/synthesis/correlation.py`. Implement a middleware that validates current Neo4j labels (`CodeEntity`) and properties (`type`) before querying, eliminating the "Neural Spark" visibility drift.
2. **V2 Cockpit Sync**: Wire the `SourcePanel` (Frontend) to the backend. Ensure "Deep Synthesis" and "Sensitivity" toggles correctly update the `Librarian` and `Correlator` state.
3. **Manual Correlation Tool**: Create a new LangGraph node/tool that allows an agent to force-trigger relationship creation for specific nodes.

### Workstream B: Advanced Data Modeling (6-Sigma Lineage)
1. **Probabilistic Edges**: Update the Neo4j merge logic to include a `confidence_score` [0.0 - 1.0] and `rationale` string on all semantic relationships.
2. **The "DNA" Trace**: Implement a lineage metadata capture that stores the `doc_fragment_id` and `source_ast_range` on every newly created edge.
3. **Temporal Readiness**: Propose a schema update that supports `created_at` and `superseded_by` properties to enable time-travel graph navigation.

### Workstream C: Observability & Health
1. **Semantic Drift Dashboard**: Write a diagnostic utility that returns link density and identifies "Orphan Hubs" (nodes with high complexity but zero semantic links).
2. **Agent Latency Monitoring**: Implement AER (Audit Execution Record) decorators to track tool-level execution time and token consumption.

### Workstream D: 3D Aesthetic & Performance (V2 Canvas)
1. **Spatial Semantics Logic**: Design the backend "Gravity Index" that calculates 3D coordinates based on semantic distance (RAG cosine similarity) rather than just a linear tree.
2. **LoD (Level of Detail) Strategy**: Define the clustering logic for the frontend to collapse distant sub-directories into "Concept Spheres" to maintain performance.

## 3. Definition of Done (DoD)
- **Zero Disconnects**: Ingesting a doc results in visible "Neural Sparks" in the 3D UI without manual intervention.
- **Audit Compliance**: 100% of agent actions are logged in the Governance AER trace.
- **Code Fidelity**: The refactor plan preserves Tree-Sitter parsing integrity.
- **Atomic Readiness**: Your output must be a markdown checklist where every task is small enough for a junior agent to execute.

## 4. Final Instruction
Review all 5 architectural documents. Identify the "Critical Path." Expand your plan to ensure that every question in `PAIN_POINTS_AND_VISION.md` is addressed.

**Generate the 6-Sigma Plan now.**
