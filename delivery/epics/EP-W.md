# EP-W — Deterministic delivery engine

**Objective:** O2 · **Goals:** P9 · **Milestone:** M1
**Plan source:** `../../architecture/PLAN-local-power-unified-ui.md` (workstream W)

Work items as declarative contracts (this delivery/ directory is the seed); `work next` returns exactly one item; sandbox+tool provisioning enforces allowlists; dogfood proof: a phase delivered without reading the plan.

## Phases → task contracts

- [ ] `W0` — contract format + validator + plan→backlog conversion (formalizes delivery/tasks)
- [ ] `W1` — `work next` deterministic selector + delivery loop
- [ ] `W2` — sandbox + tool provisioning (worktree, allowlist enforced, preflight)
- [ ] `W4` — harden W2's enforcement: the purity check is evadable (proven by its verifier) and the verify spawn concatenates args
- [ ] `W3` — dogfood proof (no plan-file read; author≠verifier chain in ledger)

## Exit

All phase gates green, verified by non-author agent; close with a VISION-CHECK note (plan §0.5):
which KRs moved, measured evidence, one honest sentence on drift.
