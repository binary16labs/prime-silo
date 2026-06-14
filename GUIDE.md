# Prime-Silo — User Guide

> *Plain-English walkthroughs for every UI screen and CLI command.*
> No prior Benny knowledge required.

---

## Contents

1. [What is Prime-Silo?](#1-what-is-prime-silo)
2. [First-time setup](#2-first-time-setup)
3. [Starting the app](#3-starting-the-app)
4. [Configuring the AI agent](#4-configuring-the-ai-agent)
   - 4a. [Cloud model (OpenRouter)](#4a-cloud-model-openrouter)
   - 4b. [Local model (Lemonade / Ollama)](#4b-local-model-lemonade--ollama)
5. [UI walkthroughs](#5-ui-walkthroughs)
   - 5a. [Talking to the agent](#5a-talking-to-the-agent)
   - 5b. [Manifest Explorer](#5b-manifest-explorer)
   - 5c. [Runs Explorer](#5c-runs-explorer)
   - 5d. [Widget canvas](#5d-widget-canvas)
6. [CLI reference](#6-cli-reference)
   - 6a. [Booting and health checks](#6a-booting-and-health-checks)
   - 6b. [Plan a manifest](#6b-plan-a-manifest)
   - 6c. [Run a manifest](#6c-run-a-manifest)
   - 6d. [Browse run history](#6d-browse-run-history)
   - 6e. [Pypes transformation pipeline](#6e-pypes-transformation-pipeline)
   - 6f. [AgentAmp skin packs](#6f-agentamp-skin-packs)
7. [Agent draft views — save, pin, load](#7-agent-draft-views--save-pin-load)
8. [Running the tests](#8-running-the-tests)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. What is Prime-Silo?

Prime-Silo is a browser-based AI operator platform. You open it in a browser, chat with an AI agent, browse manifests and runs, and compose audit-grade layouts — all backed by a deterministic execution engine.

Two pieces run on your machine:

| Piece | Port | What it does |
|---|---|---|
| **Benny runtime** | `:8005` | FastAPI backend — runs manifests, stores data, enforces security |
| **Shell server** | `:3000` | Node.js server — serves the browser UI and proxies calls to the runtime |

You point your browser at `http://localhost:3000` and work entirely in the browser.

### The two zones

The UI splits into two kinds of surfaces:

- **Deterministic zone** — read-only views of manifests and runs. No AI can write here. The Manifest Explorer and Runs Explorer live here.
- **Review zone** — AI-composed layouts (reasoning traces, drilldown tables, frame inspectors). The agent can draft here; only a human can sign and save a final view.

---

## 2. First-time setup

### Prerequisites

| What | Minimum version |
|---|---|
| Python | 3.11 |
| Node.js | 18 |
| Git | any modern |
| PowerShell or bash | included in Windows / macOS |

### Step 1 — clone

```bash
git clone https://github.com/binary16labs/prime-silo.git
cd prime-silo
```

### Step 2 — install Python deps

```bash
cd runtime
pip install -e .
cd ..
```

### Step 3 — install Node deps

```bash
cd server
npm install
cd ..
```

### Step 4 — create your `.env` file

Copy the example and fill in the blanks:

```bash
# PowerShell
Copy-Item .env.example .env

# bash
cp .env.example .env
```

Open `.env` and set at minimum:

```dotenv
# A 64-character hex string — used to sign manifests and views.
# Generate one: python -c "import secrets; print(secrets.token_hex(32))"
BENNY_HMAC_KEY=your64hexcharshere

# Optional: set to a local model so CLI commands use it by default.
# BENNY_DEFAULT_MODEL=local_lemonade
```

> **Why does HMAC matter?** The runtime signs every manifest and pinned view with this key. If the key changes the signatures are invalidated. Use the same key on every machine that shares a `.benny_home`.

### Step 5 — verify

```bash
# From the repo root:
node tests/runtime_proxy_test.mjs
# → runtime_proxy_test: ok

node tests/widget_registry_test.mjs
# → widget_registry_test: ok
```

If either prints `FAIL`, check Node ≥ 18 (`node --version`).

---

## 3. Starting the app

### Turnkey launcher (recommended)

```powershell
# PowerShell
.\scripts\dev.ps1
```

```bash
# bash
./scripts/dev.sh
```

The launcher reads `.env`, starts the Benny runtime on `:8005`, starts the shell on `:3000`, and keeps both alive. `Ctrl+C` stops everything cleanly.

You'll see:

```
▸ Prime-Silo dev launcher
  BENNY_HOME = ./.benny_home
  runtime PID = 12345
  shell   PID = 12346
```

Open `http://localhost:3000` in your browser.

### Manual start (if you need separate terminals)

```bash
# Terminal 1 — runtime
cd runtime
python -m benny.api.server
# → Uvicorn running on http://0.0.0.0:8005

# Terminal 2 — shell
node server/dev_server.js
# → Shell listening on http://localhost:3000
```

### Confirming everything is up

```bash
curl http://localhost:3000/api/runtime/agent_sandbox/health
# → {"status":"ok"}

curl http://localhost:3000/api/runtime/widgets
# → [{"id":"text.markdown",...}, ...]
```

---

## 4. Configuring the AI agent

The onscreen agent (the chat panel that appears at the bottom of the UI) connects to whatever LLM endpoint you configure. Two common setups:

### 4a. Cloud model (OpenRouter)

1. Open `http://localhost:3000`
2. Click the **agent settings** gear icon in the chat panel
3. Set:
   - **Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
   - **API key:** your OpenRouter key
   - **Model:** `anthropic/claude-sonnet-4-6` (or any OpenRouter model ID)
4. Click **Save**

Send a message — you should get a reply immediately.

### 4b. Local model (Lemonade / Ollama)

Local models (running on `localhost`) are automatically detected. The app:
- Skips the API key requirement
- Replaces the full operator system prompt with a minimal one compatible with local models
- Adds `enable_thinking: false` to suppress Qwen3 thinking-mode tokens

#### Lemonade setup

1. Install and start [Lemonade](https://github.com/microsoft/lemonade) with your preferred model (e.g. `qwen3.5-9b-FLM`)
2. Lemonade runs on `http://127.0.0.1:13305` by default
3. Open agent settings in the UI:
   - **Endpoint:** `http://127.0.0.1:13305/api/v1/chat/completions`
   - **API key:** leave blank
   - **Model:** the model name Lemonade loaded (e.g. `qwen3.5-9b-FLM`)
4. Save and send a test message

#### Ollama setup

1. Install and start [Ollama](https://ollama.ai): `ollama serve`
2. Pull a model: `ollama pull llama3.2`
3. In agent settings:
   - **Endpoint:** `http://127.0.0.1:11434/api/chat`
   - **API key:** leave blank
   - **Model:** `llama3.2`

#### Using a local model from the CLI

Set `BENNY_DEFAULT_MODEL` in your `.env`:

```dotenv
BENNY_DEFAULT_MODEL=local_lemonade
```

Or set it in your shell session before running any `benny` command:

```bash
export BENNY_DEFAULT_MODEL=local_lemonade   # bash
$env:BENNY_DEFAULT_MODEL = "local_lemonade" # PowerShell
```

The CLI uses this for `benny plan`, Pypes sandbox commands, and any other command that calls an LLM.

---

## 5. UI walkthroughs

### 5a. Talking to the agent

The chat panel sits at the bottom of every page. Click it to expand.

**Basic chat:**

```
You: What's 2 + 2?
Agent: 4.
```

**Running code on the page:**

The agent can read and manipulate the current page via JavaScript. It uses the format:

```
Checking the current page title now...
_____javascript
return { title: document.title, url: location.href }
```

You don't write this yourself — the agent generates it when it needs to interact with the UI. You see the result appear inline.

**Reading a file:**

```
You: read ~/notes/plan.txt
Agent: Reading ~/notes/plan.txt now...
       [file contents appear]
```

**Writing a file:**

```
You: write "hello world" to ~/notes/hello.txt
Agent: Writing ~/notes/hello.txt now...
       [confirmation appears]
```

**Opening a space:**

```
You: open the project space
Agent: [lists spaces, then opens it]
```

**Tips:**
- The agent remembers the full conversation history in the session.
- If the agent says "Protocol correction: your previous response was empty" and loops, the model endpoint is likely misconfigured — re-check §4.
- Asking "what can you do?" gives a live demo from the current page.

### 5b. Manifest Explorer

**Route:** `http://localhost:3000/#/_prime_silo/manifest_explorer`

This page lists every swarm manifest registered with the runtime and draws it as a directed acyclic graph (DAG).

**What you see:**
- A dropdown of all registered manifests
- A DAG showing tasks as nodes, dependencies as edges, wave layers as columns
- A summary bar: task count, edge count, wave count

**To use it:**
1. Navigate to the route above (bookmark it)
2. Pick a manifest from the dropdown
3. The DAG renders. Nodes are coloured by wave (execution order left → right)

**Deep-linking a specific manifest:**

```
http://localhost:3000/#/_prime_silo/manifest_explorer?manifest_id=mf-abc123
```

Paste this URL and the page loads directly to that manifest.

**If the page shows "No manifests registered":**

You haven't created any manifests yet. See §6b to plan one with the CLI.

**What this page is NOT for:**
- Editing manifests (read-only)
- Running manifests (use `benny run` or the Runs Explorer)
- Anything agent-authored (the agent cannot write here — this is the deterministic zone)

### 5c. Runs Explorer

**Route:** `http://localhost:3000/#/_prime_silo/runs_explorer`

Shows executed runs and overlays their execution status onto the manifest DAG.

**What you see:**
- A dropdown of runs (active runs float to the top)
- The manifest DAG with colour-coded task status:
  - 🟢 **completed** — task finished successfully
  - 🟡 **running** — task is currently executing
  - 🔵 **pending** — task is waiting to run
  - 🔴 **failed** — task errored
- Run metadata: status, duration, start/end times

**To use it:**
1. Navigate to the route
2. Pick a run from the dropdown (most recent active runs first)
3. The DAG renders with live status colours

**Deep-linking a run:**

```
http://localhost:3000/#/_prime_silo/runs_explorer?run_id=run-xyz
```

**While a run is active:**

Refresh the page (or change and re-select the run in the dropdown) to get the latest node states. The page does not auto-poll — refresh manually.

**Reading the run summary:**

| Field | What it means |
|---|---|
| Status | Overall run state |
| Duration | Wall-clock time from start to finish |
| Tasks | How many nodes have a recorded state |
| Errors | How many task errors were recorded |

### 5d. Widget canvas

The Review-zone canvas lets the agent compose multi-widget layouts for post-run analysis. Each widget is a separate panel.

**Available widgets:**

| Widget | What it shows |
|---|---|
| `text.markdown` | Markdown analyst report block |
| `run.reasoning_trace` | Step-by-step LLM reasoning from a run |
| `run.lineage_timeline` | Process / skill / data lineage events on a timeline |
| `run.drilldown_table` | CLP-annotated tabular rows from a Pypes stage |
| `run.frame_inspector` | Single cognitive frame — typed body + audit hash |
| `kg3d.synoptic_web` | Knowledge graph (2D SVG or 3D force-graph) |
| `codegraph.canvas` | Code graph: files, classes, functions, dependencies |
| `dag.canvas` | Manifest / pipeline / workflow DAG *(deterministic zone only)* |
| `memoray.overview_cards` | Memory-graph Command Center: ecosystem totals, system metrics, capabilities, worktrees, file heatmap, recent sessions |
| `memoray.lineage_graph` | One agent session's lineage (2D SVG or pluggable 3D renderer) |

**Using the 3D renderer:**

The graph widgets (`kg3d.synoptic_web`, `codegraph.canvas`, `memoray.lineage_graph`) have a pluggable renderer. By default they render a 2D SVG. To enable the 3D `3d-force-graph` view, the caller passes `options.renderer = createThreeRenderer(...)`. The 3D library loads on demand from CDN — no install needed.

### 5d-bis. Bridge — the cockpit (`#/_prime_silo/bridge`)

The Bridge is the recommended way in: one page that unifies the whole mesh so you don't hop between tabs. It's in the dashboard launcher as **Bridge**.

**Layout:** a mode rail on the left, one stage in the middle, and **Benny** (the onscreen agent) in the dock on the right. A **zen** toggle (top-right) collapses both rails to leave just the stage.

**The six modes:**
- **Pulse** — the landing: Command Center cards, the integration conformance dot, and the **Lifelog** activity feed (your sessions, artifacts, and git commits across every workspace, newest first).
- **Memory** — pick a session, see its lineage graph.
- **Documents** — pick a workspace, see its files, then **Ingest → triples** turns the documents into the knowledge graph (rendered inline); **Correlate w/ code** links concepts to the code graph. Deep-links to the full file explorer for heavy lifting.
- **Code 3D** — the Tree-Sitter code graph for the workspace; a **2D/3D** toggle swaps the SVG layout for a WebGL force-graph.
- **Flows** — type what you want, hit **Plan** (the planned manifest renders as a DAG), then **Run** (the stage flips to live run observability). No copy-paste, no terminal.
- **Runs** — pick a run; its lineage timeline and reasoning trace render together.

**Benny knows where you are:** the dock shows what's on the stage, and the suggestion chips ("Explain this graph", "What did I work on?", "Ingest these docs", "Re-run the last manifest") are mode-aware — clicking one asks Benny a prompt already grounded in the current mode, selection and workspace, and Benny answers with a deep link back. Benny loads the `benny-pilot` skill on demand.

**Same capability everywhere:** the CLI mirrors the golden paths — `node space bridge status | plan "<req>" | run <id> | ingest | open`. The page's opening mode is configurable with `node space set BRIDGE_DEFAULT_MODE=<mode>`. The whole integration is declared in [`manifests/integrations/bridge.integration.json`](manifests/integrations/bridge.integration.json) and covered by `node space memory audit`.

### 5e. Memory graph (`#/_prime_silo/memory`)

The memory graph is the third graph of the cognitive mesh — your agent sessions (Claude + Antigravity), X-rayed into an explorable lineage map by [Memo-Ray](https://github.com/binary16labs/memo-ray). It answers "what was I working on" and "which sessions touched this file" so you never have to be the institutional memory.

**How to reach it:** open `http://localhost:3000/#/_prime_silo/memory`. `scripts/dev.ps1` auto-boots the Memo-Ray server when it's enabled and the checkout exists beside prime-silo (or `MEMORAY_DIR` is set).

**What you see:**
- **Command Center cards** — totals, system metrics, capabilities, git worktrees, a file-touch heatmap, and recent sessions.
- **Session list → lineage graph** — pick a session; its lineage renders left-to-right (Session → input → thought → tool call → artifact), files as rounded nodes. Click a node to inspect its content and open the file.
- **Search / Sync now / Zen mode** — omnibar search, a manual delta-sync, and a link out to Memo-Ray's full client.
- **Conformance strip** — green when the integration matches its declared manifest; "drift" with a pointer to `node space memory audit` when it doesn't.

**Configuring it:** the wizard's *Services* step has a Memo-Ray toggle and endpoint field. Under the hood the shell proxies `/api/memoray` to `MEMORAY_BASE_URL` (or the wizard manifest's `memoray.base_url`). Turn it off with `node space set MEMORAY_ENABLED=false`.

**If Memo-Ray isn't running:** the page shows a friendly screen with the exact boot command — never a raw error.

**Ask the agent:** the onscreen agent has a `memory-recall` skill. Ask it "what was I working on yesterday?" or "which sessions touched memoray_proxy.js?" and it queries the graph itself, answering with session links you can click.

---

## 6. CLI reference

All `benny` commands run from inside `prime-silo/runtime/`. Either `cd runtime` first, or prefix paths accordingly.

### 6a. Booting and health checks

```bash
# Start just the runtime (no shell server):
cd runtime
python -m benny.api.server

# Check runtime health:
curl http://localhost:8005/api/agent_sandbox/health
# → {"status":"ok"}

# List registered widgets:
curl http://localhost:8005/api/widgets

# List registered manifests:
curl http://localhost:8005/api/manifests

# Check service status (if you used benny up):
benny status
```

### 6b. Plan a manifest

`benny plan` sends your requirement to the LLM and generates a signed manifest.

```bash
# Basic plan — prints the manifest JSON:
benny plan "analyse Q3 sales data and flag anomalies" --workspace myproject

# Save the manifest to a file:
benny plan "analyse Q3 sales data" --workspace myproject --save
# → Saved to manifests/plan_analyse_q3_...json

# Plan and immediately run:
benny plan "quick data summary" --workspace myproject --save --run
```

The manifest is a JSON file describing tasks, dependencies, and waves. It is HMAC-signed by the runtime before saving — unsigned manifests will be rejected at run time.

### 6c. Run a manifest

```bash
# Run a saved manifest:
benny run manifests/plan_analyse_q3_sales_2026.json

# Run with JSON output (machine-readable):
benny run manifests/plan_analyse_q3_sales_2026.json --json

# Resume a failed run from a specific task:
benny run manifests/plan_analyse_q3_sales_2026.json --resume <prior_run_id>
```

Each run gets a unique `run_id` (e.g. `run-abc123`). Use this id to inspect the run in the Runs Explorer or via `benny runs ls`.

### 6d. Browse run history

```bash
# List the 10 most recent runs:
benny runs ls --limit 10

# List runs for a specific workspace:
benny runs ls --workspace myproject --limit 20

# Example output:
# run-abc123  completed  2026-05-11 09:30  2m 15s  analyse_q3_sales
# run-def456  failed     2026-05-11 08:10  0m 45s  quick_data_summary
```

### 6e. Pypes transformation pipeline

Pypes is the declarative data transformation engine. It runs bronze → silver → gold stage pipelines with full lineage.

```bash
# Validate a Pypes manifest (no run, just checks):
benny pypes inspect manifests/templates/financial_risk_pipeline.json

# Run a Pypes pipeline:
benny pypes run manifests/templates/financial_risk_pipeline.json \
     --workspace pypes_demo

# Drill into a specific output stage after a run:
benny pypes drilldown <run_id> gold_exposure --workspace pypes_demo
# → Shows CLP-annotated rows with lineage notes

# Rerun from a specific stage (skip completed stages):
benny pypes rerun <run_id> --from silver_trades --workspace pypes_demo
```

**Sandbox commands (advisory — never mutate run data):**

```bash
# Ask the LLM to draft a Pypes manifest for you:
benny pypes plan "summarise customer churn by region" --workspace myproject --save

# Generate a one-shot analyst narrative for a completed run:
benny pypes agent-report <run_id> --workspace myproject

# Compare pandas vs polars performance on the same pipeline:
benny pypes bench pandas=<manifest1.json> polars=<manifest2.json> --workspace myproject

# Multi-turn drill-down chat grounded on a specific run:
benny pypes chat <run_id> --workspace myproject
```

### 6f. Memory graph (`node space memory`)

The same memory capability as the page, from the terminal — and the headless entry point for CI or a local-LLM maintainer.

```bash
# Is Memo-Ray reachable? Show totals + the resolved endpoint:
node space memory status

# Trigger a delta-sync of agent logs:
node space memory sync

# Recent sessions (filter by agent, limit count):
node space memory sessions --agent claude --limit 10

# Search across sessions, files, and actions:
node space memory search "lineage graph"

# Run the integration conformance audit (exit 1 on drift):
node space memory audit

# Manage the endpoint with the standard config system:
node space get MEMORAY_BASE_URL
node space set MEMORAY_ENABLED=false
```

The integration is declared and signed in `manifests/integrations/memoray.integration.json`; `node space memory audit` (and `node scripts/audit-integrations.mjs`) probe live reality against it and report owner-tagged drift. See `manifests/integrations/AGENTS.md` for the agent maintenance loop.

### 6g. AgentAmp skin packs

AgentAmp is the skinnable operator cockpit. Skin packs (`.aamp` files) are signed zip bundles containing themes and layouts.

```bash
# Create a new skin draft:
benny agentamp scaffold-skin my-skin

# Pack the draft into a .aamp file:
benny agentamp pack my-skin/ --out my-skin.aamp

# Sign the skin pack:
benny agentamp sign my-skin.aamp

# Install a signed skin:
benny agentamp install my-skin.aamp --workspace myproject

# Queue a manifest run from AgentAmp:
benny agentamp enqueue manifests/my-plan.json --workspace myproject

# Export your cockpit state (EQ, user settings) to a portable bundle:
benny agentamp export-cockpit my-cockpit.aamp.cockpit

# Import cockpit state on another machine:
benny agentamp import-cockpit my-cockpit.aamp.cockpit
```

### Service lifecycle

```bash
# Start all services (Neo4j, Marquez, Phoenix) via Docker:
benny up --home .benny_home

# Stop all services:
benny down --home .benny_home

# Check what's running:
benny status --home .benny_home

# Self-diagnose common issues:
benny doctor --home .benny_home
```

---

## 7. Agent draft views — save, pin, load

This is the audit workflow for Review-zone layouts the agent composes.

### The three-step flow

```
Agent drafts a view  →  Human pins it  →  Anyone loads + verifies it
     (sandbox)           (human-only)         (verifies HMAC)
```

### Step 1 — agent saves a draft

The agent uses `saveView` to write a layout to its sandbox (not accessible to the signed-view path):

```js
// Inside an agent turn:
const client = createAgentRuntimeClient("sandbox");
await client.saveView("myproject", "analysis.aamp.view", {
  schema: "aamp.view/1",
  panels: [
    { widget: "run.reasoning_trace", run_id: "run-abc123" },
    { widget: "run.drilldown_table", run_id: "run-abc123" }
  ]
});
```

The draft lands at: `.benny_home/workspaces/myproject/agent_sandbox/views/analysis.aamp.view`

### Step 2 — human pins it

Only a human can call `pinView` (the agent gets a 403 if it tries):

```js
// Human-initiated — no agent scope:
import { pinView } from "/mod/_prime_silo/runtime_client/runtime-client.js";

const result = await pinView("myproject", "analysis.aamp.view", {
  pinnedBy: "your-name"
});
// result.signature contains the HMAC value
```

Or via curl:

```bash
curl -X POST http://localhost:8005/api/views/pin \
     -H "Content-Type: application/json" \
     -d '{"workspace":"myproject","source_filename":"analysis.aamp.view","pinned_by":"your-name"}'
```

The pinned file goes to: `.benny_home/workspaces/myproject/views/analysis.aamp.view`  
It contains the layout **plus** an inline `signature` field — self-describing and tamper-evident.

### Step 3 — load and verify

```js
import { loadPinnedView } from "/mod/_prime_silo/runtime_client/runtime-client.js";

const result = await loadPinnedView("myproject", "analysis.aamp.view");

if (!result.valid) {
  // File was tampered with, or HMAC key changed. Refuse to render.
  throw new Error("Integrity check failed.");
}

renderLayout(result.view);  // safe to render
```

Or via curl:

```bash
curl http://localhost:8005/api/views/load/myproject/analysis.aamp.view
# → {"view": {...}, "signature": {...}, "valid": true}
```

**`valid: false` means:** either the file was edited after signing, or the `BENNY_HMAC_KEY` in `.env` changed since the view was pinned. Either re-pin it or restore the key.

---

## 8. Running the tests

### Browser-side tests (Node, no browser needed)

Run from the repo root:

```bash
# Individual test files:
node tests/runtime_proxy_test.mjs
node tests/widget_registry_test.mjs
node tests/manifest_explorer_test.mjs
node tests/runs_explorer_test.mjs       # 46 tests for runs_explorer helpers
node tests/runtime_client_agent_scope_test.mjs
node tests/runtime_client_saved_views_test.mjs
node tests/runtime_client_view_signing_test.mjs
node tests/runtime_client_pin_view_test.mjs
node tests/runtime_client_load_pinned_view_test.mjs

# Widget tests:
node tests/widgets_dag_canvas_test.mjs
node tests/widgets_three_renderer_test.mjs
```

Each prints `<name>_test: ok` on success.

### Run them all at once

```bash
# bash — runs every test and reports failures:
for f in tests/*_test.mjs; do
  echo "--- $f ---"
  node "$f" || echo "FAIL: $f"
done
```

```powershell
# PowerShell:
Get-ChildItem tests\*_test.mjs | ForEach-Object {
    Write-Host "--- $($_.Name) ---"
    node $_.FullName
}
```

### Runtime-side tests (pytest)

```bash
cd runtime

# Just the ADR-001 surfaces:
python -m pytest tests/api/test_views_signing.py -q     # Phase F/F2/F2b
python -m pytest tests/api/test_agent_sandbox.py -q     # Phase A/D2

# Full API suite (some pre-existing collection errors in kg3d/rag/workflows):
python -m pytest tests/api/ -q
```

---

## 9. Troubleshooting

### Agent gives "Protocol correction: your previous response was empty"

The model returned empty content. Check:

1. **Wrong endpoint** — is the URL correct? Try `curl <your-endpoint>` directly.
2. **Wrong model name** — the model ID must match exactly what the server expects.
3. **Missing API key** — cloud endpoints (non-localhost) require a key.
4. **Local model / Qwen3 thinking mode** — if using a local model and seeing this even with correct settings, make sure the endpoint starts with `http://localhost` or `http://127.0.0.1` — the app auto-detects these and disables thinking mode + uses a compatible system prompt.

### "No manifests registered" in Manifest Explorer

You haven't created any manifests yet. Create one:

```bash
cd runtime
benny plan "my first pipeline" --workspace default --save
```

Then refresh the Manifest Explorer page.

### curl to runtime returns 401

All runtime API calls require the header `X-Benny-API-Key: benny-mesh-2026-auth` (dev default):

```bash
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://localhost:8005/api/manifests
```

Calls through the shell proxy at `:3000` (e.g. `/api/runtime/...`) have the key injected automatically.

### `loadPinnedView` returns `valid: false`

One of:
- The file was hand-edited after pinning
- `BENNY_HMAC_KEY` changed between pin and load

Check the key in `.env` matches what was active when you pinned. Re-pin to fix.

### `pytest` fails with collection errors in `test_kg3d_api.py` etc.

These are pre-existing upstream issues, not regressions. Scope your pytest run to the files you care about:

```bash
python -m pytest tests/api/test_views_signing.py tests/api/test_agent_sandbox.py -q
```

### Shell server won't start — `EADDRINUSE`

Port 3000 is already in use. Either stop the conflicting process or pass a different port:

```bash
PORT=3001 node server/dev_server.js
```

### Runtime won't start — `address already in use: 8005`

Same issue on the Python side. Kill the previous process:

```bash
# Windows:
netstat -ano | findstr :8005
taskkill /PID <pid> /F

# macOS/Linux:
lsof -ti :8005 | xargs kill
```

### `node tests/*.mjs` fails with `URL is not defined`

Your Node version is below 18. Check with `node --version` and upgrade.

### Git push hangs on Windows

Git Credential Manager is waiting for an interactive login dialog. Alt-Tab to the GCM popup and authenticate. Run pushes from a terminal you can see, not a background script.

---

## Quick-reference cheat sheet

```
# Boot
.\scripts\dev.ps1                                           # Windows
./scripts/dev.sh                                            # Linux/mac

# UI surfaces
http://localhost:3000                                       # main shell
http://localhost:3000/#/_prime_silo/manifest_explorer       # manifest DAG
http://localhost:3000/#/_prime_silo/runs_explorer           # run status overlay
http://localhost:3000/#/_prime_silo/runs_explorer?run_id=X  # deep-link a run

# CLI (from prime-silo/runtime/)
benny plan "description" --workspace W --save               # generate manifest
benny run manifests/my-plan.json                            # execute manifest
benny runs ls --limit 10                                    # run history
benny pypes run manifests/pipeline.json --workspace W       # Pypes pipeline
benny pypes drilldown <run_id> <stage> --workspace W        # drill into stage
benny pypes chat <run_id> --workspace W                     # analyst chat
benny agentamp scaffold-skin my-skin                        # create skin draft
benny status / benny doctor                                 # service health

# Health checks
curl http://localhost:3000/api/runtime/agent_sandbox/health
curl http://localhost:3000/api/runtime/widgets
curl http://localhost:3000/api/runtime/manifests

# Tests (from repo root)
node tests/manifest_explorer_test.mjs
node tests/runs_explorer_test.mjs
for f in tests/*_test.mjs; do node "$f" || echo "FAIL: $f"; done
```

---

*Prime-Silo — engineered by Binary 16.*
