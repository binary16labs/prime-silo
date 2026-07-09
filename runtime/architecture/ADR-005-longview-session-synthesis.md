# ADR-005: LONGVIEW — Long-Horizon Session Synthesis on the Local Model

| Field   | Value                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| Status  | Proposed (pilot verified against live Lemonade — see §10)                                  |
| Date    | 2026-07-02                                                                                 |
| Authors | Binary 16 (engineering authority)                                                          |
| Related | ADR-004 (offload orchestrator), ADR-001 (determinism boundary), memo-ray entity store,     |
|         | `manifests/templates/togaf_sad_report_swarm.json`, memo-ray token-audit (honesty lesson)   |

---

## Addendum (2026-07-09, v1.15.0) — deterministic graph phase (longview_v2)

The `model` phase's `deep_synthesis` runs a second LLM pass to re-extract triples
from each card's prose. Since the `map` phase already distils every session into
structured entity arrays (`concepts[]`, `applications[]`, `capabilities[]`,
`skills_observed[]`), that re-extraction is redundant. A new **`graph`** phase maps
those arrays **deterministically** into the identical `Source`/`Concept`/`RELATES_TO`/
`SOURCED_FROM` schema — no model call, ~0.4 s/card vs ~60-120 s/card — then a
vectors-only ingest keeps retrieval, and `enrich` merges duplicate concepts across
cards into shared hubs. Provenance stays auditable (`confidence=1.0`,
`strategy="structured-fragment"`). This does not replace the map-reduce design; it
removes the one redundant LLM pass and adds an earned-ETA transparency layer
(`<workspace>/longview/progress.json`). Code: `scripts/longview/lib/card_triples.mjs`,
`scripts/longview/lib/eta.mjs`, route `POST /rag/graph-upsert`. `model`
(deep_synthesis) is retained as an opt-in fallback for when link discovery beyond the
fragments is wanted.

---

## 1. Problem

Nine months of agent-assisted work is sitting in local session stores, unread:

- **Antigravity**: `~/.gemini/antigravity/brain/<uuid>/` — 111 live session dirs
  (+104 more in `antigravity-backup/`), each with `task.md`,
  `implementation_plan.md`, `walkthrough.md` artifacts; 6 have full
  `transcript.jsonl`; conversations themselves are protobuf (unparsed).
- **Claude Code**: `~/.claude/projects/**/*.jsonl` — 36 transcript files, 103 MB.
- **opencode / open-notebook**: parsers exist in memo-ray; volume TBD.

That history encodes what applications exist, what capabilities were built, what
the operator is actually trying to achieve, and what should come next — but no
one can read 400+ sessions. A cloud model could, at meaningful cost; the local
model (Lemonade, `qwen3.5-9b-FLM`) can do it for free **if the workflow tolerates
slow token rates, survives restarts, and never asks the planner to read the bulk
output back** (the ADR-004 insight).

Two operating modes are required:

1. **Backlog** — a long-running, leave-it-overnight pass over everything.
2. **Delta** — after the backlog is cleared, an incremental pass that only
   touches sessions new or changed since the last run, so the picture stays
   current at near-zero cost.

## 2. Decision

A **map-reduce synthesis pipeline** over the **memo-ray entity store**, executed
by the local model in a **dedicated Benny workspace** (`longview`), with a
**checkpointed ledger** for resume, a **deterministic gate** for card quality,
and deliverables generated as **bounded swarm manifests** (the 6-task TOGAF
lesson) or direct reduce passes.

```
                          ┌─────────────────────────────────────────────────┐
                          │ $BENNY_HOME/workspaces/longview                 │
  A INVENTORY             │                                                 │
  memo-ray sync ───────►  │ longview/inventory.json                         │
  (Claude+Antigravity     │                                                 │
   parsers, watermarks)   │                                                 │
                          │                                                 │
  B EXTRACT (determin.)   │ longview/evidence/<sid>.md   (≤12 KB packs)     │
                          │                                                 │
  C MAP (qwen3.5-9b) ──►  │ longview/cards/<sid>.json    session cards      │
  gate: schema+grounding  │ longview/ledger.jsonl        (resume + honesty) │
  1 retry, fail≠block     │ longview/status.json         (live heartbeat)   │
                          │                                                 │
  D MODEL (determin. +    │ data_in/*.md → /rag/ingest → knowledge graph    │
    Benny ingest)         │ longview/rollups/{projects,capabilities}.json   │
                          │                                                 │
  E REDUCE (qwen3.5-9b    │ data_out/report/  PORTFOLIO-REPORT.md           │
    + Benny swarm)        │ data_out/prd/     PRD-WHAT-COMES-NEXT.md        │
                          │ data_out/skills/  SKILL drafts                  │
                          │ data_out/book/    chaptered narrative           │
                          │ data_out/TOGAF_SAD_binary16.md (swarm manifest) │
                          │                                                 │
  F DELTA                 │ ledger done-set + memo-ray watermarks           │
                          └─────────────────────────────────────────────────┘
```

## 3. Why the memo-ray entity store is the seam

memo-ray (standalone, `binary16/memo-ray`) already normalizes every agent's
sessions into one entity model — `Session → {User Input, Thought, Tool Call,
Tool Result, Artifact}` with parent/child edges — via four parsers
(`claudeParser`, `antigravityParser`, `opencodeParser`, `openNotebookParser`),
a config contract for every store location, **and per-agent sync watermarks**
(`claude_last_sync_timestamp`, `antigravity_last_sync_timestamp`). Its MCP
server exposes `get_recent_sessions` / `get_session_timeline` for interactive
use.

LONGVIEW therefore does **no session parsing of its own**. Phase A triggers a
memo-ray sync (HTTP `/api/sync` when the server is up, direct parser invocation
otherwise) and reads the entity store from disk. Adding a fifth agent later is
a memo-ray parser, not a LONGVIEW change. The 4-seam audit pattern is preserved.

Known gap (accepted for v1): `antigravity-backup/brain` is not in memo-ray's
`ANTIGRAVITY_BRAIN_DIRS`; adding it is a one-line config change when the operator
wants the pre-backup history included.

## 4. Why MAP is a purpose-built loop, not ADR-004 offload tasks

The natural instinct is one `aamp.offload_task/1` per session. Rejected for the
bulk lane, for measured reasons:

- **Judge miscalibration on prose.** The offload gate upgrades every `generate`
  task to yellow and requires an LLM judge. Per `JUDGE-CALIBRATION.md`, small
  local judges are unreliable on prose (the 0.5B rubber-stamps, Phi-4-mini
  safely escalates good work). 400 yellow tasks ⇒ hundreds of false
  escalations — the planner becomes the bottleneck, defeating the point.
- **Card acceptance is deterministically checkable.** A session card is valid
  iff it is parseable JSON matching the card schema, within length bounds, and
  grounded (cites the session's own artifact names / project). No judgment call
  ⇒ by ADR-004's own routing rule this is **green-tier work** — the LLM judge
  adds latency, not safety.
- **Fan-out fragility.** The TOGAF report-swarm failure (45-task planner blowup,
  267 MB variable explosion, the 38-minute wedge) established: **never put an
  unbounded fan-out inside one manifest run**. 400 sessions is exactly that.

So the MAP loop is a standalone runner (`scripts/longview/`) that calls Lemonade
directly (`http://127.0.0.1:13305/api/v1`, same host Benny's `resolve_executor`
uses), applies its own deterministic gate, and keeps ADR-004's *disciplines* —
compact contract in, verbose output absorbed locally, digest + append-only
ledger out. The offload lane remains the right vehicle for code-shaped follow-up
tasks the deliverables propose.

**The pipeline is still manifest-defined and CLI-managed.** The definition of
record is `manifests/templates/longview_synthesis.json` (variables + a plan
whose tasks are the five *phases*, not the sessions), executed by
`longview.mjs run` and wrapped as `benny longview run|status|report`. This
gives declarative review/edit and CLI management without recreating the
fan-out-in-manifest failure: the swarm executor has no shell step kind, and the
tasks API has no external run-registration surface, so the map loop's tracking
stays in its own ledger/status.json while runtime-executed steps (ingestion,
TOGAF swarm) appear in run history as real runs. A `/api/longview` route that
registers the whole manifest run in `run_store` is the identified follow-up if
full `benny runs ls` coverage is wanted.

The REDUCE phase is the opposite: **bounded** (one dossier per project,
~15 projects; one 6-task TOGAF swarm) — so deliverable synthesis reuses the
existing swarm manifests where they fit, which also buys EventBus/Mission
Control observability for those runs.

## 5. The card schema (the unit of everything)

`longview/cards/<sid>.json`, gate-enforced:

```json
{
  "session_id": "…", "agent": "Antigravity|Claude", "project": "…",
  "period": "2026-03", "intent": "what the operator was trying to do",
  "applications": ["memo-ray", …], "capabilities": ["RAG ingestion", …],
  "decisions": ["…"], "outcomes": ["…"], "failures": ["…"],
  "skills_observed": ["…"], "operator_traits": ["insists on measured claims"],
  "open_threads": ["…"], "proposed_next": ["…"],
  "evidence": ["task.md", "walkthrough.md"]
}
```

Every downstream artifact (dossier, theme, report section, PRD item, book
chapter, skill) must cite `session_id`s from the cards it draws on. That is the
grounding chain: **deliverable → dossier → card → evidence pack → raw session**.
Claims stay checkable; the memo-ray token-audit lesson applied to prose.

## 6. Greater than the sum — the actual mechanism

Three composition effects, deliberately engineered rather than hoped for:

1. **Vertical (the ladder).** Each rung reads only the rung below (evidence →
   card → dossier → theme). The local model never sees more than one bounded
   context at a time — that's what makes 400 sessions tractable on 9B — yet the
   top rung is conditioned on *all* of them transitively, with citations.
2. **Horizontal (the graph).** Cards are ingested into the workspace knowledge
   graph (`/rag/ingest`, deep synthesis on). Concepts recur *across* projects
   ("manifest signing" in prime-silo AND memo-ray AND voicebox), and
   `CORRELATES_WITH` enrichment links them — surfacing cross-project themes no
   single session contains. The TOGAF swarm's `baseline_extraction` step then
   queries this graph, so the SAD's baseline is the synthesized estate, not one
   repo.
3. **Temporal (the arc).** Cards carry `period`; rollups order intents and
   outcomes over 9 months, exposing trajectory (what was abandoned, what
   compounds). The book's chapter structure and the PRD's "what comes next" both
   read the arc, not snapshots.

## 7. Observability (honest, three instruments)

- **`longview/status.json`** — heartbeat: phase, done/total, failures, current
  session, cards/hour, ETA. Written after every card; poll it, or `longview.mjs
  status` pretty-prints it.
- **`longview/ledger.jsonl`** — append-only per-session record: timings, prompt
  and completion token counts, gate verdict, retries. `longview.mjs report`
  reads *only* the ledger and reports throughput and quality rates. No number is
  reported that the ledger cannot substantiate.
- **Benny runtime feeds** — Phase D ingestion and Phase E swarm runs execute in
  the runtime ⇒ they appear in the EventBus activity feed (Bridge chip /
  Mission Control) and run history like any other run. The MAP loop itself does
  not emit EventBus events in v1 (the bus has no external publish surface);
  status.json is its feed. Adding a `/api/activity/publish` seam is future work.

## 8. Modes

- **Backlog**: `node scripts/longview/longview.mjs all` — phases A→E, resume-safe
  at card granularity (kill it anytime; done-set lives in the ledger).
- **Delta**: `node scripts/longview/longview.mjs delta` — memo-ray sync, then
  MAP only sessions absent from the done-set or with `timestamp` newer than
  their card; rollups recomputed (cheap, deterministic); REDUCE re-run only when
  `--refresh` or new-card count ≥ threshold (default 5). Suitable for a
  scheduled task or tray timer once the backlog is cleared.

## 9. ADR-001 boundary

Everything LONGVIEW writes lives in `$BENNY_HOME/workspaces/longview/` (scratch,
`data_in`, `data_out`) — never L1/L2/`manifests/`. Skill drafts and the PRD are
**proposals in `data_out/`**; promoting any of them into the repo, `manifests/`,
or `~/.claude/skills` remains a human step. The TOGAF swarm manifest is executed
by the operator (`benny run`), not by an agent.

## 10. Status / verification

**Pilot results (2026-07-02, live Lemonade `qwen3.5-9b-FLM` on NPU, ledger-sourced):**

- MAP: 8 sessions processed → **4 cards ok, 0 gate failures, 4 skipped_thin**.
  144s cold (model load), 54–116s warm; median 77s ⇒ **~44 cards/hour**,
  extrapolated **≈2.8 h** for the remaining 122-session backlog.
- Resume verified: second `map` invocation queued only unprocessed sessions.
- MODEL: 4 card docs ingested via `/rag/ingest` (runtime run `16fe485c`,
  visible in run history) → 40 chunks / 4 documents in the `longview`
  collection; semantic `/rag/query` returns relevant cited chunks.
- REDUCE: 2 project dossiers + THEMES.md + operator SKILL.md generated, all
  citing session ids that trace back to real cards.
- Found & fixed during pilot: the running runtime resolves `$BENNY_HOME` via
  the desktop config (`%APPDATA%\space-agent\benny-home\benny`), not the repo
  `.benny_home` — `lib/config.mjs` now uses `packaging/desktop/home_resolver.js`;
  ingestion state tracked explicitly (render ≠ ingest); FLM `ctx_size 4096`
  caps evidence packs (7500 chars) and reduce inputs (8500 chars) — raising the
  ctx and the budgets together is the highest-leverage quality knob.
**Full backlog run (2026-07-02, operator-launched, ledger-sourced):** 130
sessions → **55 cards ok / 12 map-failed / 63 thin**, 51.9 cards/hour, 17
projects, 34 reduce artifacts (report, PRD, skill, dossiers, book, themes).

**Graph-ingestion defect found by the operator and fixed:** `/rag/ingest`
defaults `deep_synthesis: false`, and the model phase didn't set it — so all 55
cards landed in Chroma (550 chunks) while the Neo4j graph stayed **empty** (the
6-second "ingest" of 25 files was the tell). Fix: the manifest declares
`deep_synthesis: true` + `ingest_model`; batches shrink to 5 with a 30-min
timeout; re-ingest is idempotent (per-source vector delete before re-add).

- **Still unverified:** deliverable quality at full corpus size; delta-mode
  cadence; map-failure retry yield (12 sids listed by `report`). The ledger
  remains the instrument.

## 11. Consequences

- 9 months of history becomes a queryable graph + cited deliverables, produced
  for electricity, refreshed incrementally.
- New surface: `scripts/longview/` runner + prompts (small, no new deps) and a
  session-card schema to maintain.
- Risks: 9B synthesis quality ceiling (mitigated: citations make weak cards
  visible and re-runnable per-session); OneDrive sync churn on the workspace
  (mitigated: ledger appends, not rewrites); protobuf conversations remain
  unread (accepted: artifacts + transcripts carry the signal; a .pb decoder is
  future work).
