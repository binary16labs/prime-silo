# 6-Sigma Execution Plan: Benny Studio Neural Nexus

**Version**: 1.0.0  
**Status**: APPROVED FOR EXECUTION  
**Date**: 2026-04-16  
**Author**: Principal AI Orchestrator  
**Governance**: Every task block carries an AER compliance tag. Sub-agents must emit `NODE_EXECUTION_STATE` events for each task.

---

## 0. Grounded Research Summary

### Source Truth Audit (RAW_AST_BENNY.json)
- **141 files** parsed across Python and TypeScript/React.
- **1,232 entities** (694 Functions, 211 Files, 129 Classes, 68 Interfaces, 66 Folders, 55 Docs, 9 ExternalClasses).
- **2,248 relationships** (1,167 DEPENDS_ON, 943 DEFINES, 92 INHERITS, 46 CONTAINS).
- **Zero CORRELATES_WITH or REPRESENTS edges** in the live stats — confirming Pain Point A (Neural Spark invisibility).

### Critical Path Identified
The zero-link condition is the blocking defect. The critical path runs:

```
Schema Adapter (A.1) → Correlation Refactor (A.2) → Probabilistic Edges (B.1)
    → V2 Cockpit Sync (A.3) → Semantic Drift Dashboard (C.1) → 3D Gravity (D.1)
```

Everything downstream of the Schema Adapter depends on queries returning correct nodes. This is the **single point of failure**.

### Friction Pattern → Root Cause Mapping

| Pain Point | Root Cause (Verified in Source) | File(s) |
|---|---|---|
| **A. Schema Drift** | `correlation.py` queries `CodeEntity` nodes by `s.type IN [...]` but never validates that these labels/properties exist in the live graph. The GRAPH_SCHEMA shows separate labels (`File`, `Class`) coexist with `CodeEntity` base label + `type` property — mismatch is silent. | `benny/synthesis/correlation.py:23,49` |
| **B. Sensitivity Gap** | Hardcoded `threshold=0.70` in `run_aggressive_correlation`. UI has `correlationThreshold` state but wiring to backend `IngestRequest.correlation_threshold` needs verification at the fetch call. | `benny/synthesis/correlation.py:36`, `SourcePanel.tsx:32`, `benny/api/rag_routes.py:39` |
| **C. Token Blowout** | No graph-pruned context strategy. Raw AST is 10.5M lines. Discovery swarm feeds raw file trees to LLM. | `benny/graph/discovery_swarm.py`, `benny/graph/swarm.py` |
| **D. UI Fragmentation** | Three app shells (`App.tsx`, `AppV2.tsx`, `AppV2Beta.tsx`). `SourcePanel` toggles for `deepSynthesis`/`strategy` exist but may not propagate to the actual `/api/rag/ingest` POST body. | `frontend/src/App*.tsx`, `SourcePanel.tsx` |

### Missing Capabilities (Not Found in Codebase)
1. No `rationale` string on any semantic edge.
2. No `doc_fragment_id` or `source_ast_range` on edges.
3. No `superseded_by` temporal property on any node or edge.
4. No AER decorator pattern — only imperative `emit_*` functions.
5. No LangGraph tool for manual/forced correlation.
6. No "Gravity Index" or semantic-distance-based 3D positioning.
7. No LoD clustering logic for the 3D canvas.
8. No orphan hub detection or link density dashboard.

---

## 1. WORKSTREAM A: "Tonight" Delivery (Tactical Fixes)

### A.1 — Schema-Aware Correlation Middleware

**Objective**: Eliminate silent query failures by making the correlator schema-aware before generating Cypher.

**Impact Analysis**:
- **Modified**: `benny/synthesis/correlation.py`
- **New**: `benny/synthesis/schema_adapter.py`
- **Touched**: `benny/core/graph_db.py` (add introspection helper)

#### Task A.1.1: Create Neo4j Schema Introspection Helper
- [ ] **File**: `benny/core/graph_db.py`
- [ ] **Action**: Add function `introspect_schema(workspace: str) -> dict` that executes:
  ```cypher
  CALL db.labels() YIELD label RETURN collect(label) as labels
  ```
  and
  ```cypher
  CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) as types
  ```
  and
  ```cypher
  MATCH (n {workspace: $workspace}) 
  WITH DISTINCT labels(n) as label_set, n.type as type_prop
  RETURN label_set, type_prop, count(*) as cnt
  ```
- [ ] **Return**: `{"labels": [...], "relationship_types": [...], "entity_type_distribution": {...}}`
- [ ] **AER**: Emit `TOOL_EXECUTION` event with `tool_name="schema_introspect"`.
- [ ] **Test**: Unit test with mock Neo4j driver returning known schema.

#### Task A.1.2: Build SchemaAdapter Class
- [ ] **File**: NEW `benny/synthesis/schema_adapter.py`
- [ ] **Action**: Create class `SchemaAdapter` with methods:
  - `resolve_node_match(entity_type: str) -> str` — Returns the correct Cypher match clause. If the graph uses label-based indexing (`:File`), return `MATCH (n:File {workspace: $ws})`. If property-based (`CodeEntity` with `type='File'`), return `MATCH (n:CodeEntity {workspace: $ws, type: 'File'})`.
  - `get_valid_entity_types() -> List[str]` — Returns only types that actually exist in the graph.
  - Internal: Cache the introspection result for the session lifetime (invalidate on workspace switch).
- [ ] **Test**: Test with both label-based and property-based schemas.

#### Task A.1.3: Refactor correlation.py to Use SchemaAdapter
- [ ] **File**: `benny/synthesis/correlation.py`
- [ ] **Action — `run_safe_correlation`**:
  - Replace hardcoded `MATCH (s:CodeEntity {workspace: $workspace}) WHERE s.type IN [...]` with dynamic Cypher from `SchemaAdapter.resolve_node_match()`.
  - Before running, call `adapter.get_valid_entity_types()` and skip types not present.
- [ ] **Action — `run_aggressive_correlation`**:
  - Same dynamic Cypher replacement for the `symbol_query`.
  - Log which types were found vs expected for diagnostics.
- [ ] **AER**: Emit `SCHEMA_ADAPTATION` event recording the resolved query pattern.
- [ ] **Test**: Integration test — ingest a small Python file, run correlation, assert `CORRELATES_WITH` edges > 0.

#### Task A.1.4: Add Schema Health Check to API
- [ ] **File**: `benny/api/graph_routes.py`
- [ ] **Action**: Add endpoint `GET /api/graph/schema-health?workspace=X` that returns:
  ```json
  {
    "labels": [...],
    "expected_labels": ["CodeEntity", "File", "Class", "Function", "Concept", "Documentation"],
    "missing_labels": [...],
    "entity_type_distribution": {...},
    "recommendation": "label-based" | "property-based" | "hybrid"
  }
  ```
- [ ] **Test**: Hit endpoint after code ingestion, verify non-empty response.

---

### A.2 — V2 Cockpit Sync (SourcePanel → Backend Wiring)

**Objective**: Ensure the UI toggles for Deep Synthesis, Strategy, and Sensitivity actually reach the backend.

**Impact Analysis**:
- **Modified**: `frontend/src/components/Studio/SourcePanel.tsx`
- **Verified**: `benny/api/rag_routes.py` (IngestRequest model already accepts the fields)

#### Task A.2.1: Audit SourcePanel Fetch Call
- [ ] **File**: `frontend/src/components/Studio/SourcePanel.tsx`
- [ ] **Action**: Locate the `fetch` call to `/api/rag/ingest` (or equivalent). Verify the POST body includes:
  ```json
  {
    "deep_synthesis": deepSynthesis,
    "strategy": ingestionStrategy,
    "correlation_threshold": correlationThreshold
  }
  ```
- [ ] **If Missing**: Add these fields to the request body. The state variables already exist on lines 30-32.
- [ ] **Test**: Use browser DevTools network tab to confirm the POST body after clicking "Ingest".

#### Task A.2.2: Wire Correlation Threshold to rag_routes Ingest Pipeline
- [ ] **File**: `benny/api/rag_routes.py`
- [ ] **Action**: In the `ingest_files` handler, verify that `request.correlation_threshold` is passed through to `run_full_correlation_suite(workspace, threshold=request.correlation_threshold)`.
- [ ] **If Not Wired**: Add the call after the embedding/chunking phase.
- [ ] **Test**: POST to `/api/rag/ingest` with `correlation_threshold: 0.50`, verify aggressive links appear.

#### Task A.2.3: Add Real-Time SSE Events for Correlation Progress
- [ ] **File**: `benny/api/graph_routes.py` or new SSE endpoint
- [ ] **Action**: During `run_aggressive_correlation`, emit SSE events via `event_bus` for each concept-symbol pair evaluated: `{"type": "correlation_progress", "concept": "...", "symbol": "...", "similarity": 0.82, "linked": true}`.
- [ ] **Frontend**: Subscribe to SSE in SourcePanel to show live correlation progress.
- [ ] **Test**: Ingest a doc, observe SSE events in browser.

---

### A.3 — Manual Correlation Tool (LangGraph Node)

**Objective**: Allow an agent or user to force-create a semantic relationship between two specific nodes.

**Impact Analysis**:
- **New**: `benny/tools/manual_correlate.py`
- **Modified**: `benny/graph/swarm.py` (register tool in swarm toolset)
- **Modified**: `benny/api/graph_routes.py` (REST endpoint)

#### Task A.3.1: Create Manual Correlation Tool Function
- [ ] **File**: NEW `benny/tools/manual_correlate.py`
- [ ] **Action**: Implement `force_correlate(workspace: str, source_node_id: str, target_node_id: str, rationale: str, confidence: float = 0.90) -> dict`:
  ```cypher
  MATCH (a) WHERE id(a) = $source_id
  MATCH (b) WHERE id(b) = $target_id
  MERGE (a)-[r:CORRELATES_WITH]->(b)
  SET r.strategy = 'manual', r.confidence = $confidence, 
      r.rationale = $rationale, r.created_at = timestamp(),
      r.created_by = 'agent'
  RETURN a.name, b.name, r.confidence
  ```
- [ ] **AER**: Emit `MANUAL_CORRELATION` governance event with full lineage.
- [ ] **Test**: Force-link two known nodes, verify edge exists with correct properties.

#### Task A.3.2: Register as LangGraph Tool
- [ ] **File**: `benny/graph/swarm.py` (or wherever tools are registered)
- [ ] **Action**: Wrap `force_correlate` as a LangChain `Tool` with schema:
  ```python
  Tool(
      name="force_correlate",
      description="Force-create a semantic link between two graph nodes with a rationale.",
      func=force_correlate
  )
  ```
- [ ] **Test**: Invoke via agent prompt: "Link the Concept 'Authentication' to the Class 'AuthService'."

#### Task A.3.3: Add REST Endpoint
- [ ] **File**: `benny/api/graph_routes.py`
- [ ] **Action**: Add `POST /api/graph/force-correlate` accepting `{source_id, target_id, rationale, confidence}`.
- [ ] **Test**: cURL test with two real node IDs from Neo4j.

---

## 2. WORKSTREAM B: Advanced Data Modeling (6-Sigma Lineage)

### B.1 — Probabilistic Edges

**Objective**: Every semantic relationship carries a `confidence_score` [0.0-1.0] and `rationale` string.

#### Task B.1.1: Update CORRELATES_WITH Edge Schema
- [ ] **File**: `benny/synthesis/correlation.py`
- [ ] **Action — `run_safe_correlation`**: Add `r.rationale = 'Exact name match between Concept and CodeEntity'` to the MERGE SET clause.
- [ ] **Action — `run_aggressive_correlation`**: Add `r.rationale = 'Embedding cosine similarity above threshold'` with the actual similarity value embedded.
- [ ] **Validation**: After each correlation run, execute:
  ```cypher
  MATCH ()-[r:CORRELATES_WITH]->() WHERE r.rationale IS NULL RETURN count(r)
  ```
  Assert count = 0.

#### Task B.1.2: Update REL Edge Schema in triples.py
- [ ] **File**: `benny/graph/triples.py`
- [ ] **Action**: The `triple_query` already sets `r.confidence` and `r.citation`. Add `r.rationale = $rationale` where rationale = `f"Extracted from {source_file} via {strategy} strategy"`.
- [ ] **Test**: Ingest a doc, query `MATCH ()-[r:REL]->() RETURN r.rationale LIMIT 5`, verify non-null.

#### Task B.1.3: Update GRAPH_SCHEMA.md
- [ ] **File**: `architecture/GRAPH_SCHEMA.md`
- [ ] **Action**: Add to Section 2.2 (Semantic Relationships):
  - `confidence_score` [0.0-1.0]: Required on all semantic edges.
  - `rationale` (string): Human-readable explanation of why this link exists.
  - `strategy` (string): 'safe' | 'aggressive' | 'manual' | 'directed'.

---

### B.2 — The "DNA" Trace (Ingestion Lineage)

**Objective**: Every edge carries a traceable path back to its source document fragment and AST range.

#### Task B.2.1: Capture doc_fragment_id During Extraction
- [ ] **File**: `benny/synthesis/engine.py`
- [ ] **Action**: In `extract_triples` and `parallel_extract_triples`, when chunking text for LLM extraction, generate a `fragment_id = hashlib.md5(chunk_text.encode()).hexdigest()[:12]` and attach it to each returned `KnowledgeTriple`.
- [ ] **Schema Update**: Add `fragment_id: Optional[str] = None` to `KnowledgeTriple` in `benny/core/schema.py`.
- [ ] **Test**: Extract triples from a doc, verify each triple has a non-null `fragment_id`.

#### Task B.2.2: Capture source_ast_range During Code Analysis
- [ ] **File**: `benny/graph/code_analyzer.py`
- [ ] **Action**: The Tree-Sitter captures already have `start_point` and `end_point` (confirmed in RAW_AST_BENNY.json). When creating `CodeNode` objects, include `ast_range = {"start": start_point, "end": end_point}` in the metadata dict.
- [ ] **Persist**: When upserting to Neo4j, add `n.ast_range_start = $start, n.ast_range_end = $end` to the MERGE SET clause.
- [ ] **Test**: Query a `CodeEntity` node, verify `ast_range_start` is a list `[line, col]`.

#### Task B.2.3: Persist Lineage on Edges
- [ ] **File**: `benny/graph/triples.py`
- [ ] **Action**: In `save_knowledge_triples`, extend the `triple_query` MERGE SET clause:
  ```
  r.doc_fragment_id = $fragment_id,
  r.source_file = $source
  ```
- [ ] **File**: `benny/synthesis/correlation.py`
- [ ] **Action**: In aggressive correlation, when creating CORRELATES_WITH, set:
  ```
  r.source_concept_id = $c_id,
  r.source_symbol_id = $s_id
  ```
- [ ] **Test**: Full pipeline — ingest doc, run correlation, query edge, verify fragment_id present.

---

### B.3 — Temporal Readiness (Time-Travel Graph)

**Objective**: Support `created_at` and `superseded_by` properties for eventual time-travel navigation.

#### Task B.3.1: Add created_at to All Node MERGE Operations
- [ ] **File**: `benny/graph/code_analyzer.py`
- [ ] **Action**: In every `MERGE` Cypher statement for `CodeEntity`/`File`/`Class`/`Function` nodes, add:
  ```
  ON CREATE SET n.created_at = timestamp()
  ON MATCH SET n.updated_at = timestamp()
  ```
- [ ] **File**: `benny/graph/triples.py` — already has `created_at` on Concept nodes. Verify edges also get it.
- [ ] **Test**: Query `MATCH (n) WHERE n.created_at IS NULL RETURN count(n)` — assert 0 for new ingestions.

#### Task B.3.2: Add superseded_by Mechanism
- [ ] **File**: `benny/graph/code_analyzer.py`
- [ ] **Action**: During differential re-ingestion, when a node's definition changes (detected via AST hash comparison):
  1. Set `old_node.superseded_by = new_node.id`
  2. Set `old_node.superseded_at = timestamp()`
  3. Create new node with fresh `created_at`.
- [ ] **Note**: This is a SCHEMA PROPOSAL only for tonight. Full implementation requires differential ingestion (Pain Point 4 / "Nexus Delta"). Mark as Phase 2.

#### Task B.3.3: Update GRAPH_SCHEMA.md with Temporal Properties
- [ ] **File**: `architecture/GRAPH_SCHEMA.md`
- [ ] **Action**: Add to Section 1 (Node Classes):
  - `created_at` (timestamp): When this node was first created.
  - `updated_at` (timestamp): Last modification time.
  - `superseded_by` (string, nullable): ID of the node that replaced this one.
  - `superseded_at` (timestamp, nullable): When this node was superseded.

---

## 3. WORKSTREAM C: Observability & Health

### C.1 — Semantic Drift Dashboard

**Objective**: Diagnostic utility that returns link density, orphan hubs, and graph health metrics.

#### Task C.1.1: Create Diagnostic Query Module
- [ ] **File**: NEW `benny/synthesis/diagnostics.py`
- [ ] **Action**: Implement `async def get_graph_health(workspace: str) -> dict`:
  ```python
  # 1. Total nodes and edges
  # 2. Link density = edges / (nodes * (nodes-1))
  # 3. Semantic edge ratio = count(CORRELATES_WITH + REL) / total_edges
  # 4. Orphan Hubs: nodes with complexity > median but 0 semantic edges
  orphan_query = """
  MATCH (n:CodeEntity {workspace: $ws})
  WHERE NOT (n)-[:CORRELATES_WITH]-() AND NOT (n)-[:REL]-()
  RETURN n.name, n.type, n.file_path
  ORDER BY n.name
  """
  # 5. Cluster health: communities with only 1 member
  # 6. Average confidence on semantic edges
  ```
- [ ] **Return**:
  ```json
  {
    "total_nodes": 1232,
    "total_edges": 2248,
    "semantic_edges": 0,
    "link_density": 0.0014,
    "orphan_hubs": [{"name": "...", "type": "Class", "file_path": "..."}],
    "orphan_count": 129,
    "avg_confidence": null,
    "singleton_clusters": 0,
    "health_grade": "F"
  }
  ```
- [ ] **Health Grade Logic**: A=90%+ semantic coverage, B=70%, C=50%, D=30%, F=<30%.
- [ ] **Test**: Run on current graph, expect grade F (0 semantic links).

#### Task C.1.2: Add API Endpoint
- [ ] **File**: `benny/api/graph_routes.py`
- [ ] **Action**: Add `GET /api/graph/health?workspace=X` returning the diagnostics dict.
- [ ] **Test**: Hit endpoint, verify JSON response with expected fields.

#### Task C.1.3: Frontend Health Badge
- [ ] **File**: `frontend/src/components/Studio/SourcePanel.tsx` (or new component)
- [ ] **Action**: Add a small badge/indicator showing the health grade. Color-code: A=green, B=blue, C=yellow, D=orange, F=red.
- [ ] **Test**: Visual verification after ingestion.

---

### C.2 — Agent Latency Monitoring (AER Decorators)

**Objective**: Automatic tool-level timing and token consumption tracking via Python decorators.

#### Task C.2.1: Create AER Decorator
- [ ] **File**: NEW `benny/governance/aer_decorator.py`
- [ ] **Action**: Implement decorator `@aer_tracked(tool_name: str)`:
  ```python
  import functools, time
  from .execution_audit import emit_node_execution_state
  
  def aer_tracked(tool_name: str, workspace_resolver=None):
      def decorator(func):
          @functools.wraps(func)
          async def wrapper(*args, **kwargs):
              exec_id = str(uuid.uuid4())
              ws = workspace_resolver(args, kwargs) if workspace_resolver else kwargs.get("workspace", "default")
              start = time.monotonic()
              emit_node_execution_state(exec_id, ws, tool_name, "started")
              try:
                  result = await func(*args, **kwargs)
                  duration = (time.monotonic() - start) * 1000
                  emit_node_execution_state(exec_id, ws, tool_name, "completed", 
                      outputs={"result_type": type(result).__name__}, duration_ms=duration)
                  return result
              except Exception as e:
                  duration = (time.monotonic() - start) * 1000
                  emit_node_execution_state(exec_id, ws, tool_name, "failed", 
                      error=str(e), duration_ms=duration)
                  raise
          return wrapper
      return decorator
  ```
- [ ] **Sync variant**: Also create `@aer_tracked_sync` for non-async functions.
- [ ] **Test**: Decorate a dummy function, verify AER events emitted.

#### Task C.2.2: Apply Decorators to Critical Paths
- [ ] **File**: `benny/synthesis/correlation.py`
  - Decorate `run_safe_correlation` with `@aer_tracked("safe_correlation")`
  - Decorate `run_aggressive_correlation` with `@aer_tracked("aggressive_correlation")`
- [ ] **File**: `benny/synthesis/engine.py`
  - Decorate `extract_triples` with `@aer_tracked("triple_extraction")`
  - Decorate `get_embedding` with `@aer_tracked("embedding_generation")`
- [ ] **File**: `benny/graph/code_analyzer.py`
  - Decorate the main analysis entry point with `@aer_tracked("code_analysis")`
- [ ] **Test**: Run full ingestion pipeline, query audit log, verify timing data for each tool.

#### Task C.2.3: Token Consumption Tracking
- [ ] **File**: `benny/core/models.py`
- [ ] **Action**: In `call_model`, capture `prompt_tokens` and `completion_tokens` from the LLM response and emit as part of the AER event.
- [ ] **Test**: Call a model, verify token counts in audit log.

---

## 4. WORKSTREAM D: 3D Aesthetic & Performance (V2 Canvas)

### D.1 — Spatial Semantics Logic ("Gravity Index")

**Objective**: Calculate 3D coordinates based on semantic distance rather than directory tree structure.

#### Task D.1.1: Design Gravity Index Algorithm
- [ ] **File**: NEW `benny/graph/gravity_index.py`
- [ ] **Action**: Implement `compute_gravity_layout(workspace: str) -> List[dict]`:
  1. Fetch all nodes with embeddings from Neo4j.
  2. Compute pairwise cosine similarity matrix (use numpy, cap at 500 nodes for performance).
  3. Apply force-directed layout (spring model): semantically similar nodes attract, dissimilar repel.
  4. Use `scipy.optimize.minimize` or iterative relaxation (Barnes-Hut approximation for large graphs).
  5. Return `[{"id": "...", "x": float, "y": float, "z": float, "community_id": int}]`.
- [ ] **Fallback**: For nodes without embeddings, use directory-tree hierarchy to assign initial positions.
- [ ] **Performance**: Cache layout per workspace. Invalidate on new ingestion.
- [ ] **Test**: Generate layout for test workspace, verify coordinates are in [-100, 100] range.

#### Task D.1.2: Add Gravity Layout API Endpoint
- [ ] **File**: `benny/api/graph_routes.py`
- [ ] **Action**: Add `GET /api/graph/layout?workspace=X&mode=gravity` returning the 3D coordinate array.
- [ ] **Frontend**: Modify `CodeGraphCanvas.tsx` to fetch positions from this endpoint when `mode=gravity`.
- [ ] **Test**: Compare visual output with gravity layout vs. tree layout.

#### Task D.1.3: Integrate with Existing ClusteringService
- [ ] **File**: `benny/graph/clustering_service.py`
- [ ] **Action**: After LPA clustering, pass `community_id` assignments into the gravity index so that nodes in the same community start closer together.
- [ ] **Test**: Verify clustered nodes form visible spatial groups in 3D.

---

### D.2 — Level of Detail (LoD) Strategy

**Objective**: Collapse distant sub-directories into "Concept Spheres" for performance at scale.

#### Task D.2.1: Define LoD Tiers
- [ ] **Document**: This plan defines 3 tiers:
  - **Tier 1 (Close)**: Individual function/class nodes with labels, edges visible. Camera distance < 50 units.
  - **Tier 2 (Mid)**: File-level spheres. Functions collapsed into parent file. Camera distance 50-200 units.
  - **Tier 3 (Far)**: Folder/Module-level "Concept Spheres". All children collapsed. Camera distance > 200 units.

#### Task D.2.2: Backend Aggregation Endpoint
- [ ] **File**: `benny/api/graph_routes.py`
- [ ] **Action**: Add `GET /api/graph/lod?workspace=X&tier=2` that returns:
  - Tier 1: Full node list.
  - Tier 2: Aggregated by file — each file becomes one node with `child_count`, `total_complexity`, `avg_confidence`.
  - Tier 3: Aggregated by folder — each folder becomes one sphere with aggregate metrics.
- [ ] **Test**: Verify Tier 3 returns ~66 nodes (folder count from live stats).

#### Task D.2.3: Frontend LoD Switching Logic
- [ ] **File**: `frontend/src/components/Studio/CodeGraphCanvas.tsx`
- [ ] **Action**: On camera distance change (Three.js `controls.addEventListener('change', ...)`):
  1. Calculate distance to graph center.
  2. Select appropriate LoD tier.
  3. Fetch or switch to cached tier data.
  4. Animate transition (scale nodes up/down with `spring` from react-spring).
- [ ] **Performance Target**: 60 FPS with 1,232 nodes at Tier 1, 211 at Tier 2, 66 at Tier 3.
- [ ] **Test**: Open canvas, zoom in/out, verify smooth tier transitions.

---

## 5. CROSS-CUTTING: Pain Point Resolution Matrix

This section maps every question from `PAIN_POINTS_AND_VISION.md` Section 3 to a task in this plan.

| Critical Question | Resolution | Task ID |
|---|---|---|
| **Temporal Graph Evolution** ("travel back in time") | `created_at` + `superseded_by` properties. Phase 1 adds properties; Phase 2 adds query API for time-travel. | B.3.1, B.3.2, B.3.3 |
| **Probabilistic Lineage** (`confidence_score` on edges) | All semantic edges now carry `confidence` [0-1] and `rationale`. UI can fade low-confidence links. | B.1.1, B.1.2 |
| **The "DNA" Trace** (click link → see ingestion path) | `doc_fragment_id` + `source_ast_range` on every edge. Frontend tooltip can show full trace. | B.2.1, B.2.2, B.2.3 |
| **Semantic Drift Monitoring** (dashboard for health) | `diagnostics.py` module + `/api/graph/health` endpoint + frontend badge. | C.1.1, C.1.2, C.1.3 |
| **Agent Latency Budgets** (cost/value per tool) | AER decorator + token tracking. Dashboard shows ms/tool and tokens/call. | C.2.1, C.2.2, C.2.3 |
| **Spatial Semantics** (semantic gravity in 3D) | Gravity Index with force-directed layout using cosine similarity. | D.1.1, D.1.2, D.1.3 |
| **Visual Fidelity & Shaders** | Deferred to Phase 2 — requires GLSL expertise. Plan proposes using Three.js `ShaderMaterial` with pulse animation tied to `confidence_score`. | Phase 2 |
| **Level of Detail** (cluster spheres at distance) | Three-tier LoD with backend aggregation and frontend camera-distance switching. | D.2.1, D.2.2, D.2.3 |

### Additional Vision Items Addressed

| Vision Item | Resolution | Task ID |
|---|---|---|
| **Semantic Schema Adapter** (Pain Point §2.1) | `SchemaAdapter` class with runtime introspection. | A.1.1, A.1.2, A.1.3 |
| **Adaptive Correlation Intelligence** (§2.2) | `correlationThreshold` wired from UI to backend. Future: auto-tune until target density reached. | A.2.1, A.2.2 |
| **Graph-Pruned LLM Context** (§2.3) | Deferred to Phase 2 — requires implementing `RankedSubgraph` utility. Pre-requisite: gravity index (D.1). | Phase 2 |
| **Differential Ingestion / "Nexus Delta"** (§2.4) | `superseded_by` temporal model (B.3) is the prerequisite. Full diff ingestion is Phase 2. | B.3.1 (prerequisite) |

---

## 6. EXECUTION ORDER & DEPENDENCY GRAPH

```
PHASE 1 (Critical Path - Do First)
├── A.1.1  Schema Introspection Helper
├── A.1.2  SchemaAdapter Class         [depends: A.1.1]
├── A.1.3  Refactor correlation.py     [depends: A.1.2]
├── A.1.4  Schema Health API           [depends: A.1.1]
│
├── B.1.1  Probabilistic CORRELATES_WITH  [depends: A.1.3]
├── B.1.2  Probabilistic REL edges     [parallel with B.1.1]
├── B.1.3  Update GRAPH_SCHEMA.md      [after B.1.1 + B.1.2]

PHASE 2 (Wiring & Tools - Do Second)
├── A.2.1  Audit SourcePanel fetch     [independent]
├── A.2.2  Wire threshold to rag_routes [depends: A.2.1]
├── A.2.3  SSE for correlation progress [depends: A.2.2]
│
├── A.3.1  Manual Correlate function   [depends: B.1.1]
├── A.3.2  Register LangGraph Tool     [depends: A.3.1]
├── A.3.3  REST endpoint               [depends: A.3.1]

PHASE 3 (Lineage & Observability - Do Third)
├── B.2.1  doc_fragment_id capture     [independent]
├── B.2.2  source_ast_range capture    [independent]
├── B.2.3  Persist lineage on edges    [depends: B.2.1, B.2.2]
│
├── B.3.1  created_at on all MERGEs   [independent]
├── B.3.2  superseded_by mechanism     [schema proposal only]
├── B.3.3  Update GRAPH_SCHEMA.md      [after B.3.1]
│
├── C.1.1  Diagnostics module          [depends: A.1.3 for meaningful data]
├── C.1.2  Health API endpoint         [depends: C.1.1]
├── C.1.3  Frontend health badge       [depends: C.1.2]
│
├── C.2.1  AER decorator               [independent]
├── C.2.2  Apply decorators            [depends: C.2.1]
├── C.2.3  Token tracking              [depends: C.2.2]

PHASE 4 (3D & UX - Do Last)
├── D.1.1  Gravity Index algorithm     [depends: B.1.1 for confidence data]
├── D.1.2  Layout API endpoint         [depends: D.1.1]
├── D.1.3  Integrate clustering        [depends: D.1.1]
│
├── D.2.1  Define LoD tiers            [document only]
├── D.2.2  Backend aggregation endpoint [depends: D.1.1]
├── D.2.3  Frontend LoD switching      [depends: D.2.2]
```

---

## 7. SUB-AGENT TASK FORMAT

Every task above is designed to be executed by a Sub-Agent with the following contract:

```json
{
  "task_id": "A.1.1",
  "title": "Create Neo4j Schema Introspection Helper",
  "file": "benny/core/graph_db.py",
  "action": "ADD_FUNCTION",
  "function_name": "introspect_schema",
  "inputs": ["workspace: str"],
  "outputs": ["dict with labels, relationship_types, entity_type_distribution"],
  "cypher_queries": ["CALL db.labels()...", "CALL db.relationshipTypes()..."],
  "aer_event": "TOOL_EXECUTION",
  "test_strategy": "unit_test_with_mock_driver",
  "estimated_tokens": 800,
  "dependencies": [],
  "idempotent": true
}
```

Each task is atomic, idempotent (can be re-run safely due to MERGE semantics), and produces a verifiable output.

---

## 8. DEFINITION OF DONE CHECKLIST

- [ ] **Zero Disconnects**: Run `diagnostics.py` after full ingestion → `semantic_edges > 0` and `health_grade >= "C"`.
- [ ] **Audit Compliance**: Run `retrieve_execution_audit` for any ingestion run → all tool executions have timing data and AER events.
- [ ] **Code Fidelity**: Tree-Sitter parsing tests pass. `RAW_AST_BENNY.json` can be regenerated identically.
- [ ] **Probabilistic Lineage**: `MATCH ()-[r:CORRELATES_WITH]->() WHERE r.confidence IS NULL OR r.rationale IS NULL RETURN count(r)` → returns 0.
- [ ] **3D Visibility**: Open `CodeGraphCanvas` after ingestion → "Neural Sparks" (CORRELATES_WITH edges) render as visible lines between nodes.
- [ ] **Performance**: 3D canvas maintains 60 FPS at Tier 1 with 1,232 nodes.
- [ ] **Atomic Readiness**: Every task in this plan is executable by a junior agent without additional context.

---

*Generated by Principal AI Orchestrator. All decisions grounded in RAW_AST_BENNY.json (10.5M lines, 141 files) and live Neo4j stats (1,232 entities, 2,248 relationships, 0 semantic edges).*
