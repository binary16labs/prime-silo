# Synthesis Engine, Workflow & UI Graph Optimization Plan

A comprehensive audit and optimization plan for the Benny platform's synthesis engine (`benny/synthesis/engine.py`), workflow orchestration (`benny/graph/`), graph database layer (`benny/core/graph_db.py`), API routes (`benny/api/graph_routes.py`), and frontend knowledge graph visualization (`frontend/src/components/Notebook/`).

## User Review Required

> [!IMPORTANT]
> This plan includes **40+ individual improvements** across 5 layers. Some changes are large (adaptive chunking, streaming SSE, graph deduplication). I recommend approving in phases:
>
> - **Phase 1 (Backend Engine)** — Highest ROI, fixes active bugs
> - **Phase 2 (Graph DB)** — Performance and data quality
> - **Phase 3 (Workflow)** — Robustness and observability
> - **Phase 4 (Frontend)** — UX polish and interactivity
>
> Please confirm if you'd like all phases done together, or prioritized.

> [!WARNING]
> **Active bug found (Line 595, graph_routes.py):** The `/graph/synthesize` endpoint references an undefined variable `graph_summary` (should be `"\n".join(lines)`). This will crash every call to the synthesis endpoint. Fixed in Phase 1.

---

## Proposed Changes

### Phase 1: Synthesis Engine (`benny/synthesis/engine.py`)

The synthesis engine is functional but has several critical opportunities for improvement.

---

#### [MODIFY] [engine.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/synthesis/engine.py)

**1. Adaptive Context-Window Chunking (replaces hardcoded 6000/8000 char limits)**

- Replace `safe_text = text[:6000]` with an intelligent chunker that estimates token count (~4 chars/token) and adapts to model capabilities.
- Add a `max_context_tokens` parameter configurable per-provider.

**2. Batch Embedding Pipeline (single sequential → concurrent)**

- Currently, embeddings are generated one-by-one in a serial loop (graph_routes.py L523-545). Move embedding logic into the engine as `batch_embed_concepts()` using `asyncio.gather()` with a semaphore for throughput.

**3. Retry Logic with Exponential Backoff**

- `call_llm()` currently has zero retry handling. Add configurable retry with exponential backoff (3 retries, 1/2/4s delays) to handle transient NPU timeouts.

**4. Streaming JSON Parser**

- `_parse_json_from_llm()` fails silently on malformed JSON (returns `[]`). Add partial-match recovery: if the JSON array is truncated (missing `]`), attempt to close it and parse what's available.

**5. Deduplication in Triple Extraction**

- Multiple sections can produce near-duplicate triples (e.g., "Dopamine → drives → reward" appearing in both intro and conclusion). Add a post-extraction deduplication pass using normalized subject/predicate/object strings.

**6. Confidence Thresholding**

- Add a configurable minimum confidence filter (default 0.3) to discard low-quality triples before storage, reducing graph noise.

**7. Proper Logging (replace print statements)**

- Replace all `print()` calls with `logging.getLogger(__name__)` for structured observability.

---

### Phase 2: Graph Database Layer (`benny/core/graph_db.py`)

---

#### [MODIFY] [graph_db.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/graph_db.py)

**8. Connection Pooling & Session Context Manager**

- Currently, every function opens a new `driver.session()` without any pooling configuration. Add a connection pool config to the driver initialization (`max_connection_pool_size=50`).
- Create a reusable `@contextmanager` for session management to ensure consistent cleanup.

**9. Read Transactions vs Write Transactions**

- All queries use `session.run()` (auto-commit). Use `session.execute_read()` for read paths (`get_full_graph`, `get_stats`, `vector_search`) and `session.execute_write()` for mutations. This enables the driver to route reads to replicas if available.

**10. Efficient Graph Stats (Single Query)**

- `get_graph_stats()` makes 5 separate round-trips to Neo4j. Consolidate into a single Cypher query using `OPTIONAL MATCH` and `count()` aggregation.

**11. Paginated Full Graph**

- `get_full_graph()` returns ALL nodes and edges unconditionally. For large graphs (1000+ nodes), this kills performance. Add `SKIP`/`LIMIT` pagination with a `page` and `page_size` parameter.

**12. Incremental Recent Updates (Real Timestamp Filtering)**

- `/graph/recent` currently returns the last 50 edges from the full graph. Replace with a proper Cypher timestamp filter: `WHERE r.created_at > datetime() - duration({seconds: $seconds})`.

**13. True Centrality Calculation**

- `update_graph_centrality()` only computes degree (neighbor count). Upgrade to PageRank using a lightweight in-memory calculation or APOC procedure if available.

**14. Vector Index Dimension Auto-Detection**

- The vector index is hardcoded to 1536 dimensions (OpenAI). Local models like nomic-embed-text use 768 dimensions. Detect dimension from the first embedding stored and create the index dynamically.

---

### Phase 3: API Routes & Workflow (`benny/api/graph_routes.py`, `benny/graph/workflow.py`, `benny/graph/swarm.py`)

---

#### [MODIFY] [graph_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/graph_routes.py)

**15. Fix Critical Bug: Undefined `graph_summary` Variable**

- Line 595: `analogies = await find_synthesis(graph_summary=graph_summary, ...)` references a variable that's never assigned. Should be `graph_summary = "\n".join(lines)`.

**16. SSE Progress Streaming for Ingestion**

- File ingestion (`/graph/ingest-files`) blocks until completion with no progress feedback. Add a Server-Sent Events (SSE) endpoint that streams progress events: `section_started`, `triples_extracted`, `embedding_complete`, `conflicts_detected`.

**17. Eliminate Duplicate Import**

- Lines 20-24 and 332-336 both import from `..synthesis.engine`. Consolidate into a single import block at the top.

**18. Background Task for File Ingestion**

- Currently, `/graph/ingest-files` runs synchronously in the request handler. Long ingestion jobs (multi-file, large PDFs) will cause HTTP timeouts. Move to `BackgroundTasks` with a status polling endpoint, matching the pattern already used in `workflow_routes.py`.

**19. Defensive Source Name Handling**

- File processing uses raw filenames as source identifiers. Add URL-encoding/sanitization to prevent injection in Cypher queries.

---

#### [MODIFY] [workflow.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/graph/workflow.py)

**20. Error Recovery in call_llm Node**

- Currently, `call_llm()` catches all exceptions and stores the error, but the routing function `should_use_tool()` doesn't check for errors, so the flow continues to `format_output` even on failure without any recovery attempt. Add an error-aware routing path.

**21. Streaming Node Status Updates**

- Add `current_node` updates as the graph progresses for real-time UI feedback via the existing execution status endpoint.

---

#### [MODIFY] [swarm.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/graph/swarm.py)

**22. Async Executor Nodes**

- `executor_node()` and `planner_node()` use synchronous `completion()` calls, blocking the event loop. Convert to `await acompletion()` for proper async behavior.

**23. Task-Level Progress Tracking**

- The aggregator currently only reports success/failure. Add per-task status updates to `partial_results` for real-time progress in the SwarmStatePanel.

**24. Configurable Skill Priority**

- `discover_skills()` returns all skills equally. Add a priority/ranking system based on skill metadata (e.g., `priority: high` in the skill's front-matter).

---

### Phase 4: Frontend (Knowledge Graph Canvas & Synthesis Panel)

---

#### [MODIFY] [KnowledgeGraphCanvas.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Notebook/KnowledgeGraphCanvas.tsx)

**25. Debounced Search**

- The search input triggers re-renders on every keystroke. Add a 300ms debounce to prevent excessive WebGL repaints.

**26. Node Detail Sidebar (replaces inline tooltip)**

- The current node info panel (`graph-node-info`) is minimal. Expand it to show: connected edges, source documents, confidence distribution, and a "neighbor subgraph" mini-view.

**27. Edge Label Rendering on Canvas**

- Predicate text is only visible on hover. Add `linkThreeObjectExtend` text labels so relationship names are always visible for the focused subgraph.

**28. Graph Performance Guards**

- For graphs with >500 nodes, automatically switch to lower-fidelity rendering (disable particles, reduce node resolution) to maintain 60fps.

**29. WebSocket for Real-Time Updates**

- Replace polling (`setInterval(5000)`) with a WebSocket connection that pushes new edges as they're ingested, enabling live "grow" animations.

**30. Export Graph as Image/Data**

- Add toolbar buttons to export the current view as PNG (canvas screenshot) and the graph data as JSON/CSV.

---

#### [MODIFY] [SynthesisPanel.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Notebook/SynthesisPanel.tsx)

**31. Ingestion Progress Bar**

- Replace the simple Loader spinner with a determinate progress bar showing: "Processing section 3/12 — 45 triples extracted".

**32. Triple Inspector**

- The results section shows triples as flat text. Render each triple as an interactive card with: confidence gauge, citation excerpt, and a "fly-to" button that navigates to the triple's nodes in the 3D graph.

**33. Conflict Resolution UI**

- Detected conflicts are shown as a count but never actionable. Add an inline conflict resolution panel where users can approve, reject, or merge conflicting triples.

**34. Synthesis History Timeline**

- Add a chronological timeline view of past synthesis runs, showing which documents were processed, how many triples/conflicts/analogies were found, and the model used.

---

#### [MODIFY] [SourcePanel.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/SourcePanel.tsx)

**35. Non-Blocking Ingestion UI**

- Replace `alert()` and `window.confirm()` dialogs with inline toast notifications and confirmation modals that don't interrupt workflow.

**36. File Preview Thumbnails**

- Show a miniature preview (first page of PDF, first 200 chars of text) in the file cards.

---

### Phase 5: Cross-Cutting Optimizations

---

**37. Unified Logging with Structured JSON**

- All `print()` statements across the backend should be replaced with Python's `logging` module using a JSON formatter for production observability.

**38. Configuration File for Engine Defaults**

- Move hardcoded values (parallel_limit=4, inference_delay=2.0, context truncation sizes, confidence thresholds) into a `synthesis_config.yaml` or `workspace_manifest` settings.

**39. httpx Client Reuse**

- Multiple functions create new `httpx.AsyncClient()` instances per request. Create a shared client with connection pooling at the module level.

**40. Type Safety for Triple Objects**

- Define a Pydantic `KnowledgeTriple` model and use it throughout the pipeline instead of raw `Dict[str, Any]`.

---

## Open Questions

> [!IMPORTANT]
> **1. Phasing:** Do you want all changes implemented together, or would you prefer starting with Phase 1 (engine + critical bug fix) first?

> [!IMPORTANT]
> **2. WebSocket vs SSE:** For real-time graph updates during ingestion, would you prefer WebSocket (bidirectional, more complex) or SSE (simpler, one-way server push)?

> [!IMPORTANT]
> **3. Large Graph Pagination:** For graphs exceeding ~500 nodes, should the UI automatically paginate (show clusters on demand) or should we implement level-of-detail rendering (all nodes visible but simplified)?

---

## Verification Plan

### Automated Tests

1. **Synthesis Engine:**
   - Unit test `_parse_json_from_llm()` with truncated/malformed JSON inputs
   - Unit test deduplication logic with near-duplicate triples
   - Integration test `parallel_extract_triples()` with mock LLM responses
2. **Graph DB:**
   - Test consolidated stats query returns same results as current 5-query approach
   - Test paginated `get_full_graph()` with boundary conditions
3. **API Routes:**
   - Verify `/graph/synthesize` no longer crashes (the `graph_summary` bug)
   - Test SSE streaming endpoint delivers proper event format

### Manual Verification

- Run a full ingestion pipeline with a multi-section PDF document
- Observe the 3D graph rendering performance before/after optimizations
- Verify the streaming progress updates in the Synthesis Panel UI

## Status

# Benny Optimization Task Tracker

## Phase 1: Synthesis Engine (`benny/synthesis/engine.py`)

- [x] 1. Adaptive context-window chunking
- [x] 2. Batch embedding pipeline (`batch_embed_concepts`)
- [x] 3. Retry logic with exponential backoff in `call_llm()`
- [x] 4. Streaming JSON parser (truncated JSON recovery)
- [x] 5. Triple deduplication pass
- [x] 6. Confidence thresholding
- [x] 7. Replace print() with proper logging

## Phase 2: Graph Database (`benny/core/graph_db.py`)

- [x] 8. Connection pooling config
- [x] 9. Read/write transaction separation
- [x] 10. Consolidated stats query (single round-trip)
- [x] 11. Paginated full graph + "see all" mode
- [x] 12. Timestamp-based incremental updates
- [x] 13. PageRank centrality (with weighted degree fallback)
- [x] 14. Vector index dimension auto-detection

## Phase 3: API & Workflow

- [x] 15. Fix critical bug: undefined `graph_summary` in synthesize endpoint
- [x] 16. SSE progress streaming for ingestion
- [x] 17. Eliminate duplicate imports in graph_routes.py
- [x] 18. Background task for file ingestion
- [x] 19. Defensive source name handling
- [x] 20. Error recovery routing in workflow.py
- [x] 21. Streaming node status updates (via SSE events)
- [x] 22. Async executor nodes in swarm.py (acompletion)
- [x] 23. Task-level progress tracking (event callback)
- [x] 24. Configurable skill priority (front-matter)

## Phase 4: Frontend

- [x] 25. Debounced search in KnowledgeGraphCanvas
- [x] 26. Node detail sidebar
- [x] 27. Edge label rendering (via linkLabel with enhanced detail)
- [x] 28. Graph performance guards (>500 nodes)
- [x] 29. SSE real-time graph updates (replace polling)
- [x] 30. Export graph as PNG/JSON
- [x] 31. Ingestion progress bar in SynthesisPanel
- [x] 32. Triple inspector cards
- [x] 33. Conflict resolution UI
- [x] 34. Synthesis history timeline
- [ ] 35. Non-blocking toast notifications (replace alert/confirm) — partial (confirm still uses window.confirm)
- [x] 36. Dual-mode graph: paginated drilldown + "see all" view

## Phase 5: Cross-Cutting

- [x] 37. Structured JSON logging (logging module throughout)
- [x] 38. Config file for engine defaults (SynthesisConfig in schema.py)
- [x] 39. httpx client reuse (shared client in engine.py)
- [x] 40. Pydantic KnowledgeTriple model
