# Knowledge Enrichment Workflow

**Purpose**: Bridge the Notebook knowledge graph and the Studio code graph by creating `CORRELATES_WITH` edges that link `Concept` nodes (extracted from architecture documents) to `CodeEntity` nodes (extracted from source code). Once this pipeline has run, the **ENRICH toggle** in Benny Studio overlays semantic meaning onto the structural code graph.

---

## 1. What This Does

```
Architecture PDFs / UML docs          Source code (Python, TS, JS)
        ↓                                       ↓
  [Docling extract]                    [Tree-Sitter scan]
        ↓                                       ↓
  Concept nodes in Neo4j             File/Class/Function nodes in Neo4j
        ↓                                       ↓
  [Deep synthesis]                             ↓
  REL {predicate} edges              DEFINES / DEPENDS_ON / INHERITS edges
        ↓                                       ↓
              [Semantic correlation (Neural Spark)]
                          ↓
            CORRELATES_WITH {confidence, rationale} edges
                          ↓
          Studio ENRICH toggle — amber dashed overlay
```

**End state**: hovering a `Function` node in Studio shows amber lines to the `Concept` nodes from your UML docs that semantically match it, with a confidence score.

---

## 2. CLI: `benny enrich`

The enrichment pipeline is a fixed 7-task DAG. It does not require LLM planning.
It can be driven in two equivalent ways:

- **Inline mode** — `benny enrich --workspace … --src … --run` builds the manifest in memory from CLI flags.
- **Declarative mode** — `benny enrich --manifest <path> --run` loads a v2.0 manifest template (see §3) that declares every endpoint, timeout, body, and fallback policy.

Both modes share the same executor. Declarative mode is preferred when you want to check a manifest into git, tweak per-task timeouts, or resume a partial run.

### 2.1 Generate manifest only (review before running)

```bash
benny enrich \
    --workspace c5_test \
    --src src/dangpy \
    --out plans/c5_enrich.json

# Review the manifest
cat plans/c5_enrich.json | jq '.plan.waves'

# Then run when ready
benny run plans/c5_enrich.json --json
```

### 2.2 Generate and run immediately

```bash
benny enrich \
    --workspace c5_test \
    --src src/dangpy \
    --run
```

### 2.3 Declarative mode — `--manifest`

```bash
benny enrich \
    --manifest manifests/templates/knowledge_enrichment_pipeline.json \
    --workspace c5_test \
    --src src/dangpy \
    --run
```

On load the CLI substitutes `${...}` tokens in the manifest with values from (in order) CLI flags → env vars → `manifest.variables` defaults, then applies these overrides to the runtime:

- `execution.api.base` → replaces `BENNY_API_URL`
- `execution.api.auth_value` → replaces `BENNY_API_KEY`
- `config.model` → replaces `--model`
- `inputs.context.src_path` / `correlation_threshold` / `correlation_strategy` → replace `--src` / `--threshold` / `--strategy`
- `plan.tasks[*].execution.request.timeout.read` → per-task read timeouts (1800s for `rag_ingest` and `deep_synthesis`, 900s for `semantic_correlate`, etc.)

A `Loaded manifest: … (N per-task timeouts resolved)` line is printed at startup for visibility.

### 2.4 Resume from a prior run — `--resume`

If a pipeline fails mid-wave, you can rerun without repeating the expensive stages that already succeeded:

```bash
benny enrich \
    --manifest manifests/templates/knowledge_enrichment_pipeline.json \
    --workspace c5_test \
    --src src/dangpy \
    --resume 38d42cdf5ace \
    --run
```

Behaviour:

1. Reads `$BENNY_HOME/workspace/<workspace>/runs/enrich-<resume_run_id>/task_*.json`.
2. For each task whose recorded `status` is in `execution.resume.skip_if_status` (default: `done`, `completed`, `completed_after_timeout`), the CLI:
   - Marks the task **`↺ reused`** (cyan) in the live table with `elapsed = 0.0s`.
   - Rehydrates cross-task artefacts from the prior `result` (e.g. `pdf_files`, `staging_files`) so downstream waves still see their inputs.
   - Writes a new `task_<id>.json` into the current run folder with `status: "reused"` + `reused_from: <resume_run_id>` for audit continuity.
3. Tasks that were `failed` / `skipped` in the prior run are re-executed from scratch.

Typical workflow: Wave 0 and Wave 1 complete, Wave 2 dies on an LLM timeout → fix the issue → rerun with `--resume <prior_run_id>` and the pipeline picks up at `deep_synthesis` in under a second instead of repeating the 9-minute Docling ingest.

### 2.5 Full options

```
benny enrich [OPTIONS]

Options:
  --workspace TEXT        Target workspace (default: c5_test)
  --src TEXT              Source path to scan, relative to workspace (default: src/)
  --model TEXT            LLM model ID (defaults to active manager selection)
  --threshold FLOAT       Semantic correlation confidence threshold 0.0-1.0 (default: 0.70)
  --strategy {safe,aggressive}
                          Correlation strategy (default: aggressive)
  --out TEXT              Write manifest JSON to path without running
  --run                   Execute the manifest immediately after building
  --json                  Emit full RunRecord JSON on completion (implies --run)
  --manifest PATH         Load a declarative v2.0 manifest from disk instead of
                          building one inline. Variables are substituted from CLI
                          flags + env + manifest.variables defaults.
  --resume RUN_ID         Reuse already-completed tasks from a prior run folder
                          (workspace/<ws>/runs/enrich-<RUN_ID>/task_*.json). Tasks
                          whose status is in execution.resume.skip_if_status are
                          rehydrated and skipped; the rest run fresh.
```

### 2.6 Running on a different workspace

```bash
# Any workspace with architecture docs in staging/ and code in src/
benny enrich \
    --workspace my_project \
    --src src/my_package \
    --threshold 0.65 \
    --strategy safe \
    --run
```

---

## 3. Manifest Template (schema_version 2.0)

The canonical template lives at [`manifests/templates/knowledge_enrichment_pipeline.json`](../../manifests/templates/knowledge_enrichment_pipeline.json). It is fully declarative — **nothing the CLI needs to dispatch a task is hardcoded in Python**. Copy it into a workspace and edit the `variables` block:

```bash
cp manifests/templates/knowledge_enrichment_pipeline.json \
   $BENNY_HOME/workspace/my_project/manifests/knowledge_enrichment.json

# Edit the `variables` map: workspace, src_path, model, correlation_threshold, ...
# Then run:
benny enrich --manifest $BENNY_HOME/workspace/my_project/manifests/knowledge_enrichment.json --run
```

### 3.1 Key sections of the template

| Section | What it declares |
|---------|------------------|
| `variables` | Defaults for every `${token}` in the manifest (`workspace`, `src_path`, `model`, `correlation_threshold`, `correlation_strategy`, `api_base`, `api_key`, `benny_home`, `resume_from_run_id`, …). CLI flags and env vars override these at load time. |
| `inputs` | `files` list and a `context` map passed as manifest metadata. |
| `outputs` | `base_dir` (e.g. `${benny_home}/workspace/${workspace}/${data_out_dir}`), `files`, `format`, `spec`. |
| `config` | `model`, `max_concurrency`, `max_depth`, `skills_allowed`. |
| `execution.api` | HTTP base URL, auth header name, auth value, content-type. Replaces hardcoded `BENNY_API_URL` / `BENNY_API_KEY`. |
| `execution.preflight` | Pulse endpoint, timeout, and `on_fail_hint` shown when the server is unreachable. |
| `execution.resume` | `skip_if_status` list, `rehydrate_emits` flag, `scan_glob` pattern for prior task files. |
| `execution.governance` | Toggles for OpenLineage, GDPR record, audit events, and SHA-256 seal. |
| `plan.tasks[*].execution` | Per-task dispatch contract (see §3.2). |
| `plan.edges`, `plan.waves`, `plan.ascii_dag` | DAG rendering for Studio / run history / CLI preview. |

### 3.2 Per-task execution kinds

Every task carries an `execution.kind` tag that tells the CLI how to dispatch it:

| `kind` | Used by | What the CLI does |
|--------|---------|-------------------|
| `inspect_and_classify` | `pdf_extract` | Calls `steps[*]` endpoints, classifies the returned files into buckets (`ingestible_exts`, `markdown_exts`), picks the first matching `case`, and emits artefacts (e.g. `pdf_files`) into the shared state dict. |
| `fire_and_poll` | `code_scan` | POSTs `start` to kick off a background task, then polls `poll.path` every `interval_s` up to `max_attempts` times, checking `success_when`. |
| `blocking` | `semantic_correlate` | One POST with the declared `request.timeout`. |
| `blocking_with_task_fallback` | `rag_ingest` | POST with long read timeout; on `ReadTimeout`/`RemoteProtocolError`/`ConnectError`, queries `GET /api/tasks/tasks/${task_run_id}` — if server-side status is `completed`, returns `status: "completed_after_timeout"`. |
| `blocking_with_task_list_fallback` | `deep_synthesis` | Same as above but fallback queries `/api/tasks?workspace=…` and filters by `filter_type` (e.g. `synthesis`), sorts by `sort_by`, then checks `success_when_status`. |
| `validate` | `validate_enrichment` | GET + JSONPath `assertion` (`require_count: ">= 1"`) against the response. Fails with `fail_message` if the count is zero. |
| `report` | `generate_report` | GET stats, then writes to `output.path` using `template_id`. |

### 3.3 Variable substitution

Any string field can contain `${name}` tokens. Resolution order:

1. **CLI flags** — `--workspace`, `--src`, `--model`, `--threshold`, `--strategy`, `--resume`.
2. **Environment variables** — `BENNY_HOME`, `BENNY_API_URL`, `BENNY_API_KEY`.
3. **`manifest.variables` map** — fallback defaults.

Unresolved tokens are left literal so a downstream runner or user edit can still fill them in. Substitution is recursive up to 4 levels (so `"${benny_home}/workspace/${workspace}"` resolves cleanly).

Runtime-only tokens (filled by the CLI during execution, not at load):

- `${run_id}` — hex ID of the current run.
- `${task_run_id}` — set by tasks with `execution.generate_run_id_as`; used in `rag_ingest` to pre-allocate a task ID the fallback endpoint can look up.

---

## 4. Pipeline DAG

```
Wave 0 (parallel):
  pdf_extract   → Convert staging/ PDFs/docs to Markdown (Docling)
  code_scan     → Tree-Sitter scan of src/ → Neo4j code graph

Wave 1:
  rag_ingest    → Chunk + embed Markdown → ChromaDB  [depends: pdf_extract]

Wave 2:
  deep_synthesis → Extract Concept triples → Neo4j REL edges  [depends: rag_ingest]

Wave 3:
  semantic_correlate → Neural Spark: POST /api/rag/correlate  [depends: code_scan, deep_synthesis]
                       Creates CORRELATES_WITH {confidence, rationale} edges

Wave 4 (parallel):
  validate_enrichment → Assert CORRELATES_WITH edges > 0  [depends: semantic_correlate]
  generate_report     → Write data_out/enrichment_report.md [depends: validate_enrichment]
```

**Skill hints and endpoints** (as declared in the v2.0 manifest):

| Task | Skill hint | Execution kind | HTTP call(s) | Read timeout |
|------|-----------|----------------|--------------|--------------|
| `pdf_extract` | `extract_pdf` | `inspect_and_classify` | `GET /api/files/recursive-scan`, optionally `GET /api/rag/status` | 90s |
| `code_scan` | `code_scan` | `fire_and_poll` | `POST /api/graph/code/generate`, polls `GET /api/graph/code` | 90s start / 10s poll / 72 × 5s |
| `rag_ingest` | `rag_ingest` | `blocking_with_task_fallback` | `POST /api/rag/ingest`; on timeout `GET /api/tasks/tasks/${task_run_id}` | 1800s |
| `deep_synthesis` | `rag_ingest` | `blocking_with_task_list_fallback` | `POST /api/graph/synthesize`; on timeout `GET /api/tasks?workspace=…` filtered by `type=synthesis` | 1800s |
| `semantic_correlate` | `kg3d_ingest` | `blocking` | `POST /api/rag/correlate?threshold=…&strategy=…` | 900s |
| `validate_enrichment` | `validate_enrichment` | `validate` | `GET /api/graph/code/lod?tier=1` | 30s |
| `generate_report` | `rag_ingest` | `report` | `GET /api/graph/stats`, writes `data_out/enrichment_report.md` | 30s |

---

## 5. Prerequisites

Before running the pipeline:

```bash
# 1. Services must be up
benny up --home $BENNY_HOME
benny doctor --home $BENNY_HOME

# 2. Workspace must exist
benny status --home $BENNY_HOME

# 3. Architecture documents must be in staging/
ls $BENNY_HOME/workspaces/c5_test/staging/
# Expected: *.pdf, *.docx, or *.md files containing UML / architecture content

# 4. Source code must be in src/
ls $BENNY_HOME/workspaces/c5_test/src/
# Expected: Python/TS/JS source tree

# 5. Check RAG status before running
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     "http://127.0.0.1:8005/api/rag/status?workspace=c5_test"
```

---

## 6. Monitoring the Run

```bash
# Follow execution events in real time (after benny enrich --run)
curl -N \
     -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     -H "Accept: text/event-stream" \
     http://127.0.0.1:8005/api/workflows/execute/<manifest_id>

# Check run history
benny runs ls --workspace c5_test --limit 5
benny runs show <run_id>

# Check CORRELATES_WITH edges were created (Neo4j Browser: http://localhost:7474)
# MATCH (c:Concept)-[r:CORRELATES_WITH]->(e:CodeEntity {workspace: 'c5_test'})
# RETURN c.name, r.confidence, e.name, e.type
# ORDER BY r.confidence DESC LIMIT 25

# Or via API
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     "http://127.0.0.1:8005/api/graph/stats?workspace=c5_test" | jq '.relationship_types'
```

---

## 7. Using the ENRICH Toggle in Studio

Once the pipeline completes:

1. Open Benny Studio in the browser (default: **http://localhost:3000**)
2. Select workspace **c5_test** from the workspace selector
3. Navigate to the **Studio** tab → **Code Graph** view
4. In the **Graph_Commands** panel (right side), click **ENRICH**
   - Button turns amber and label changes to **ENRICHED**
   - The graph re-fetches with Concept nodes and `CORRELATES_WITH` edges included
5. Hover any code symbol — amber dashed lines show which architecture concepts map to it, with confidence percentage

**Visual language**:
- Amber dashed lines = `CORRELATES_WITH` (semantic, from knowledge graph)
- Solid coloured lines = structural edges (`DEFINES`, `DEPENDS_ON`, `INHERITS`)
- Magenta spheres = `Concept` nodes from architecture documents
- Toggle off: `ENRICH` — removes enrichment edges, returns to pure code structure view

---

## 8. Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| `validate_enrichment` fails — zero edges | Check `deep_synthesis` output: did triples get extracted? | Re-run with more permissive model; check `$BENNY_HOME/logs/api.log` |
| Studio shows ENRICHED but no amber lines | `visibleTypes` doesn't include `Concept` | Open Studio settings → re-enable `Concept` in node type filter |
| Low confidence scores (all < 0.3) | Architecture docs may be too abstract | Try `--strategy safe` with `--threshold 0.50`; check that docs reference code symbol names |
| `code_scan` wave fails | Tree-Sitter language support | Ensure Python, TypeScript, or JavaScript parsers are available: `pip show tree-sitter-python` |
| Pipeline re-runs but no new edges | `MERGE` deduplication | This is correct behaviour — edges are idempotent. To force re-correlation: `DELETE CORRELATES_WITH` edges in Neo4j first |
| `rag_ingest: ReadTimeout (no message)` at 360s | Docling on large (>5 MB) PDFs legitimately exceeds 6 min | Fixed in v2.0 manifest — `rag_ingest.execution.request.timeout.read` is now 1800s. If still seen, confirm you're on `--manifest` mode or a post-April-2026 build |
| `deep_synthesis: ReadTimeout (no message)` at 360s | `/api/graph/synthesize` runs a long LLM pass on a fresh graph | Same fix — v2.0 manifest sets `deep_synthesis.execution.request.timeout.read` = 1800s |
| Backend log: `ValueError: too many file descriptors in select()` | Windows default `SelectorEventLoop` caps at ~512 FDs | Fixed — `benny/api/server.py` now forces `WindowsProactorEventLoopPolicy` on `sys.platform == "win32"`. **Requires a full `benny down && benny up` cycle** to pick up. |
| Wave-0 task times out at 30s with `ReadTimeout (no message)` | Prior crashed uvicorn worker leaked FDs; `/pulse` still answers but heavy endpoints stall | Restart the stack: `benny down && benny up`. The CLI now probes `/pulse` on timeout and prints one of two diagnostic messages telling you whether the server is dead or just stuck. |
| Want to rerun without redoing expensive stages | `benny runs ls --workspace c5_test` — find the `run_id` of the partial run | `benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json --workspace c5_test --src src/dangpy --resume <run_id> --run` (see §2.4) |
| Resume reports `0/N tasks reusable` | The prior run folder's `task_*.json` files show non-`done` statuses, or the folder doesn't exist | Verify `$BENNY_HOME/workspace/<ws>/runs/enrich-<run_id>/` exists and contains `task_*.json` files with `status: "done"`. Check `execution.resume.skip_if_status` in the manifest. |

### Force re-correlation (Neo4j Browser)

```cypher
MATCH (c:Concept)-[r:CORRELATES_WITH]->(e:CodeEntity {workspace: 'c5_test'})
DELETE r
```

Then re-run: `benny enrich --workspace c5_test --src src/dangpy --run`

---

## 9. c5_test Specific Notes

c5_test is the primary enrichment experiment workspace:
- **`data_in/staging/`**: UML diagrams and architecture PDFs (9 MB uml-models.pdf, 262 KB Use-Case-Driven-Object.pdf). `pdf_extract` finds them via recursive scan and hands their paths to `rag_ingest`.
- **`src/dangpy`**: Python codebase targeted for code graph analysis (~1800 code nodes after `code_scan`).
- **Recommended command** (declarative + resumable):

```bash
benny enrich \
    --manifest manifests/templates/knowledge_enrichment_pipeline.json \
    --workspace c5_test \
    --src src/dangpy \
    --run
```

If a later wave fails, fix the issue and rerun with `--resume <prior_run_id>` to skip the ~9-minute Docling ingest and the Tree-Sitter scan.

After a successful run, view the enrichment report:
```bash
cat $BENNY_HOME/workspace/c5_test/data_out/enrichment_report.md
```
