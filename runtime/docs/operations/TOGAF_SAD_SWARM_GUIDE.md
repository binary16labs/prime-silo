# TOGAF SAD report swarm — run guide

Generates a TOGAF-compliant System Architecture Document (SAD) with a bounded
6-task swarm on the local model: planner → baseline analyst (queries the
workspace knowledge graph) → target architect → gap/impact analyst → viewpoint
designer → publishing editor.

Manifests (in `manifests/templates/`):

| Manifest | Scope |
| -------- | ----- |
| `togaf_sad_report_swarm.json` | Single-topic SAD (the default) |
| `togaf_plus_sad_report_swarm.json` | SAD + extended viewpoints |
| `togaf_enterprise_sad_report_swarm.json` | Enterprise-wide framing |

## Run

```powershell
cd prime-silo/runtime
python benny_cli.py run manifests/templates/togaf_sad_report_swarm.json --json ^
  --var workspace=<ws> ^
  --var topic="<what the SAD is about>" ^
  --var model=lemonade/qwen3.5-9b-FLM ^
  --var output_file=data_out/TOGAF_SAD_<name>.md
```

Track it like any run: `benny runs ls`, Mission Control activity feed, or the
run's SSE event stream. Output lands in `workspaces/<ws>/data_out/`.

## The two lessons baked into this design (do not undo them)

1. **Fixed 6-task template, never a planner-generated fan-out.** A planner once
   expanded this into 45 tasks with a 267 MB variable explosion — the 38-minute
   wedge. Bounded task count with sliding-window editorial refinement is the fix.
2. **`${model}` must resolve.** Pass `--var model=...` (or keep the manifest
   default); an unresolved `${model}` fails the run instantly.

## Best input: a populated knowledge graph

`baseline_extraction` queries the workspace graph (`query_graph`) — the SAD is
only as good as what's been ingested. Two strong feeds:

- **Documents**: ingest PDFs/markdown with deep synthesis (Bridge → Documents →
  Ingest, or `/api/rag/ingest` with `deep_synthesis: true`).
- **LONGVIEW corpus**: after a LONGVIEW run, the `longview` workspace holds the
  session-card graph — run this swarm with `--var workspace=longview` and a
  topic like "The binary16 application estate" (the exact command is written to
  `data_out/TOGAF-RUN.md` by the LONGVIEW reduce phase). See
  [LONGVIEW_GUIDE.md](LONGVIEW_GUIDE.md).

## Verify

- `benny runs ls` shows the run completed; inspect stages with `benny runs show <run_id>`.
- The output file exists, is near `word_count_target`, and its Baseline section
  reflects graph content (spot-check a claim against the graph or source docs).
