---
name: phase-runner
description: DRAFT — pick up and deliver one delivery/tasks/ work contract under the six-sigma protocol (deterministic selection, TDD, allowlist discipline, author≠verifier). Use when asked to "take the next task", "work the board", or deliver a specific task id. Full mechanization lands with W1 (work next) and W2 (sandbox provisioning).
---

# Phase runner (draft — manual protocol until W1/W2 land)

1. **Read the protocol once:** `delivery/README.md`. It is binding; this skill is its checklist.
2. **Select:** open `delivery/board/BOARD.md`, take the TOPMOST item in READY. Never choose.
3. **Claim:** move its line to CLAIMED (`· <agent> · <ISO date>`), append a `claimed` line to
   `delivery/board/LOG.md`, commit `chore(delivery): claim <ID>` BEFORE working.
4. **Sandbox:** `git worktree add .worktrees/<ID> -b feat/<ID> main` (contract `sandbox: worktree`).
   Work only inside it. Never restart services a live run depends on.
5. **Read ONLY your contract** (`delivery/tasks/<ID>.md`). Insufficient contract = log
   `blocked: contract insufficient — <missing>` and stop. Never improvise scope.
6. **TDD, in order:** failing test (run it, observe red, commit) → implement → green → refactor.
   Name tests after the contract's `Scenario:` lines. Respect the allowlist and `budget`.
7. **Verify:** run the contract's `verify` command until exit 0 from a clean tree. Lint/format
   touched files. Validate contracts changed: `node scripts/gates/w0.mjs`.
8. **Hand off:** move the board line to VERIFY + append `ready-for-verify` to LOG (honest
   deviations included), commit on main. You may NOT move your own task to DONE — a fresh
   clean-checkout session with a distinct identity re-runs the gate (README rule 7).
9. **Blocked twice = stop.** Append `blocked` with the exact error and what you tried.

Log format: `<ISO-ts> | <task-id> | <event> | <agent> | <note>` — append-only, never edit history.
