# Architectural Pain Points & Strategic Vision

This document captures the primary friction points identified during the current development cycle and outlines a vision for their resolution. This is intended for senior architectural review and roadmap planning.

---

## 1. Primary Pain Points (The "Friction Patterns")

### A. Schema Rigidity vs. Dynamic Indexing
*   **The Pattern**: Incompatibility between extraction labels and query logic. (e.g., Code symbols indexed as `CodeEntity` with property `type='file'`, while the UI/Correlation engine expects a primary label of `File`).
*   **Impact**: Silent failures where "Neural Sparks" (semantic links) fail to materialize on the canvas despite successful indexing.

### B. The "Small Project" Sensitivity Gap
*   **The Pattern**: Hardcoded cosine similarity thresholds (e.g., 0.85) are often too strict for smaller codebases or sparse documentation.
*   **Impact**: Zero-link results for initial ingestions, requiring manual "Force Correlate" triggers or sensitivity tuning.

### C. Context Constraint Exhaustion (Token Blowout)
*   **The Pattern**: Attempting to feed raw ASTs or large directory trees into the LLM during agent discovery tasks.
*   **Impact**: Frequent "Max length reached" errors, stalling the Discovery Swarm.

### D. UI State Fragmentation
*   **The Pattern**: Feature disparity between V1 and V2 "cockpits," leading to user confusion regarding the location of ingestion and source panels.
*   **Impact**: Reduced observability of the ingestion pipeline.

---

## 2. Strategic Vision (The "Path to Zero Friction")

### 1. The Semantic Schema Adapter (SSA)
*   **Concept**: Decouple the query logic from the physical graph schema.
*   **Vision**: Implement a reflection layer where the agent first "inspects" the Neo4j schema labels/properties before generating Cypher. This eliminates "Schema Drift" issues.

### 2. Adaptive Correlation Intelligence
*   **Concept**: Moving beyond static thresholds.
*   **Vision**: Implement a "Warm-up Phase" for new workspaces where the system dynamically adjusts the similarity threshold until a healthy link density (e.g., 5-10 clusters/module) is achieved.

### 3. Graph-Pruned LLM Context
*   **Concept**: Stop feeding raw files.
*   **Vision**: Use the Neo4j graph itself to "rank" the importance of nodes. The agent receives a "Ranked Subgraph" summary rather than a full AST, significantly reducing token usage while maintaining high context.

### 4. Differential Ingestion ("Nexus Delta")
*   **Concept**: Incremental Graph updates.
*   **Vision**: Use file hashes to trigger Tree-Sitter parses ONLY on modified files, then update the graph with `MERGE` and `DETACH DELETE` only for changed relationships.

---

## 3. Critical Questions for Senior Architects

### A. Data Modeling & Lineage
*   **Temporal Graph Evolution**: Should we implement a "versioned graph" that allows the architect to travel back in time to see how the system was modeled 6 months ago?
*   **Probabilistic Lineage**: Should we introduce a `confidence_score` on semantic edges? This would allow the UI to "fade out" links that the LLM is less certain about.
*   **The "DNA" Trace**: Can we enable a feature where clicking a 3D link reveals the exact "Ingestion Path" (e.g., Docling Fragment -> LLM Extraction -> Graph Logic -> Neo4j Merge)?

### B. Observability & Monitoring
*   **Semantic Drift Monitoring**: How do we measure the "health" of the Knowledge Engine? Should we have a dashboard for link density, isolated "orphan" modules, and conflicting semantic triples?
*   **Agent Latency Budgets**: As the LangGraph swarm grows, how do we monitor the cost/value ratio of each discovery tool?

### C. Design Aesthetics & 3D Rendering
*   **Spatial Semantics**: Should the physical distance in the 3D canvas be a functional variable? (e.g., nodes that are semantically similar but structurally distant in code are pulled closer together by a "Semantic Gravity" shader).
*   **Visual Fidelity & Shaders**: Implementation of custom GLSL shaders for "Neural Sparks" and data flow pulses to make the system feel "alive" during ingestion.
*   **Level of Detail (LoD)**: Transitioning from high-fidelity code symbols to "Abstract Cluster" spheres as the camera zooms out, preventing visual noise in massive codebases.

---

*Ref: Prepared by Antigravity for Senior Review.*
