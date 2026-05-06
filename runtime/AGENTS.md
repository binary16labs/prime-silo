# Benny Global Agent Directives (AGENTS.md)

Welcome to Benny. If you are an AI agent operating in this repository, this file is your root instruction manual. Benny is a local-first, multi-model AI orchestration platform built on FastAPI, React, Neo4j, and LangGraph.

## The Prime Directive
You are not just a user of this codebase; you are its co-developer. You have the autonomy to use the tools available in `skills/` to read files, modify code, search the knowledge graph, and write documentation.

## Architecture Guidelines
- **Zero-Egress by Default**: We strictly adhere to `BENNY_OFFLINE=1`. Do not introduce dependencies that require an active internet connection at runtime unless explicit permission is granted.
- **Dual-Graph Awareness**: Always be mindful of the Neo4j dual-graph (Knowledge Graph and Code Graph). Any significant architectural change must consider its impact on graph parsing and the Pypes transformation engine.
- **Model Agnosticism**: Never hardcode litellm, openai, or specific model APIs. Always route via `benny.core.models.call_model()`.

## Data Lifecycle & Ingestion (CRITICAL)
- **Staging Directory**: Any PDF or raw document located in a `staging/` directory is considered **un-ingested**. 
- You must **NEVER** attempt to run multi-agent swarms, complex analysis, or model comparisons directly against raw PDFs in staging. 
- You MUST first draft a pipeline that routes the file through `pdf_extract` -> `rag_ingest` -> `deep_synthesis` to populate the ChromaDB and Neo4j graphs before executing downstream analytical tasks.

## Repository Navigation
Depending on where you are working, consult the localized `AGENTS.md`:
- Working on the UI/AgentAmp? See `frontend/AGENTS.md`.
- Working on the core orchestrator or backend? See `benny/AGENTS.md`.
- Updating documentation or the DeepWiki? See `docs/AGENTS.md`.

## Skills and Autonomy
Consult the `skills/` directory and `skills/TOOLS.md` for a list of your available tools. You are expected to use these tools to perform tasks such as semantic search, file manipulation, and data processing independently.

## Do Not Do List
1. Do not use absolute paths. Always use `${BENNY_HOME}`.
2. Do not bypass `X-Benny-API-Key` on new routes.
3. Do not ignore the Six-Sigma release gates in `tests/release/`.
