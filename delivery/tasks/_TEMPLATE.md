---
id: <ID> # e.g. C1
epic: EP-<X>
milestone: M1
okr: O<n>.KR<n>
deps: [] # task ids that must be DONE
authority: agent-ok # or human-signed
allowlist: [] # exact files/dirs this task may create/modify (tests implied)
tools: [] # required: node, python, pytest, preview, lemonade, mcp:<name>...
sandbox: worktree # or in-place
verify: <command> # must exit 0; the gate
budget: 400 # max changed lines (excl. tests/lockfiles)
---

# <ID> — <title>

## Goal

2-3 sentences. What exists after this task that didn't before, and why it matters (link the KR).

## Context pointers (never inline content)

- file:line refs, plan section, review docs, memory names, prior art

## TDD plan

Ordered list: which failing test to write first, then next. Tests named after scenarios.

## Acceptance (BDD — every Scenario must map to an automated test)

```gherkin
Feature: <capability>
  Scenario: <name>
    Given <precondition>
    When <action>
    Then <observable outcome>
```

## Out of scope

Explicit non-goals to prevent drift.

## Handoff

What the verifier re-runs; what docs/skills/board updates are part of DONE.
