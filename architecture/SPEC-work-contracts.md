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

## Budget bands (2026-10-20)

**The budget is declared when the contract is authored, and it is a maximum, not an opening bid.**
Before this, every substantive contract had its budget raised mid-flight - S21 600->680->800, S22
600->800->900, C3 300->1100 - four amendments, each a round trip to the owner in the middle of the
work. The number was a guess made before anything was measured, so it was wrong roughly half the
time and always in the same direction.

A contract declares `band` alongside `budget`, and the budget IS the band's figure. The bands are
measured against what work of each shape has actually cost in this repo, docs and gate included,
because the contract mandates those too (115 of S22's 883 lines were its own required docs and gate):

| Band | Budget | What it covers                                                                        |
| ---- | ------ | ------------------------------------------------------------------------------------- |
| `S`  | 300    | one surface, one doc, a gate fix, a hotfix                                            |
| `M`  | 500    | one library or one route set, with its tests                                          |
| `L`  | 800    | two layers - a library and its routes, or routes and a panel                          |
| `XL` | 1000   | the full stack: a library, its routes, an agent surface, the mandated docs and a gate |

**How the lines are counted.** Pinned here because it was undefined, and claude-s22-verifier-2
showed the same finished work measuring 923, 990 or 856 depending on the convention chosen - which
makes any band argument unfalsifiable. The figure is **added lines only**, from a **three-dot diff
against the merge base**, **excluding the contract file itself and everything under `tests/`**.
Deleted lines do not offset added ones: replacing 50 lines with 50 costs 50, because the budget
measures how much is written, not how much the file grew. `delivery/board/` is excluded too — the
Definition of Done makes every task write there, so counting it would charge an author for the
protocol itself.

**The budget follows the contract, not the branch.** A change an author makes in service of a
contract counts against that contract wherever it is committed, including straight to `main`.
Without this the figure is one the author can move by choosing where to commit, which is exactly
what happened in S22: a spec change made during that contract went to `main` and so escaped its
budget. If a change genuinely belongs to no contract, say which in the log before committing it, so
the claim is on the record and can be disagreed with. Formatter reflow counts, so run the
formatter before measuring rather than after arguing about it.

**XL is the ceiling.** Nothing is authored above 1000. Work that does not fit XL is two contracts,
and the split is decided while authoring - before any code is written - not discovered at line 880.

**What to do when the work does not fit.** Stop and split; do not ask for more. The one exception is
a verifier's FAIL whose fixes land outside the band: that is new information rather than a bad
estimate, and it is logged as `blocked` with the measured overrun for the owner to rule on.

Contracts authored before this rule keep their budgets and need no `band`; the validator checks the
pair only where `band` is declared, and refuses any band figure above the XL ceiling.

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
