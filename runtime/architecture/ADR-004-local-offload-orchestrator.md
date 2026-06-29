# ADR-004: Local Offload Orchestrator — Route Execution to Benny, Reserve the Planner for Strategy and Adjudication

| Field      | Value                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Status     | Accepted (Phase 0–4 implemented; generate+judge verified live against Lemonade 2026-06-29)      |
| Date       | 2026-06-29                                                                                      |
| Authors    | Binary 16 (engineering authority)                                                              |
| Related    | ADR-001 (determinism boundary / agent_sandbox), opencode audit pattern, memo-ray token-audit   |

---

## 1. Problem

Driving Prime-Silo development through a cloud planning agent (Claude Code,
Antigravity) burns credits/tokens on work a local model could do. The operator's
hypothesis: **≥75% of execution tasks are offloadable**, which would free the
planner's budget for planning and strategy.

## 2. The one insight that shapes the design

**Offloading *execution* to a local model does not, by itself, save the planner's
tokens.** The expensive resource is tokens flowing **through the planner's
context** — so if the planner reads the full local output back, nothing is saved.
The savings come from three disciplines:

1. The planner writes a **compact manifest** instead of doing the work.
2. An **evaluation gate** absorbs verbose output **locally**.
3. The planner reads back only a **digest + verdict**, and is escalated to only on
   failure or ambiguity.

This reframes "MCP sub-agent vs. async queue": it is **both, behind one gate**.
The async/manifest lane is what unlocks the bulk; the gate is what makes it safe.

## 3. Decision

A **local-first executor with an audit gate**, composed from primitives Prime-Silo
already has (workflow manifests, the integration-audit pattern, the vision
fidelity judge, the MCP server, the `resolve_executor` local-model layer):

- **Contract** — `aamp.offload_task/1` (`manifests/offload/task.manifest.schema.json`).
  Planner authors `intent` + testable `acceptance_criteria` + `risk_tier`.
- **Router** (`benny/core/offload/router.py`, `router.matrix.json`) — classifies
  green / yellow / red. May **upgrade** a tier, never silently downgrades.
  Guarded paths (`L1/ L2/ manifests/`, signing) and security intents force red.
- **Executor** (`executor.py`) — `shell` (codemods/scaffolds) or `generate` (local
  model via `resolve_executor`). Output is a *proposed artifact*, never a direct
  write to the deterministic zone.
- **Gate** (`gate.py`) — deterministic checks first (build/lint/type/test, every
  `verify` command, all must exit 0); then, for yellow only, an **LLM judge**
  scores the artifact against the acceptance criteria.
- **Orchestrator** (`orchestrator.py`) — ties submit → route → execute → gate →
  digest; persists the full artifact to the workspace **outbox** and returns only
  a compact **digest** to the planner.
- **Ledger** (`ledger.py`) — append-only JSONL of honest components for
  measurement.

### Two lanes, one gate

- **Sync (MCP):** `offload_exec` tool → `POST /api/offload/submit?wait=1` → digest
  inline. For small bounded tasks the planner needs now.
- **Async (queue):** `enqueue` → inbox → `scripts/offload-runner.mjs` drains →
  outbox + digest. The default for bulk work — the "less synchronous" path.

## 4. The routing rule

> **If you can write crisp, testable acceptance criteria up front, the task is
> offloadable. If defining "done" needs judgment, the planner keeps it.**

| Tier      | Examples                                                            | Handling                         |
| --------- | ------------------------------------------------------------------ | -------------------------------- |
| 🟢 green  | scaffolds, codemods, test stubs, doc-gen, formatting, dep bumps     | deterministic gate only          |
| 🟡 yellow | feature against a spec, bug fix with a repro, multi-file edit       | deterministic gate **+ judge**   |
| 🔴 red    | architecture, ambiguous reqs, security/signing, deterministic zone  | **escalate — never offloaded**   |

**`shell` vs `generate` — what the gate can actually validate.** A `shell` task
acts *in place*, so the deterministic gate validates the real effect → it can be
true green. A `generate` task produces an *unapplied proposal* in the outbox
(ADR-001); deterministic checks run against the unchanged repo and cannot validate
it. So the router **upgrades every generate task to yellow** and the gate
**refuses to auto-pass** a generate proposal without a judge — the judge reading
the artifact is the only valid evaluator for unapplied output. (Found while
preparing to run a `generate` docstring task on real code: it would have "passed"
deterministic checks against the stale file — a false pass this rule prevents.)

## 5. Anti-collusion

The judge model SHOULD differ from the executor model; same-model self-judging
rubber-stamps (the strawman failure mode from the memo-ray token-audit). The gate
**flags** `judge == executor` and treats that judgment as low-confidence. The
deterministic checks are the hard backstop the judge can never override.

**Judge reliability is the current weak link (measured).** See
`manifests/offload/JUDGE-CALIBRATION.md`. On this box the small local judges are
not reliable enough to *pass* work: the 0.5B false-positived broken code (0.9), so
the default judge is `Phi-4-mini-instruct-NPU` whose failure mode is *safe* (it
rejects bad work / escalates good work rather than rubber-stamping). Consequence:
**reliable savings come from GREEN deterministic tasks**; YELLOW judged tasks often
escalate even when good, until a more capable non-reasoning judge model is
available. `run_judge` forces `response_format: json_object`, retries once, and
parses the last balanced JSON to maximize what reliability is achievable.

**Pick a fast *non-reasoning* instruct model as judge.** Live finding (2026-06-29):
`deepseek-r1-8b-FLM` as judge spent its whole token budget reasoning in prose and
never emitted the JSON verdict — so every judgment came back unscored and escalated,
defeating the gate. Reasoning models belong on the **executor** (hard generation),
not the judge (quick structured scoring). `run_judge` is hardened to survive a
reasoning judge anyway — it requests thinking-off (`enable_thinking: false`), gives a
larger budget, and parses the **last** balanced JSON object (ignoring leading
chain-of-thought / `<think>` blocks) — but a small instruct judge (e.g.
`Qwen2.5-0.5B-Instruct-CPU`, the default) is faster and more reliable.

## 6. ADR-001 boundary (why this is safe)

The executor writes only into `$BENNY_HOME/workspaces/<ws>/offload/` (scratch /
outbox). Promotion of a passing result into `manifests/` / L1 / L2 stays a
**human-signed** step — the existing `drafts/ → HITL → sign_manifest()` flow. The
gate is the machine pre-filter in front of the human gate, not a replacement.

## 7. Honesty / measurement

Per the memo-ray token-audit lesson, **measure** the savings, don't assert them.
`scripts/offload-report.mjs` reports the **offload rate** (passed locally without
escalation), the **read-back cost** (digest chars the planner consumed), and a
clearly-labelled **estimate** of saved completion tokens. 75% is a target to reach
in the ledger, not a number to claim.

## 8. Status / what is and isn't verified

- ✅ Phase 0 contract; router; deterministic gate; orchestrator control-flow;
  red-escalation; outbox/digest discipline; ledger; MCP tool; runner; report —
  all implemented and covered by `tests/core/test_offload.py` (network-free).
- ✅ **Verified live (2026-06-29):** end-to-end `generate` + judge against
  Lemonade. Default executor `qwen3.5-9b-FLM` produced clean, correct code
  (no reasoning-dump), judge `Qwen2.5-0.5B-Instruct-CPU` (distinct model,
  `collusion: False`) scored 0.95 → passed in 1 iteration, digest 512 chars while
  the artifact stayed in the outbox. (`qwen3-tk-4b-FLM` also passed at 0.85 but
  buried the code in chain-of-thought — hence 9b is the default.) An earlier run
  confirmed honest **escalation** when the executor model 500'd (GGUF/llamacpp +
  NPU recipes fail to load `llama-server` on this box).
- ⚠️ **Still unverified:** the actual offload *rate* on a real task stream — the
  ledger is the instrument to validate the 75% hypothesis; needs volume.

## 9. Consequences

- The planner's budget shifts toward planning/adjudication.
- New surface to maintain (router matrix, gate). Mitigated by reuse + tests.
- Risk: output bloat back into context — mitigated by strict digest discipline
  (enforced + tested). Risk: silent quality erosion — tracked via escalation rate
  and (future) defect-escape rate in the ledger.
