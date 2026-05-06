# Benny — The Agentic OS

> _Stop giving agents the will to fail. Build a manifest._

<img src="docs/marketing/assets/swarm_visual.png" alt="Benny" width="400">

Benny is a **local-first, multi-model AI orchestration platform** that turns vague requirements into signed, deterministic, auditable workflows — then executes them. It runs on your hardware, talks to any LLM (local or cloud), and produces artefacts an auditor can actually verify.

---

## The problem Benny solves

Every AI agent framework today hands the agent a goal and steps back. The agent "thinks" unconstrained, calls tools unvalidated, and either burns your API credits in a loop or silently produces wrong answers. There is no contract, no proof of work, no way to resume after failure.

**Benny closes the loop.** Before a single token fires, a signed `SwarmManifest` defines every valid transition. Agents cannot drift outside the DAG. Every step is checkpointed. Every artefact is content-addressed. Every decision emits OpenLineage provenance. If a run fails at task 7 of 20, `benny run --resume` picks up at task 7 — same host, different host, or portable USB drive.

---

## What's been built

| Phase          | Capability                                                                                                                                                               | Status          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| Foundation     | LangGraph swarm executor, multi-model router, HITL approval gates                                                                                                        | **SHIPPED**     |
| Knowledge      | Dual Neo4j graph (knowledge + code), RAG, enrichment overlay                                                                                                             | **SHIPPED**     |
| Data           | Pypes declarative transformation engine (bronze→silver→gold, CLP lineage, drill-down)                                                                                    | **SHIPPED**     |
| Studio         | React/Three.js visual canvas, SSE event bus, real-time DAG view                                                                                                          | **SHIPPED**     |
| AOS-001 P0–P7  | SDLC manifest (v1.1), artifact store (PBR), progressive disclosure, diagram gen, durable resume, VRAM-aware worker pool, BDD pipeline, TOGAF+ADR emission, quality gates | **SHIPPED**     |
| AOS-001 P8–P10 | JSON-LD provenance, Policy-as-Code ledger, SOX/BCBS compliance, sandbox runner                                                                                           | **IN PROGRESS** |

All shipped phases have 6σ acceptance tests — zero manual sign-off required. Run `pytest tests/release -q` to verify on your machine.

---

## Four capability surfaces

### 1. Workflow Studio — Plan, Approve, Run

Convert a plain-English requirement into a signed, executable manifest. Approve it (or gate on Human-in-the-Loop). Execute it. Watch it in the 3D canvas.

```bash
benny plan "Audit the Pypes engine for schema drift" --workspace c5_test --save
benny run manifests/audit.json
benny runs ls --limit 10
```

Every task in the manifest has a budget (time + iterations). Every failure is caught at the gate, not silently swallowed.

### 2. Knowledge & Code Intelligence — Understand before you act

Ingest your PDFs, architecture docs, and source code. Benny builds a dual Neo4j graph — concepts from documents, AST nodes from code — and links them with semantic `CORRELATES_WITH` edges. Ask questions against it in the Notebook or navigate the 3D code graph in Studio.

```bash
# Ingest docs + code, build the enrichment overlay
benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json \
             --workspace c5_test --src src/myapp --run
```

### 3. Pypes — Deterministic data transformation

Manifest-driven bronze→silver→gold pipelines with byte-identical replay, column-level lineage, and explainable risk reports. When a regulator asks why `total_exposure = £525M` for a counterparty on a given date, the drill-down command shows every source row, every transformation, and the CLP annotation that produced the number.

```bash
benny pypes run  manifests/templates/financial_risk_pipeline.json --workspace pypes_demo
benny pypes drilldown <run_id> gold_exposure --workspace pypes_demo
benny pypes rerun     <run_id> --from silver_trades --workspace pypes_demo
benny pypes bench pandas=manifest_a.json polars=manifest_b.json --workspace pypes_demo
```

### 4. SDLC Pipeline (AOS-001) — Requirement to release

`benny req` converts a free-text requirement into a PRD + Gherkin BDD scenarios + deterministic pytest stubs. The resulting SDLC manifest maps every wave to a TOGAF ADM phase, auto-generates Architecture Decision Records at phase boundaries, and runs quality gates before advancing.

```bash
benny req "Add JWT authentication to the API" --workspace auth_project
# → data_out/prd/add_jwt_authentication.json
# → data_out/prd/add_jwt_authentication.feature
# → tests/stubs/test_add_jwt_authentication.py (deterministic)

benny plan "Implement the JWT requirement" \
      --sdlc --workspace auth_project --save

benny run manifests/jwt_sdlc.json
# Emits ADR-001 at information_systems boundary
# Quality gate: ruff + pyright + BDD stubs before wave 3 advances
```

---

## Quick start

### 1. Install

```bash
git clone https://github.com/skybluecycology/benny.git
cd benny
python -m venv venv && source venv/bin/activate    # or .\venv\Scripts\activate
pip install -e .
```

### 2. Initialise a portable home

```bash
benny init --home D:/benny_home --profile app
# Windows:
setx BENNY_HOME D:\benny_home
# Linux/Mac:
export BENNY_HOME=/mnt/benny_home
```

### 3. Start the stack

```bash
benny up          # starts Neo4j, Marquez, Phoenix, N8N via Docker
benny status      # verify every service is healthy
benny doctor      # full pre-flight: graphs, models, offline mode, lineage
```

### 4. Wire up a model

Benny routes through LiteLLM — any provider works. Common setups:

| Provider                       | How                                         |
| ------------------------------ | ------------------------------------------- |
| **Lemonade** (NPU, local)      | `OPENAI_API_BASE=http://localhost:13305/v1` |
| **LM Studio / Ollama** (local) | `OPENAI_API_BASE=http://localhost:1234/v1`  |
| **Claude** (cloud)             | `ANTHROPIC_API_KEY=sk-...`                  |
| **OpenAI** (cloud)             | `OPENAI_API_KEY=sk-...`                     |

### 5. Run the demo

```bash
# Validate + execute the bundled financial risk demo
benny pypes inspect manifests/templates/financial_risk_pipeline.json
benny pypes run     manifests/templates/financial_risk_pipeline.json --workspace pypes_demo

# Or plan + run a swarm workflow
benny plan "Summarise all Python files in my project" --workspace demo --save
benny run  manifests/demo_*.json
```

---

## For agents

If you are an AI agent consuming this platform, here is the fast path.

**Entry point — run a manifest:**

```bash
python benny_cli.py run manifests/templates/model_comparison_planner.json --workspace agent_ws --json
```

**MCP server (Claude / compatible clients):**

```bash
benny mcp   # starts the MCP stdio server; exposes plan / run / doctor as tools
```

**Key invariants to respect:**

1. All HTTP calls require `X-Benny-API-Key: benny-mesh-2026-auth`
2. Never use absolute paths in manifests — always `${BENNY_HOME}` tokens
3. Always call `call_model()` (never raw litellm) — this fires offline guard, logging, and lineage
4. Large artefacts (> 1 024 tokens) are automatically promoted to content-addressed store and replaced with an `artifact://sha256` reference in context — **do not inline them**

**Offline / air-gapped mode:**

```bash
BENNY_OFFLINE=1 benny run <manifest.json>   # hard-blocks all cloud model calls
```

---

## Observability

| Signal            | Where                                                                |
| ----------------- | -------------------------------------------------------------------- |
| **Lineage**       | OpenLineage → Marquez at `http://localhost:3010`                     |
| **Tracing**       | OTLP → Phoenix at `http://localhost:6006`                            |
| **Audit records** | `$BENNY_HOME/workspaces/<ws>/runs/<run_id>/aer.json`                 |
| **Policy ledger** | Git orphan branch `benny/checkpoints/v1` (append-only, HMAC-chained) |
| **Logs**          | Structured JSON at `$BENNY_HOME/logs/` — never committed             |

```bash
benny doctor --json     # machine-readable health + PBR store + pending HITL count
benny doctor --audit    # verify HMAC chain on the policy ledger
```

---

## Architecture in brief

```
  You / Claude / Agent
        │
   benny_cli.py  ◄──── MCP server ◄──── Claude Desktop / Code
        │
   FastAPI :8005  (24 route modules, governance middleware, SSE bus)
        │
   ┌────┴──────────────────┐
   │  LangGraph swarm      │  ← manifest DAG → worker pool → task agents
   │  Pypes engine         │  ← bronze/silver/gold → CLP lineage → reports
   │  SDLC pipeline (AOS)  │  ← req → PRD → BDD → TOGAF → ADR → quality gates
   └────┬──────────────────┘
        │
   Neo4j (code + knowledge graph)   ChromaDB (vectors)   SQLite (run store)
        │
   Marquez (lineage)   Phoenix (traces)   Git ledger (policy)
```

**Model router** (`benny/core/models.py`): single `call_model()` function routes to Lemonade (NPU), LM Studio, Ollama, LiteRT, Claude, OpenAI — plus enforces `BENNY_OFFLINE`, cost tracking, and lineage headers.

---

## Running tests

```bash
pytest tests/ -q                   # full suite
pytest tests/release -q            # 6σ release gates (coverage, portability, latency, offline)
pytest tests/portability -q        # SR-1: zero new absolute paths
```

Release gates: **G-COV** ≥85%, **G-SR1** ≤408 path violations, **G-LAT** <300ms plan, **G-ERR** 0 flakes, **G-SIG** manifest integrity, **G-OFF** offline compliance.

---

## Open-loop vs closed-loop

|                     | Open-loop agent (everyone else) | Benny (closed loop)                      |
| ------------------- | ------------------------------- | ---------------------------------------- |
| **Authority**       | The agent's "will"              | The signed manifest                      |
| **Failures**        | Silent, expensive               | Caught at the gate                       |
| **Reproducibility** | Re-prompt and hope              | Byte-identical replay from checkpoint    |
| **Cost control**    | Burn tokens, discover later     | Per-wave budget limits                   |
| **Compliance**      | None                            | OpenLineage + JSON-LD + SOX 404 ledger   |
| **Visibility**      | Black-box logs                  | Real-time 3D canvas + Phoenix traces     |
| **Portability**     | Cloud-locked                    | One `$BENNY_HOME` directory, any machine |

---

## What we want feedback on

Benny is actively developed. These are the questions we are trying to answer with real usage:

1. **Pypes adoption** — are the bronze→silver→gold stages the right abstraction for your data problem, or do you need something different?
2. **SDLC pipeline** — does `benny req` → BDD → quality-gated execution actually reduce the rework loop in your team?
3. **Model routing** — which local model + NPU combination are you running? What's your VRAM budget?
4. **Compliance targets** — SOX 404 and BCBS 239 are the current compliance stories. What else matters?
5. **Agent consumption** — are you using Benny as an MCP tool server from Claude Code or another agent? What's missing?

Open an issue, start a discussion, or reach out. Every feature in Benny was built from a concrete request.

---

## Documentation

| Doc                                                                                            | What's in it                                                   |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [docs/README.md](docs/README.md)                                                               | Navigation hub — all docs indexed                              |
| [architecture/SAD.md](architecture/SAD.md)                                                     | C4 diagrams, dual-graph design, swarm lifecycle                |
| [docs/operations/BENNY_OPERATING_MANUAL.md](docs/operations/BENNY_OPERATING_MANUAL.md)         | Full run book — install, configure, operate                    |
| [docs/operations/PYPES_TRANSFORMATION_GUIDE.md](docs/operations/PYPES_TRANSFORMATION_GUIDE.md) | Pypes DAG manifests, CLP lineage, drill-down, risk reports     |
| [docs/operations/LOG_AND_LINEAGE_GUIDE.md](docs/operations/LOG_AND_LINEAGE_GUIDE.md)           | Logs, SSE events, Marquez, Phoenix, AER format                 |
| [architecture/WORKSPACE_GUIDE.md](architecture/WORKSPACE_GUIDE.md)                             | Workspace layout, c4_test / c5_test reference workspaces       |
| [docs/requirements/10/requirement.md](docs/requirements/10/requirement.md)                     | AOS-001 full specification — SDLC manifest, TOGAF, BDD, policy |

---

_© 2026 Benny Platform — MIT License._
