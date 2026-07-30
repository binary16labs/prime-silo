# REVIEW: LONGVIEW v2 card corpus (2026-07-05, mid-run)

> Snapshot analysis of 148 cards (of ~224 sessions, run still in progress) at
> `benny-home/benny/workspaces/longview_v2/longview/cards`. Read-only review; the run was not disturbed.
> This document is the requirements source for **A7 (card schema v2)**, the seed source for **A0 judge calibration**,
> and the evidence base for the **Q2 path/encoding lint** and **Workstream W** in `PLAN-local-power-unified-ui.md`.

## Corpus health

148/148 parse cleanly. `intent` always filled (avg 375 chars), `evidence` and `applications` never empty.
Agents: **Antigravity 95 / Claude 53**. Periods: 2026-04 (7), 2026-05 (47), 2026-06 (89), 2026-07 (5).
Schema keys: project, period, intent, applications, capabilities, decisions, outcomes, failures,
skills_observed, operator_traits, open_threads, proposed_next, evidence, concepts, session_id, agent.

## Measured failure taxonomy (354 failures across cards)

| Class                            | Count  | Plan counter-measure                                                           |
| -------------------------------- | ------ | ------------------------------------------------------------------------------ |
| **Windows path / encoding**      | **52** | **Q2 path/encoding lint + shared path utility (added rev 10 — was uncovered)** |
| Service down / port / connection | 43     | F2 garage health, A6 honest `no_capable_model`, W2 tool preflight              |
| Timeout / hang / wedge           | 29     | A0 watchdog                                                                    |
| Environment / install drift      | 28     | Q1 lockfiles, W2 sandbox provisioning                                          |
| Model returned invalid JSON      | 23     | A1 schema-validated windows + bounded retry                                    |
| Context / token limits           | 19     | A1 windowing                                                                   |
| Permissions                      | 14     | W2 preflight                                                                   |
| Pre-existing test issues         | 4      | Q2 CI running the full suite                                                   |

**Use for A0:** the judge's known-bad calibration set must include: invalid/truncated JSON,
path-mangled output, context-overflow truncation — these are the _measured_ ways local-model work fails here.

## Measured operator profile (343 operator_traits)

Consistent across 9 months: prefers **explicit over implicit** (capability detection, strategy parameters,
error messages); **validates before committing**; **iterative testing**; **honest/actionable errors over
silent failures**. Use for A0 judge acceptance criteria and the phase-runner skill's working style.
This profile independently matches the plan's honesty/determinism ethos — it is evidence, not aspiration.

## Evidence for Workstream W (shared backlog)

Open_threads recur across sessions nearly verbatim ("implement SchemaAdapter class and tests Task A.1.2",
"Task B.1.3 update graph_schema.md pending", "verify plan completeness against pain_points_and_vision.md"):
task-shaped work is carried forward in prose with no shared tracker and no closure signal.
`proposed_next` is never linked to a later session that did it.

## Data-quality findings (fix in A7, deterministically — no new model calls)

1. **Silent truncation:** every list field caps at exactly 6 (concepts 12) and saturation is heavy —
   evidence 94/148, capabilities 86, outcomes 83, concepts 72. No `truncated` flag or overflow count exists,
   so "had 6" and "had 20, dropped 14" are indistinguishable. Keep caps; add `<field>_total` when overflowed.
2. **Project-name fragmentation:** `prime-silo`/`Prime-Silo`, `benny`/`Benny`/`Benny Studio`, plus
   workspace-folder leaks (`outputs`) counted as projects → graph will build islands. Needs a canonical
   project registry + alias normalizer at assembly.
3. **Evidence quality:** 725 entries — only 15 contain a commit hash; 421 are vague free-text; 16 are
   malformed `/c:/...` paths. Prefer repo-relative path + commit hash when resolvable.
4. **Bullet artifacts:** 6 open_threads begin with orphaned `". "` (bullet-splitting regex).

## Data not collected (schema v2 additions — all deterministically derivable)

- `started_at` / `ended_at` / `duration` (raw logs have timestamps; cards only carry month `period`)
- `model` + `ctx` + local/cloud attribution (only `agent` exists today)
- `disposition`: success | partial | abandoned (rules first, judge only for ambiguous)
- Quantitative counts: files touched, commits made, tests run/passed (when the log shows them)
- Stable content-hash **thread ids** on open_threads/proposed_next → cross-session resolution linking
- Future: `run_id` / ledger task ids once G0 + Workstream B exist (closes the memory↔execution loop)

## Live telemetry captured during this run (grounds the plan's facts table)

`2026-07-05 17:12` lemonade/qwen3.5-9b-FLM: input 7,695 tok → **output 500 tok** (above the previously
assumed ~415 self-limit — 500 proven, likely max_tokens ceiling), **TTFT 22.0 s**, **8.33 tok/s**.
Consequence: prefill dominates per-call cost → A1 windows must be few and full, not many and small.
