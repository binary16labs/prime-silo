# Solution Design — Model plurality: evaluate, benchmark, promote (EP-M)

**Requirements:** `REQUIREMENTS-trained-model-workflows.md` (R1–R23). This document fills the _how_.
**Status:** DRAFT for owner review. **Author:** claude-opus, 2026-08-03. **Verifier:** unassigned
(author≠verifier — a non-author agent must verify each contract).

---

## 1. Mandate

Produce a buildable design for one benchmark instrument that can rank two models on the estate's own
agent loop, and the task contracts that deliver it. Not in this document: any GPU time, any change to
EP-T's training method, worktree provisioning (that is `W2`).

## 2. Definition of ready — the gate BEFORE any EP-M work starts

The owner's ordering decision (W2 before EP-M) has a longer chain than it appears. Verified against
`delivery/board/BOARD.md` on 2026-08-03:

```
B0 DONE ─→ B1 DONE ─→ B2 AUTHORED ─→ W1 AUTHORED ─→ W2 AUTHORED ─→ EP-M (M0…M5)
                      (deps: B1 ✓)    (deps: W0 ✓,   (deps: W1)
                       READY NOW       B2 ✗)
```

**Three contracts stand between today and M0**, not one:

- **B2** — agent surfaces: `benny coord ls|claim|progress|done|note` CLI + four MCP tools over the B1
  ledger. Its dependency B1 is DONE, so **B2 is ready to pick up now**.
- **W1** — deterministic `work next` selector + delivery loop. Blocked only by B2.
- **W2** — the sandbox provisioning the owner asked for: `git worktree add .worktrees/<id> -b
  feat/<id>`, `work verify` enforcing changed-files ⊆ allowlist and diff ≤ budget, and tool preflight
  emitting an honest `blocked`.

**Board hygiene note (observation, not a fix):** the `AUTHORED` column is stale. It is defined as
"deps not yet DONE", yet B2 sits there yet with its only dependency DONE. `w0` asserts each id appears
exactly once across columns; it does not re-derive which column is correct. B2 should be in `READY`.

**Prerequisite outside the chain:** `w0`'s parser fix is verified green but **uncommitted and
unsigned**. Nothing registers until the owner takes it.

## 3. Decisions taken in this design

| # | Decision | Rationale |
|---|---|---|
| D1 | The unit under test is a **subject**, not a model: a named persona→model assignment plus serving topology. | R6 wants heterogeneous rosters (E4B reviewer + 12B implementer) rankable as one unit. Making "one model everywhere" just a degenerate subject removes the special case, and makes the incumbent a subject too. |
| D2 | `run_multi_model`'s existing `models: List[str]` parameter carries **subject labels**; the hook resolves label → assignment from the roster. | Satisfies R6 with **zero signature change**, honouring R21 (additive) and preserving AOS-NFR9/R23. |
| D3 | **No composite score.** Results are a metric vector; ranking is by a primary metric declared in the frozen rubric. | A weighted composite invented at design time is an unfrozen rubric wearing a number. The estate's discipline (EP-T) is to freeze the instrument before seeing results. |
| D4 | `_dry_run_stub` stays, but becomes **explicitly selectable only** (`hook="dry-run"`); `hook=None` raises. | R2. Today `None` silently yields zeros — the defect that left this harness unmeasured. Fail loudly instead. |
| D5 | Metrics are sourced from the **existing run-event stream** (G0, DONE) and the execution register, not from bespoke instrumentation. | Reuse over rebuild; also the only way R9's ledger requirement is satisfiable by construction. |
| D6 | Every model call goes through `call_model()`. | `runtime/CLAUDE.md` rule 1 — it is how offline mode, logging and lineage fire. A bench that bypasses it produces unlineaged numbers. |

## 4. Architecture

### 4.0 The one idea

**One subject, one frozen rubric, one ledger record.** Everything else is plumbing. The harness's job
is to make "model B beat model A at driving our SDLC loop" a sentence with a citation behind it.

### 4.1 Roster — declarative subjects · R4–R8

New manifest kind `model_roster/1` under `runtime/manifests/templates/`. Two blocks:

- `models[]` — the pool. Per entry: `label`, `id` (resolver key), `max_tokens`, `temperature`,
  `tier[]` ⊆ `{planner, architect, implementer, reviewer, judge}`.
- `subjects[]` — the units under test. Per entry: `label`, and `assign{}` mapping persona → model
  `label`. A single-model subject assigns every persona to one label.

Validation (M0, fail-closed): a persona may only be assigned a model whose `tier[]` contains it
(R5); the `judge` block is separate and a subject assigning the judge model is **rejected** (R8);
unknown labels rejected. Assignments feed `model_resolver.resolve_model()`'s existing
`model_per_persona` map (R6) — no change to the resolution order.

### 4.2 The executor hook — where the zeros end · R1–R3

New `runtime/benny/sdlc/bench_executor.py` implementing the existing `_ModelHook` contract
`(model, manifest_path, workspace) → SandboxResult`, where `model` is a **subject label** (D2).

Per subject it: resolves the assignment → builds a `ManifestConfig` with `model_per_persona` →
executes the SDLC manifest through the normal swarm path → collects the run's events → derives the
eight fields:

| `SandboxResult` field | Source |
|---|---|
| `tool_selection_accuracy` | chosen tool vs the rubric's expected op per step (reuses Path A's `rubric_required_ops`) |
| `tool_efficiency` | `tools_used / rubric_min_steps` |
| `context_efficiency` | unique / total prompt tokens, from `call_model()` accounting |
| `iteration_latency_ms_p95`, `loop_count_p95` | run-event stream (G0 spec) |
| `constraint_adherence` | 1 − (contract-gate rejections / gate evaluations), from the checkpoint path |
| `total_cost`, `total_tokens` | execution register entry for the run |

**R3 is a schema change, not a convention.** Each field becomes `float \| None`; `None` renders as
`unmeasured` in the report and is excluded from ranking. A metric that cannot be derived must be
`None` — never `0.0`. This is the single most important line in the design: the current harness's
failure was not that it lacked metrics, but that it reported absent ones as real zeros.

### 4.3 Folding Path A into Path B · R1

`pypes model-bench` keeps working unchanged (R21). M2 adds an **authoring block** to the bench record
carrying Path A's rubric outcome (`required_ops` satisfied, step counts, judge verdict when enabled),
alongside the navigation block from 4.2. One record, two blocks, no composite (D3). A subject may be
scored on either block or both; ranking declares which block and which primary metric up front.

### 4.4 Integrity and the ledger · R9–R12

- **Rubric + roster frozen by content hash**, recorded in the result. A post-hoc rubric edit
  invalidates prior results by hash mismatch (M0 negative control).
- **Serving topology captured** per subject: endpoint, quantisation, context length (R11). q4_k_m and
  q8 of the same weights are different subjects, and the record must be able to prove which ran.
- **Ledger + lineage:** each bench emits an execution-register entry and an OpenLineage RunEvent
  through the existing governance path. Unledgered result ⇒ treated as not having happened.
- **Serialisation (R12):** the eGPU is single-tenant. The runner holds a host lock and executes
  subjects strictly in sequence. Liveness is judged by **CPU-time and artifact mtime**, never by a log
  line — a tqdm line is not proof of life, and a false positive on that has already been caught once
  in this estate.

### 4.5 Promotion · R13, R14

Unchanged from T4: a winning subject becomes an **additive** router candidate, incumbent stays
default, unhealthy candidate falls back without crashing. Promotion to default needs a no-regression
result on the frozen rubric, a non-author verifier, and an owner signature.

### 4.6 Requirement → component map

| Component | Requirements |
|---|---|
| `model_roster/1` + validator | R4, R5, R6, R7, R8 |
| `bench_executor.py` | R1, R2, R3, R6, R13 |
| `SandboxResult` → optional fields | R3, R22 |
| Bench record (authoring + navigation blocks) | R1 |
| Hashing, topology capture, ledger, host lock | R9, R10, R11, R12 |
| Router candidate path (existing T4) | R13, R14 |
| EP-T sequence, unchanged | R15, R16, R17, R17.1, R18, R19 |

## 5. Schema

### 5.1 `model_roster/1`

```json
{
  "schema_version": "1.0",
  "kind": "model_roster",
  "id": "roster-incumbent-vs-gemma",
  "models": [
    { "label": "qwen-house-v3", "id": "house/qwen2.5-coder-tuned", "tier": ["planner","architect","implementer","reviewer"], "max_tokens": 4096, "temperature": 0.2 },
    { "label": "gemma-e4b",     "id": "lemonade/Gemma-4-E4B-it-GGUF", "tier": ["reviewer","judge"],      "max_tokens": 4096, "temperature": 0.2 },
    { "label": "gemma-12b",     "id": "lemonade/gemma-4-12b",         "tier": ["implementer","architect"], "max_tokens": 4096, "temperature": 0.2 }
  ],
  "subjects": [
    { "label": "incumbent",   "assign": { "*": "qwen-house-v3" } },
    { "label": "gemma-split", "assign": { "implementer": "gemma-12b", "architect": "gemma-12b", "reviewer": "gemma-e4b", "planner": "qwen-house-v3" } }
  ],
  "judge": { "enabled": false, "model": "lemonade/Gemma-4-26B-A4B-it-GGUF", "max_tokens": 400 },
  "rubric": "scripts/train/eval/rubric.md",
  "primary_metric": "tool_selection_accuracy",
  "repeats": 3
}
```

`"*"` is the only wildcard: assign-all. `judge.model` must not appear in `models[]` (R8).

### 5.2 Bench record (one JSONL line per subject per repeat)

```json
{
  "bench_id": "…", "subject": "gemma-split", "repeat": 1,
  "roster_hash": "sha256:…", "rubric_hash": "sha256:…", "code_commit": "…",
  "serving": { "endpoint": "…", "quantisation": "q4_k_m", "context_length": 16384 },
  "navigation": { "tool_selection_accuracy": 0.71, "tool_efficiency": 0.62,
                  "context_efficiency": null, "iteration_latency_ms_p95": 4180.0,
                  "loop_count_p95": 7, "constraint_adherence": 0.94,
                  "total_cost": 0.0, "total_tokens": 184203 },
  "authoring": { "required_ops_satisfied": true, "steps": 9, "gold_steps": 4, "judge": null },
  "status": "measured", "captured_at": "2026-…"
}
```

`null` = unmeasured and excluded from ranking (R3). `status` ∈ `measured | unavailable | wedged`,
with `reason` when not `measured` (R7).

## 6. Task breakdown — EP-M contracts

Frontmatter below is complete except `okr` and `milestone`, which are **owner-assigned** and which
`w0` will reject if empty. `deps` for M0 encodes the §2 chain.

| id | deps | allowlist (abridged) | verify | budget |
|---|---|---|---|---|
| `M0` | `[W2]` | `runtime/manifests/templates/model_roster*.json`, `server/coordination/…/roster-schema/`, `tests/roster/`, `scripts/gates/m0.mjs` | `node scripts/gates/m0.mjs` | 400 |
| `M1` | `[M0]` | `runtime/benny/sdlc/bench_executor.py`, `runtime/benny/sdlc/sandbox_runner.py`, `runtime/tests/sdlc/`, `scripts/gates/m1.py` | `python scripts/gates/m1.py` | 500 |
| `M2` | `[M1]` | `runtime/benny/sdlc/sandbox_runner.py`, `runtime/benny/pypes/`, `runtime/tests/sdlc/`, `scripts/gates/m2.mjs` | `node scripts/gates/m2.mjs` | 350 |
| `M3` | `[M1]` | `runtime/benny/governance/`, `runtime/benny/sdlc/bench_executor.py`, `runtime/tests/governance/`, `scripts/gates/m3.mjs` | `node scripts/gates/m3.mjs` | 400 |
| `M4` | `[M2, M3]` | `docs/bench/M4-report.md`, `scripts/gates/m4.py` | `python scripts/gates/m4.py` | 250 |
| `M5` | `[M4]` | `scripts/train/`, `docs/train/M5-e4b-report.md`, `scripts/gates/m5.py` | `python scripts/gates/m5.py` | 450 |

All carry `authority: agent-ok`, `sandbox: worktree`, `tools: [node, python, lemonade]` (M5 adds the
trainer). **M4 is the contract that closes the epic**, and it is deliberately a *report* contract: its
budget buys evidence, not code.

### Red-first scenarios each gate must fail on before it passes

- `m0` — a subject assigning a persona outside a model's `tier[]` is rejected; a subject assigning the
  judge model is rejected; a rubric-hash mismatch is rejected.
- `m1` — `hook=None` **raises** (D4); a subject whose endpoint is down yields `status: unavailable`
  naming the reason while other subjects complete (R7); a metric that cannot be derived is `null`,
  and a mutation forcing it to `0.0` turns the gate RED (this is the non-vacuity proof for R3).
- `m2` — a record missing either block is rejected; `pypes model-bench`'s existing output is
  byte-unchanged for an existing caller (R21).
- `m3` — a bench with no execution-register entry is rejected; a wedged endpoint is detected by
  CPU-time/mtime while its log is still emitting lines.
- `m4` — two subjects, all eight fields either measured or explicitly `null`, ranked on the declared
  primary metric, non-author verified.
- `m5` — the full R16 sequence ran in order, with the **base eval re-run on the new split**; a stale
  baseline turns the gate RED.

## 7. Phasing

1. **Unblock** — owner commits the `w0` fix. B2 → W1 → W2 (§2 chain).
2. **Instrument** — M0, M1. End state: `run_multi_model` returns a real `SandboxResult`.
3. **Unify + govern** — M2, M3 (independent of each other; both depend on M1).
4. **Prove** — M4: incumbent vs one candidate, non-author verified. EP-M closes here.
5. **Train** — M5: E4B alone (R17.1). 12B remains deferred pending M5's result. GRPO remains blocked
   by R15 in all phases.

## 8. Delivery doctrine

Red-first gates; author≠verifier; allowlist-clean diffs under budget; mutation-proof that each gate is
non-vacuous (break the thing, watch the gate go RED, revert); honest ledger entries including negative
results. EP-T's own record — DPO logged at +0.3% rather than dressed up — is the standard this epic is
held to.

## 9. Open questions blocking registration

1. `okr` for EP-M — must resolve to exactly one `TRACEABILITY.md` row.
2. `milestone` for EP-M (`M1`–`M8`).
3. `plan-deps.json` must gain the EP-M phases, and that file updates **only with a plan rev**
   (`SPEC-work-contracts.md`) — so `PLAN-local-power-unified-ui.md` needs a workstream-M revision
   before any M-contract can pass `w0`.
4. Does the owner want B2/W1/W2 executed by agents now that `w0` is green, or held?
