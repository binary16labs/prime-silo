# Cognitive Mesh PRD: Gap Analysis & Implementation Plan for Benny

A systematic audit of the Benny platform against every pillar of the Cognitive Mesh PRD. Each section maps the PRD mandate to the current codebase state, identifies the gap, assigns severity, and proposes the remediation path.

---

## 1. Meta-Model Framework (BPMN + UML + ER)

The PRD mandates a unified meta-model integrating BPMN 2.0 (macro-orchestration), UML (agent institutional manifests), and ER (memory tier schemas) **before code is written**.

| PRD Mandate                                                                                                                      | Current Benny State                                                                                                                                                             | Gap Severity |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **BPMN 2.0 Macro-Orchestration** — Visual process modeling with Hard Gates, Pools/Swimlanes mapped to Agent Nodes.               | Benny's Studio uses a `ReactFlow` canvas with custom nodes (`WorkflowCanvas.tsx`). Workflows are JSON-serialized, not BPMN-compliant. No Hard Gate enforcement.                 | **HIGH**     |
| **UML Agent Institutional Manifests** — Every agent has a formalized class blueprint (permissions, memory, tools, token limits). | Agents are defined ad-hoc in `studio_executor.py` (system prompts + tool lists). No formalized class schema. No token expenditure limits per agent.                             | **HIGH**     |
| **ER Memory Tier Schemas** — Explicit separation of Short-Term, Working State, and Long-Term memory with defined schemas.        | ChromaDB handles Long-Term (chunked embeddings in `rag_routes.py`). No formal Working State persistence (no LangGraph checkpointer). Short-Term is just the LLM context window. | **MEDIUM**   |

### Proposed Remediation (Phase 2+)

- [ ] Define a `AgentManifest` Pydantic schema in [schema.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/schema.py) enforcing: `name`, `persona`, `tools_allowed[]`, `memory_collections[]`, `token_budget`, `access_scope`.
- [ ] Add a `manifest.agent.yaml` file per workspace defining agent boundaries.
- [ ] Long-term: Explore BPMN 2.0 XML import/export for the Studio canvas to achieve formal compliance.

---

## 2. Micro-Reasoning Engine (LangGraph Alignment)

The PRD standardizes on **LangGraph** for stateful, cyclical, checkpointed agent reasoning.

| PRD Mandate                                                                                               | Current Benny State                                                                                                                                   | Gap Severity |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Stateful Directed Graph** — Nodes (logic), Edges (conditional routing), State (shared typed structure). | Benny's Studio canvas uses `ReactFlow` nodes with a custom executor (`studio_executor.py`). Execution is linear/sequential, not a true state machine. | **MEDIUM**   |
| **Cyclical Reasoning** — Agents can loop back to previous steps if tool outputs are insufficient.         | No cyclical execution support. Nodes execute once per workflow run.                                                                                   | **MEDIUM**   |
| **Persistent Checkpointing** — Pause/resume long-running workflows with perfect state integrity.          | No checkpointing. If a synthesis run fails mid-way, the entire pipeline must be re-run from scratch.                                                  | **HIGH**     |

### Proposed Remediation (Phase 2+)

- [ ] Evaluate wrapping `_process_content_to_graph` in a LangGraph `StateGraph` to formalize the extraction → conflict-detection → storage → embedding pipeline.
- [ ] Introduce a checkpoint table in the workspace (`runs/{run_id}/checkpoint.json`) to allow resumption.

---

## 3. Interoperability Protocols (MCP + A2A)

The PRD mandates **Model Context Protocol** (tool discovery) and **Agent2Agent** (peer-to-peer agent collaboration).

| PRD Mandate                                                                                            | Current Benny State                                                    | Gap Severity     |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------- |
| **MCP Client** — Agents dynamically discover and invoke external tools at runtime.                     | Tools are hardcoded per-node in the Studio. No runtime tool discovery. | **LOW** (future) |
| **A2A Protocol** — Agents publish Agent Cards (`.well-known/agent.json`) and collaborate via JSON-RPC. | No A2A support. All agents are internal to the Benny process.          | **LOW** (future) |

### Proposed Remediation (Phase 3+)

- [ ] Publish a `.well-known/agent.json` endpoint on the Benny API describing the platform's synthesis capabilities.
- [ ] Implement an MCP client in the Studio executor to allow nodes to discover tools from external MCP servers.

---

## 4. Security & Sandboxing (Zero-Trust)

The PRD mandates defense-in-depth: ephemeral sandboxes, strict workspace confinement, loopback-only binding, and Policy-as-Code.

| PRD Mandate                                                                               | Current Benny State                                                                                                                                                     | Gap Severity |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Workspace Confinement** — Strict `$WORKSPACE_ROOT` confinement; path traversal blocked. | `workspace.py` constructs paths via `WORKSPACE_ROOT / workspace_id / subdir`. **No path traversal validation.** A crafted `workspace_id` like `../../etc` would escape. | **CRITICAL** |
| **Gateway Binding** — Bound to loopback or secure tailnet with mandatory token auth.      | `server.py` line 115: `host="0.0.0.0"`. CORS allows `*`. **No authentication middleware.**                                                                              | **CRITICAL** |
| **Tool Authority** — Explicit allow-lists; read-only scoped tokens.                       | `studio_executor.py` grants tools based on node type. No explicit deny-list. No read-only scoping.                                                                      | **HIGH**     |
| **Execution Sandbox** — Ephemeral VM/Container for non-idempotent commands.               | All execution happens directly on the host Python process. No containerization.                                                                                         | **MEDIUM**   |
| **Policy-as-Code** — DMN + NeMo Guardrails to override agent intent.                      | No guardrails integration. No DMN decision tables.                                                                                                                      | **MEDIUM**   |

### Proposed Remediation (Phase 1 — Immediate)

> [!CAUTION]
> **Path Traversal Vulnerability**: The `get_workspace_path` function does NOT validate `workspace_id`. An attacker could escape the workspace root. This must be fixed immediately.

- [ ] **FIX NOW**: Add path traversal validation to `get_workspace_path()` in [workspace.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/workspace.py). Ensure the resolved path is always a child of `WORKSPACE_ROOT`.
- [ ] **FIX NOW**: Bind uvicorn to `127.0.0.1` instead of `0.0.0.0` in [server.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/server.py).
- [ ] Add a simple API key middleware for production deployments.

---

## 5. Observability, Provenance & Lineage

The PRD mandates **OpenLineage** (data lineage), **Agent Execution Records** (reasoning provenance), and **Phoenix/OpenTelemetry** (tracing).

| PRD Mandate                                                                                        | Current Benny State                                                                                                                                                                                                                             | Gap Severity             |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **OpenLineage / Marquez** — Track dataset consumption, transformation, and production.             | `lineage.py` exists with a full `BennyLineageClient`. It emits `START`/`COMPLETE`/`FAIL` events. Custom facets for LLM calls, workflow execution, and tool execution are defined. `etl_routes.py` calls `track_file_conversion` ✅.             | **LOW** (partially done) |
| **Agent Execution Record (AER)** — Structured tuple: Intent, Observation, Inference, Plan Version. | **Not implemented.** Synthesis engine outputs raw triples. No structured reasoning log is emitted.                                                                                                                                              | **HIGH**                 |
| **Phoenix / OpenTelemetry Tracing** — Distributed tracing for LLM calls, tools, and workflows.     | `tracing.py` exists with full Phoenix/OTEL integration, decorators (`trace_llm_call`, `trace_tool_execution`, `trace_workflow`), and W3C trace context propagation ✅. **However, no route or engine function actually uses these decorators.** | **MEDIUM**               |
| **Real-time Task Progress** — UI shows percentage completion of long-running operations.           | Ingestion logs are polled from a flat file (`ingest.log`). No structured progress tracking. No percentage.                                                                                                                                      | **HIGH**                 |

### Proposed Remediation (Phase 1 — This Sprint)

#### [NEW] [task_manager.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/task_manager.py)

- In-memory task registry with thread-safe progress updates.
- Schema: `task_id`, `workspace`, `type` (indexing|synthesis|etl), `status` (queued|running|paused|complete|failed), `progress` (0-100), `total_steps`, `current_step`, `aer_log[]`, `lineage_run_id`, `created_at`, `updated_at`.

#### [NEW] [task_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/task_routes.py)

- `GET /api/tasks` — All tasks across all workspaces (for Admin Dashboard).
- `GET /api/tasks?workspace={id}` — Scoped tasks (for Notebook Activity tab).

#### [MODIFY] [rag_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/rag_routes.py)

- Register task on ingest start. Update progress after each batch commit. Emit AER entries: Intent ("Indexing document X"), Observation ("Batch N committed, M chunks"), Inference ("Remaining: ...").

#### [MODIFY] [graph_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/graph_routes.py)

- Register task on synthesis start. Update progress per-section during `parallel_extract_triples`. Emit AER entries with extraction reasoning.

#### [MODIFY] [lineage.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/governance/lineage.py)

- Add `AgentExecutionRecordFacet` dataclass ($I_k, O_k, N_k, P_k$).
- Wire `START`/`RUNNING`/`COMPLETE` events into the task lifecycle.

---

## 6. Human-in-the-Loop (HITL) Experience

The PRD mandates seamless pause/resume via LangGraph checkpointing, with Z-pattern AER dashboards for human review.

| PRD Mandate                                                                                         | Current Benny State                                                      | Gap Severity |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| **Pause/Resume Agent Execution** — Serialize state at conditional boundaries, await human approval. | No pause/resume capability. All operations run to completion or failure. | **HIGH**     |
| **HITL Dashboard** — Z-pattern UI showing AER narrative, confidence metrics, and override controls. | No HITL UI exists.                                                       | **HIGH**     |

### Proposed Remediation (Phase 1 — This Sprint, UI Only)

#### [NEW] [GlobalAdminDashboard.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Admin/GlobalAdminDashboard.tsx)

- **Left pane**: Workspace list with health indicators (task count, last activity, governance tags from manifest).
- **Main pane**: System-wide task queue with status badges, progress bars, and Marquez lineage links.
- **Right pane**: Selected task detail with AER timeline (Intent → Observation → Inference → Plan).

#### [NEW] [WorkspaceActivityLog.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Notebook/WorkspaceActivityLog.tsx)

- Workspace-scoped view in the Notebook right-hand Discovery Panel (new "Activity" tab).
- Shows only tasks for `currentWorkspace`.
- Polls `GET /api/tasks?workspace={id}` every 2 seconds during active operations.

#### [MODIFY] [App.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/App.tsx)

- Add `view = 'admin'` with a Shield icon in the navigation rail.
- Route to `GlobalAdminDashboard` when active.

#### [MODIFY] [NotebookView.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Notebook/NotebookView.tsx)

- Add "Activity" as a fourth tab in the Discovery Panel.

---

## 7. Regulatory Compliance (EU AI Act, ISO 42001)

| PRD Mandate                                                                                                                            | Current Benny State                                                                                                                                                      | Gap Severity     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **EU AI Act** — Detailed technical documentation, traceability of algorithmic outputs, data provenance, human oversight documentation. | AER (not yet implemented) would satisfy traceability. OpenLineage (partially implemented) satisfies data provenance. BPMN visual documentation (not BPMN-compliant yet). | **MEDIUM**       |
| **ISO/IEC 42001** — Risk assessments, documented accountability, infrastructure security.                                              | `governance_tags` field exists in `WorkspaceManifest` but is not enforced anywhere. No risk assessment framework.                                                        | **LOW** (future) |

### Proposed Remediation (Phase 2+)

- [ ] Enforce `governance_tags` in the manifest to gate operations (e.g., `high_compliance` tag prevents unsandboxed execution).
- [ ] Generate compliance reports from AER + OpenLineage data.

---

## Implementation Priority

| Priority | Item                                                   | Files                                                                                                                                                                        |
| -------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 P0    | Path traversal fix in `workspace.py`                   | [workspace.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/workspace.py)                                                                                           |
| 🔴 P0    | Bind server to `127.0.0.1`                             | [server.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/server.py)                                                                                                  |
| 🟠 P1    | Task Manager + Task Routes                             | NEW: `task_manager.py`, `task_routes.py`                                                                                                                                     |
| 🟠 P1    | AER Facet in lineage.py                                | [lineage.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/governance/lineage.py)                                                                                         |
| 🟠 P1    | Wire progress into `rag_routes.py` + `graph_routes.py` | [rag_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/rag_routes.py), [graph_routes.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/api/graph_routes.py) |
| 🟡 P2    | Global Admin Dashboard                                 | NEW: `GlobalAdminDashboard.tsx`                                                                                                                                              |
| 🟡 P2    | Workspace Activity Log tab                             | NEW: `WorkspaceActivityLog.tsx`                                                                                                                                              |
| 🟢 P3    | Agent Manifest schema                                  | [schema.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/schema.py)                                                                                                 |
| 🟢 P3    | Apply Phoenix tracing decorators                       | [synthesis/engine.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/synthesis/engine.py)                                                                                  |
| ⚪ P4    | MCP Client, A2A Protocol, NeMo Guardrails              | Future sprint                                                                                                                                                                |

---

## Verification Plan

### P0 Security Fixes

- Attempt path traversal via API: `GET /api/files?workspace=../../etc` → must return 403.
- Confirm server binds to `127.0.0.1` only.

### P1 Task Manager

- Start a large indexing job → poll `GET /api/tasks?workspace=test2` → verify progress 0→100%.
- Verify AER entries appear in the task's log array.

### P2 Admin Dashboard

- Navigate to the Admin view → verify all workspaces are listed with health data.
- Click a running task → verify AER timeline renders correctly.
