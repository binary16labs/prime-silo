# Workspace Guide

This document describes how Benny workspaces are structured and documents the active test/experiment workspaces.

---

## 1. Workspace Anatomy

Each workspace lives at `$BENNY_HOME/workspaces/<name>/`:

```
workspaces/<name>/
├── manifest.yaml          # workspace config: default_model, tools, wiki config
├── AGENTS.md              # agent standards: coding rules, tool policies, forbidden actions
├── SOUL.md                # agent persona (name, purpose, communication style, values)
├── USER.md                # user preferences for this workspace
├── data_in/               # source documents — PDFs, markdown, code files for ingestion
├── data_out/              # generated artefacts (reports, summaries, plans)
├── chromadb/              # vector store — isolated per workspace
├── manifests/             # signed SwarmManifest JSONs for this workspace
├── runs/                  # run records (SQLite)
├── reports/               # analysis output
├── staging/               # files queued for processing
├── live/                  # live connector cache
├── skills/                # workspace-scoped agent skills
├── credentials/           # encrypted credential vault (git-ignored)
└── src/                   # source code for code graph analysis (code workspaces only)
```

### Switching Workspaces

```bash
# CLI
benny plan "..." --workspace c5_test

# HTTP API
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     "http://127.0.0.1:8005/api/rag/status?workspace=c5_test"

# Global default
export BENNY_WORKSPACE=c5_test
```

---

## 2. Active Test Workspaces

### c4_test — Workflow & RAG Experiment Ground

**Purpose**: End-to-end validation of the RAG pipeline. H.G. Wells texts have been ingested as markdown and are used to test semantic retrieval, graph chat, and synthesis.

**What's in `data_in/`**:
- `Tales of Space and Time.md`
- `The First Men in the Moon.md`
- `The Time Machine.md`

**Typical operations**:
```bash
# Check RAG status
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     "http://127.0.0.1:8005/api/rag/status?workspace=c4_test"

# Semantic chat
curl -X POST -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     -H "Content-Type: application/json" \
     -d '{"query": "What happens in The Time Machine?", "workspace": "c4_test", "mode": "semantic"}' \
     http://127.0.0.1:8005/api/rag/chat

# View knowledge graph
# Open Notebook tab in Studio UI → select c4_test workspace → KnowledgeGraphCanvas
```

**Graph type**: Knowledge graph only (`Concept`, `Document`, `REL` edges). No code analysis in this workspace.

---

### c5_test — Code Analysis & Architecture Mapping Ground

**Purpose**: The code intelligence experiment workspace. Architecture PDFs and UML diagrams have been ingested to markdown (via Docling) and loaded into the knowledge graph. The goal is to map architecture concepts onto source code structure.

**What's in `data_in/`**: UML diagrams, architecture documents (converted to markdown via `benny/core/extraction.py` + Docling).

**What's in `src/`**: `dangpy` — a Python codebase targeted for code graph analysis.

**Current state**:
- Knowledge graph: ✅ Concepts extracted from architecture docs, `REL` edges present.
- Code graph: `src/dangpy` ready for Tree-Sitter analysis (run the analyser to populate).
- Enrichment overlay: 🔜 Pending code graph population + semantic correlator run.

**Next steps to complete the c5_test analysis**:

```bash
# Step 1: Run code analysis on the workspace source
curl -X POST -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     -H "Content-Type: application/json" \
     -d '{"workspace": "c5_test", "path": "src/dangpy"}' \
     http://127.0.0.1:8005/api/graph/code/analyze

# Step 2: Run semantic correlator to link Concepts → CodeEntities
curl -X POST -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     -H "Content-Type: application/json" \
     -d '{"workspace": "c5_test", "strategy": "aggressive"}' \
     http://127.0.0.1:8005/api/rag/synthesize

# Step 3: Check CORRELATES_WITH edges exist in Neo4j
# Query in Neo4j Browser (http://localhost:7474):
# MATCH (c:Concept)-[r:CORRELATES_WITH]->(e:CodeEntity {workspace: 'c5_test'})
# RETURN c.name, r.confidence, e.name, e.type LIMIT 25

# Step 4: Enable enrichment toggle in Benny Studio
# → Studio tab → Code Graph view → toggle "Enrich with Knowledge Graph"
```

**Graph types**:
- Knowledge graph: `Concept` nodes from architecture docs with `REL {predicate}` edges.
- Code graph: `File`, `Class`, `Function` from `dangpy` source with `DEFINES`, `DEPENDS_ON` edges.
- Enrichment edges (pending): `CORRELATES_WITH` linking both graphs.

---

## 3. Graph Visualisation: Where Each Graph Appears

| Graph | UI Surface | Tab | Data Source |
|-------|-----------|-----|-------------|
| Knowledge graph (concepts, docs) | Notebook | `KnowledgeGraphCanvas` | `benny/api/rag_routes.py` |
| Code graph (files, classes, functions) | Studio | `CodeGraphCanvas` | `benny/api/graph_routes.py` |
| Enriched overlay (concepts linked to code) | Studio | `CodeGraphCanvas` (toggle) | `graph_routes.py?enrich=true` *(planned)* |

Both graphs are stored in the same **Neo4j instance** using different node labels and are queryable together via Cypher. The UI surfaces them separately to keep cognitive load manageable — the enrichment toggle is the bridge.

---

## 4. Creating a New Workspace

```bash
# Via CLI (creates $BENNY_HOME/workspaces/<name>/ with default scaffold)
benny init --workspace my_workspace

# Or manually: copy an existing workspace and edit manifest.yaml
cp -r $BENNY_HOME/workspaces/c4_test $BENNY_HOME/workspaces/my_workspace
# Edit: manifest.yaml (change name, default_model)
#       SOUL.md (change persona)
#       AGENTS.md (add domain-specific rules)
```

---

## 5. Workspace vs. `$BENNY_HOME` — What Lives Where

| Item | Location | Reasoning |
|------|----------|-----------|
| Source code (repo) | `git clone` location | Version controlled |
| User data (vectors, manifests, runs) | `$BENNY_HOME/workspaces/` | Portable, survives reinstall |
| Local LLM weights | `$BENNY_HOME/models/` | Large, not committed |
| Service logs | `$BENNY_HOME/logs/` | Ephemeral, not committed |
| Service PID files | `$BENNY_HOME/state/pids/` | Runtime only |
| Config | `$BENNY_HOME/config.toml` | Per-install, not committed |
