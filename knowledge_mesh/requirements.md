# Knowledge Mesh: Lean & Portable Profile Requirements

## 1. Analysis: Initial Requirements vs. Outcome (Pypes)

**Initial Vision (`01_initial_requirements.md`)**:
- A declarative, contract-driven data transformation engine.
- Strictly decoupled processing using Medallion architecture (Bronze, Silver, Gold).
- Multi-engine backend (Pandas, Polars, PySpark) driven by Pydantic stateless JSON contracts.
- Clear separation between the "AI agent sandbox" and the actual data execution layer.

**Actual Outcome (Current `pypes` codebase)**:
- The codebase evolved into a highly capable but tightly coupled AI Agent orchestration tool.
- Files like `agent_chat.py`, `planner.py`, `orchestrator.py`, and `model_compare.py` live directly alongside the core execution engine (`engine.py`, `validators.py`).
- **The Gap**: The AI functional knowledge (how an agent plans and chats) is tangled with the execution logic (how data is transformed and audited). This prevents easy portability of "Skills" to new workspaces.

## 2. Core Objectives for the Knowledge Mesh

To achieve a **leaner, cleaner profile** where every project within a workspace can be isolated for the various "functions of life", we must fundamentally restructure how knowledge and skills are managed:

- **Decoupling**: Separate the AI reasoning (skills, planning, orchestration) from the execution utilities (data pipelines, database interactions).
- **Portability**: Package skills and function knowledge as lightweight, portable modules (e.g., standard `.md` or `.json` definitions) that can be easily plugged into any new isolated project silo.
- **Isolation**: Each project (or "function of life") should only load the specific slice of the Knowledge Mesh it requires, minimizing bloat.

## 3. Pillar Components

### A. Data Audit (Powered by Pypes)
- Strip `pypes` down to its core: `models.py`, `validators.py`, `engine.py`, and `engines/`.
- Move the agentic layers (`planner.py`, `agent_chat.py`) into the portable Knowledge Mesh as standalone **Skills**.
- Ensure the data audit strictly uses JSON contracts, making it fully portable.

### B. Document Management (Graph of Ingestion)
- Implement a streamlined pipeline that ingests documents directly into a structured graph (Neo4j).
- The "Graph of Ingestion" will track provenance, relationships, and extracted entities.
- This serves as the localized "Brain" for a specific project silo.

### C. Session & Action Audit (Powered by Memo-Ray)
- Utilize `memo-ray` as the visualization and session management layer.
- Ensure all actions taken by agents within a project silo are logged to an Action Audit trail (Memo-Ray's provenance).
- Deliver a "really cool interface" that provides real-time oversight of the agent's work, active skills, and the evolving document graph.

## 4. Next Steps
- Re-architect the `prime-silo` directory structure to physically separate `skills/` from `core-engines/`.
- Establish standard templates for spinning up a new "isolated function of life" project with just the required mesh components.
