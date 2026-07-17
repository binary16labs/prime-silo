# TOGAF SAD over the binary16 estate — validated runbook (2026-07-16)

Human-launched per ADR-001. Every claim below was verified against the code,
not the old `TOGAF-RUN.md` doc (whose command does not run: `benny run` has no
`--var` flag — only `--workspace` / `--model` / `--json`).

## What was prepared

1. **`manifests/templates/togaf_sad_prime_silo.json`** — additive copy of the
   TOGAF SAD swarm with variables baked in (workspace `sessions_v1`, model
   `lmstudio/google/gemma-4-12b`, output `data_out/TOGAF_SAD_binary16.md`) and a
   rewritten `baseline_extraction` task that queries BOTH graphs (LONGVIEW KG +
   Tree-sitter code graph + `CORRELATES_WITH` overlay) and flags
   claimed-vs-observed divergence. Validated through `_load_manifest` — passes
   schema, no unresolved tokens. Original template untouched.
2. **`<benny-home>/workspaces/sessions_v1/.gitignore`** — scan-scope excludes
   read by `CodeGraphAnalyzer._load_ignore_patterns` (workspace-root
   `.gitignore`). Keeps the AST scan out of `archive/`, `scratch/`,
   `agent_sandbox/`, `.claude/` (worktree clones!), `home/`, `workspace/`,
   `memoray/`, the `Usersnsdha...benny-home` duplicate tree, `vendor/`,
   `*.min.js`. Without this, symbols would appear 2–3× (worktrees + vendored
   copies) and poison correlation.
3. `sessions_v1/src/prime-silo` is already a symlink to the repo (verified) —
   no copying needed. `os.walk` follows it because it is the scan root itself.

## Verified environment facts

- **BENNY_HOME resolves to** `C:\Users\nsdha\AppData\Roaming\space-agent\benny-home\benny`
  (checked live via `resolve_benny_home()`). The `runtime/workspace/sessions_v1`
  dir is a decoy — contains only `runs/`.
- **Neo4j is DOWN** (`ServiceUnavailable` on :7687). Must start it first.
- **LM Studio LAN box** `192.168.68.125:1234` is up, serves exactly
  `google/gemma-4-12b`, **and its embeddings endpoint works**: probed live,
  `model=default` JIT-resolves to `nomic-ai/text-embedding-nomic-embed-text-v1.5`,
  768-dim real vectors (NOT the broken cstr/ fork this time).
- **The LAN IP exists in no config anywhere** — the `lmstudio` provider
  hardcodes `localhost:1234`, where nothing listens. The endpoint-pool env var
  below is mandatory, or every model call dies.

## Launch sequence (PowerShell)

```powershell
# 0. Environment — every step below needs these in the SAME shell
$env:BENNY_HOME = "$env:APPDATA\space-agent\benny-home\benny"
$env:BENNY_LMSTUDIO_ENDPOINTS = "http://192.168.68.125:1234/v1"

cd C:\Users\nsdha\OneDrive\binary16\prime-silo\runtime

# 1. Bring Neo4j up (only neo4j needed; API/UI optional for a CLI run)
python benny_cli.py up --home $env:BENNY_HOME --only neo4j

# 2. Sanity: graph reachable + LONGVIEW KG present in sessions_v1
#    DONE 2026-07-16: concepts=16169, sources=188, code files=0 (pre-enrich).
#    NOTE the backtick before $workspace — PowerShell escaping, not bash \$.
python -c "from benny.core.graph_db import run_cypher; print(run_cypher('MATCH (c:Concept {workspace: `$workspace}) RETURN count(c) AS concepts', workspace='sessions_v1'))"

# 2b. Start the Benny API server on :8005 — enrich drives everything through it.
#     Gotchas discovered live (2026-07-16):
#       * the enrich manifest's variables.api_base HARDCODES :8005 and the
#         manifest override beats BENNY_API_URL (benny_cli.py:433) — and 8005 is
#         the desktop-supervisor convention (DEFAULT_API_PORT), while portable
#         `up --only api` serves :8000. So do NOT use `up` for the api here;
#         launch uvicorn directly on 8005 to match the manifest.
#       * uvicorn must run with the runtime dir importable → PYTHONPATH + -WorkingDirectory;
#       * the server inherits YOUR shell env at spawn — BENNY_LMSTUDIO_ENDPOINTS
#         must be set BEFORE this, since the server makes the LLM/embed calls.
$env:PYTHONPATH = "C:\Users\nsdha\OneDrive\binary16\prime-silo\runtime"
Start-Process python -WindowStyle Minimized -WorkingDirectory "C:\Users\nsdha\OneDrive\binary16\prime-silo\runtime" `
  -ArgumentList '-m','uvicorn','benny.api.server:app','--host','127.0.0.1','--port','8005'
# give it ~10s, then verify:
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:8005/api/system/pulse

# 3. Build the code graph + CORRELATES_WITH overlay (the AST ingest).
#    Declarative manifest form; ~long-running (embedding pass is the long pole).
python benny_cli.py enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json `
  --workspace sessions_v1 --src src/prime-silo `
  --model lmstudio/google/gemma-4-12b --run

# 3-RECOVERY (2026-07-16, after the first enrich attempt "failed"): the run's
# 90s client timeouts fired, but the server-side Tree-sitter scan KEPT RUNNING
# and wrote snapshot 9abe723c (13k+ entities, .gitignore scoping worked — half
# the size of the unscoped Jul-14 scans). Facts learned:
#   * cmd_enrich ALWAYS executes its hardcoded 7-task plan; a declarative
#     manifest only overlays timeouts/endpoints — you cannot trim tasks via
#     --manifest. Do NOT rerun the full enrich (it would re-scan into a 4th
#     snapshot while racing nothing useful).
#   * The Jul-14 snapshots (f1b388be…, 9b5c9957…) have NO CODE_REL edges —
#     their saves were killed early too. They are stale duplicates; delete
#     before correlating or every symbol matches 2-3x:
#     MATCH (e:CodeEntity) WHERE e.snapshot_id IN ['f1b388be-c78a-47fd-9329-d0a87f566111','9b5c9957-19b3-45d4-9240-120c67348633'] DETACH DELETE e
#   * DONE 2026-07-16 late: scan save completed at 772k nodes (packaging/
#     runtime-bundle/site = 667k — a full Python site-packages the excludes
#     missed, plus root-level .worktrees/). Root cause of the 3-nodes/s crawl:
#     CodeEntity had NO index — created code_entity_merge + code_entity_snap,
#     write rate went 2.9 -> 886 nodes/s. Cleanup executed (user-approved):
#     junk entities + both Jul-14 snapshots + orphaned concepts deleted.
#     Final state: snapshot 9abe723c = 33,402 real nodes, 33,674 CODE_REL,
#     concepts 23,080 (16,169 LONGVIEW + real code names). .gitignore now
#     also excludes .worktrees/ and packaging/runtime-bundle/.
#   * Correlation is ONE deterministic endpoint — run it directly:
#     $key = (Get-Content "$env:BENNY_HOME\state\hmac-key" -Raw).Trim()
#     curl.exe -s -m 3600 -X POST "http://127.0.0.1:8005/api/rag/correlate?workspace=sessions_v1&threshold=0.82&top_k=32&use_ann=true" -H "X-Benny-API-Key: $key"

# 3a. HONESTY CHECK after enrich — the embed path silently returns [0.0]*768
#     on failure, which yields garbage correlations with no error. Verify:
# NOTE: workspace lives on the edge ENDPOINTS, not the relationship — a
# `WHERE r.workspace` filter silently returns 0 (found the hard way).
python -c "from benny.core.graph_db import run_cypher; print(run_cypher('MATCH (a:Concept)-[r:CORRELATES_WITH]->(b:CodeEntity) WHERE a.workspace = `$workspace RETURN count(r) AS edges, avg(r.confidence) AS avg_conf', workspace='sessions_v1'))"
#     edges == 0 or avg_conf near 0/1.0 uniformly -> embeddings were zeros; stop and check
#     the LM Studio embeddings endpoint before wasting a SAD run.

# 4. The TOGAF run (variables are baked into the new template; no flags needed)
python benny_cli.py run manifests/templates/togaf_sad_prime_silo.json --json

# Output lands at:
#   $env:BENNY_HOME\workspaces\sessions_v1\data_out\TOGAF_SAD_binary16.md
```

To change topic/output later: edit the `variables` block in the template (CLI
can only override `workspace` and `model`).

## Observability — watching the TOGAF run (Marquez-free OpenLineage)

The swarm already writes REAL OpenLineage RunEvents (spec 1-0-5) to the
integrity-hashed governance ledger — no Marquez container needed. New
dashboard integration (2026-07-16, additive):

- **Dashboard**: `bash scratch/longview_run/dashboard/dash.sh` →
  **http://127.0.0.1:8788/lineage.html** → "Runtime swarm runs · TOGAF SAD &
  report swarms" tile: LIVE banner (elapsed + per-task states) when a run is
  in flight, execution register (every swarm run: manifest, model, workspace,
  status, duration, artifacts/errors), and a "⬇ OpenLineage (runtime)"
  download (`openlineage_runtime.json`). Refreshes every 15s via the
  collector loop. Stale zombie records (running >6h, e.g. killed CLI) are
  badged `stale`, never shown as live.
- **Sources of truth** (what the tile derives from, deterministically):
  - `runtime/workspace/governance.log` — OL RunEvents (workflow START/
    COMPLETE/FAIL + tool executions) + ENRICH_TASK_* events
  - `runtime/workspace/manifests/runs/<run_id>.json` — RunRecord (status,
    node_states, duration, artifacts). NOTE: repo-relative, NOT $BENNY_HOME.
  - `runtime/workspace/manifests/<id>.json` — the DAG as authored
- **Console** — `benny run` prints each wave; `--json` dumps the RunRecord.
- **CLI register** — `python benny_cli.py runs ls --limit 5` / `runs show <id>`.
- **LM Studio server log** on 192.168.68.125 — ground truth for "is the model
  actually generating right now".
- **Phoenix (optional LLM telemetry)** — per-call OTel traces if Phoenix runs
  at :6006 (`PHOENIX_URL`); benny/governance/tracing.py registers lazily.
- Files: `runtime_lineage.mjs` (derivation), wired in `collect.mjs`
  (runtime_lineage key + openlineage_runtime.json), rendered in `lineage.html`.

## Phase 2 — TOGAF EPIC SAD (deterministic diagrams-as-code + swarm narrative)

One CLI, repeatable, evidence-grounded (2026-07-17). The Phase-1 lesson inverted:
diagrams are GENERATED from disk/graph truth; the swarm only narrates.

```powershell
cd C:\Users\nsdha\OneDrive\binary16\prime-silo\runtime
$env:BENNY_HOME = "$env:APPDATA\space-agent\benny-home\benny"
$env:BENNY_LMSTUDIO_ENDPOINTS = "http://192.168.68.125:1234/v1"
$env:BENNY_DEFAULT_MODEL = "lmstudio/google/gemma-4-12b"

# deterministic build (~60s): probe + evidence + 10 mermaid diagrams + assemble
python scripts\togaf_epic.py --workspace sessions_v1

# full epic (adds the 19-task narrative swarm first; the long pole)
python scripts\togaf_epic.py --workspace sessions_v1 --run-swarm

# or weave an existing narrative
python scripts\togaf_epic.py --workspace sessions_v1 --narrative <path.md>
```

- Output: `<BENNY_HOME>\workspaces\sessions_v1\data_out\TOGAF_EPIC_SAD_binary16.md`
  + evidence pack (`togaf_epic_evidence/*.json` — hardware, models, deps,
  graph schema, code stats, lifecycle).
- Diagrams as code (all mermaid, all from evidence): C4 context/container,
  use-case, BPMN-style pipeline, class (top classes by real method count),
  sequence (from the real run's AER events), ER (real edge counts), data
  conceptual/logical/physical (real property keys + measured store sizes),
  deployment topology (probed CPU/NPU/GPU/RAM + LAN host probe).
- Hardware: probed laptop (Ryzen AI NPU) vs LAN eGPU host; declared test
  matrix in `scripts/togaf_epic_declared_hardware.json` (create/edit to
  declare rigs — kept separate from probes for honesty). Models-tested table
  comes from run records (real durations).
- Observability: the build emits TASK_METADATA_UPDATE events → it appears in
  the :8788/lineage.html register like any swarm run, with live step-through.
- Narrative manifest: `manifests/templates/togaf_epic_sad_swarm.json`
  (19 personas, LM Studio baked, dual-evidence rules in graph-touching tasks).

## Known residual risks

- `benny enrich --resume <run_id>` exists if the enrich run wedges partway.
- If enrich's embed provider resolves to `lemonade` instead of `lmstudio`
  (it derives provider from the active/graph_synthesis model, not always the
  CLI flag), local lemonade at :13305 is alive and can serve embeds — but it
  has wedged before. The step-3a check catches either failure mode.
- gemma-4-12b context: the baseline task now instructs LIMITed Cypher queries,
  but a very chatty `query_graph` result can still blow the window; if wave 1
  loops, lower the LIMITs in the template.
