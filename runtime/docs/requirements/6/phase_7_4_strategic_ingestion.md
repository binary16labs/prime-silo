# Phase 7.4 — The Strategic Inquisitor (Deployment)

## 1. Objective
Pull together the Recursive Swarm, Least-Skill Security, and UX 360 into a final, mission-specific execution for the `test4` workspace.

## 2. Architectural Changes

### 2.1 Strategic Workflow Definition (`workspace/workflows/strategic_architect.yaml`)
- **Workflow YAML**: Defines the "Strategic Inquisitor" strategy, identifying initial "Knowledge Pillars" from the source documents.
- **Planner Seed**: The prompt regarding the software architect's next steps in the agentic era.

### 2.2 Specialized Agent Personas
- **The Skeptic**: Focused on security and model drift (Least-Skill: `read_document`, `verify_hash`).
- **The Technologist**: Focused on compute trends and architecture (Least-Skill: `read_document`, `code_analysis`).
- **The Economist**: Focused on resource allocation and tokenomics (Least-Skill: `read_document`, `calculator`).

## 3. Implementation Details

### [NEW] [workspace/workflows/strategic_architect.yaml](file:///C:/Users/nsdha/OneDrive/code/benny/workspace/workflows/strategic_architect.yaml)
```yaml
id: strategic_architect
name: The Architect's Pivot
version: 1.0.0
trigger:
  prompt: "What would a software architect do next in an era of agentic transformations?"
  files:
    - FrolovRoutledge2024.md
    - Title The Art of War.txt
strategy:
  fan_out: dynamic
  recursion_depth_max: 2
  synthesis_mode: additive
```

## 4. Acceptance Criteria (BDD)
- **Scenario**: End-to-end "Architect's Pivot" execution.
  - **Given** the `test4` workspace is initialized.
  - **When** the "Strategic Inquisitor" workflow is selected and triggered.
  - **Then** the `Planner` must generate at least 3 specialized agent tasks.
  - **And** each agent must generate a section appended to the `strategic_report.md`.
  - **And** the `Neo4j` graph must be updated with the identified architectural relationships.
  - **And** the final output must be "Greater than the sum of its parts".

## 5. Verification Plan
- **Manual Verification**:
    - Launch Benny Studio.
    - Select Workspace `test4`.
    - Upload `FrolovRoutledge2024.md` and `Title The Art of War.txt` (if not present).
    - Select "Strategic Architect" from the selectable workflow list.
    - Execute and monitor "UX 360" for the Trust Bar status.
    - Inspect the final `strategic_report.md` for multi-persona synthesis.
