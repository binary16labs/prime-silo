# Benny - Deterministic Graph Workflow Platform

A multi-model AI orchestration platform with governance and observability.

## Features

- **n8n-style Workflow Studio** - Visual drag-and-drop workflow builder
- **Multi-Model Orchestration** - LiteLLM integration for any LLM provider
- **LangGraph Workflows** - Deterministic state graphs with conditional routing
- **Human-in-the-Loop** - Governance checkpoints for approval workflows
- **OpenLineage** - Data lineage tracking to Marquez
- **Phoenix Tracing** - Distributed observability
- **Persistence** - SQLite/PostgreSQL checkpointing with time-travel debugging

## Quick Start

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

```bash
pip install -e .
uvicorn benny.api.server:app --reload
```

### LLM Services

```bash
manage_llm.bat start-ollama
```

## Architecture

```
benny/
├── api/         # FastAPI endpoints
├── core/        # State schemas, model config
├── graph/       # LangGraph workflows
├── governance/  # OpenLineage, Phoenix
├── persistence/ # SQLite/PostgreSQL checkpointers
└── tools/       # Agent tools (files, knowledge, data)

frontend/
└── src/
    └── components/
        ├── Studio/     # Workflow canvas, nodes
        └── LLMManager/ # LLM provider controls
```

## License

MIT
