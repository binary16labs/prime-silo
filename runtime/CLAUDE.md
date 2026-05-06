# Benny — Agent Navigation Guide

This is a **local-first, multi-model AI orchestration platform**. Key facts before you start:

## Architecture in one sentence
A FastAPI backend + React/Three.js frontend + Neo4j knowledge/code graph + LangGraph swarm executor + **Pypes declarative transformation engine**, all portable under `$BENNY_HOME`.

## Four capability surfaces

Benny treats **documents**, **code**, **tabular data**, and the **operator cockpit** as first-class:

- **Documents** → RAG / Knowledge Graph (`benny/api/rag_routes.py`, `benny/core/adaptive_rag.py`)
- **Code** → Code Graph + Swarm execution (`benny/api/graph_routes.py`, `benny/graph/swarm.py`)
- **Tabular data** → Pypes transformation engine (`benny/pypes/`, `benny/api/pypes_routes.py`) — manifest-driven DAG with bronze→silver→gold stages, CLP lineage, checkpoints, drill-down, and explainable financial-risk reports. Plus a **sandbox layer** (`pypes plan` / `agent-report` / `bench` / `chat`) for LLM manifest authoring, agent narratives, pandas-vs-polars benchmarks, and multi-turn drill-down — all advisory and side-effect-free relative to the deterministic core. See [docs/operations/PYPES_TRANSFORMATION_GUIDE.md](docs/operations/PYPES_TRANSFORMATION_GUIDE.md).
- **Operator cockpit** → AgentAmp (`benny/agentamp/`, `frontend/src/agentamp/`) — Winamp-style skinnable cockpit. **Phases 1–6 shipped**: `.aamp` skin packs + HMAC signing (`scaffold-skin / pack / sign / install`); AgentVis WebGL plugin sandbox (Phase 2); DSP-A deterministic spectrum/VU/loop pipeline (Phase 3); Textual TUI mini-mode (Phase 4); Equalizer manifest write + policy/ledger (Phase 5); Playlist run-history + enqueue + Layout DSL snap/clamp + user-state portability export/import (Phase 6). Phases 7–9 (effects pipeline, marketplace, release hardening) are next. See [docs/operations/AGENTAMP_GUIDE.md](docs/operations/AGENTAMP_GUIDE.md).

## Where things live

| What | Where |
|------|-------|
| **Backend API** (FastAPI, 24 route modules) | `benny/api/` |
| **Pypes transformation engine** (DAG manifests, CLP lineage, drill-down) | `benny/pypes/` + `benny/api/pypes_routes.py` |
| **AgentAmp cockpit** (skin packs, signing, scaffold, plugins) | `benny/agentamp/` + `frontend/src/agentamp/` |
| **CLI entry point** | `benny_cli.py` |
| **Frontend** (React 19, Three.js, Vite) | `frontend/src/` |
| **Swarm executor** (LangGraph) | `benny/graph/swarm.py` |
| **Planner** (requirement → manifest) | `benny/graph/manifest_runner.py` |
| **LLM router + offline guard** | `benny/core/models.py` |
| **Knowledge graph (RAG, concepts)** | `benny/api/rag_routes.py` + `benny/core/adaptive_rag.py` |
| **Code graph (Tree-Sitter AST)** | `benny/api/graph_routes.py` + `benny/graph/code_analyzer.py` |
| **Neo4j driver** | `benny/core/graph_db.py` |
| **Governance / audit / lineage** | `benny/governance/` |
| **Portable home (init/up/down)** | `benny/portable/` |
| **MCP server for Claude** | `benny/mcp/server.py` |
| **Docker services** | `docker-compose.yml` (Neo4j, Marquez, Phoenix, N8N) |

## Key CLI commands

```bash
benny plan "<requirement>" --workspace <ws> --save   # LLM-generate manifest
benny run <manifest.json> --json                      # execute manifest
benny runs ls --limit 10                              # run history
benny enrich --workspace c5_test --src src/dangpy --run               # enrichment (inline mode)
benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json \
             --workspace c5_test --src src/dangpy --run                # enrichment (declarative v2.0)
benny enrich --manifest <path> --resume <prior_run_id> --run           # resume a partial run
benny pypes inspect manifests/templates/financial_risk_pipeline.json   # validate a pypes manifest
benny pypes run     manifests/templates/financial_risk_pipeline.json --workspace pypes_demo
benny pypes drilldown <run_id> gold_exposure --workspace pypes_demo    # rows + CLP annotations
benny pypes rerun    <run_id> --from silver_trades --workspace pypes_demo
# --- pypes sandbox layer (advisory; never mutates run audit data) ---
benny pypes plan         "<requirement>" --workspace W [--save] [--run] [--strategy auto|oneshot|incremental|swarm]  # LLM-author a draft manifest (auto picks incremental for local/thinking models)
benny pypes agent-report <run_id>        --workspace W                    # one-shot risk-analyst Markdown narrative
benny pypes bench        pandas=<m1> polars=<m2> --workspace W [--repeats N]   # head-to-head wall/CPU/RSS/cost
benny pypes model-bench  manifests/templates/model_comparison_planner.json --workspace W [--judge] [--save-report out.md]   # cross-model time/cost/tokens/accuracy/quality
benny pypes chat         <run_id>        --workspace W                    # multi-turn risk-analyst REPL grounded on the run
# --- agentamp — skinnable cockpit (Phases 1–6 shipped) ---
benny agentamp scaffold-skin <id>  [--drafts-dir D]  # create deterministic draft (signature: null)
benny agentamp pack   <draft_dir> --out <id>.aamp     # zip draft into .aamp
benny agentamp sign   <id>.aamp                       # HMAC-SHA256 sign (uses BENNY_HMAC_KEY)
benny agentamp install <id>.aamp [--workspace W]      # verify sig + register under $BENNY_HOME
benny agentamp enqueue <manifest.json> [--workspace W] [--api-base URL] [--api-key KEY]  # enqueue run
benny agentamp export-cockpit <out.aamp.cockpit>      # export user state + EQ to portable bundle
benny agentamp import-cockpit <in.aamp.cockpit>       # restore user state + EQ from bundle
benny up/down/status/doctor --home $BENNY_HOME        # service lifecycle
```

## Documentation (read these first)

- **[docs/README.md](docs/README.md)** — navigation hub for all docs
- **[architecture/SAD.md](architecture/SAD.md)** — C4 diagrams, dual-graph design, swarm lifecycle
- **[docs/operations/BENNY_OPERATING_MANUAL.md](docs/operations/BENNY_OPERATING_MANUAL.md)** — run book
- **[docs/operations/LOG_AND_LINEAGE_GUIDE.md](docs/operations/LOG_AND_LINEAGE_GUIDE.md)** — logs, SSE, Marquez, Phoenix, AER
- **[docs/operations/PYPES_TRANSFORMATION_GUIDE.md](docs/operations/PYPES_TRANSFORMATION_GUIDE.md)** — declarative DAG transformations, CLP lineage, drill-down, financial-risk reports
- **[docs/operations/AGENTAMP_GUIDE.md](docs/operations/AGENTAMP_GUIDE.md)** — AgentAmp cockpit: skin pack format, HMAC signing, scaffold/pack/sign/install CLI, release gates
- **[architecture/WORKSPACE_GUIDE.md](architecture/WORKSPACE_GUIDE.md)** — workspace structure + c4_test/c5_test guide
- **[architecture/GRAPH_SCHEMA.md](architecture/GRAPH_SCHEMA.md)** — Neo4j schema

## Critical rules (do not break)

1. **Always use `call_model()`** (`benny/core/models.py`) — never call litellm directly. This is how offline mode, logging, and lineage fire.
2. **Never add absolute paths** to manifests or config. Use `${BENNY_HOME}` tokens. The SR-1 gate (`pytest tests/portability`) enforces this.
3. **Always sign manifests** with `sign_manifest()` before sharing or executing.
4. **All HTTP API calls need** `X-Benny-API-Key: benny-mesh-2026-auth` (unless path is in `GOVERNANCE_WHITELIST`).
5. **Never commit** `logs/`, `brain/`, `$BENNY_HOME/` contents — they are git-ignored for good reason.

## Dual-graph architecture

There are **two graphs** in the same Neo4j instance:

- **Knowledge graph** (`Concept`, `Document`, `REL` edges) — populated from ingested PDFs/markdown. Shown in **Notebook → KnowledgeGraphCanvas**.
- **Code graph** (`File`, `Class`, `Function`, `DEFINES`/`DEPENDS_ON` edges) — populated by Tree-Sitter analysis. Shown in **Studio → CodeGraphCanvas**.
- **Enrichment overlay** (`CORRELATES_WITH` edges) — links both graphs; built by the `benny enrich` pipeline (see [docs/operations/KNOWLEDGE_ENRICHMENT_WORKFLOW.md](docs/operations/KNOWLEDGE_ENRICHMENT_WORKFLOW.md)), toggled in Studio. Manifest template at `manifests/templates/knowledge_enrichment_pipeline.json` (schema_version 2.0, fully declarative).

## Active test workspaces (in `$BENNY_HOME/workspaces/`)

- **c4_test** — H.G. Wells texts ingested; validates RAG pipeline end-to-end.
- **c5_test** — UML/architecture PDFs in `data_in/staging/`; `src/dangpy` for the code graph; enrichment pipeline operational end-to-end via `benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json --workspace c5_test --src src/dangpy --run`.

## Running tests

```bash
pytest tests/ -q                      # full suite (~200 tests)
pytest tests/release -q               # 6σ release gates
pytest tests/portability -q           # SR-1 absolute-path auditor
```

Release gates: G-COV (≥85%), G-SR1 (≤408 path violations), G-LAT (<300ms plan), G-ERR (0 flakes), G-SIG (manifest integrity), G-OFF (offline compliance).
