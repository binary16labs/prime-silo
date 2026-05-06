# Benny Core Backend Directives (benny/AGENTS.md)

This directory contains the FastAPI backend, the LangGraph swarm executor, the Pypes declarative engine, and the core orchestration logic.

## Ownership and Architecture
- `benny/api/`: All FastAPI routes must implement standard exception handling and require `X-Benny-API-Key` (unless whitelisted).
- `benny/graph/`: Swarm execution and state management. LangGraph nodes must be pure functions where possible, mutating state deterministically.
- `benny/pypes/`: The declarative transformation engine. Changes here must maintain backward compatibility with existing pipeline manifests and preserve CLP (column-level provenance).
- `benny/agentamp/`: Server-side support for the skinnable cockpit (handling .aamp files, signatures, DSP-A SSE streams).

## Implementation Rules
1. **Deterministic Execution**: The core must remain byte-replay-identical. Do not introduce side-effects in manifest-execution paths.
2. **Logging**: Use the standard logger. Critical swarm events must be emitted over the `EventBus` for AgentAmp to visualise.
3. **Database**: Always use the Neo4j driver via `benny.core.graph_db`. Do not introduce raw cypher queries outside of the established repository layer without explicit review.
