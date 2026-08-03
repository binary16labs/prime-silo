# Requirements — Trained-model workflows + the multi-model evaluation harness

**Status:** DRAFT for owner review. Requirements only — **solution design and task contracts are for
a separate session**. Nothing here prescribes _how_; it states _what the system must do_, _why_, and
_what evidence closes it_, with numbered requirements (R#) a design session can trace to.

**Author:** claude-opus, 2026-08-03. **Reviewer:** owner (unsigned).
**Supersedes:** the "Trained Model Workflows in the Prime-Silo Agentic Operating System" narrative
draft. That draft is retained for intent only; §9 records the claims it made that this document
corrects, so the corrections stay on the record rather than being quietly dropped.

**Board note:** this document does **not** register anything. §8 proposes epic and task text for the
owner to sign onto the board.

**`w0` status — RESOLVED 2026-08-03, pending owner signature.** The gate was RED for a parser defect,
not a governance gap: `parseFrontmatter()` in `server/coordination/work-schema/validate.mjs` read a
YAML flow sequence only when `[` sat on the key's own line, so every allowlist prettier had wrapped
onto the following line parsed as empty — and the `verify`-gate check, which consults that same
allowlist, then failed for the same reason. One defect, 148 reported errors (98 × "allowlist empty",
50 × "gate neither exists nor is in the allowlist"). **No contract was malformed.** The fix gathers
continuation lines until the brackets balance; `w0` now reports **GATE GREEN, 89 contracts
validated**, with both negative-control scenarios still failing closed.

---

## 1. Objective

Make the agentic SDLC **measurably** model-plural: any local model — including a second and third
house-trained one — can be admitted as a candidate engine, benchmarked against the incumbent on the
same instrument, and either promoted or rejected on evidence. Today the estate can train a model
(EP-T, closed) and can serve one behind the router (T4, live). It cannot yet answer "is model B
better than model A at driving _our_ agent loop" with a real number.

The narrative draft framed this as a training problem. It is mostly a **harness** problem. The
training pipeline is built and verified; the evaluation surface is where the gap is.

## 2. What we're standing on (reuse, do not rebuild)

Verified present in the repository at the time of writing:

| Capability | Where |
|---|---|
| Tree-Sitter AST code graph, dual-graph + `CORRELATES_WITH` overlay | `runtime/benny/graph/code_analyzer.py` (470 ln), `runtime/benny/api/graph_routes.py`, `architecture/run_raw_ast_extraction.py` |
| Six-wave SDLC state machine (Vision→Business→InfoSys→Technology→Implement→Review) | `runtime/manifests/templates/sdlc_pipeline_v2.json` |
| HMAC checkpoints, atomic write, pause/resume, time+iteration budgets | `runtime/benny/sdlc/checkpoint.py` (261 ln) |
| Gherkin BDD gate | `runtime/benny/sdlc/bdd.py` (190 ln) |
| Per-persona model resolution (task → persona map → config → registry default) | `runtime/benny/sdlc/model_resolver.py` |
| Multi-model planner bench (rubric-scored, judge-capable) | `runtime/manifests/templates/model_comparison_planner.json` + `benny pypes model-bench` |
| Multi-model SDLC sandbox API + 8 agentic metrics | `runtime/benny/sdlc/sandbox_runner.py` (AOS-F29/F30) |
| House QLoRA + DPO trainer, frozen rubric, gates `t0`–`t5` | `scripts/train/{qlora,dpo,eval}/`, `scripts/gates/t*.py` |
| Work-contract format incl. `sandbox: worktree` | `architecture/SPEC-work-contracts.md:22`, 87 task files |
| OpenLineage DAG + execution register + hash-chained HMAC ledger | dashboard `:8788/lineage.html`, `runtime/benny/governance/` |

**Hardware reality (a hard constraint, not a footnote):** one Razer Core X eGPU (RX 9060 XT 16 GB,
RDNA4/gfx1200) on the T480, **single-tenant** — a concurrent request wedges ROCm. Serving is LM
Studio only. Any requirement below that implies GPU work is implicitly serialised.

## 3. Scope

**In scope:** admitting additional models as first-class candidates; one unified benchmark
instrument covering both manifest authoring and agentic navigation; declarative model rosters;
promotion/rejection evidence; the cost model for training a second and third house model.

**Out of scope here:** the solution design, schemas, and task breakdown (separate session); replacing
EP-T's training method; any cloud dependency; and — explicitly — worktree provisioning, which is
already contracted as **W2** under `EP-W` and must not be re-specified here.

**Ordering decision (owner, 2026-08-03): W2 lands before EP-M.** EP-M carries a hard dependency on
W2 rather than proceeding on convention. The consequence is stated plainly: EP-M does not start until
`scripts/gates/w2.mjs` is green, and in exchange every EP-M contract's `allowlist` and `budget` are
machine-enforced rather than honoured by discipline. This also fixes the gap for the other 87
contracts that declare `sandbox: worktree`, so the cost is shared, not carried by EP-M alone.

---

## 4. Functional requirements — the evaluation and benchmark harness

### 4.1 The problem: three disjoint evaluation paths

There are three ways to compare models today and no two of them produce comparable numbers.

- **Path A — `pypes model-bench`.** `model_comparison_planner.json` (`kind:
  pypes_model_comparison`, `task: "plan"`) runs a real four-model roster — `qwen3-tk-4b`,
  `lemonade/Gemma-4-E4B-it-GGUF`, `DeepSeek-Qwen3-8B`, `qwen3.5-9b` — against a rubric of
  `rubric_required_ops` / `min_steps` / `min_gold_steps`, with an optional
  `Gemma-4-26B-A4B` judge (currently `enabled: false`). This works, and it already contains
  Gemma-4-E4B. **But it scores manifest authoring only** — one shot, no tool loop.
- **Path B — `sandbox_runner.run_multi_model`.** This is the richer instrument: eight per-model
  agentic metrics (`tool_selection_accuracy`, `tool_efficiency`, `context_efficiency`,
  `iteration_latency_ms_p95`, `loop_count_p95`, `constraint_adherence`, `total_cost`,
  `total_tokens`). **It has never produced a real number.** `hook` defaults to `None`, which
  selects `_dry_run_stub` — a function that returns zeros for every metric. The API, the report
  writer, and the metric schema are all built; the executor is not wired.
- **Path C — EP-T eval.** `scripts/train/eval/` + the frozen rubric + gates `t3`/`t5` produce the
  only honest base-vs-tuned deltas the estate has (agg_nll, tool-match). It is bound to a single
  base model and runs offline against a held-out split, not through the agent loop.

**R1.** The system SHALL expose **one** benchmark instrument that produces comparable metrics for
both manifest authoring (Path A's rubric) and agentic navigation (Path B's eight metrics), such
that two models can be ranked on the same scale.

**R2.** `run_multi_model` SHALL be invocable with a **real executor hook** that drives a model
through the actual SDLC manifest and populates all eight `SandboxResult` fields from observed
behaviour. The zeroed `_dry_run_stub` SHALL remain available and SHALL be explicitly selected, never
reached by default — a benchmark that silently returns zeros is worse than one that fails.

**R3.** A benchmark run that yields a zero or absent value for any metric SHALL mark that metric
`unmeasured` and SHALL NOT report it as `0.0`. Reports SHALL distinguish "measured zero" from "not
measured."

### 4.2 Declarative model rosters

**R4.** The set of models under evaluation SHALL be declared in a manifest, not in code. Adding
Gemma-4-E4B and Gemma-4-12B to a benchmark SHALL be a manifest edit.

**R5.** The roster schema SHALL carry, per model: a stable `label`, the resolver `id`, `max_tokens`,
`temperature`, and a **`tier`** declaring which personas the model is eligible for
(`planner` / `architect` / `implementer` / `reviewer` / `judge`).

**R6.** The roster SHALL feed `model_resolver.resolve_model()`'s existing per-persona map so a
benchmark can evaluate a **heterogeneous assignment** (e.g. E4B as reviewer/judge, 12B as
implementer) as a single unit under test, not only single-model runs.

**R7.** A model declared in a roster but unresolvable or unhealthy on the host SHALL cause that
model's row to be recorded as `unavailable` with the reason. It SHALL NOT abort the other rows and
SHALL NOT be silently substituted by the resolver's registry default.

**R8.** The judge model SHALL be declared separately from the models under test, and a run where the
judge appears in the roster under test SHALL be rejected at validation time (self-judging).

### 4.3 Benchmark integrity

**R9.** Every benchmark run SHALL emit an execution-register entry through the existing governance
path (commit, roster, per-model outcome, cost, wall time) and SHALL appear in the OpenLineage DAG.
A benchmark whose result is not in the ledger did not happen.

**R10.** The scoring rubric SHALL be **frozen before** the run and referenced by content hash in the
result, matching the EP-T discipline (`scripts/train/eval/rubric.md`). A rubric edited after results
are seen invalidates those results.

**R11.** Benchmark results SHALL record the serving topology (endpoint, quantisation, context
length). A GGUF at q4_k_m and the same weights at q8 are different subjects.

**R12.** Because the eGPU is single-tenant, the harness SHALL serialise model execution and SHALL
detect a wedged endpoint by liveness evidence (CPU-time / artifact mtime), not by log-line presence
alone.

### 4.4 Promotion

**R13.** A model SHALL become a router candidate only via the existing **additive** T4 path: the
incumbent engine remains default, the candidate is opt-in, and an unhealthy candidate falls back
without crashing.

**R14.** Promotion of a candidate to default SHALL require a benchmark result showing no regression
on the frozen rubric, verified by a **non-author** agent, and SHALL carry an owner signature.

---

## 5. Functional requirements — training additional house models

### 5.1 What EP-T actually established

EP-T is closed and verified: T3 tuned Qwen2.5-Coder-7B beat its base by **−62.5% agg_nll** on a
held-out split with RAG disabled; T4 served it behind the router on a real ADR-004 offload task.
Two findings from that work bind everything below.

**Finding 1 — data was the lever, not the second-stage algorithm.** Dataset v2→v3 moved A-stream
NLL from −9.2% to **−38.3%** (≈4×). T5's DPO stage over the same SFT adapter moved aggregate NLL
1.1253→1.1218 — **+0.3%**, with tool-match flat at 0.263→0.260. Logged honestly at the time.

**Finding 2 — the −62.5% number does not transfer to a new base.** It is a property of that base,
that dataset split, and that frozen rubric.

**R15.** Any proposal to replace the second-stage algorithm (DPO → GRPO or otherwise) SHALL be
pre-registered with a **data-depth control arm**, so the run distinguishes "the new algorithm helped"
from "the corpus grew." Absent that control the run SHALL NOT be scheduled, because T5 already
demonstrates the failure mode.

**R16.** Adopting a new base model SHALL re-run the full recorded sequence per model — rebuild → `t2`
gate → **re-run base eval on the new split** → train → tuned eval → `t3` gate → merge on `D:`. A
base-vs-tuned delta computed against a stale baseline SHALL be rejected.

### 5.2 Cost of the two-Gemma proposal

Stated so the owner can scope it, not to discourage it:

- Per model, serialised on the single eGPU: ≈100 min train + ≈1 h eval (with gen-match; ~15 min
  NLL-only) + merge staging on `D:` (~30 GB).
- A 12B QLoRA on the 16 GB host will hit the T5 constraint: `use_gradient_checkpointing=True` and
  `max_seq 512`. The default `"unsloth"` host-offload checkpointing swap-thrashed the host (pagefile
  peaked 9.4 GB) and killed two runs before that fix.
- Gemma-4-12B is currently the **generation** model LM Studio serves for LONGVIEW, and
  Gemma-4-E4B is already a Path-A roster entry. Neither is currently a trained house model.

**R17.** E4B and 12B SHALL be trained and gated as **separate** subjects with separate frozen rubric
hashes. A single "Gemma house model" result covering both SHALL be rejected.

**R17.1 — sequencing (owner decision, 2026-08-03).** The harness (EP-M) lands **before** any Gemma
training run, and the first trained subject SHALL be **E4B alone**. 12B is deferred until E4B has a
measured result on the EP-M instrument. Rationale: E4B is the cheap probe of the one question that
governs the 12B spend — *does a Gemma base beat Qwen2.5-Coder-7B on the house corpus?* — at roughly
100 min train + 1 h eval, and without the 16 GB checkpointing constraints that killed two T5 runs.
A negative E4B result cancels the 12B run; a positive one justifies it with evidence. Committing GPU
time to both bases before the harness can compare them would produce two numbers that cannot be
ranked against the incumbent.

**R18.** The training corpus SHALL remain leak-gated per the existing T2 pipeline; CV/job content
SHALL NOT enter training data, and quarantined sids SHALL remain excluded.

**R19.** Method and voice stay in weights; **facts stay in RAG**. No fact-recall rows from the
knowledge graph, per EP-T doctrine.

---

## 6. Non-functional requirements

**R20.** Local-first. No cloud dependency in the benchmark or training path.

**R21.** Additive. The harness SHALL NOT alter the behaviour of `pypes model-bench` or the EP-T eval
scripts for existing callers; both remain valid entry points during migration.

**R22.** Deterministic given a fixed roster, rubric hash, and seed, to the limit of model sampling —
and where sampling makes a metric non-deterministic, the harness SHALL report variance across
`repeats`, not a single sample presented as fact.

**R23.** Stateless and re-runnable: ten consecutive `run_multi_model` calls SHALL be safe (the
existing AOS-NFR9 property SHALL survive the addition of a real hook).

---

## 7. Evidence that closes this

Not "the code exists" — a measured number, per the house instrument:

1. `run_multi_model` produces a non-stub `SandboxResult` for ≥2 real models with all eight fields
   populated from observation, written to the sandbox report and the execution register.
2. One roster manifest evaluates a heterogeneous persona assignment end-to-end.
3. A deliberately unavailable model in the roster yields an `unavailable` row while the others
   complete (R7 negative control).
4. A rubric-hash mismatch is rejected (R10 negative control).
5. Verified by a **non-author** agent, per the delivery-board author≠verifier rule.

---

## 8. Proposed board text (for owner signature — not registered)

**Epic `EP-M` — Model plurality: evaluate, benchmark, promote.**
Objective O1 · Milestone TBD by owner · KR assignment TBD by owner.

| Task | Contract |
|---|---|
| `M0` | Roster schema + validator; rubric-hash freeze; self-judge rejection (R4–R8, R10). Red-first gate `scripts/gates/m0.mjs`. |
| `M1` | Real executor hook for `run_multi_model`; all eight metrics observed; `unmeasured` distinct from `0.0` (R1–R3). Gate `m1.py`. |
| `M2` | Unify Path A rubric into the Path B report so authoring and navigation land on one scale (R1). Gate `m2.mjs`. |
| `M3` | Ledger + lineage emission, serialisation, wedge detection by liveness evidence (R9, R12). Gate `m3.mjs`. |
| `M4` | Two-model live bench (incumbent vs one candidate), non-author verified (§7). Gate `m4.py`. |

| `M5` | First new base: **E4B alone**, trained on the existing proven SFT method, gated on the full R16 sequence and measured on the M1–M4 instrument (R17, R17.1). Gate `m5.py`. |

**Hard dependency: `M0` is blocked on `W2`.** Per the owner's 2026-08-03 ordering decision, EP-M does
not start until `node scripts/gates/w2.mjs` is green. Every EP-M contract carries `sandbox: worktree`
per `SPEC-work-contracts.md:22`; under W2 that becomes machine-enforced (changed-files ⊆ allowlist,
diff ≤ budget, declared tools preflighted) rather than honoured by discipline. W2 itself is unblocked
now that `w0` is green — its own dependency is `W1`.

**M5 is not blocked by R15.** R15 gates replacing the *second-stage algorithm* (DPO → GRPO). Training
a new base with the existing, proven SFT method is not that substitution, so E4B may proceed on
evidence from M4 without a data-depth control arm. **GRPO remains blocked** by R15 regardless of
which base is in use, and no GRPO task is proposed here.

---

## 9. Corrections to the superseded draft

Kept on the record so the reasoning is auditable.

| Draft claim | Correction |
|---|---|
| A two-stage SFT→**GRPO** pipeline is deployed. | No GRPO code exists anywhere in the estate. The built and verified pipeline is SFT→**DPO** (`scripts/train/dpo/`). GRPO is a proposal, and R15 gates it. |
| GRPO breaks the SFT "imitation ceiling." | Untested here, and the estate's own measurement points the other way: DPO gained +0.3% while data depth gained ≈4×. Presented as established fact, this would not survive verification. |
| A **Codebase-Memory MCP** provides SQLite-WAL storage, 66–158 languages, 99% token reduction, and a 6-strategy call-graph cascade at 0.95/0.55 confidence. | Not this system. Benny's MCP server exposes four tools — `plan_workflow`, `run_workflow`, `stream_events`, `get_run` — and no graph-navigation tools. The code graph is **Neo4j**, not in-memory SQLite. Those figures belong to a third-party product and must not be cited as prime-silo's. |
| Every agentic task **is** provisioned with an isolated Git worktree. | Specified (`SPEC-work-contracts.md:22`, `.worktrees/<id>`, branch `feat/<id>`) and declared in 87 contracts, but **not implemented** — provisioning is `W2` under `EP-W`, unbuilt. |
| Mutation testing probes agent-generated tests. | No mutation-testing tool is present in `runtime/`. |
| Diff-analysis against allowlists is an active gate. | Two corrections. (a) The gate's own status: `w0` was RED for a **validator parser defect**, now fixed — see the board note above. The widely-repeated claim that "contracts A0–C4 have empty allowlists and reference gates that do not exist" is **false**; those contracts are well-formed and each lists its own gate in its allowlist, exactly as `SPEC-work-contracts.md:23` permits. This document previously repeated that claim from a stale note and was wrong to. (b) Enforcement: even with `w0` green, allowlists are validated at authoring time but not enforced against a working tree — that is `W2`, unbuilt. |
| 26,457 `CodeEntity` nodes / 13,938 `Concept` nodes. | **Unverified** — Neo4j rejected authentication from the authoring session. A nearby recorded figure is 26,652 `CORRELATES_WITH` edges, which is a different quantity; do not merge them. Re-measure before this number reaches a board. |
| PRA SS1/23: P2 and P3 MET, P1/P4/P5 PARTIAL. | Directionally consistent with the v7 SAD (17/26 controls MET) and retained. P4 remains PARTIAL for the stated reason — author≠verifier is enforced by convention on the board, not organisationally. |

---

## 10. Decisions taken and questions still open

**Resolved by the owner, 2026-08-03:**

1. **`w0`** — fix drafted and verified green; awaiting the owner's commit/signature. The fix is one
   function in `server/coordination/work-schema/validate.mjs`; no contract was touched.
2. **W2 ordering** — W2 lands before EP-M (§3, §8). Isolation is machine-enforced, not conventional.
3. **Gemma sequencing** — harness first; first trained subject is **E4B alone**; 12B deferred pending
   E4B's measured result (R17.1).

**Still open:**

4. **KR assignment.** EP-T closed KR1.5. Which KR does model plurality move? Required before M0 can
   be authored — `okr` is a mandatory contract field and must resolve to exactly one
   `TRACEABILITY.md` row.
5. **Milestone.** EP-M needs a milestone (`M1`–`M8`) assigned.
6. **W1 status.** W2 declares `deps: [W1]`. W1's state on the board should be confirmed before the
   W2-first ordering is treated as costed.
7. **Graph node counts (R-adjacent).** The 26,457 / 13,938 figures remain unverified pending Neo4j
   credentials; §9 flags them.
