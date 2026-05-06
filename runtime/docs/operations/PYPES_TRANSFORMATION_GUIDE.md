# Benny Pypes — Declarative Transformation Engine

Pypes is Benny's third capability surface — alongside **documents** (RAG / Knowledge Graph) and **code** (Code Graph + Swarm execution). It turns Benny into a **manifest-driven, DAG-based data transformation engine** that can:

- Run bronze → silver → gold pipelines with checkpoints at every step.
- Validate data inline (completeness, uniqueness, thresholds, move-analysis vs. prior runs).
- Generate explainable financial-risk-style reports with drill-down + CLP (Conceptual / Logical / Physical) lineage.
- Re-execute any subset of a previous run from the exact checkpoint where it diverged.
- Speak the same `${BENNY_HOME}` portability and `X-Benny-API-Key` governance as the rest of Benny.

Pypes brings the lessons from `docs/requirements/9/pypes/requirements/previous_project_pain_points.md` (chiefly: *"every transformation step needs a typed contract, a checkpoint, and a way to drill back to the source row"*) into a small, declarative engine that ships natively with Benny.

---

## TL;DR — Run the demo

```bash
# 1. Validate the bundled demo manifest
benny pypes inspect manifests/templates/financial_risk_pipeline.json

# 2. Execute it (creates workspace/pypes_demo/runs/pypes-<run_id>/)
benny pypes run manifests/templates/financial_risk_pipeline.json --workspace pypes_demo

# 3. List prior runs
benny pypes runs --workspace pypes_demo

# 4. Drill into a step's checkpoint with CLP-annotated columns
benny pypes drilldown <run_id> gold_exposure --workspace pypes_demo

# 5. Re-execute from a step (reuses checkpoints for everything before it)
benny pypes rerun <run_id> --from silver_trades --workspace pypes_demo

# 6. Re-render a single report without re-executing the pipeline
benny pypes report <run_id> counterparty_risk --workspace pypes_demo
```

You should see three reports under `workspace/pypes_demo/runs/pypes-<run_id>/reports/`:

| Report | Kind | What it shows |
|--------|------|---------------|
| `counterparty_risk.md`  | `financial_risk`      | Top exposures + threshold breaches + CLP provenance for the gold table |
| `breaches.md`           | `threshold_breaches`  | Every row that breached a `notional` / `total_exposure` cap |
| `exposure_move.md`      | `move_analysis`       | Day-on-day delta vs. the most recent prior run for the same manifest |

---

## Why declarative, why a closed DAG?

The pain points doc is blunt: imperative pipelines built up step-by-step in Python notebooks fail four ways:

1. **No reproducibility.** A bug fix in step 7 forces you to re-execute steps 1–6 — slow and lossy.
2. **No drill-back.** When a regulator asks *"why did `total_exposure = 525M` for CP-TESLA on 22 April?"* the answer requires re-deriving the calculation from logs, screenshots, and tribal memory.
3. **No threshold gating.** Validation lives in dashboards, not in the pipeline; bad data leaks into reports.
4. **No lineage.** OpenLineage / Marquez emissions are bolted on after the fact, never matching the actual graph.

A **closed DAG manifest** fixes all four:

- Every step is a node with declared inputs/outputs — the executor builds the topological order.
- Every step writes a checkpoint, indexed by `step_id` and tied to the exact manifest snapshot for the run.
- Validations are part of the step contract (pre + post), not an afterthought.
- Lineage is emitted from the same model the executor consumes, so the Marquez graph is the actual run.

Agents (planner / swarm) reason about the DAG as data — adding a step is editing a JSON file, not editing Python.

---

## Manifest anatomy

The canonical example is at `manifests/templates/financial_risk_pipeline.json`. The kind is `pypes_pipeline` (versus `swarm_manifest` for LangGraph swarms).

```jsonc
{
  "schema_version": "1.0",
  "kind": "pypes_pipeline",
  "id": "financial-risk-demo",
  "name": "Market Risk — Counterparty Exposure (Demo)",
  "workspace": "pypes_demo",

  "governance": { "compliance_tags": ["BCBS-239", "SOX"], "owner": "Risk_Quant_Team", "criticality": "high" },

  "clp": {
    "conceptual": [{ "name": "Trade", "owner": "Front Office" }, /* … */],
    "logical":    [{ "entity": "Trade", "fields": [/* typed columns + thresholds */] }],
    "physical":   [{ "entity": "Trade", "uri_template": "data_in/trades.csv", "format": "csv", "primary_key": ["trade_id"] }]
  },

  "variables": { "trades_source": "${benny_home}/manifests/templates/data/trades_sample.csv" },

  "steps": [
    {
      "id": "bronze_trades",
      "stage": "bronze",
      "engine": "pandas",
      "source": { "uri": "${trades_source}", "format": "csv" },
      "operations": [{ "operation": "load", "params": { "source_id": "FRONT_OFFICE" } }],
      "outputs": ["raw_trades"],
      "post_validations": { "completeness": ["trade_id", "trade_date"], "uniqueness": ["trade_id"], "row_count": { "min": 1 } },
      "clp_binding": { "trade_id": "Trade.trade_id", "notional": "Trade.notional" }
    },
    /* silver_trades, silver_trades_usd, gold_exposure … */
  ],

  "reports": [
    { "id": "counterparty_risk", "kind": "financial_risk", "source_step": "gold_exposure", "drill_down_by": ["counterparty_id"], "top_n": 25 },
    { "id": "breaches",          "kind": "threshold_breaches", "source_step": "silver_trades" },
    { "id": "exposure_move",     "kind": "move_analysis", "source_step": "gold_exposure", "top_n": 20 }
  ]
}
```

### Key concepts

| Concept | Where it lives | Why |
|---------|----------------|-----|
| **Stage** (`bronze` / `silver` / `gold` / `raw` / `feature` / `governed`) | `steps[].stage` | Lakehouse convention; gold steps require `clp_binding` so reports can drill back to logical attributes. |
| **CLP** (Conceptual → Logical → Physical) | `clp.*` block + `steps[].clp_binding` | BCBS-239 backbone. Every report annotates each column with its logical attribute and physical source. |
| **Operations** | Built into a registry (`benny.pypes.registry`) | `load`, `filter`, `dedupe`, `standardize`, `calc`, `aggregate`, `sort`, `join`, `union`, plus engine-specific extensions. |
| **Validations** | `pre_validations` / `post_validations` per step | `completeness`, `uniqueness`, `thresholds`, `row_count`, `move_analysis` — all FAIL → step status = `FAIL`, run status = `PARTIAL`. |
| **Variables** | `variables{}` + CLI `--var k=v` + `BENNY_HOME` env | All `${name}` tokens substituted at run-time. `benny_home` is auto-injected so manifests stay portable. |
| **Reports** | `reports[]` block | Kinds: `financial_risk`, `threshold_breaches`, `move_analysis`, `generic_summary`. Each consumes a step's checkpoint. |
| **Engines** | `engine: "pandas" | "polars"` per step | Same operations, different runtime. Engines auto-fall-back (parquet → CSV when pyarrow is missing). |
| **Sub-manifests** | `sub_manifest_uri` on a step | A step can recursively execute another manifest — useful for shared cleansing routines. |

---

## What gets persisted

Every run produces:

```
$BENNY_HOME/workspace/<workspace>/runs/pypes-<run_id>/
├── manifest_snapshot.json     ← exact resolved manifest (variables substituted)
├── receipt.json               ← signed RunReceipt (SHA-256 over status + checkpoints)
├── checkpoints/
│   ├── _index.json            ← step_id → {path, format, row_count, fingerprint}
│   ├── bronze_trades.parquet  ← (or .csv when pyarrow is unavailable)
│   ├── silver_trades.parquet
│   ├── silver_trades_usd.parquet
│   └── gold_exposure.parquet
└── reports/
    ├── counterparty_risk.md
    ├── breaches.md
    └── exposure_move.md
```

A re-run with `--from <step_id>` loads checkpoints for every step *upstream* of `<step_id>` and re-executes from there. Reports re-render against the new outputs — without recomputing the bronze/silver layers if they did not change.

---

## CLI cheatsheet

```bash
# Validate without executing
benny pypes inspect <manifest.json>

# Execute (override variables, skip steps, run only one)
benny pypes run <manifest.json> --workspace <ws> \
                                --var trades_source=$PWD/data_in/feb.csv \
                                --only bronze_trades silver_trades

# List runs in a workspace
benny pypes runs --workspace <ws> --limit 20

# Drill into a checkpoint (rows + CLP annotations)
benny pypes drilldown <run_id> <step_id> --workspace <ws> --rows 50

# Re-execute downstream of a step (reuses prior checkpoints)
benny pypes rerun <run_id> --from <step_id> --workspace <ws>

# Re-render one report from a prior run
benny pypes report <run_id> <report_id> --workspace <ws>

# Inspect the registered operation/engine catalog
benny pypes registry
```

---

## HTTP API (Studio integration)

Every CLI action has a paired endpoint under `/api/pypes/`. All endpoints require the standard `X-Benny-API-Key: benny-mesh-2026-auth` header.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/pypes/registry`                           | List operations + engines |
| `POST` | `/api/pypes/validate`                           | Validate manifest, return DAG order + CLP gaps |
| `POST` | `/api/pypes/run`                                | Execute (`{manifest, variables, only_steps, resume_from_run_id}`) |
| `GET`  | `/api/pypes/runs?workspace=<ws>`                | List prior runs |
| `GET`  | `/api/pypes/runs/{run_id}?workspace=<ws>`       | Receipt + manifest snapshot |
| `GET`  | `/api/pypes/runs/{run_id}/steps/{step_id}`      | Drill-down rows + CLP binding |
| `POST` | `/api/pypes/runs/{run_id}/rerun`                | Re-execute from `from_step` |
| `POST` | `/api/pypes/runs/{run_id}/reports/{report_id}` | Re-render a single report |

The Studio surface is `frontend/src/components/Studio/PipelineCanvas.tsx`. It loads a run via the API, renders the DAG with stage-coloured nodes, colours each node by validation status, and drills down into the checkpoint when you click a step.

---

## Lineage and audit

Pypes runs emit OpenLineage events through the same emitter the swarm uses. With Marquez running:

```bash
docker compose up -d marquez-db marquez-api marquez-web
# then open http://localhost:3010 — pypes runs appear as their own jobs/datasets
```

The signed `receipt.json` plus the `manifest_snapshot.json` give you a tamper-evident audit trail without needing Marquez at all — useful for offline / portable Benny.

---

## Sandbox layer — planner, agent reports, bench, chat

Above the deterministic flow (`run` / `inspect` / `rerun` / `report`) sit four
**sandbox** subcommands that are deliberately advisory and side-effect-free.
They never mutate run data, never alter the manifest snapshot, and never
appear in OpenLineage. They exist so a user can *design with an agent*,
*get a narrative*, *compare backends*, and *interrogate a finished run*
without contaminating the audit trail.

| Subcommand | Purpose | Mutates run data? |
|------------|---------|-------------------|
| `pypes plan "<requirement>"` | LLM-generates a draft `PypesManifest` from English | No — writes a draft JSON only |
| `pypes agent-report <run_id>` | Persona-driven Markdown narrative on top of gold reports | No — writes `risk_narrative.md` next to existing reports |
| `pypes bench <m1> <m2> [...]` | Sequentially runs N manifests over the same workspace and compares wall-time, CPU, RSS, cost | The runs are real (each gets its own `pypes-<id>/`); the comparison itself is read-only |
| `pypes model-bench <spec.json>` | Runs the **same task** (planner / agent-report / chat-qa) through N LLMs and scores each on time, cost, tokens, content size, accuracy, quality | No — writes to `${benny_home}/runs/model-compare/<id>/` only |
| `pypes chat <run_id>` | Multi-turn risk-analyst REPL grounded against a finished run's gold facts | No — optional `/save` writes a transcript file |

### `pypes plan` — LLM authors a draft manifest

```bash
benny pypes plan "ingest 3 days of options trades, mark by delta bucket, and produce a gold view by underlier" \
  --workspace pypes_demo --save
# review manifests/drafts/<id>.json, then:
benny pypes run manifests/drafts/<id>.json --workspace pypes_demo

# Or one-shot:
benny pypes plan "..." --workspace pypes_demo --save --run
```

The planner routes through `call_model()` (offline-aware, never touches
LiteLLM directly per CLAUDE.md rule #1). The system prompt embeds the live
operation registry plus a minimal valid example. Output is parsed (handles
raw JSON, fenced ` ```json ` blocks, or chatty wrappers) and validated
against the `PypesManifest` Pydantic model as a hard gate. The CLI flag wins
for `id` and `workspace` so successive `--save` attempts diff cleanly.

Default model: `--model` → `$BENNY_DEFAULT_MODEL` → `get_active_model()`
(probes local providers) → `ollama/llama3.1`.

### `pypes agent-report` — risk-analyst narrative

```bash
benny pypes agent-report <run_id> --workspace pypes_demo
```

A `RiskAnalystAgent` persona ("15-yr senior market-risk analyst") with eight
named skills (counterparty concentration, country/sovereign, DV01/Vega
attribution, BCBS-239 / FRTB framing, etc.) reads **only** gold checkpoints
and the breach roll-up from the receipt — never raw CSVs. It writes a
separate `runs/pypes-<id>/reports/risk_narrative.md` with seven mandatory
sections (Headline, Top exposures, Concentration callouts, Top risk drivers,
Day-over-day movement, Threshold breaches, Recommended actions) — each
required to cite specific counterparty ids / ISINs / USD values from the
JSON, never to invent them.

### `pypes bench` — head-to-head performance

```bash
# Compare engines on the same DAG (one each — minimum two manifests)
benny pypes bench \
  pandas=manifests/templates/counterparty_market_risk_pipeline.json \
  polars=manifests/templates/counterparty_market_risk_pipeline_polars.json \
  --workspace pypes_demo

# Repeat each manifest 3 times, best wall-clock wins (defends against OS hiccups)
benny pypes bench pandas=... polars=... --workspace pypes_demo --repeats 3

# Emit a JSON report instead of the Rich UI
benny pypes bench pandas=... polars=... --workspace pypes_demo --json
```

The harness wraps each `Orchestrator().run()` call with a `psutil`-driven
sampler (50 ms by default) and reports:

| Column | Meaning |
|--------|---------|
| `Wall s`     | End-to-end wall-clock seconds |
| `CPU s`      | Process user+system CPU time consumed during the run |
| `CPU%avg`    | Mean of non-zero process CPU% samples |
| `CPU%max`    | Peak process CPU% sample (can exceed 100% on multi-core) |
| `RSS MB`     | Peak resident set size of the Python process |
| `RSS Δ`      | RSS growth from start to end (proxy for retained allocations) |
| `Cost $`     | `wall_seconds × $/hr / 3600` (default $0.20/hr; override `BENNY_COMPUTE_COST_USD_PER_HOUR`) |
| `Rows`       | Sum of all step row counts — should match across runs (parity check) |

The verdict panel highlights **fastest**, **cheapest**, and **smallest mem**
labels; a **parity diff** table appears only when row counts disagree
between runs (so the headline number is never silently misleading).

### `pypes model-bench` — same task, N models, head-to-head scorecard

Where `pypes bench` compares two **manifests** (e.g. pandas vs polars on the
same DAG), `pypes model-bench` compares two **models** on the same prompt —
useful when you're picking which local LLM to standardise on for the planner,
risk-narrative, or chat workflows.

```bash
# Cross-model planner comparison (4 local models authoring the same pipeline)
benny pypes model-bench manifests/templates/model_comparison_planner.json \
  --workspace pypes_demo

# Repeat each model 3 times (best wall time per model wins) + LLM judge
benny pypes model-bench manifests/templates/model_comparison_planner.json \
  --workspace pypes_demo --repeats 3 --judge

# Headless: structured JSON + Markdown scorecard for PRs / docs
benny pypes model-bench manifests/templates/model_comparison_planner.json \
  --workspace pypes_demo --json
benny pypes model-bench manifests/templates/model_comparison_planner.json \
  --workspace pypes_demo --save-report ./model_compare.md
```

**Spec schema** (`ModelCompareSpec` — see
`manifests/templates/model_comparison_planner.json`):

| Field | Purpose |
|-------|---------|
| `task`                  | `plan` \| `agent_report` \| `chat_qa` — picks the prompt-builder + auto-rubric |
| `requirement` / `run_id` / `question` | Task-specific inputs (planner needs `requirement`; agent-report + chat-qa need `run_id`; chat-qa also needs `question`) |
| `models[].id`           | Routable model id passed to `call_model()` (`lemonade/...`, `ollama/...`, `openai/gpt-4o`, …) |
| `models[].cost_per_1k_in` / `cost_per_1k_out` | Set for paid models → token-based pricing. Unset for local → falls back to compute pricing (`$BENNY_COMPUTE_COST_USD_PER_HOUR`) |
| `repeats`               | N runs per model; best wall-time wins (defends against OS hiccups) |
| `rubric_required_ops`   | (planner only) Operations the manifest MUST use to score full points |
| `rubric_min_steps` / `rubric_min_gold_steps` | (planner only) Minimum DAG shape thresholds |
| `judge.enabled` / `judge.model` | Optional: a second LLM scores each candidate 0-10 on completeness / faithfulness / usability |
| `output_dir`            | `${benny_home}/runs/model-compare` by default — portable per SR-1 |

**Scorecard columns** (best run per model is the headline; full per-trial
detail lands in `results.json`):

| Column | Meaning |
|--------|---------|
| `Wall s`     | End-to-end wall-clock for the LLM call |
| `Tok in / Tok out` | Counted via `cl100k_base` (tiktoken) — provider-agnostic |
| `Resp chars` | Raw response size (whitespace + JSON / Markdown payload) |
| `Cost $`     | Token-priced when `cost_per_1k_*` set; else compute-priced from wall time |
| `CPU%avg` / `RSS MB` | Process resource envelope during the call (psutil sampler) |
| `Auto`       | Auto-rubric score in [0, 1] — schema validity, required-ops coverage, step count, gold-presence, validations, reports, non-empty response |
| `Judge`      | (Optional) blended 0-10 judge rating — completeness, faithfulness, usability + rationale |
| `Quality`    | Blended quality score: 60% auto-rubric + 40% normalised judge |

The verdict panel highlights **fastest**, **cheapest**, **fewest tokens**, and
**best quality**. Failed trials surface in a separate red panel with their
upstream error (e.g. `Max length reached!` if the model's context window
isn't big enough — see `BENNY_PYPES_FACTS_CHAR_BUDGET`).

Per-trial raw output (manifest JSON for `plan`, Markdown for
`agent_report` / `chat_qa`) is written to
`${benny_home}/runs/model-compare/<spec.id>/<label>__r<N>.<ext>` so you can
diff candidate manifests by hand.

### `pypes chat` — drill-down conversation

```bash
benny pypes chat <run_id> --workspace pypes_demo
```

Opens a multi-turn REPL bound to one finished run. The system prompt is
built once from the run's gold facts (top 12 rows per gold table + breach
roll-up); each user turn is sent with a sliding window of conversation
history (capped by `--max-history`, default 20). Slash commands:

| Command | Action |
|---------|--------|
| `/facts`   | Show loaded gold tables (rows × cols × stage) |
| `/receipt` | Print the run's `receipt.json` |
| `/history` | Show the current conversation history |
| `/clear`   | Reset history (facts stay loaded) |
| `/save <path>` | Persist transcript as Markdown |
| `/help`    | Show available commands |
| `/exit` \| `/quit` | Leave the harness |

The agent is forbidden by its own system prompt from inventing rows or
recommending pipeline edits — it stays advisory, citing exact USD values
and counterparty ids from the loaded JSON facts.

### Why a sandbox layer at all?

Three properties matter and they would fight each other if everything lived
in one path:

1. **Determinism** — auditors need byte-identical replay of any prior run.
   The declarative flow (run / rerun) provides that.
2. **Designability** — an engineer needs to iterate on a manifest without
   ceremony. The planner provides that.
3. **Explainability** — a risk officer needs a narrative on top of the
   numbers. The agent-report and chat harness provide that.

Splitting them keeps the deterministic core small, signed, and testable
while letting the agent surfaces evolve quickly.

---

## Two backends, same DAG — `pandas` vs `polars`

Every step declares `engine: pandas | polars` independently. Two paired
manifests ship for direct comparison:

| Manifest | Engine | Notes |
|----------|--------|-------|
| `manifests/templates/counterparty_market_risk_pipeline.json`        | `pandas`  | Reference implementation |
| `manifests/templates/counterparty_market_risk_pipeline_polars.json` | `polars`  | Identical DAG, identical reports — only the per-step `engine` is swapped |

Use `pypes bench` (above) to measure on your machine. On the bundled 49-row
demo data, polars typically wins wall-clock by ~10-20% but loses on peak
RSS by ~30-40% because the polars engine eagerly materialises columns;
results swing the other way on larger datasets. **Always bench on data
shaped like your real workload** before picking a backend for production.

The two engines must produce **byte-identical row counts** per step — the
bench harness emits a yellow "Parity Disagreement" panel if they diverge.

---

## Expanded test data — counterparty market risk

`manifests/templates/data/cmr_trades_2026-04-{22,23,24}.csv` — three daily
front-office snapshots (49 trades total) with the columns a real
counterparty-market-risk pack needs:

| Column | Why it matters |
|--------|----------------|
| `as_of_date` | Drives day-over-day move analysis |
| `counterparty_id`, `counterparty_name` | Headline grouping |
| `product_type` | Equity / Bond / Swap / Option / FX (concentration view) |
| `segment` | Tech / Financials / Energy / Auto / Consumer / Materials / Government |
| `country` | Sovereign-risk lens (US / DE / GB / JP / CH / FR / SA / AU / BR) |
| `isin` | Security-level concentration (real-format codes) |
| `notional`, `ccy`, `fx_rate`, `mtm_usd` | Currency-normalised exposure |
| `dv01`, `delta`, `vega` | Greeks → top-risk-drivers view |
| `maturity_date` | Maturity profile / ALM lens |
| `status` | Cleansing filter (drops `cancelled` / `pending`) |

The CMR manifest deliberately includes a 250M Tesla trade that breaches the
200M notional threshold on day 1 — gives the breach-report a real row to
narrate and the day-over-day move analysis a real swing to flag.

---

## Where the source lives

| File | Role |
|------|------|
| `benny/pypes/models.py`         | Pydantic schema (`PypesManifest`, `PipelineStep`, `RunReceipt`, `ValidationResult`, etc.) |
| `benny/pypes/registry.py`       | Operation registry — register your own with `@registry.register("my_op")` |
| `benny/pypes/engines/pandas_impl.py` | Default execution engine (also used to read checkpoints) |
| `benny/pypes/engines/polars_impl.py` | Polars engine for high-throughput steps |
| `benny/pypes/orchestrator.py`   | Topological execution + checkpoints + sub-manifest recursion |
| `benny/pypes/validators.py`     | Completeness / uniqueness / thresholds / move-analysis |
| `benny/pypes/reports.py`        | Markdown renderers for the four report kinds |
| `benny/pypes/checkpoints.py`    | Parquet + CSV fallback checkpoint store |
| `benny/pypes/lineage.py`        | OpenLineage emitter |
| `benny/pypes/planner.py`        | **Sandbox** — LLM-driven `PypesManifest` generator (`benny pypes plan`) |
| `benny/pypes/agent_report.py`   | **Sandbox** — risk-analyst persona for one-shot narratives (`benny pypes agent-report`) |
| `benny/pypes/agent_chat.py`     | **Sandbox** — multi-turn risk-analyst REPL (`benny pypes chat`) |
| `benny/pypes/bench.py`          | **Sandbox** — psutil-instrumented head-to-head perf harness (`benny pypes bench`) |
| `benny/pypes/model_compare.py`  | **Sandbox** — cross-model planner/agent/QA scorecard (`benny pypes model-bench`) |
| `benny/pypes/cli.py`            | argparse subcommands wired into `benny_cli.py` |
| `benny/api/pypes_routes.py`     | FastAPI router mounted at `/api/pypes` |
| `manifests/templates/financial_risk_pipeline.json` | Original investment-bank demo manifest |
| `manifests/templates/counterparty_market_risk_pipeline.json` | Multi-date counterparty market risk pipeline (pandas) |
| `manifests/templates/counterparty_market_risk_pipeline_polars.json` | Same DAG, polars backend (for `pypes bench`) |
| `manifests/templates/data/trades_sample.csv`       | Original demo trades |
| `manifests/templates/data/cmr_trades_2026-04-{22,23,24}.csv` | Three-day rich CMR test data |
| `frontend/src/components/Studio/PipelineCanvas.tsx`| Studio DAG visualisation + drill-down panel |

---

## See also

- [SAD §3.6 Pypes Transformation Engine](../../architecture/SAD.md) — architectural placement
- [BENNY_OPERATING_MANUAL.md](BENNY_OPERATING_MANUAL.md) — full run book
- [LOG_AND_LINEAGE_GUIDE.md](LOG_AND_LINEAGE_GUIDE.md) — Marquez + Phoenix observability
- [`docs/requirements/9/pypes/requirements/`](../../requirements/9/pypes/requirements/) — original requirement docs and pain-point retrospective
