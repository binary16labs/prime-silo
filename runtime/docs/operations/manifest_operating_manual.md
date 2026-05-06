# Manifest Operating Manual

**Plan-then-approve-then-run workflows via a single declarative JSON contract.**

The `SwarmManifest` is the one shape that drives everything: the CLI, the HTTP API, the studio canvas, and the run history. Write it once, share it, replay it, audit it.

---

## Mental Model

```
  requirement ──▶  PLAN  ──▶  SwarmManifest.json  ──▶  RUN  ──▶  RunRecord
                                    │                              │
                                    ├─ copy / paste / share        ├─ status overlay on graph
                                    ├─ renders as xyflow graph     ├─ errors, timings, outputs
                                    └─ checked into git            └─ lineage → Marquez
```

Two phases, always separable:

1. **Plan** — a planner agent expands the requirement into a full DAG of tasks grouped by execution waves. No executor runs. You get a manifest back.
2. **Run** — the executor consumes the manifest and emits a `RunRecord`. One manifest → many runs.

---

## The JSON Contract

A manifest is a Pydantic v2 model with `schema_version = "1.0"` (the general-purpose `SwarmManifest`). Core fields:

| Field             | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `id`              | Stable manifest id (reuse across edits to preserve run history).   |
| `name`            | Human label.                                                       |
| `requirement`     | Original user ask.                                                 |
| `inputs`          | `{files: [...], context: {...}}`.                                  |
| `outputs`         | `{format, word_count_target, sections, spec, files}`.              |
| `config`          | `{workspace, model, max_concurrency, max_depth, allow_swarm}`.     |
| `plan.tasks[]`    | `{id, label, wave, complexity, is_pillar, skill_hint, deps, ...}`. |
| `plan.edges[]`    | `{source, target, kind}`.                                          |
| `plan.waves[]`    | Ordered list of task-id groups (execution waves).                  |
| `plan.ascii_dag`  | Optional human-readable DAG sketch.                                |

A `RunRecord` carries: `run_id`, `manifest_id`, `status`, `started_at`, `duration_ms`, `errors[]`, `node_states{task_id: status}`, `final_document`, `artifact_paths[]`, `governance_url`, optional `manifest_snapshot`.

### Declarative pipeline manifests (`schema_version = "2.0"`)

Some fixed-DAG workflows — currently the knowledge enrichment pipeline — ship with an extended manifest shape that makes the executor fully declarative. These manifests add:

- A top-level **`variables`** map providing defaults for every `${token}` used elsewhere in the file.
- An **`execution`** block that declares the API base URL, auth header, preflight probe, resume policy, and governance toggles.
- A per-task **`execution`** block carrying `kind` (`inspect_and_classify` | `fire_and_poll` | `blocking` | `blocking_with_task_fallback` | `blocking_with_task_list_fallback` | `validate` | `report`), the HTTP contract (`method`, `path`, `body`, `params`, `timeout`), and — for blocking kinds — a `fallback_on_timeout` strategy that consults the server's `task_manager` when the request times out.
- **`inputs_from`** declarations that wire one task's emitted artefacts into another task's request body (e.g. `rag_ingest.inputs_from.pdf_files.source_task = "pdf_extract"`).

Reference template: [`manifests/templates/knowledge_enrichment_pipeline.json`](../../manifests/templates/knowledge_enrichment_pipeline.json). Full usage guide: [`KNOWLEDGE_ENRICHMENT_WORKFLOW.md`](KNOWLEDGE_ENRICHMENT_WORKFLOW.md). Invoked via `benny enrich --manifest <path> --run` (add `--resume <prior_run_id>` to skip already-completed stages).

---

## CLI

Installed via `pyproject.toml` `[project.scripts]` — the `benny` command.

```bash
# Plan a workflow (writes manifest to workspace/manifests/<id>.json by default)
benny plan "Generate a 10k-word market analysis of Cerebras vs Groq vs SambaNova" \
  --input whitepaper_a.pdf -i whitepaper_b.pdf \
  --format md --word-count 10000 \
  --max-concurrency 4 \
  --out ./my_plan.json

# Run a manifest — by file or by id
benny run ./my_plan.json
benny run 0c9e3b7f-...

# List past runs (optionally filtered)
benny runs ls --manifest 0c9e3b7f-...
benny runs show <run_id>

# List saved manifests
benny manifests ls
```

`benny plan` takes `--requirement` / positional, plus: `--workspace`, `--model`, `--spec`, `--max-depth`, `--name`, `--no-save`.

`benny run` accepts either a path to a manifest.json OR a manifest id in the workspace store.

---

## HTTP API

All routes mounted at `/api`. Every request must include:

```
X-Benny-API-Key: benny-mesh-2026-auth
```

| Method | Path                               | Purpose                                           |
| ------ | ---------------------------------- | ------------------------------------------------- |
| POST   | `/api/manifests/plan`              | Plan-only. Returns `SwarmManifest`.               |
| POST   | `/api/manifests`                   | Upsert a manifest (full JSON).                    |
| GET    | `/api/manifests`                   | List manifests.                                   |
| GET    | `/api/manifests/{id}`              | Fetch one.                                        |
| DELETE | `/api/manifests/{id}`              | Remove.                                           |
| POST   | `/api/manifests/{id}/run`          | Run in background. Returns `{run_id}`.            |
| POST   | `/api/manifests/run`               | Inline run from a posted manifest (no save).      |
| GET    | `/api/manifests/runs`              | All runs.                                         |
| GET    | `/api/manifests/{id}/runs`         | Runs for one manifest.                            |
| GET    | `/api/runs/{run_id}`               | Full `RunRecord`.                                 |
| POST   | `/api/manifests/trigger-check`     | `{consider_swarm, reason}` for a chat message.    |

`/api/chat/query` responses now include `consider_swarm: bool` and `swarm_reason: string | null` — agents / UIs should surface this so the user can promote a chat into a planned workflow.

---

## UI (Studio v2)

The floating **PLAN** and **RUNS** pills live in the GodMode HUD.

- **PLAN** opens `ManifestPlanner`: left form → describe requirement, inputs, target word count, format → *Plan workflow* → right pane shows the DAG as an xyflow graph, the raw JSON (copy-pasteable), and the ASCII DAG. **Run** sends it to the background runner; **Download** saves `manifest.json`.
- **RUNS** opens `RunsPanel`: pick a run to see its graph with live per-task status overlay (pending/running/completed/failed/skipped colored borders), errors, governance link, and truncated final output.

The graph uses the same `manifestToCanvas()` projection in both panels — there is only one renderer, only one layout.

---

## Swarm-Trigger Heuristic

`benny.core.manifest.should_trigger_swarm(message, input_files, output_spec)` returns `(bool, reason)`.

Fires when any of:

- `output.word_count_target >= 1500`
- `len(input_files) >= 3`
- `len(message) > 1200`
- `>= 2` long-form keyword hits: `report, book, thesis, whitepaper, deep dive, comprehensive, dossier, codebase, refactor, migration plan, rfc, spec, analysis, audit`

Chat endpoint calls this and sets `consider_swarm` on the response. The UI should prompt the user: *"this looks swarm-sized, open the planner?"*

---

## File Layout

```
workspace/
  manifests/
    <manifest_id>.json         # canonical plan JSON
    runs/
      <run_id>.json            # RunRecord, includes manifest_snapshot
```

`workspace` defaults to the project root; override with `--workspace` on the CLI or `config.workspace` in the manifest.

Source map:

| Concern               | File                                                   |
| --------------------- | ------------------------------------------------------ |
| Schema                | `benny/core/manifest.py`                               |
| Persistence           | `benny/persistence/run_store.py`                       |
| Planner + executor    | `benny/graph/manifest_runner.py`                       |
| HTTP routes           | `benny/api/manifest_routes.py`                         |
| CLI                   | `benny_cli.py`                                         |
| Chat trigger          | `benny/api/chat_routes.py`                             |
| UI types + layout     | `frontend/src/types/manifest.ts`                       |
| UI state              | `frontend/src/hooks/slices/manifestSlice.ts`           |
| Planner panel         | `frontend/src/components/Studio/ManifestPlanner.tsx`   |
| Graph renderer        | `frontend/src/components/Studio/ManifestCanvas.tsx`    |
| Runs panel            | `frontend/src/components/Studio/RunsPanel.tsx`         |

---

## Common Playbooks

**Long-form report (10k words from PDFs):**

1. `benny plan "Summarize attached whitepapers into a 10k-word competitive analysis" -i a.pdf -i b.pdf --word-count 10000 --format md --out report.json`
2. Inspect `report.json` — edit `plan.tasks` if you want to rename/reorder.
3. `benny run report.json` → note the `run_id`.
4. `benny runs show <run_id>` to see output and artifact paths.

**Share a workflow with a teammate:**

Commit the `*.json` to git. They run `benny run <file>` — same `id`, their runs append to history if they share the same workspace.

**Replay an old run with tweaks:**

1. `benny runs show <run_id>` and save the embedded `manifest_snapshot`.
2. Edit.
3. `benny run edited.json`.

---

## Example Manifests

The swarm can be driven by predefined JSON manifests for common workflows. You can find these in the `docs/operations/examples/` directory:

- **[Codebase Audit](file:///c:/Users/nsdha/OneDrive/code/benny/docs/operations/examples/codebase_audit.json)**: Deep-dive security and architecture analysis.
- **[Documentation Wiki](file:///c:/Users/nsdha/OneDrive/code/benny/docs/operations/examples/documentation_swarm.json)**: Automated generation of dev onboarding wikis.
- **[Market Research](file:///c:/Users/nsdha/OneDrive/code/benny/docs/operations/examples/market_research.json)**: High-concurrency competitor analysis across multiple documents.

To run an example:
```bash
benny run docs/operations/examples/codebase_audit.json
```

---

## Troubleshooting

| Symptom                                 | Check                                                                 |
| --------------------------------------- | --------------------------------------------------------------------- |
| `401` / `403` from API                  | Missing `X-Benny-API-Key` header.                                     |
| `benny: command not found`              | `pip install -e .` hasn't been run against the current env.           |
| Plan endpoint returns empty tasks       | Model unreachable — check `config.model` and local LLM process.       |
| Run completes instantly with no errors  | Manifest has zero tasks in `plan.waves` — re-plan with more detail.   |
| UI canvas shows but nodes overlap       | Many tasks in one wave; layout is row-stacked — widen window.         |
| `consider_swarm` always false on chat   | Message is too short or output spec absent — set `word_count_target`. |

---

## Invariants

- **One contract.** Everything serializes to / from `SwarmManifest`. Don't grow parallel shapes.
- **Plan ≠ Run.** Planning must be side-effect free. Only `execute_manifest` writes `RunRecord`s.
- **Runs are append-only.** Never mutate a `RunRecord` after terminal status.
- **Manifest id is stable.** Editing a manifest keeps its id so history accumulates; a rename is not a new manifest.
