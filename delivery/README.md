# Prime-Silo Delivery System

> **You are an agent pointed at this folder. Everything you need is here. Do not begin work until you have read this file.**
> Source narrative: `../architecture/PLAN-local-power-unified-ui.md` (rev 10+). This directory is its executable form.

## The hierarchy (traceability, top to bottom)

```
OKR.md                → Objectives & Key Results (the "why" — quarterly truth)
epics/EP-*.md         → One epic per workstream (the "what area")
milestones/M*.md      → Release-bound scope (the "when/version")
tasks/<ID>.md         → Work contracts with BDD acceptance (the "do this")
board/BOARD.md        → Kanban state (the "where is everything")
board/LOG.md          → Append-only event log (the "what happened")
TRACEABILITY.md       → The full OKR→epic→milestone→task matrix
```

Every task traces up: `task → epic → milestone → OKR`. A task that cannot name its chain is invalid.

## Agent operating protocol (six-sigma rules — mandatory)

1. **Select deterministically.** Open `board/BOARD.md`. Take the **topmost task in the READY column**. Not your favorite — the topmost. If READY is empty, stop and log `blocked: no ready tasks`.
2. **Claim it.** Move its line to CLAIMED with your agent name + ISO date. Append a `claimed` line to `board/LOG.md`. Commit this before starting work (`chore(delivery): claim <ID>`).
3. **Read only your contract.** The task file contains everything: goal, allowlist, tools, acceptance. You should not need to read the whole plan. If the contract is insufficient, that is a defect — log `blocked: contract insufficient — <what's missing>` and stop.
4. **TDD order is mandatory.** For each acceptance scenario: (a) write the failing test first, (b) run it and observe it fail, (c) implement, (d) run it green, (e) refactor. Commit tests with or before implementation, never after.
5. **BDD scenarios are the acceptance criteria.** Every `Scenario:` in the contract must map to at least one automated test (or scripted check for infra tasks). Name tests after scenarios so the mapping is greppable.
6. **Respect the allowlist.** Only create/modify files the contract lists (plus its tests). Needing another file = `blocked`, not improvisation. Never touch: `node_modules/`, `dist/`, `archive/`, `memoray/` (vendored), `L1/`, `L2/`, any live run workspace.
7. **Verify before handoff.** Run the contract's `verify` command. It must exit 0. Then move the board line to VERIFY and log `ready-for-verify`. **You may not move your own task to DONE** — the independent verifier re-runs `verify` from a clean checkout and moves it to DONE with a `verified-by` log line (author ≠ verifier, no exceptions).
   **Sequential-session provision:** when the other agent isn't running concurrently, verification is performed by a **fresh session with no shared context**: either the other harness run later (preferred — Claude↔Antigravity), or a clean-checkout subagent/new session of the same harness that (a) reads only the contract + this README, (b) did not author any of the diff, and (c) logs `verified-by` with a distinct identity (e.g. `claude-verifier`, `antigravity-verifier`). What makes verification independent is *fresh context + clean checkout + re-derived verdict*, not the brand of the model. Do not park work waiting for a human unless the contract is `human-signed`.
8. **Log everything, invent nothing.** Every state change = one line in `board/LOG.md` (append-only, never edit history): `<ISO-ts> | <task-id> | <event> | <agent> | <note>`. Honest failures are logged as failures. "Should work" is not a state.
9. **Two strikes → blocked.** Same failure twice = stop, log `blocked` with exact error + what you tried. Do not redesign around the contract.
10. **Small diffs.** Respect the contract's `budget` (changed lines). Over budget = split request via `blocked`, not a big PR.

## Observability & transparency (for the owner)

The board and log ARE the observability: `git log --oneline -- delivery/` shows all delivery activity;
`board/BOARD.md` is the kanban at a glance; `board/LOG.md` greps to any task's full history.
When Workstream B lands, LOG.md events migrate to the coordination ledger and the Bridge renders this
board live (plan B3 — scrum/kanban lanes). Until then, this file-based board is canonical. Lose nothing.

## Standards in force

- **BDD:** Gherkin (`Given/When/Then`) in every contract's Acceptance section.
- **TDD:** red→green→refactor, tests named after scenarios.
- **Agile SDLC:** kanban flow (READY→CLAIMED→VERIFY→DONE, WIP limit 1 per agent); milestones are the
  sprint-equivalent release trains (see `milestones/`); epics group scope; OKRs steer priority.
  Retro = the VISION-CHECK note each epic closes with (plan §0.5).
- **Versioning:** semver per milestone (`milestones/*.md` name the target release).
- **Definition of Done (every task):** all scenarios green · verify exits 0 · lint/format clean ·
  allowlist respected · board+log updated · independent verifier confirmed · docs/skills touched if
  the contract says so.

## Standing approvals (owner-granted, plan rev 11)

- **Backend edits for Workstreams B, G, Q, W** (`server/`, `runtime/`, `commands/`) are pre-approved
  *within each contract's allowlist* — coordination, atomic leases, SSE, run-event streams, and security
  remediation are backend-owned by design (root `/AGENTS.md` justification satisfied). No per-PR pause needed.
- **Canonical backlog location:** `delivery/tasks/` — the plan's earlier `backlog/` naming is superseded;
  never create a parallel backlog directory.
- **Antigravity protocol doc:** rendered to `delivery/AGENTS.md` (once W0's build step exists), with only
  an index line in root `/AGENTS.md`.

## Authoring new tasks

Only via `tasks/_TEMPLATE.md`, only tracing to an existing epic+milestone, only within a plan rev
(scope enters through the plan, never through a task file). Frontier agent (Claude) authors/splits
contracts at the checkpoints defined in plan §3.5; humans approve `authority: human-signed` items.
