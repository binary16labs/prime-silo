# Local Offload Orchestrator — the Claude↔Benny contract

> Goal: route the bulk of *execution* to the local model (Benny) so Claude's
> tokens/credits are spent on **planning, strategy, and adjudication** — not on
> typing out boilerplate and reading verbose output back.

## The one insight that shapes everything

Offloading *execution* to a local model does **not** save tokens on its own. The
expensive resource is tokens flowing **through the planner's context** — so the
savings come from three disciplines, not from "Benny ran the command":

1. The planner writes a **compact manifest** instead of doing the work.
2. An **evaluation gate** absorbs verbose output **locally**.
3. The planner reads back only a **digest + verdict**, and is pulled in only on
   failure or ambiguity (**escalation**).

If the planner reads the full output back, you saved nothing. Digest discipline
is the product.

## The routing rule

**If you can write crisp, testable acceptance criteria up front, the task is
offloadable. If defining "done" needs judgment, the planner keeps it.**

| Tier      | What                                                                 | Handling                                  |
|-----------|---------------------------------------------------------------------|-------------------------------------------|
| 🟢 green  | scaffolds, codemods, test stubs, doc-gen, formatting, dep bumps     | deterministic gate only, auto-pass        |
| 🟡 yellow | feature against a spec, bug fix with a repro, multi-file edit       | deterministic gate **+ LLM judge**        |
| 🔴 red    | architecture, ambiguous reqs, security/signing, deterministic zone  | **escalate to planner — never offloaded** |

`router.matrix.json` encodes this and may **upgrade** a declared tier (it never
silently downgrades). Touching `L1/ L2/ manifests/` or signing keys forces red.

## The gate (cheapest check first)

1. **Deterministic** (free): `eval_plan.deterministic` commands + every
   acceptance-criterion `verify`. Every one must exit 0. Most failures stop here.
2. **LLM judge** (yellow only, only if deterministic passed): scores the result
   against `acceptance_criteria`, returns `score` + `rationale`.
3. **Planner adjudication**: only on gate failure (budget exhausted) or
   low-confidence, per `escalation_policy`.

⚠️ **Anti-collusion:** the judge model SHOULD differ from the executor model.
Same-model self-judging rubber-stamps. Every judgment is anchored by the
deterministic checks regardless — the judge can never *override* a red gate.

## ADR-001 boundary (why this is safe)

Benny's executor writes only into the workspace **offload scratch** zone
(`$BENNY_HOME/workspaces/<ws>/offload/`), never the deterministic zone. Promotion
of a passing result into `manifests/` / L1 / L2 remains a **human-signed** step —
exactly the existing `drafts/ → HITL → sign_manifest()` flow. The gate is the
machine pre-filter in front of that human gate, not a replacement for it.

## Files

- `task.manifest.schema.json` — `aamp.offload_task/1` JSON Schema (the contract).
- `router.matrix.json` — `aamp.offload_router/1` risk matrix + upgrade signals.
- `examples/green-docstrings.task.json` — deterministic-only task.
- `examples/yellow-bugfix.task.json` — judged task with escalation.

## Lanes

- **Sync (MCP):** `offload_exec` tool → `POST /api/offload/submit?wait=1` →
  returns a compact digest inline. For small bounded tasks the planner needs now.
- **Async (queue):** drop a manifest in the inbox → `scripts/offload-runner.mjs`
  drains it → results land in the outbox → planner notified with a digest. The
  default for bulk work.

## Honesty

Per the memo-ray token-audit lesson: **measure** the savings, don't assert them.
`scripts/offload-report.mjs` reads the ledger and reports
*planner-tokens-saved-estimate*, local pass-rate, and escalation rate. Do not
claim "75% offloaded" until the ledger shows it.

See `runtime/architecture/ADR-004-local-offload-orchestrator.md` for the full design.
