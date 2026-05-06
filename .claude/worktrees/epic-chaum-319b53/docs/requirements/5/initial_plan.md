# Enterprise Cognitive Mesh — Studio Enhancement Implementation Plan

This plan maps the requirements from `PRD_dog_pound.txt` onto the existing Benny codebase, focusing on evolving the **Studio** from a basic visual workflow canvas into a full **Agentic Workflow Orchestration Engine** with governed inter-agent communication, adaptive retrieval, wave-based swarm execution, and enterprise-grade security.

---

## Current State Assessment

The Benny platform currently has:

| Layer                   | What Exists                                                                                                    | Gap vs PRD                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Studio Canvas**       | ReactFlow canvas with 5 node types (trigger, llm, tool, data, logic), topological execution, basic ConfigPanel | No dynamic control flow, no HITL auto-forms, no runtime branching, no live execution visualization            |
| **Swarm Orchestration** | LangGraph StateGraph: Planner → Orchestrator → Dispatcher → Executor → Aggregator                              | No wave-based execution, no dependency DAG visualization, no conflict avoidance, no context handover protocol |
| **RAG Pipeline**        | ChromaDB vector search, basic top-k retrieval                                                                  | No Adaptive/Self-Correcting RAG, no Smart Router, no Hallucination/Answer grading, no GraphRAG                |
| **Governance**          | OpenLineage + Marquez (lineage), local audit log, API key middleware                                           | No RBAC per tool, no Remix Server pattern, no permission manifests, no Operating Manuals                      |
| **Inter-Agent Comms**   | None — agents are isolated execution units                                                                     | No A2A protocol, no Agent Cards, no capability discovery, no async task delegation                            |
| **Security**            | `X-Benny-API-Key` governance header, loopback binding                                                          | No VM sandboxing, no contact pairing, no credential vault, no explicit permission manifests                   |

---

## User Review Required

> [!IMPORTANT]
> **Phased Delivery Strategy**: This is a large scope. The plan is structured into 6 incremental phases, each delivering a deployable, testable improvement. Phases 1-3 are **core architecture**, Phases 4-6 are **hardening & polish**. Please confirm which phases you'd like to prioritize.

> [!WARNING]
> **New Dependencies**: Phases 1 and 3 introduce new Python packages (`pydantic-settings`, `fastapi-utils`) and potentially a Redis instance for async task state. Phase 3 (A2A) requires a JSON-RPC server. Confirm if adding Redis is acceptable or if we should stay file/SQLite-based.

> [!CAUTION]
> **Breaking Change — Swarm State Schema**: Phase 2 extends `SwarmState` with wave/dependency fields. Existing saved swarm executions won't be compatible. This is internal state only (not user-facing), but flagging it.

---

## Proposed Changes

### Phase 1 — Adaptive RAG & Smart Router

**Goal**: Replace the static top-k vector retrieval with the PRD's Adaptive RAG framework—a self-correcting retrieval pipeline with a Smart Router, quality graders, and a question re-writer.

---

#### Backend — RAG Engine

##### [NEW] [adaptive_rag.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/adaptive_rag.py)

New module implementing the Adaptive RAG pipeline as a LangGraph StateGraph:

- **`SmartRouter` node**: LLM classifier that evaluates query complexity and routes to one of three paths:
  - `no_retrieval` — direct LLM answer from parametric knowledge
  - `single_step` — standard ChromaDB vector search + generation
  - `multi_hop` — iterative graph traversal + vector search + synthesis
- **`RetrieverGrader` node**: Scores retrieved documents for strict relevance (binary yes/no per document)
- **`GenerationNode`**: Synthesizes answer from graded, relevant documents
- **`HallucinationGrader` node**: Binary check — is the answer grounded in the retrieved facts?
- **`AnswerGrader` node**: Quality/completeness assessment
- **`QuestionReWriter` node**: Refines the query and loops back to retrieval if graders fail
- State: `AdaptiveRAGState(query, documents, generation, route, retry_count, max_retries=3)`

##### [MODIFY] [rag_routes.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/rag_routes.py)

- Add new endpoint `POST /api/rag/adaptive-query` that invokes the Adaptive RAG graph
- Preserve existing `POST /api/rag/query` for backward compatibility
- Add `X-RAG-Strategy` response header indicating which route was taken (no_retrieval | single_step | multi_hop)

##### [MODIFY] [graph_db.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/graph_db.py)

- Add `multi_hop_traversal(query, depth=3)` method for graph-based relational reasoning
- Add `compute_sector_exposure()` and `impact_score()` functions as per PRD Table 2 entity schema
- Ensure the knowledge graph supports the PRD entity types: Portfolio, Holding, Company, Sector, Event, Filing

---

#### Frontend — Studio RAG Node Enhancement

##### [MODIFY] [DataNode.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/nodes/DataNode.tsx)

- Add new operation type `adaptive_search` to the data node
- Visual indicator showing which RAG route was taken (color-coded badge)

##### [MODIFY] [ConfigPanel.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/ConfigPanel.tsx)

- When data node has `adaptive_search` operation, show additional config:
  - Max retries slider (1-5)
  - Enable/disable hallucination grading toggle
  - Multi-hop depth slider (1-5)

---

### Phase 2 — Wave-Based Swarm Orchestration

**Goal**: Upgrade the linear Planner → Dispatcher → Executor chain into a proper wave-based dependency-aware execution engine with conflict avoidance, context handover, and post-execution review cycles.

---

#### Backend — Swarm Engine

##### [MODIFY] [state.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/state.py)

Extend `SwarmState` and `TaskItem` with wave/dependency fields:

```python
class TaskItem(TypedDict):
    task_id: str
    description: str
    status: str
    skill_hint: Optional[str]
    wave: int                    # NEW: Wave assignment (0-indexed)
    dependencies: List[str]      # NEW: List of task_ids this depends on
    assigned_model: Optional[str] # NEW: Role-specific model assignment
    files_touched: List[str]     # NEW: For conflict avoidance

class SwarmState(TypedDict):
    # ... existing fields ...
    dependency_graph: Dict[str, List[str]]  # NEW: task_id → [dependency_ids]
    waves: List[List[str]]                  # NEW: Computed wave schedule
    current_wave: int                       # NEW: Currently executing wave
    wave_results: Dict[int, List[PartialResult]]  # NEW: Results per wave
    context_handover: Dict[str, Any]       # NEW: State delta between waves
    review_pass_results: List[Dict]         # NEW: Post-execution QA findings
```

##### [MODIFY] [swarm.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/graph/swarm.py)

Major refactor of the swarm graph:

1. **Enhanced `planner_node`**: Generate tasks with explicit `dependencies` and `wave` assignments. Produce ASCII dependency graph visualization. Implement role-based model assignment (deep-reasoning model for planner/archaeologist, fast model for explore/beads).

2. **New `wave_scheduler_node`**:
   - Compute waves from the dependency graph using topological layering
   - Validate no circular dependencies
   - Generate conflict report (files_touched overlap check)
   - Output: `waves: [[task_1, task_2], [task_3], [task_4, task_5]]`

3. **Refactored `dispatcher_node`**: Instead of fan-out of ALL tasks, dispatch only the **current wave's** tasks. After aggregation, check if more waves remain and loop.

4. **New `context_handover_node`**: After each wave completes:
   - Summarize the delta state (what changed)
   - Persist context variables for the next wave
   - Trim previous wave's full outputs to maintain context window budget

5. **New `review_node`**: Post-execution subagent pass:
   - Validate execution against allowed file paths
   - Check for dependency gaps
   - Run pattern migration checks
   - Return `review_pass_results`

6. **Updated `aggregator_node`**: Combine results from ALL waves, not just a single parallel batch.

7. **New graph structure**:
   ```
   START → planner → wave_scheduler → orchestrator → dispatcher → executor →
   wave_aggregator → context_handover → [dispatcher (next wave) OR review → aggregator → END]
   ```

##### [NEW] [wave_scheduler.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/graph/wave_scheduler.py)

Dedicated module for dependency-aware wave computation:

- `compute_waves(tasks, dependencies) → List[List[str]]`
- `detect_conflicts(wave, file_assignments) → List[Conflict]`
- `generate_ascii_dag(tasks, dependencies) → str`
- `assign_models(tasks, model_registry) → Dict[str, str]` — map cognitive role to best model

---

#### Frontend — Wave Visualization

##### [NEW] [WaveTimeline.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/WaveTimeline.tsx)

New component showing swarm execution as a horizontal timeline:

- Each wave is a column
- Tasks within a wave are vertically stacked cards
- Live status indicators (pending → running → completed/failed)
- Dependency arrows between waves
- Context handover markers between wave transitions

##### [MODIFY] [SwarmStatePanel.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/SwarmStatePanel.tsx)

- Integrate `WaveTimeline` component
- Show ASCII dependency graph in a monospace pre-formatted block
- Display per-wave progress alongside overall progress
- Show review pass findings with severity indicators

##### [MODIFY] [ExecutionBar.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/ExecutionBar.tsx)

- When swarm executes, auto-populate canvas with per-wave visualization instead of the static 5-node linear chain
- Add "Pause after Wave" checkbox for human review between waves

---

### Phase 3 — Agent2Agent (A2A) Protocol

**Goal**: Implement the A2A protocol specification for inter-agent communication, enabling capability discovery, standardized task delegation, and async result streaming.

---

#### Backend — A2A Infrastructure

##### [NEW] [benny/a2a/](file:///C:/Users/nsdha/OneDrive/code/benny/benny/a2a/)

New package for A2A protocol implementation:

###### [NEW] [**init**.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/a2a/__init__.py)

###### [NEW] [models.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/a2a/models.py)

Pydantic models for A2A protocol objects:

- `AgentCard` — capability manifest (JSON metadata: name, description, skills, endpoint, auth)
- `A2ATask` — unit of work (id, status, messages, artifacts, metadata)
- `A2AMessage` — single exchange turn (role, parts, timestamp)
- `UXPart` — modality negotiation (type: text | json | iframe | form | stream)
- `A2AError` — standardized error format

###### [NEW] [server.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/a2a/server.py)

A2A Server implementation (this Benny instance as a remote agent):

- `POST /a2a/tasks/send` — receive a task from a client agent (JSON-RPC 2.0)
- `GET /a2a/tasks/{task_id}` — get task status
- `POST /a2a/tasks/{task_id}/sendSubscribe` — SSE streaming for long-running tasks
- `GET /.well-known/agent.json` — serve this instance's Agent Card

###### [NEW] [client.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/a2a/client.py)

A2A Client for delegating tasks to remote agents:

- `discover_agent(url) → AgentCard` — fetch remote agent's capability manifest
- `send_task(agent_url, task) → A2ATask` — delegate work to a remote agent
- `poll_task(agent_url, task_id) → A2ATask` — check async task status
- `subscribe_task(agent_url, task_id) → AsyncIterator[A2ATask]` — SSE subscription

###### [NEW] [registry.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/a2a/registry.py)

Local agent registry for discovered agents:

- File-based storage under `workspace/agents/`
- `register_agent(agent_card)`, `list_agents()`, `find_agent_for_skill(skill_name)`

##### [MODIFY] [server.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/server.py)

- Mount the A2A router: `app.include_router(a2a_router, prefix="/a2a", tags=["Agent2Agent"])`
- Add `/.well-known/agent.json` endpoint at the root level
- Whitelist A2A discovery endpoint from governance middleware

---

#### Frontend — Agent Management UI

##### [NEW] [AgentRegistry.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/AgentRegistry.tsx)

New component for the "agents" sidebar tab (currently shows `WorkflowList mode="agents"`):

- List of registered agents with their capability cards
- "Discover Agent" button — enter URL, fetch Agent Card, display capabilities
- Agent health status indicators (online/offline)
- Quick-delegate action: select an agent + compose a task

##### [NEW] [A2ANode.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/nodes/A2ANode.tsx)

New canvas node type for delegating to external agents:

- Config: target agent URL, task template, timeout
- Visual: agent card preview, connection status indicator
- Execution: sends A2A task and polls/subscribes for result

##### [MODIFY] [WorkflowCanvas.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/WorkflowCanvas.tsx)

- Register `a2a` node type in `nodeTypes` map
- Add corresponding minimap color

##### [MODIFY] [studio_executor.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/studio_executor.py)

- Add handler for `a2a` node type that invokes the A2A client to delegate to remote agent
- Support async execution with polling for long-running A2A tasks

---

### Phase 4 — MCP Gateway & Remix Servers

**Goal**: Implement the MCP Gateway pattern with Remix Servers to replace the current flat skill registry with a governed, permission-bounded tool delivery system.

---

#### Backend — Gateway Infrastructure

##### [NEW] [benny/gateway/](file:///C:/Users/nsdha/OneDrive/code/benny/benny/gateway/)

###### [NEW] [**init**.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/gateway/__init__.py)

###### [NEW] [remix_server.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/gateway/remix_server.py)

Remix Server — virtualized, curated tool endpoint:

- `RemixServerConfig` — defines which skills are exposed, with what permissions
- `create_remix_server(config) → RemixServer` — compose from skill registry
- `RemixServer.execute(skill_id, args, agent_identity) → Result` — bounded execution
- Permission model: `allow_read`, `allow_write`, `max_calls_per_minute`, `allowed_workspaces`

###### [NEW] [rbac.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/gateway/rbac.py)

Role-Based Access Control for tools:

- `AgentRole` — enum (planner, executor, reviewer, admin)
- `ToolPermission` — per-tool RBAC entry (role, allowed_operations, credential_ref)
- `check_permission(agent_id, tool_id, operation) → bool`
- File-based policy storage: `workspace/policies/rbac.json`

###### [NEW] [credential_vault.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/gateway/credential_vault.py)

Credential management (replaces plain-text API keys):

- Encrypted storage using `cryptography.fernet`
- `store_credential(name, value)`, `get_credential(name) → str`
- Time-limited ephemeral tokens
- Audit log for every credential access

##### [MODIFY] [skill_registry.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/skill_registry.py)

- Add `SkillRegistry.create_remix_view(skill_ids, permissions) → RemixServer`
- `execute_skill` now routes through RBAC checks before execution
- Add `permission_manifest` field to `Skill` dataclass

##### [MODIFY] [skill_routes.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/skill_routes.py)

- New endpoints: `POST /api/remix-servers` (create), `GET /api/remix-servers` (list)
- `POST /api/skills/{skill_id}/execute` — now checks RBAC before execution

---

#### Frontend — Gateway Management

##### [NEW] [RemixServerPanel.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/RemixServerPanel.tsx)

Configuration UI for Remix Servers:

- Drag skills from the skill catalog into a Remix Server composition
- Set per-skill permissions (read/write/execute)
- Assign Remix Server to specific agent roles
- Visual "decision space" indicator showing how bounded the agent is

---

### Phase 5 — Enhanced Studio UI & HITL

**Goal**: Transform the Studio from a static canvas into a live orchestration cockpit with real-time execution visualization, auto-generated HITL forms, runtime branching, and proper result presentation.

---

#### Frontend — Execution Visualization

##### [NEW] [LiveExecutionOverlay.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/LiveExecutionOverlay.tsx)

Real-time execution overlay on the workflow canvas:

- Animated edge flow showing data movement between nodes
- Per-node execution timer
- Pulsing glow on currently executing node
- Error state with expandable error details
- "Reasoning Trace" popover on LLM nodes showing the AER (Agent Execution Record)

##### [NEW] [HITLFormPanel.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/HITLFormPanel.tsx)

Auto-generated HITL intervention form:

- When a workflow hits `requires_approval`, auto-render a form showing:
  - Current agent state (what it's done so far)
  - Intended next action (what it wants to do)
  - Internal reasoning (AER facet data)
  - Approve / Reject / Edit & Continue buttons
- Support for type-safe form fields derived from the node's schema

##### [MODIFY] [WorkflowCanvas.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/WorkflowCanvas.tsx)

- Integrate `LiveExecutionOverlay` during workflow runs
- Add execution progress indicator in canvas header
- Support runtime node insertion (logic branching adds nodes dynamically during execution)

##### [MODIFY] [ResultPanel.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/ResultPanel.tsx)

- Rich result rendering with Markdown support
- Download artifact buttons
- Governance link to Marquez lineage visualization
- Token usage summary and cost estimation

##### [MODIFY] [useWorkflowStore.ts](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/hooks/useWorkflowStore.ts)

- Add `executionPhase: 'idle' | 'running' | 'paused_hitl' | 'completed' | 'failed'`
- Add `currentExecutingNodeId: string | null`
- Add `hitlPendingData: HITLRequest | null`
- Add WebSocket/SSE connection state for live execution updates

---

#### Backend — Streaming Execution

##### [MODIFY] [studio_executor.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/studio_executor.py)

- Add SSE endpoint `GET /api/workflows/execute/{run_id}/events` for real-time execution events
- Emit events: `node_started`, `node_completed`, `node_error`, `hitl_required`, `workflow_completed`
- Add `POST /api/workflows/execute/{run_id}/hitl-response` for HITL form submissions

##### [MODIFY] [workflow_routes.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/workflow_routes.py)

- Add WebSocket endpoint for live execution state streaming
- Enhance interrupt system to return structured HITL form schemas

---

### Phase 6 — Security Hardening & Operating Manuals

**Goal**: Implement the PRD's security architecture—Operating Manuals (SOUL.md / USER.md / AGENTS.md), explicit permission manifests, contact pairing, and filesystem hardening.

---

#### Backend — Operating Manuals

##### [NEW] [benny/governance/operating_manual.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/governance/operating_manual.py)

Operating Manual system:

- Load and parse `SOUL.md`, `USER.md`, `AGENTS.md` from workspace root
- `get_agent_identity(workspace) → AgentIdentity` — structured identity from SOUL.md
- `get_operational_rules(workspace) → OperationalRules` — coding standards, escalation paths
- `get_user_context(workspace) → UserContext` — enterprise context, authorized personnel
- System prompts are dynamically augmented with Operating Manual content before LLM calls

##### [NEW] [benny/governance/permission_manifest.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/governance/permission_manifest.py)

Permission manifest enforcement:

- Load `permissions.json` from skill/tool packages
- Validate declared capabilities against actual behavior
- Block undeclared filesystem/network access
- Audit log for every permission check

##### [MODIFY] [audit.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/governance/audit.py)

- Add SHA-256 verification for all audit log entries (immutable audit trail)
- Add `emit_security_event()` for permission violations, unauthorized access attempts
- Add explicit AI contribution disclosure in governance events (`co_authored_by` field)

---

#### Frontend — Security Dashboard

##### [MODIFY] [GlobalAdminDashboard.tsx](file:///C:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Admin/GlobalAdminDashboard.tsx)

Enhance the admin dashboard with:

- **Operating Manual Editor**: View/edit SOUL.md, USER.md, AGENTS.md per workspace
- **Permission Audit Log**: Real-time feed of permission checks and violations
- **Agent Identity Cards**: Visual cards showing each configured agent's identity and boundaries
- **Credential Vault UI**: Manage encrypted credentials (add/rotate/revoke)
- **Security Threat Matrix**: Visual rendering of PRD Table 3 threat vectors with current mitigation status

---

#### Workspace Templates

##### [NEW] Template files in workspace creation

When `ensure_workspace_structure()` creates a new workspace, generate default:

- `SOUL.md` — default agent identity template
- `USER.md` — enterprise context placeholder
- `AGENTS.md` — default operational rules
- `policies/rbac.json` — default role-based access control policy
- `agents/` — directory for A2A agent registrations

---

## Open Questions

> [!IMPORTANT]
> **Redis vs SQLite for Async State**: The PRD specifies async background tasks and long-running A2A workflows. Currently, execution state is in-memory (`executions: Dict`). Should we:
>
> - **(A)** Add Redis as a managed service in docker-compose (recommended for production)
> - **(B)** Use SQLite for persistence (simpler, no new infra)
> - **(C)** Keep in-memory with file-based crash recovery (current approach, extended)

> [!IMPORTANT]
> **Phase Priority**: Which phases are most critical to deliver first? My recommendation:
>
> - **Quick wins**: Phase 2 (Wave Swarm) + Phase 5 (Studio UI) — most visible impact
> - **Foundation**: Phase 1 (Adaptive RAG) — critical for quality
> - **Enterprise**: Phase 3 (A2A) + Phase 4 (Gateway) — for multi-agent scenarios
> - **Hardening**: Phase 6 (Security) — for production deployment

> [!WARNING]
> **VM Sandboxing**: The PRD mandates VM sandboxing for third-party tools. Full VM isolation (e.g., gVisor, Firecracker) is significant infrastructure. Should we:
>
> - **(A)** Implement subprocess isolation with restricted permissions (pragmatic)
> - **(B)** Use Docker containers for tool execution (containerized sandboxing)
> - **(C)** Defer to a future phase and document the gap

---

## Verification Plan

### Automated Tests

Each phase includes verification:

| Phase                | Test Strategy                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Adaptive RAG** | Unit tests for SmartRouter classification, grader accuracy against golden dataset, end-to-end RAG pipeline test with known-answer queries |
| **2 — Wave Swarm**   | Unit tests for wave computation from dependency graphs, conflict detection tests, integration test executing a 3-wave plan                |
| **3 — A2A Protocol** | Spin up two Benny instances, discover + delegate + receive result, verify JSON-RPC compliance                                             |
| **4 — MCP Gateway**  | RBAC unit tests (allow/deny for each role), Remix Server composition tests, credential encryption round-trip                              |
| **5 — Studio UI**    | Browser subagent tests: drag nodes, execute workflow, verify HITL form appears, approve, verify completion                                |
| **6 — Security**     | Operating Manual loading tests, permission manifest validation, audit log SHA-256 verification                                            |

### Manual Verification

- Visual inspection of Studio UI enhancements via dev server (`npm run dev`)
- Swarm execution with wave visualization using a multi-step document generation task
- A2A delegation test between two local Benny instances
- Security audit of credential storage and RBAC enforcement
