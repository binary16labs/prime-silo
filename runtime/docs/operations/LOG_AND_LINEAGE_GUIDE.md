# Log, Process & Lineage Guide

**Audience**: Operators and developers who need to observe, debug, or audit what Benny did and why.

---

## 1. Log Files

All logs live under `$BENNY_HOME/logs/`. They are **git-ignored** — never committed.

| File | What it contains | Format |
|------|-----------------|--------|
| `api.log` | FastAPI request/response, startup, route errors | Plain text (uvicorn) |
| `neo4j.log` | Neo4j server stdout/stderr | Plain text |
| `lemonade.log` | Local LLM service output | Plain text |
| `ui.log` | Vite dev server / UI build output | Plain text |
| `llm_calls.jsonl` | One JSON object per LLM call (model, duration, ok, run_id) | JSONL |

### 1.1 Tailing Logs

```bash
# Follow a specific service log in real time
tail -f $BENNY_HOME/logs/api.log

# Follow all logs simultaneously (requires multitail or separate terminals)
tail -f $BENNY_HOME/logs/api.log &
tail -f $BENNY_HOME/logs/neo4j.log &
tail -f $BENNY_HOME/logs/lemonade.log

# Windows (PowerShell)
Get-Content $env:BENNY_HOME\logs\api.log -Wait -Tail 50
```

### 1.2 Querying the LLM Call Log

The structured `llm_calls.jsonl` is useful for cost and latency analysis:

```bash
# Show all calls for a specific run
grep '"run_id": "run-abc"' $BENNY_HOME/logs/llm_calls.jsonl | jq .

# Show failed calls
grep '"ok": false' $BENNY_HOME/logs/llm_calls.jsonl | jq '{ts, model, run_id}'

# Total calls by model
cat $BENNY_HOME/logs/llm_calls.jsonl | jq -r '.model' | sort | uniq -c | sort -rn

# Average latency (ms) across all calls
cat $BENNY_HOME/logs/llm_calls.jsonl | jq '[.duration_ms] | add / length'
```

Log format per entry:
```json
{
  "ts": "2026-04-23T10:15:00Z",
  "run_id": "run-abc123",
  "model": "lemonade/Llama-3.1-8B-Instruct",
  "provider": "lemonade",
  "ok": true,
  "duration_ms": 842
}
```

Source: `benny/ops/llm_logger.py`

---

## 2. Process Observability

### 2.1 Service Status

```bash
benny status --home $BENNY_HOME
```

States: `healthy` (health probe passed) · `alive` (process up, probe failing) · `down` (no process).

```bash
# JSON form via API
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/ops/doctor
```

### 2.2 System Metrics

```bash
# Neo4j entity counts, disk usage, workspace stats
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/system/metrics | jq .
```

### 2.3 Real-Time Execution Events (SSE)

Every workflow run emits a Server-Sent Events stream. Connect with curl to watch in real time:

```bash
curl -N \
     -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     -H "Accept: text/event-stream" \
     http://127.0.0.1:8005/api/workflows/execute/<manifest_id>
```

Event types and their meaning:

| Event | Payload | Meaning |
|-------|---------|---------|
| `plan_updated` | `{manifest_id, task_count, wave_count}` | Manifest validated and execution started |
| `wave_started` | `{wave_id, task_ids[], wave_index}` | A parallel wave of tasks has begun |
| `task_started` | `{task_id, name, wave_id}` | Individual task is executing |
| `task_completed` | `{task_id, name, ok, duration_ms, output_preview}` | Task finished (ok=false = failed) |
| `run_finished` | `{run_id, ok, duration_ms, tasks_total, tasks_ok}` | Entire run complete |

Source: `benny/core/event_bus.py`

### 2.4 Run History

```bash
# List recent runs
benny runs ls --limit 20

# Inspect a specific run (shows all tasks, durations, outputs)
benny runs show <run_id>

# Via API
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/workflows/runs | jq .

curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/workflows/runs/<run_id> | jq .
```

Runs are persisted to `$BENNY_HOME/runs/` (SQLite via `benny/persistence/run_store.py`).

---

## 3. Lineage Tracking (Marquez / OpenLineage)

Marquez captures **what ran, what data it consumed, and what it produced** — the upstream/downstream dependency chain of every workflow run.

### 3.1 Starting Marquez

```bash
docker compose up -d marquez-db marquez-api marquez-web
```

Set the environment variable to enable lineage emission:

```bash
export MARQUEZ_URL=http://localhost:5000
# or in $BENNY_HOME/config.toml:
# [lineage]
# marquez_url = "http://localhost:5000"
```

### 3.2 Viewing Lineage

Open the Marquez UI: **http://localhost:3010**

Navigate: **Namespaces → benny → Jobs → <manifest_id>**

Each run appears as a **Job Run** with:
- Input datasets (source files, workspace RAG index)
- Output datasets (generated artefacts, reports)
- Start/end timestamps
- Run state (COMPLETE / FAILED)

### 3.3 Querying Lineage via API

```bash
# List all jobs in the benny namespace
curl http://localhost:5000/api/v1/namespaces/benny/jobs | jq '.jobs[].name'

# Get lineage graph for a specific job (upstream + downstream)
curl "http://localhost:5000/api/v1/lineage?nodeId=job:benny:<manifest_id>&depth=3" | jq .

# Get run history for a job
curl http://localhost:5000/api/v1/namespaces/benny/jobs/<manifest_id>/runs | jq .
```

Source: `benny/governance/lineage.py`

### 3.4 RunRecord Governance URL

Every `RunRecord` in the run store contains a `governance_url` field pointing to its Marquez job run URL:

```bash
benny runs show <run_id>
# → governance_url: http://localhost:5000/api/v1/namespaces/benny/jobs/...
```

---

## 4. Distributed Tracing (Phoenix / OpenTelemetry)

Phoenix captures **LLM spans** — the internal reasoning trace of each model call, including prompts, completions, token counts, and latency.

### 4.1 Starting Phoenix

```bash
docker compose up -d phoenix
```

Open Phoenix UI: **http://localhost:6006**

### 4.2 What You Can See

- **Traces view**: Each workflow run is a root span; nested under it are individual `call_model()` calls.
- **Span details**: Prompt text, completion, model name, duration, token counts.
- **LLM evals**: Compare across runs to spot regressions in output quality.

### 4.3 Enabling Tracing

Phoenix receives OTLP data automatically when `PHOENIX_ENDPOINT` is set:

```bash
export PHOENIX_ENDPOINT=http://localhost:4317
```

Source: `benny/governance/tracing.py`

---

## 5. Audit Execution Record (AER)

Every task execution writes an **AER** — a structured record of what the agent did, what inputs it received, and what it produced.

### 5.1 Query AERs via API

```bash
# List audit records for a run
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     "http://127.0.0.1:8005/api/governance/audit?run_id=<run_id>" | jq .

# Get audit record for a specific task
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     "http://127.0.0.1:8005/api/governance/audit/<task_id>" | jq .
```

AER fields: `task_id`, `run_id`, `task_name`, `started_at`, `completed_at`, `ok`, `input_hash`, `output_preview`, `model`, `governance_flags`.

Source: `benny/governance/audit.py`, `benny/governance/execution_audit.py`

---

## 6. Process Lineage — Full Trace of One Run

Here is the complete chain from `benny plan` to final output, showing every observability touchpoint:

```
1. CLI: benny plan "<requirement>"
   └── benny/graph/manifest_runner.py::plan_from_requirement()
       ├── call_model() → LLM span in Phoenix
       ├── sign_manifest() → manifest stored in $BENNY_HOME/workflows/
       └── (no AER yet — planning is not execution)

2. CLI: benny run <manifest.json>
   └── POST /api/workflows/execute/<manifest_id>
       ├── manifest_hash.py::verify_signature()  ← trust boundary
       ├── SSE stream opens → client receives events
       │
       ├── Wave 1 fan-out (benny/graph/wave_scheduler.py)
       │   ├── Task A starts → SSE: task_started
       │   │   ├── call_model() → Phoenix LLM span
       │   │   ├── AER written → benny/governance/audit.py
       │   │   └── OpenLineage event → Marquez (task input/output datasets)
       │   │   └── SSE: task_completed
       │   └── Task B ... (parallel)
       │
       ├── Wave 2 fan-out (depends on Wave 1 outputs)
       │   └── ...
       │
       └── run_finished → SSE: run_finished
           ├── RunRecord persisted → $BENNY_HOME/runs/ (SQLite)
           ├── RunRecord.governance_url → Marquez job run URL
           └── Final OTLP root span closed → Phoenix

3. Post-run inspection
   ├── benny runs show <run_id>        ← CLI
   ├── GET /api/workflows/runs/<id>    ← API
   ├── Marquez UI http://localhost:3010 ← lineage graph
   └── Phoenix UI http://localhost:6006 ← LLM spans
```

---

## 7. Quick Reference: Log Locations

| What you want to see | Where to look |
|---------------------|---------------|
| Service startup errors | `$BENNY_HOME/logs/<service>.log` |
| LLM call history (model, latency) | `$BENNY_HOME/logs/llm_calls.jsonl` |
| Live execution events | SSE stream: `/api/workflows/execute/<id>` |
| Run history + task breakdown | `benny runs ls` / `benny runs show <id>` |
| Data lineage (what ran, what it touched) | Marquez UI http://localhost:3010 |
| LLM prompt/completion traces | Phoenix UI http://localhost:6006 |
| Per-task audit records | `GET /api/governance/audit?run_id=<id>` |
| System health JSON | `GET /api/ops/doctor` |
| Neo4j metrics | `GET /api/system/metrics` |
