# Benny Operating Manual

**Audience:** operators of a shipped Benny install (PBR-001 Phases 0–8 complete).
**Scope:** day-to-day run book — how to start, stop, diagnose, migrate, and recover the stack. Not a design doc, not a phase plan. Open this when something needs to happen *now*.

> **Where you are in the lifecycle.** The platform is portable, local-first, Claude-orchestratable, and TDD-gated. Every command in this manual is implemented and covered by tests. If something here does not work, treat it as a defect (see §11).

---

## 1. First principles

| Rule | Why it matters |
|------|----------------|
| Everything lives under **`$BENNY_HOME`** (e.g. `D:/optimus`). | One drive → one install → one backup. No files are left on `C:` except the Python interpreter and the optional `pip install -e .` shim. |
| **Manifests are the contract**. CLI, API, MCP, and Studio all read/write the same `SwarmManifest` JSON. | If two surfaces disagree, the manifest wins. |
| **Plan ≠ run**. `benny plan` builds and signs a manifest; `benny run` executes it. | You can audit, diff, and re-play plans. Cheap to plan, expensive to run. |
| **Local-first.** `BENNY_OFFLINE=1` is a hard kill switch — any cloud model call raises `OfflineRefusal`. | Safe to hand the box to a customer or take it on a plane. |
| **TDD floor.** The 6 release gates (G-COV, G-SR1, G-LAT, G-ERR, G-SIG, G-OFF) are tests, not a wiki page. | `pytest tests/release` is the final arbiter. |

---

## 2. Install & first boot

```bash
# 1. Clone and install the package (editable).
git clone <repo> benny && cd benny
pip install -e ".[dev,mcp]"

# 2. Initialise the portable home on the target drive.
benny init --home D:/optimus --profile app     # or --profile native

# 3. Point the shell at it (persist for your user).
setx BENNY_HOME D:\optimus                     # Windows
# export BENNY_HOME=/mnt/ssd/optimus           # Linux/macOS
```

**What `init` creates** (PBR-001 §3, `benny/portable/home.py`):

```
$BENNY_HOME/
├── bin/              # launcher shims (benny-neo4j, benny-llm, benny-ui)
├── runtime/          # bundled binaries (profile=native only)
├── workspaces/       # user data — survives uninstall --keep-data
├── workflows/        # signed manifest JSONs
├── runs/             # RunRecord history (SQLite)
├── logs/             # per-service stdout/stderr (*.log), structured llm_calls.jsonl
├── state/
│   ├── pids/         # <service>.pid written by `benny up`
│   └── profile-lock  # records app vs native profile
├── models/           # local LLM weights (git-ignored, large)
└── config.toml       # PortableConfig — ports, defaults
```

If `$BENNY_HOME` is missing, `.gitignored` state is corrupt, or ports collide, see §11.

---

## 3. Daily operations

### 3.1 Start the stack

```bash
benny up --home $BENNY_HOME
# → neo4j    healthy  pid=...  http 200
# → lemonade healthy  pid=...  http 200
# → api      healthy  pid=...  http 200
# → ui       healthy  pid=...  http 200
```

- Bring up only one service: `benny up --home $BENNY_HOME --only api`
- Skip the health-wait (CI/dev): `--no-wait`
- Logs stream to `$BENNY_HOME/logs/<service>.log` — tail that file to debug a failed start.
- Health probes are HTTP with a 30–60s timeout (see `benny/portable/services.py`).

### 3.2 Status

```bash
benny status --home $BENNY_HOME
# SERVICE     STATE    PID      DETAIL
# neo4j       healthy  12456    http 200
# lemonade    healthy  12457    http 200
# api         healthy  12458    http 200
# ui          healthy  12459    http 200
```

States: `healthy` (health probe passed), `alive` (process up, probe failing), `down` (no process).

### 3.3 Stop the stack

```bash
benny down --home $BENNY_HOME              # all services
benny down --home $BENNY_HOME --only ui    # one service
```

Graceful stop first (SIGTERM / Ctrl+Break on Windows), hard kill after 10s. PID files are removed; logs are kept for forensics.

### 3.4 Health check: `benny doctor`

```bash
benny doctor --home $BENNY_HOME
# ┏━━━━━━━━━━━━━━━━━━━━━ Benny System Health ━━━━━━━━━━━━━━━━━━━━━┓
# ┃ Check          ┃ Status ┃ Message                             ┃
# ┣━━━━━━━━━━━━━━━━┻━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
# ┃ BENNY_HOME     ┃ OK     ┃ Valid and writable: D:/optimus      ┃
# ┃ Structure      ┃ OK     ┃ All required directories present    ┃
# ┃ Hardware Clock ┃ OK     ┃ System time verified: 2026-04-19    ┃
# ┃ Offline Policy ┃ OK     ┃ Offline mode disabled               ┃
# ┃ Service: Lemonade ┃ OK  ┃ Responding (200 OK)                 ┃
# ┃ Backend API    ┃ OK     ┃ Responding (200 OK)                 ┃
# ┃ Manifest Schema┃ OK     ┃ v1.0                                ┃
# ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

Exit codes: `0` = all OK · `2` = WARN only · `1` = ERROR present (stop and investigate).
JSON form: `curl http://127.0.0.1:8005/api/ops/doctor`.

---

## 4. Planning and running workflows

### 4.1 CLI

```bash
# Plan — no execution, produces a signed manifest.
benny plan "Summarise every PDF in data_in/ into a single briefing" \
    --workspace default \
    --output briefing.md \
    --word-count 2000 \
    --out plans/briefing.manifest.json

# Review → commit to git → share.

# Run — executes the manifest.
benny run plans/briefing.manifest.json --json

# Inspect runs.
benny runs ls --limit 10
benny runs show <run_id>
benny manifests ls
```

Key flags:
- `--model` — override the manager-selected model. Omit to use the active model for the workspace.
- `--max-concurrency N` — cap parallel executor fan-out.
- `--max-depth N` — recursion limit for pillar-expansion planning (default 3).
- `--no-save` — skip persistence to the run-store (ad-hoc plans).

### 4.2 HTTP API

All endpoints require `X-Benny-API-Key: benny-mesh-2026-auth` except the whitelist in `benny/api/server.py` (`/`, `/api/health`, `/docs`, SSE streams, `/.well-known/agent.json`).

| Verb | Path | Purpose |
|------|------|---------|
| POST | `/api/workflows/plan` | Build and sign a manifest |
| POST | `/api/workflows/execute/{manifest_id}` | Run; returns SSE event stream |
| GET  | `/api/workflows/runs` | List run records |
| GET  | `/api/rag/status?workspace=...` | Vector store state |
| POST | `/api/rag/query` | Retrieval-only |
| POST | `/api/rag/chat` | RAG chat (`mode=semantic|graph`) |
| GET  | `/api/ops/doctor` | JSON version of §3.4 |
| GET  | `/api/health` | Liveness |

### 4.3 Claude via MCP

```bash
# Start the MCP server (stdio transport) from inside Claude Desktop/Claude Code.
benny mcp --port 8005
```

The MCP server (`benny/mcp/server.py`) exposes `plan`, `run`, `list_runs`, `get_run`, and `doctor` as Claude tools. Tool authentication uses the same `X-Benny-API-Key` header the HTTP API does — the MCP wrapper reads it from `$BENNY_API_KEY` (falls back to the built-in dev key).

### 4.4 Knowledge enrichment (`benny enrich`)

A dedicated, non-LLM-planned pipeline that bridges the knowledge graph and the code graph by creating `CORRELATES_WITH` edges — the data feeding the **ENRICH** toggle in Studio. It is a fixed 7-task DAG across 5 waves.

```bash
# Declarative mode (preferred) — loads the v2.0 manifest template from disk
benny enrich \
    --manifest manifests/templates/knowledge_enrichment_pipeline.json \
    --workspace c5_test \
    --src src/dangpy \
    --run

# Resume a partial run (skips already-completed tasks)
benny enrich \
    --manifest manifests/templates/knowledge_enrichment_pipeline.json \
    --workspace c5_test \
    --src src/dangpy \
    --resume <prior_run_id> \
    --run
```

Everything about each task — endpoint, HTTP method, body shape, per-task read timeout, `fire-and-poll` vs `blocking_with_task_fallback` dispatch, variable substitution — lives in `manifests/templates/knowledge_enrichment_pipeline.json` (`schema_version: "2.0"`). The full reference is in [KNOWLEDGE_ENRICHMENT_WORKFLOW.md](KNOWLEDGE_ENRICHMENT_WORKFLOW.md).

**Per-task read timeouts** (from the v2.0 manifest; defend against slow Docling and LLM passes):

| Task | Read timeout | Notes |
|------|-------------:|-------|
| `rag_ingest` | 1800s | Docling + ChromaDB embedding of multi-MB PDFs |
| `deep_synthesis` | 1800s | LLM triple extraction over the whole ingested corpus |
| `semantic_correlate` | 900s | Concept × CodeEntity similarity pass |
| `code_scan` | 90s (start) + 72 × 5s (poll) | Background Tree-Sitter scan + polling `GET /api/graph/code` |

**Windows-only**: `benny/api/server.py` pins `WindowsProactorEventLoopPolicy` to avoid `ValueError: too many file descriptors in select()` under heavy ingest load (the default `SelectorEventLoop` caps around 512 FDs). This takes effect on the next `benny down && benny up` cycle.

### 4.5 Pypes — declarative tabular transformations

Pypes is the third capability surface (alongside docs/RAG and code/swarm). Run book in [PYPES_TRANSFORMATION_GUIDE.md](PYPES_TRANSFORMATION_GUIDE.md). The CLI splits cleanly into a **deterministic core** and a **sandbox layer**.

**Deterministic core — signed, replayable, audit-bound**

```bash
# Inspect, run, drill, rerun, re-render
benny pypes inspect    manifests/templates/financial_risk_pipeline.json
benny pypes run        manifests/templates/financial_risk_pipeline.json --workspace pypes_demo
benny pypes runs       --workspace pypes_demo                          # default sub-action: ls
benny pypes drilldown  <run_id> gold_exposure --workspace pypes_demo
benny pypes rerun      <run_id> --from silver_trades --workspace pypes_demo
benny pypes report     <run_id> counterparty_risk  --workspace pypes_demo
```

Outputs live under `${BENNY_HOME}/workspace/<ws>/runs/pypes-<run_id>/`:
`receipt.json` (signed), `manifest_snapshot.json`, `checkpoints/<step>.parquet`, `reports/*.md`.

**Sandbox layer — agent-driven, advisory, non-mutating**

```bash
# 1. LLM-author a draft manifest (does not execute unless --run)
benny pypes plan "ingest 3 days of options trades and produce a delta-bucket gold view" \
    --workspace pypes_demo --save              # writes manifests/drafts/<id>.json
benny pypes plan "..." --workspace pypes_demo --save --run     # author and execute

# 2. Risk-analyst Markdown narrative on a finished run
benny pypes agent-report <run_id> --workspace pypes_demo
# → writes runs/pypes-<id>/reports/risk_narrative.md

# 3. Head-to-head perf bench (pandas vs polars on the same DAG)
benny pypes bench \
    pandas=manifests/templates/counterparty_market_risk_pipeline.json \
    polars=manifests/templates/counterparty_market_risk_pipeline_polars.json \
    --workspace pypes_demo --repeats 3
# Reports wall-time, CPU s, CPU% mean/max, peak RSS, RSS Δ, cost ($), row parity.
# Override the cost rate: BENNY_COMPUTE_COST_USD_PER_HOUR=0.45 benny pypes bench ...

# 4. Multi-turn risk-analyst REPL grounded on a finished run
benny pypes chat <run_id> --workspace pypes_demo
#   you > Which counterparty has the largest day-3 exposure?
#   you > /facts            # show loaded gold tables
#   you > /save C:/risk/transcript.md
#   you > /exit
```

**Sandbox guarantees** — none of these subcommands mutates run audit data:

| Subcommand | What it writes | What it never touches |
|------------|----------------|------------------------|
| `pypes plan`         | `manifests/drafts/<id>.json` (or `--out` path) | Existing runs, manifest snapshots, OpenLineage |
| `pypes agent-report` | `runs/pypes-<id>/reports/risk_narrative.md`     | Receipts, checkpoints, deterministic reports |
| `pypes bench`        | New runs (each manifest gets its own `pypes-<id>/`) for the durations being measured; no writes to *prior* runs | Comparison itself is read-only |
| `pypes chat`         | Optional `/save <path>` writes a transcript     | Receipts, checkpoints, reports |

All four sandbox commands route LLM calls through `call_model()` (CLAUDE.md rule #1) so offline mode, the structured LLM log, and lineage all fire correctly.

---

### 4.6 AgentAmp — skinnable, pluggable agentic cockpit

AgentAmp extends Benny's CLI and Studio surfaces with Winamp-style skin packs, visualiser plugins, and manifest-knob panels. Full run book in [AGENTAMP_GUIDE.md](AGENTAMP_GUIDE.md).

**Phase 1 (shipped) — skin pack lifecycle**

```bash
# Create a draft skin
benny agentamp scaffold-skin my-team-skin
# → $BENNY_HOME/agentamp/drafts/my-team-skin/skin.manifest.json  (signature: null)

# Pack, sign, install
benny agentamp pack   $BENNY_HOME/agentamp/drafts/my-team-skin --out my-team-skin.aamp
benny agentamp sign   my-team-skin.aamp        # HMAC-SHA256; uses BENNY_HMAC_KEY
benny agentamp install my-team-skin.aamp --workspace default
```

Install exit codes: `0` = success · `1` = I/O error · `2` = security rejection (missing/invalid signature, path traversal).

**Security invariants (enforced at every `install`)**
- Unsigned packs are always rejected — no bypass flag in production (`GATE-AAMP-AUTOSIGN-1`).
- Zip path-traversal sequences (`../`, absolute paths) raise `SkinPathEscape` before any file is read.
- `BENNY_OFFLINE=1` is fully supported — all Phase 1 operations are stdlib-only.

**HMAC key**

Skin packs share the same key as manifests and checkpoints:

```bash
export BENNY_HMAC_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
```

---

## 5. The LLM router (Phase 3 hardening)

Knobs, in order of precedence:

1. `executor_override=<model>` kwarg to `call_model()` — forces the exact executor for that call.
2. `local_only=True` kwarg — refuses to dispatch to cloud providers.
3. **Env `BENNY_OFFLINE=1`** — same as `local_only` but process-wide. Raises `OfflineRefusal` before any network I/O.
4. Workspace manifest `default_model` (from `core/workspace.py`).

**Check whether a model is local**:

```python
from benny.core.models import is_local_model, LOCAL_PROVIDERS
is_local_model("lemonade/Llama-3.1-8B-Instruct")   # True
is_local_model("openai/gpt-4")                     # False
```

The registered local providers (`LOCAL_PROVIDERS` in `benny/core/models.py`) are:
`lemonade` (13305) · `ollama` (11434) · `lmstudio` (1234) · `fastflowlm` (52625) · `litert` (in-process).

**If `BENNY_OFFLINE=1` is set and the active model is cloud**, `benny doctor` emits a `WARN`. Fix it by changing `default_model` in the workspace manifest or by starting a local provider.

---

## 6. Observability

> **Full details**: [docs/operations/LOG_AND_LINEAGE_GUIDE.md](LOG_AND_LINEAGE_GUIDE.md) — covers every log file, SSE events, Marquez lineage queries, Phoenix tracing, AER records, and a full end-to-end process trace.

### 6.1 Structured LLM log

`$BENNY_HOME/logs/llm_calls.jsonl` — one JSON object per call:

```jsonl
{"ts": "2026-04-19T14:29:15Z", "run_id": "run-abc", "model": "lemonade/Llama-3.1-8B", "ok": true, "provider": "lemonade", "duration_ms": 842}
```

This file is **git-ignored**. Tail or grep it to answer "why did this run cost $X / take Y seconds?".

```bash
# Show failed calls
grep '"ok": false' $BENNY_HOME/logs/llm_calls.jsonl | jq '{ts, model, run_id}'

# Follow the API log
tail -f $BENNY_HOME/logs/api.log
```

### 6.2 Event Bus / SSE

`/api/workflows/execute/{id}` is an SSE stream. Connect with curl to watch live:

```bash
curl -N -H "Accept: text/event-stream" \
     -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/workflows/execute/<manifest_id>
```

Events: `plan_updated`, `wave_started`, `task_started`, `task_completed`, `run_finished`.

### 6.3 Lineage (Marquez)

Marquez integration is optional. Set `MARQUEZ_URL=http://localhost:5000` to enable. Each run emits OpenLineage events via `benny/governance/lineage.py`. Browse lineage at **http://localhost:3010**.

```bash
docker compose up -d marquez-db marquez-api marquez-web
export MARQUEZ_URL=http://localhost:5000
```

`RunRecord.governance_url` carries the direct Marquez job-run URL for a completed run.

### 6.4 Distributed Tracing (Phoenix)

Phoenix captures LLM spans (prompts, completions, token counts). Set `PHOENIX_ENDPOINT=http://localhost:4317`. Browse traces at **http://localhost:6006**.

```bash
docker compose up -d phoenix
export PHOENIX_ENDPOINT=http://localhost:4317
```

### 6.5 System health endpoint

`/api/system/*` (see `benny/api/system_routes.py`) exposes Neo4j, disk, and workspace metrics.

```bash
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/system/metrics | jq .
```

---

## 7. Workspaces

> **Full details**: [architecture/WORKSPACE_GUIDE.md](../../architecture/WORKSPACE_GUIDE.md) — covers workspace anatomy, the c4_test and c5_test workspaces, graph visualisation surfaces, and how to create a new workspace.

- A workspace is a folder under `$BENNY_HOME/workspaces/<name>/`.
- Each workspace has a `manifest.yaml` defining `default_model`, tools, and wiki config.
- Switch via `--workspace <name>` on any CLI verb or `?workspace=<name>` on the HTTP API.
- `BENNY_WORKSPACE` env var sets the global default.

**Active test workspaces:**

| Workspace | Purpose | Graph types |
|-----------|---------|-------------|
| `c4_test` | RAG / retrieval test (H.G. Wells texts ingested) | Knowledge graph |
| `c5_test` | Code analysis + architecture mapping (UML/PDF in `data_in/staging/`; `src/dangpy` for code graph) | Knowledge + Code graph + `CORRELATES_WITH` enrichment overlay (see §4.4) |

Wiki articles live at `$BENNY_HOME/workspaces/<name>/.benny/wiki/*.md` and are served via `/api/rag/wiki/articles`.

---

## 8. Migration & relocation (Phase 8)

Copy the whole `$BENNY_HOME` directory to a new drive and run:

```bash
benny migrate --from /old/benny_home --to $BENNY_HOME --dry-run
# review the rewrite report
benny migrate --from /old/benny_home --to $BENNY_HOME --apply
```

What `migrate` does (`benny/migrate/importer.py`):

1. Walks the source tree, copies files into the new home.
2. Rewrites absolute host paths in JSON / manifest / config files to `${BENNY_HOME}` tokens.
3. **Re-signs** every manifest it rewrites (HMAC-SHA256 via `benny/core/manifest_hash.py`).
4. Emits a report: `rewrites=N`, per-file actions, and any errors.

Dry-run first. Always.

---

## 9. Uninstall

```bash
benny uninstall --home $BENNY_HOME                 # removes app, runtime, data
benny uninstall --home $BENNY_HOME --keep-data     # keeps workspaces/, models/, config.toml, state/
```

The `--keep-data` path is the supported way to reinstall onto the same drive or upgrade across versions.

---

## 10. Release gates (the 6σ floor)

`tests/release/test_release_gates.py` — run these before shipping:

| Gate | What it asserts | Target |
|------|-----------------|--------|
| G-COV | Code coverage on `scope` modules | ≥ 85% |
| G-SR1 | Absolute-path violations in the tree | ≤ 408 (ratchet baseline) |
| G-LAT | Planning latency (platform overhead, LLM mocked) | < 300 ms median |
| G-ERR | Soak test — stable-core run N× consecutively | 0 flakes |
| G-SIG | Manifest signature integrity | `sign_manifest → verify_signature == True` |
| G-OFF | Offline compliance flag | `BENNY_OFFLINE` honored |

```bash
pytest tests/release -q                 # all gates
pytest tests/portability -q             # SR-1 auditor (regenerates baseline JSON)
pytest tests/ -q                        # full suite (~200 tests, ~45s on a laptop)
```

Baseline for G-SR1 lives at the path in `docs/requirements/release_gates.yaml`. Never *raise* the threshold — only lower it as you fix violations.

---

## 11. Troubleshooting cookbook

| Symptom | First check | Fix |
|---------|-------------|-----|
| `benny up` says `port X already in use` | `benny status`, then OS `netstat -ano` | Stop the stale process (`benny down` rarely leaves orphans; otherwise kill the PID reported) |
| `benny up` says `alive` but never `healthy` | `tail -f $BENNY_HOME/logs/<service>.log` | Fix the service config (model path, neo4j creds) or increase `HealthCheck.timeout_seconds` |
| Test `test_plan_from_requirement_success` flakes | `grep AsyncMock tests/graph/test_manifest_runner.py` | `wave_scheduler_node` is called **synchronously** — the fixture must be `MagicMock`, not `AsyncMock`. Planner IS awaited, keep it `AsyncMock`. |
| `OfflineRefusal` on every call | `echo $BENNY_OFFLINE` | Either `unset BENNY_OFFLINE` or change the workspace `default_model` to a local one |
| `AttributeError: module ... has no attribute 'get_active_model'` in rag_routes | Stale import | Already fixed on master — ensure you're on the latest tip; `get_active_model` is explicitly imported in `benny/api/rag_routes.py` |
| `Governance violation: Invalid or missing X-Benny-API-Key` | curl without header | Add `-H "X-Benny-API-Key: benny-mesh-2026-auth"` or whitelist the path in `server.GOVERNANCE_WHITELIST` |
| Merge conflict markers in `benny/api/server.py` | `grep -n '<<<<<<' benny/api/server.py` | Keep the "Updated upstream" side — it has the Phase 2+ routers (`manifest_router`, `workflow_endpoints_router`). |
| `coverage.json` missing → G-COV fails | Run `pytest --cov=benny --cov-report=json:coverage.json` first | The gate test is permissive — it calls pytest itself, so check the subprocess stderr |
| Dirty `logs/llm_calls.jsonl` in `git status` | The file is now git-ignored | `git rm --cached logs/llm_calls.jsonl` if it re-appears; the root cause is an old checkout |

### 11.1 Reset to a known-good state

```bash
benny down --home $BENNY_HOME
benny doctor --home $BENNY_HOME          # identify bad component
# If still broken:
benny uninstall --home $BENNY_HOME --keep-data
benny init --home $BENNY_HOME --profile app
benny up --home $BENNY_HOME
```

Your workspaces, models, and config survive this sequence.

---

## 12. Where the code lives (cheat sheet)

| Concern | Module |
|---------|--------|
| CLI dispatch | `benny_cli.py` |
| Portable home (init/uninstall/validate) | `benny/portable/home.py` |
| Service specs (ports, commands) | `benny/portable/services.py` |
| Process runner (`up`/`down`/`status`) | `benny/portable/runner.py` |
| Config (TOML → ports) | `benny/portable/config.py` |
| Manifest types | `benny/core/manifest.py` |
| Manifest hash + signatures | `benny/core/manifest_hash.py` |
| LLM router, LOCAL_PROVIDERS, offline | `benny/core/models.py` |
| Local executor (LC-1..4 contract) | `benny/core/local_executor.py` |
| Planner → manifest loop | `benny/graph/manifest_runner.py` |
| Swarm graph (LangGraph) | `benny/graph/swarm.py` |
| Doctor diagnostics | `benny/ops/doctor.py` |
| Structured LLM log | `benny/ops/llm_logger.py` |
| Migration / path rewriter | `benny/migrate/importer.py` |
| MCP server for Claude | `benny/mcp/server.py` |
| HTTP API surface | `benny/api/*.py` |
| Governance middleware | `benny/api/server.py::GovHeaderMiddleware` |
| Event Bus / SSE | `benny/core/event_bus.py` |
| Release gates | `tests/release/test_release_gates.py` + `docs/requirements/release_gates.yaml` |

---

## 13. Golden rules

1. **Never commit with `--no-verify`.** The pre-commit hooks enforce SR-1 and linting.
2. **Never raise the SR-1 baseline.** If you must add an absolute path, add it behind `_materialise_argv` in `benny/portable/runner.py`.
3. **Never call `completion()` directly.** Always go through `call_model()` in `benny/core/models.py` so offline, logging, and lineage all fire.
4. **Never share an unsigned manifest.** `sign_manifest` populates `content_hash` and `signature`; `verify_signature` is the trust boundary.
5. **Never skip `benny doctor` after a migration.** Path rewrites are heuristic — doctor is how you confirm they landed.

---

*Last updated: PBR-001 Phase 8 complete. See `docs/requirements/PBR-001_CONTINUATION_PLAN.md` for the phase-by-phase history.*
