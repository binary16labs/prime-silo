---
name: longview-pipeline
description: Operate, analyze, or extend the LONGVIEW session-synthesis pipeline (cards, graph, reports, book, audiobook). Use when working on scripts/longview, reviewing card output, planning card schema changes, or debugging a LONGVIEW run.
---

# LONGVIEW pipeline — operational knowledge

LONGVIEW map-reduces months of agent sessions (memo-ray store) into per-session **cards** via a local
model, then graph + themes + report/book/PDF/audiobook.
Pipeline: inventory → extract → map(walk) → (model **or** graph) → code → weave → enrich → review → reduce(TIMELINE) → opus → pdf.
Code: `scripts/longview/`. Guide: `runtime/docs/operations/LONGVIEW_GUIDE.md`.

**Model is env/profile-driven** (not hardcoded): `BENNY_DEFAULT_MODEL` / `LONGVIEW_MODEL` pick it,
the manifest carries only a preconfigured default. Verified LAN setup: LM Studio on
`192.168.68.125:1234` serving `lmstudio/google/gemma-4-12b` (a reasoning model — the per-call token
budget must clear its ~500-1000-tok preamble, e.g. `LONGVIEW_FRAGMENT_MAX_TOKENS=1800`, or content
comes back empty → blank cards; full org/model id required; `response_format` must be `json_schema|text`,
never `json_object`). A wedged gemma engine returns HTTP 200 but zero tokens — reload the model on the
LM host to reset it; embeddings on the same host still answering isolates it as generation-specific.

**Graph build — two paths, same schema (Source/Concept/RELATES_TO/SOURCED_FROM):**
- `model` = deep_synthesis: a second LLM pass re-extracts triples per card section. ~60-120s/card.
- `graph` = **longview_v2, deterministic**: builds triples directly from the card's own
  `concepts[]`/`applications[]`/`capabilities[]`/`skills_observed[]` — no model call, **~0.4s/card**.
  `(:Project)-[INVOLVES/USES/DEMONSTRATES/APPLIES]->` entities + an anchor `CO_OCCURS_WITH` star per card.
  The map phase already distilled the entities once, so re-extraction is redundant — `graph` is the
  speed lever. Then run `enrich` to merge duplicate concepts across cards into shared hubs.
  Code: `lib/card_triples.mjs` (pure `buildCardTriples`), server route `POST /rag/graph-upsert`
  (→ `save_knowledge_triples`, no clustering), live earned-ETA via `lib/eta.mjs` → `<ws>/longview/progress.json`.
  Sentence-shaped fields (decisions/outcomes/failures) are deliberately NOT nodes — they stay in the card
  md for vectors. Blank cards (no entities) are counted + skipped, never written as empty hubs.

## Hard-won constraints (violate these and the run fails slowly)

- **ONE clean call at a time — never probe the LM host during a run (2026-07-09).** A second
  concurrent request, or an aborted in-flight call, wedges the LM Studio engine →
  `{"_error":"Engine protocol predict request failed: fetch failed"}` (400) on every subsequent
  predict, while `/v1/models` still says `loaded` and embeddings still answer. Recovery = eject +
  reload the model on the LM host (no HTTP unload). Do diagnostic/health probes ONLY between runs
  with the runner stopped. Any timing measured while a probe competed with the map is inflated —
  discard it. This bit us live: the "gemma is slow / 56s probe / 1835s card" numbers were all self-
  inflicted concurrency, and killing a queued probe is what wedged the engine.
- **Turn off reasoning on extraction calls (2026-07-09) — the 4× lever.** gemma-4-12b burns ~78% of
  every call on a reasoning preamble that adds nothing to a *reading* task (verified: 640→0 reasoning
  tokens, JSON still full/valid, 16-window card 160s/win → 42s/win). The prompt CANNOT suppress it and
  `enable_thinking:false` / `thinking:false` / `reasoning_effort:"low"` are ignored — the working
  control is the request param **`reasoning_effort:"none"`** (LM Studio honors it; it's on/off, not
  low/med/high). Wired as `LONGVIEW_REASONING_EFFORT` → `llm.mjs`; env-gated so it's omitted for
  providers that would reject it. Quality held completely (all 13 fields, rich concepts).
- **Halt on an engine wedge, don't march through it (2026-07-09).** LM Studio's engine wedges
  spontaneously under sustained load → `Engine protocol predict request failed: fetch failed` (400) on
  every predict until reloaded. This is INDEPENDENT of reasoning on/off (seen both ways). The map now
  detects the wedge (`isEngineWedge`), does NOT cache the failed window (so resume retries it), stops
  the phase, and exits non-zero so build_v2.sh halts before graph/enrich. Recovery: reload the model on
  the host, rerun — resume re-maps the unwritten sessions. Root-cause needs LM Studio's OWN logs
  (OOM/KV-cache → lower ctx or GPU layers; GPU error → host; poison input → re-crashes same session).
- **Window size vs timeout on a reasoning model (2026-07-09).** Full 24k-char windows on gemma-4-12b
  overran the 200s `LONGVIEW_LLM_TIMEOUT_MS` (prefill ~6.9k tok + ~1000-tok reasoning preamble + output)
  and got amputated → `{"_error":"...aborted due to timeout"}`, ~31% window loss on multi-window cards.
  Fix that held: `LONGVIEW_WINDOW_CHARS=12000` + `LONGVIEW_LLM_TIMEOUT_MS=420000` → 0 timeouts.
  Tradeoff: smaller windows = more calls/session, and gemma's reasoning tax is paid **per call**
  (~90% of a small call's tokens are reasoning), so single-window sessions get ~2× slower. Distinguish
  the two error strings: "aborted due to timeout" = shrink window / raise timeout; "Engine protocol
  predict request failed" = engine wedge, reload the model. Purge affected cards+window dirs to re-map.
- **Backlog then top-up.** Map the whole corpus once (all sessions), then `longview run --delta` for
  incremental top-ups — don't cut scope to go faster; fix throughput instead.
- **Local model output is short.** ~415-token self-truncation observed; 500 proven max (live telemetry
  2026-07-05). Window every extraction (`lib/walk.mjs`), assemble cards **losslessly in code** — never ask
  the model for a whole card.
- **Prefill dominates cost:** TTFT 22 s @ 7.7k input, 8.33 tok/s. Prefer few, full windows over many small
  calls. Estimate `calls × (TTFT + out/TPS)` before launching a run.
- **16k ctx** via `~/.cache/lemonade/recipe_options.json` per-model `ctx_size` + restart with
  `POST /api/v1/load` (never a chat call right after killing flm.exe — it races the respawn).
- **Workspace precedence:** a manifest's hardcoded `workspace` silently overrode env once (killed a run).
  Always verify the `[run] … → workspace 'X'` log line after launch.
- **Never disturb a live run** — analysis of cards/ledger is read-only; normalizations run post-hoc.
- **One run = one model/engine (A8, fixed v1.12.3).** Never let two models alternate on one NPU:
  graph_synthesis on qwen (FLM) + default-role calls on a catalog-roulette GGUF pick (llamacpp)
  evict each other per call → "No model loaded" both sides → the 2026-07-06 overnight loop.
  The fix: /rag/ingest pins run affinity from its `model` field; auto-detect prefers the
  currently-loaded model; roulette picks WARN. Belt-and-braces env pin: `BENNY_DEFAULT_MODEL=
  lemonade/qwen3.5-9b-FLM`. Ingest client fails a batch after 30 min of task-record silence
  (`LONGVIEW_INGEST_STALL_MS`) and reconciles per-file via `.benny/wiki/` evidence on failure —
  retries skip completed cards. Diagnosis pattern: read `runs/task_registry.json` think-log and
  `longview/ledger.jsonl`, check flm.exe PID changes; ledger `ts` is UTC, file mtimes local.

## Card corpus facts (2026-07-05 review — full doc: architecture/REVIEW-longview-cards-2026-07-05.md)

- Failure taxonomy of 354 captured failures: **path/encoding #1 (52)**, service-down (43), wedge (29),
  env drift (28), invalid JSON (23), ctx limits (19), permissions (14). Judge calibration (plan A0) and
  the Q2 path lint are seeded from this — do not re-derive.
- Operator profile (343 traits): explicit>implicit, validate-before-commit, honest errors. Use as judge
  acceptance criteria and working style.
- Known data-quality issues to normalize (plan A7): silent truncation at caps (add `<field>_total`),
  project alias fragmentation (`benny`/`Benny`/`Benny Studio`, `outputs` leak), `/c:/` evidence paths,
  leading-`". "` thread artifacts.
- Schema v2 (A7, next delta run): timestamps/duration, model+ctx, disposition, quantitative counts,
  content-hash thread ids, truncation totals, future run_id/ledger links. All deterministic — no new
  model calls.

## Quick analysis recipe (read-only)

Cards live at `<benny-home>/benny/workspaces/<ws>/longview/cards/*.json` (readers must exclude `*.meta.json`).
Fields: project, period, intent, applications, capabilities, decisions, outcomes, failures, skills_observed,
operator_traits, open_threads, proposed_next, evidence, concepts, session_id, agent.
For corpus stats, fold with Python (field fill rates, saturation at cap=6/12, Counter on
projects/agents/concepts, regex-cluster failures). Provenance per card: `cards/<sid>.meta.json`,
`windows/<sid>/manifest.json`; run history: `longview record <scope>` / `GET /api/longview_record?scope=`.
