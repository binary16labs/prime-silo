# LONGVIEW — run & test guide

Turns months of local agent sessions (Antigravity brain + Claude Code, via the
memo-ray entity store) into a workspace knowledge graph and cited deliverables —
portfolio report, PRD, operator skill, project dossiers, book, TOGAF prep — all
on the local model, for electricity instead of tokens.

- Design: [`architecture/ADR-005-longview-session-synthesis.md`](../../architecture/ADR-005-longview-session-synthesis.md)
- Definition of record: [`manifests/templates/longview_synthesis.json`](../../manifests/templates/longview_synthesis.json)
- Runner internals: [`scripts/longview/README.md`](../../../scripts/longview/README.md)

## Prerequisites

| What | Check |
| ---- | ----- |
| Lemonade on `:13305` with `qwen3.5-9b-FLM` | `curl http://127.0.0.1:13305/api/v1/models` |
| Benny runtime on `:8005` | `curl -H "X-Benny-API-Key: benny-mesh-2026-auth" http://127.0.0.1:8005/api/offload/health` |
| memo-ray checkout sibling of prime-silo | its server running is optional (sync falls back to direct parsers) |
| Node.js on PATH | the runner is Node; `benny longview` shells out to it |

The workspace lives under the **runtime's resolved home** (desktop config →
e.g. `%APPDATA%\space-agent\benny-home\benny\workspaces\longview`), never the
repo. The runner resolves it identically via `packaging/desktop/home_resolver.js`.

## Run from the EXE (v1.9.1+)

No terminal needed — both surfaces call the same launcher and read the same
disk-truth status (runner lock + heartbeat), so runs started anywhere show
everywhere:

- **Tray** — right-click Prime-Silo: `LONGVIEW: idle/running (…)` status line,
  **Run LONGVIEW delta sync**, **Stop LONGVIEW (resume-safe)**, and
  **Open LONGVIEW outputs**.
- **Bridge → Documents** (workspace `longview`) — the **LONGVIEW pipeline**
  panel: *Run delta sync* / *Run full pipeline* / *Stop*, with a live heartbeat
  (phase, cards done/total, failures, ETA) and the last runner log line while
  running. Deliverables appear below in **Outputs**.
- **API** — `POST /api/longview_run {"mode":"delta"|"all"|"<phase>"}`,
  `GET /api/longview_status`, `POST /api/longview_stop`.

The child process logs to `<workspace>/longview/runner.log`; only one runner
per workspace can hold the lock, regardless of launcher.

## Commands (all from `prime-silo/runtime/`)

```powershell
python benny_cli.py longview run                  # all enabled phases, resume-safe
python benny_cli.py longview run --phase map      # one phase (also retries failed cards)
python benny_cli.py longview run --delta          # only new/changed sessions
python benny_cli.py longview status               # heartbeat: phase, counts, ETA
python benny_cli.py longview report               # honest ledger report
```

Phases (declared in the manifest, executed in order):
`inventory` → `extract` → `map` → `model` → `code` → `weave` → `reduce` → `opus` → `pdf`.
Edit the manifest to change model, budgets, batch sizes, `deep_synthesis`,
loop counts, or to disable phases — no code changes.

**Phase isolation (v1.10.1):** a phase that throws is ledgered as a
`phase_error` entry and skipped — the remaining phases still run. (Before this,
an opus outline parse failure killed the whole process and took the pdf phase
with it.) Check `longview report` / the ledger after a full run; a missing
deliverable now always has a ledger entry saying why.

- **code** — junctions the repo into `<workspace>/src/` and runs `benny enrich`
  (Tree-Sitter scan → code graph → `CORRELATES_WITH` links to the knowledge
  concepts). The dual graph is what lets later phases cross-reference decisions
  to the code they shaped.
- **weave** — discovery loops (`weave_loops` × `weave_questions`): the model
  proposes under-explored questions, each is answered from retrieval (vector
  chunks + graph concepts) into a **cited discovery note**, and the notes are
  ingested back — so every loop, and every deliverable after it, stands on a
  richer corpus. This is the compounding "greater than the sum" mechanism.
- **opus** — *The AI Vampire*: a 200+ page narrative-nonfiction book built
  hierarchically (one outline call → per-chapter section specs → ~100
  retrieval-grounded sections of 650–950 words, each cited, each resume-safe
  as a file under `data_out/opus/sections/`). Assembles to
  `data_out/opus/THE-AI-VAMPIRE.md`; partial assemblies are valid previews.
- **pdf** — the assembled book → print-styled HTML → PDF via headless
  Edge/Chrome: `data_out/opus/THE-AI-VAMPIRE.pdf`.

## Book on demand (decoupled from ingestion)

The book does **not** need the model/ingest phase: the opus phase reads
THEMES.md + dossiers from `data_out/` and pulls evidence by retrieval from the
vectors and graph that already exist. Once a corpus is in place, regenerate the
book (and nothing else) with:

```powershell
node scripts/longview/longview.mjs reduce --only dossiers,themes,report   # refresh the foundation (~30-40 min)
node scripts/longview/longview.mjs opus                                   # ~100 sections, resume-safe per section
node scripts/longview/longview.mjs pdf                                    # THE-AI-VAMPIRE.pdf via headless Edge
```

Skip the first command if the foundation is current. Operational rule: **never
run a deep-synthesis ingest concurrently with reduce/opus** — at ~30k concepts
one ingest batch pays a multi-hour clustering pass that wedges Lemonade, and a
wedged model answers the reduce calls with empty bodies (seen live as 0-byte
dossiers; since v1.10.1 those are retried and ledgered `ok:false` instead of
being written over good files).

## Test procedure (small slice first, then the whole)

1. **Pilot the map** — prove the local model produces gated cards:
   ```powershell
   node ../scripts/longview/longview.mjs inventory
   node ../scripts/longview/longview.mjs extract
   node ../scripts/longview/longview.mjs map --limit 5
   python benny_cli.py longview report     # expect cards ok > 0, failures listed by sid
   ```
2. **Prove resume** — Ctrl+C mid-map, rerun the same command: the queue must
   shrink by exactly the already-ledgered sessions.
3. **Prove the graph** — run the model phase, then check Neo4j actually filled
   (Chroma chunks alone are NOT the graph):
   ```powershell
   python benny_cli.py longview run --phase model
   # then: MCP get_graph_stats(workspace="longview"), or Bridge → Documents →
   # knowledge graph. Expect Concept nodes + RELATES_TO / SOURCED_FROM edges.
   ```
4. **Full run** — `python benny_cli.py longview run` and walk away. Reference
   throughput on this box: ~52 cards/hour (map), LLM-per-document synthesis in
   the model phase (~2–5 min/doc), reduce ≈ 30–60 min.
5. **Deliverables** — `workspaces/longview/data_out/`: PORTFOLIO-REPORT.md,
   PRD-WHAT-COMES-NEXT.md, THEMES.md, dossiers/, skills/, book/BOOK.md,
   TOGAF-RUN.md. Every claim should cite session ids — spot-check one against
   `longview/cards/<sid>.json`.
6. **TOGAF SAD over the corpus** — follow `data_out/TOGAF-RUN.md` (human-launched;
   see the TOGAF swarm guide).
7. **Keep it current** — after the backlog: `python benny_cli.py longview run --delta`
   (re-maps only new/changed sessions; reduce re-runs at ≥5 new cards).

## Observability

- `longview/status.json` — written after every card (phase, done/total, ETA).
- `longview/ledger.jsonl` — append-only; `report` reads only this.
- Model-phase ingests and TOGAF swarm runs are **real runtime runs** — Mission
  Control activity feed, `/api/tasks`, `benny runs ls`.
- Deliverables are visible in Bridge → Documents → **Outputs** (v1.9.0+).

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| Graph empty although "ingest ok" | `deep_synthesis` false — must be true in the manifest. A multi-file ingest returning in seconds is the tell (vectors only). |
| Ingest batch "FAILED (fetch failed)" at ~5 min | Pre-v1.9 client waited on the HTTP response; Node kills idle connections at ~5 min. Fixed: the client now fire-and-polls the task record. Server task keeps running either way. |
| Cards fail the gate repeatedly | See `gate_errors` in the ledger; often the session is near-empty. Thin sessions are auto-skipped below `thin_session_chars`. |
| Wrong workspace / files "missing" | Home divergence — the runner resolves the runtime's home via `home_resolver.js`; check the tray Home submenu or `/api/home`. |
| Antigravity sessions missing | memo-ray sync stale — the runner triggers it; check memo-ray server or run its parsers. `antigravity-backup/brain` needs a one-line addition to memo-ray's config to be included. |
| Quality ceiling | Raise Lemonade FLM `ctx_size` to 16384+, then `evidence_budget_chars`/`reduce_input_chars` in the manifest. |
| 0-byte dossiers / empty deliverables | A wedged model (usually a concurrent deep-synthesis ingest) answers 200 with an empty body. v1.10.1: reduce retries once, never overwrites a real file with nothing, ledgers `ok:false`. Restart Lemonade, rerun `reduce --only …`. |
| Full run finished but no book/PDF | Pre-v1.10.1 an opus outline parse failure was fatal to the whole run. Now it's a `phase_error` ledger entry; rerun `--phase opus` then `--phase pdf` (both resume-safe). |
| Documents tab: "Knowledge graph load failed: Maximum call stack size exceeded" | Post-synthesis graphs (~30k concepts) blew the widget's fallback renderer in v1.10.0. Fixed in v1.10.1 — the fallback caps the view at 400 nodes (all Sources + most-connected concepts). |
| Two dossiers for the same project / one overwrites the other | Case-variant project names ("benny"/"Benny") collide on Windows' case-insensitive fs. v1.10.1 merges them under the first-seen spelling. |
