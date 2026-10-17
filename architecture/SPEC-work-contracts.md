# SPEC — Work contracts (W0)

> A work item is to human/agent work what a pypes manifest is to data work: a declarative,
> versioned contract executed by small composable services (selector W1, sandbox W2, verifier).
> Validator: `server/coordination/work-schema/validate.mjs` · Gate: `node scripts/gates/w0.mjs`
> Canonical backlog: `delivery/tasks/` (one markdown file per item; `backlog/` naming is superseded).

## Format (one file, `delivery/tasks/<ID>.md`)

YAML frontmatter — all fields required unless noted:

| field       | rule                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `id`        | equals the filename; `[A-Z]\d+` or `M2-\d+`                                                        |
| `epic`      | an existing `delivery/epics/EP-*.md`                                                               |
| `milestone` | any `M<n>` with a `delivery/milestones/M<n>-*.md` file                                             |
| `okr`       | non-empty; the id must sit in exactly one `TRACEABILITY.md` row                                    |
| `deps`      | task ids; must resolve; must equal `plan-deps.json` (the machine-readable plan §12)                |
| `authority` | `agent-ok` or `human-signed`                                                                       |
| `allowlist` | non-empty repo-relative paths; each path (or its top segment) must exist; no `..`                  |
| `tools`     | non-empty (node, python, pytest, preview, lemonade, mcp:\<name\>, …) — W2 preflights these         |
| `sandbox`   | `worktree` (default; `.worktrees/<id>`, branch `feat/<id>`) or `in-place`                          |
| `verify`    | the gate command; a referenced `scripts/gates/*` file must exist or be in the item's own allowlist |
| `budget`    | max changed lines (excl. tests/lockfiles), positive int                                            |

Body sections: `## Goal` (2–3 sentences) · context pointers (**never inlined content** — file:line,
plan §, memory names) · TDD plan · `## Acceptance` with at least one gherkin `Scenario:` (every
scenario maps to an automated test) · out of scope · handoff.

## Budgets

Target ≤ ~600 tokens per contract; hard ceiling **1500 estimated tokens** (`ceil(chars/4)`) —
sized to the largest legitimate exemplar (Q0). Over the ceiling = split the contract.

**Granted oversize (2026-10-17).** Seven contracts the owner signed as written in October 2026 are
2480–3843 tokens, because they carry folded-in owner direction and measured numbers: S21–S24
(the librarian), U0 and U1 (the drive registry and the owner's data) and K0 (the capacity report).
Splitting them would rewrite signed scope, so each is named in `OVERSIZE_GRANTED` in the validator
**at the size it was measured at** and the 1500 ceiling stays in force for every other contract.
The recorded size is a pin, not a licence: a listed contract that grows past it fails the gate
again, which forces a deliberate re-grant instead of silent creep. Adding an id to that list is a
scope act — prefer splitting.

## State lives on the board, never in the file

Contracts are immutable once signed (amendments are logged authoring defects, Q0 precedent).
`todo/claimed/verify/done/blocked` is derived from `delivery/board/BOARD.md` + `LOG.md` today and
from the B-ledger after B2. The validator asserts every task id appears **exactly once** across
board columns (AUTHORED = deps not yet DONE) and exactly once in `TRACEABILITY.md`.

## Scope enters through the plan

`plan-deps.json` mirrors plan §12 (+hotfix ids) and is updated only with a plan rev. A task file
without a plan phase, or a phase without a task file, fails the gate — nothing is lost, nothing is
invented. The dependency graph must be acyclic.
