---
name: longview-pipeline
description: Operate, analyze, or extend the LONGVIEW session-synthesis pipeline (cards, graph, reports, book, audiobook). Use when working on scripts/longview, reviewing card output, planning card schema changes, or debugging a LONGVIEW run.
---

# LONGVIEW pipeline — operational knowledge

LONGVIEW map-reduces months of agent sessions (memo-ray store) into per-session **cards** via the local
model (qwen3.5-9b-FLM through lemonade), then graph + themes + report/book/PDF/audiobook.
Pipeline: inventory → extract → map(walk) → model → code → weave → enrich → review → reduce(TIMELINE) → opus → pdf.
Code: `scripts/longview/`. Guide: `runtime/docs/operations/LONGVIEW_GUIDE.md`.

## Hard-won constraints (violate these and the run fails slowly)

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
