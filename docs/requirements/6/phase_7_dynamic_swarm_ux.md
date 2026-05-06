# Phase 7 — Dynamic Swarm & UX 360 (Cognitive OS Evolution)

## 0. Vision & Context: The Cognitive Operating System

Benny is transitioning from a task assistant to a **Cognitive Operating System**. This phase establishes the "Strategic Inquisitor" capability—a self-organizing, multi-agent engine designed to navigate the "uncharted territory" of the agentic era.

### 0.1 The "Uncharted Territory" Mandate
As compute and model capacity increase at an exponential rate, software architecture must evolve from static codebases to dynamic, agent-governed meshes. This phase implements the tools to analyze and build that future.

### 0.2 Core Architectural Principles
1.  **Dynamic Emergence**: Execution strategies are not hard-coded; they emerge from the interaction of agents and data.
2.  **Least-Skill Segregation**: Security via minimal capability. Each agent instance is "blind" to tools it doesn't strictly need.
3.  **Additive Synthesis**: The results of many specialized agents must be integrated into a product greater than the sum of its parts.
4.  **UX Transparency (UX 360)**: Every cognitive step, security check, and agent-to-agent negotiation is visible to the human operator.

---

## 1. Project Requirements (PRD)

### 1.1 Dynamic Fan-out System
- **Recursive Tasking**: The `executor` can identify "Deep Gutters" in its findings and signal the `planner` to spawn sub-tasks (max depth 2).
- **Flexible Scheduling**: Wave-based execution must adapt in real-time if sub-tasks are added during a run.
- **Context Handover (Deep)**: Sub-tasks must inherit a filtered, relevant subset of the parent's context without bloating the token window.

### 1.2 Skill & Security Bounding
- **Least-Skills Enforcement**: The `executor` must check a task's `assigned_skills` against the `MCP Permission Manifest`.
- **Credential Isolation**: Each agent session uses ephemeral, scoped credentials, never global keys.
- **SHA-256 Audit Integrity**: Every task result must be cryptographically hashed and verified in the UI (The "Trust Bar").

### 1.3 UX 360 Visualization
- **Cognitive Control Center**: A centralized dashboard aggregating all previous telemetry (A2A, Swarm, RAG, Security).
- **A2A Pulse**: Live view of agent message traffic and registry lookups.
- **The Trust Bar**: A high-visibility indicator showing the verification status of the current execution's audit trail.
- **Dynamic Wave Timeline**: A visualization that updates in real-time as the fan-out expands recursively.

### 1.4 Local Resource Governor (Laptop Safety)
- **`max_concurrency` (User Defined)**: Hard cap on parallel agent executions via `SWARM_MAX_CONCURRENCY`. Defaults to 1 for laptops. 
- **`recursion_limit` (User Defined)**: Maximum depth of sub-swarm spawning. Settable in Config Panel.
- **Config UI**: A dedicated "Compute" tab in the Config Panel allows real-time adjustment of these limits for local hardware safety.

---

## 2. Specific Strategic Objective: "The Architect's Pivot"

### 2.1 Scenario Configuration
- **Prompt**: *"what would a software architect do next in an era of uncharted territory of agentic transformations and change especially when models and compute is increasing in capacity at fast rate"*
- **Workspace**: `test4`
- **Data Files**: `FrolovRoutledge2024.md`, `Title The Art of War.txt`.

### 2.2 Expected Output
1.  **Integrated Knowledge Graph**: A Neo4j graph linking agentic capacity to architectural shifts.
2.  **Strategic Synthesis Report**: A deep, multi-agent document where specialized agents (Economist, Security Expert, System Architect) have appended their specific perspectives.

---

## 3. Implementation Phases

| Phase | Title | Focus |
| :--- | :--- | :--- |
| **7.1** | [Recursive Swarm Logic](file:///C:/Users/nsdha/OneDrive/code/benny/docs/requirements/6/phase_7_1_recursive_swarm.md) | Multi-depth planning and dynamic scheduling. |
| **7.2** | [Least-Skill Enforcement](file:///C:/Users/nsdha/OneDrive/code/benny/docs/requirements/6/phase_7_2_least_skill_security.md) | MCP Permission Manifest integration and agent isolation. |
| **7.3** | [UX 360 Observability](file:///C:/Users/nsdha/OneDrive/code/benny/docs/requirements/6/phase_7_3_ux_360_cockpit.md) | Trust Bar, A2A Pulse, and Dynamic Timeline components. |
| **7.4** | [Strategic Workflow Deployment](file:///C:/Users/nsdha/OneDrive/code/benny/docs/requirements/6/phase_7_4_strategic_ingestion.md) | `test4` ingestion and "Architect's Pivot" execution. |
