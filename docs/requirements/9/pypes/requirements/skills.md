# Pypes: Agentic Skills & Governance Protocol

This document defines the operational standards and "Mental Model" that any AI agent must adopt when contributing to the Pypes project. Its purpose is to ensure consistency, prevent context drift, and minimize token waste across multiple development sessions.

## 1. Core Mental Model: The UI-Observer / CLI-Master Pattern
Agents must treat the **CLI and Service Layer** as the single source of truth. 
- The UI is a secondary, visual representation of the **Execution Contract (The Manifest)**.
- Do NOT build logic into the UI; build it into the `pypes` engine and expose it via the `FileService`.

## 2. Operational Skills & Protocols

### A. Session Initiation (The "Handoff Hook")
At the start of every session, the agent MUST:
1. **Initialize Session Hash**: Generate or retrieve the current session's cryptographic hash. This hash is the unique identifier for all activities in the `kortex/` directory.
2. **Locate the Global Index**: Read `global_index.json` to understand the current workspace landscape.
3. **Review the State**: Check `project_plan.md` (Section: Current Flight Status) to see where the previous session left off.
4. **Verify Constants**: Check `core/config.py` for port mappings and service URLs. Do NOT guess ports.


### B. The "Progressive Discovery" Mantra
When analyzing the codebase or data:
- Start with high-level summaries (e.g., `list_dir`).
- Only "drill down" into file contents when a specific path is identified as relevant.
- Avoid massive `grep` or `ls -R` calls that flood the context window.

### C. Cognitive Integrity & Rationale
- **Rationale Articles**: Every non-trivial code change or manifest generation must be accompanied by a "Rationale Article" explaining the *why* behind the design.
- **Mechanical Review**: When performing data transformations, the agent must generate a `Signed Rationale` (JSON) that documents the validation steps taken.
- **Reasoning Hygiene**: Always strip `<think>` blocks and internal monologues before outputting final JSON or code artifacts.

### D. Kortex Memory & Session Logging
- **Immutable Trace**: Every chat interaction, manifest generation, and execution audit MUST be mirrored to `kortex/{session_hash}/`.
- **Semantic Linkage**: When creating objects or files, include the `session_hash` in the metadata to enable back-tracing to the specific session that birthed the artifact.
- **Audit Synchronicity**: Ensure that `kortex/` logs are updated *before* final execution commits to prevent data loss if a process crashes mid-flight.

## 3. Technical Constraints

### A. The CLP Meta-Model
- Every data attribute must be mapped: **Conceptual** (Business intent) -> **Logical** (Type/Constraint) -> **Physical** (Schema/Path).
- If a new field is added to a model, it MUST include metadata for all three layers.

### B. Orchestration (Hamilton + Ibis)
- **Logic Isolation**: All transformation logic must be written in **Ibis**.
- **Graph Control**: The execution flow must be managed by **Hamilton**. 
- Never hardcode execution sequences; define them as DAG nodes with clear inputs and outputs.

### C. File I/O
- Use the `FileService` (or equivalent `core/files.py` abstraction) for ALL I/O.
- Do not use raw `open()` or `pathlib` for data operations; use the system's "Unified Access" layer to ensure lineage tracking.

## 4. Drift Prevention & State Management

### A. Context Locking
- When working on a specific workspace (e.g., `workspaces/trade_reports`), do not modify files in other workspaces unless explicitly requested.
- Keep the "Context Window" clean by closing unrelated files or summarizing large documents into `requirements/` artifacts.

### B. The "Pause" Protocol (Session End)
Before ending a session, the agent MUST:
1. Update `project_plan.md` with the current status.
2. Ensure all active code is committed or saved as a draft.
3. Record any "Hidden Gotchas" found during the session in `previous_project_pain_points.md`.

## 5. Error Handling & Resilience
- **LLM Instability**: If a model call fails or returns malformed JSON, trigger the "Self-Healing Loop": Diagnose -> Patch Manifest -> Retry.
- **Broken Data**: If a transformation step fails due to data quality, do not stop. Generate a "Data Patch" step and notify the Human Architect for review.
