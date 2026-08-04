# EP-M — Model plurality: evaluate, benchmark, promote

**Objective:** O1 · **Goals:** P1,P9 · **Milestone:** M9
**Plan source:** `../../architecture/SOLUTION-model-plurality.md` (workstream M, plan rev 2026-08-03)

Make the agentic SDLC **measurably** model-plural. The estate can train a model (EP-T, closed) and
serve one behind the router (T4), but cannot answer "is model B better than model A at driving _our_
agent loop" with a number. That is a harness problem, not a training problem: `run_multi_model` has
eight agentic metrics and has never produced a real one, because `hook` defaults to a stub returning
zeros for every field.

Task ids are `P0`-`P5`, not `M0`-`M5`: M-prefixed ids are milestone-scoped by convention
(`M2-1`..`M2-8` are live on the board), so M-numbered task ids would be ambiguous.

## Phases → task contracts

- [ ] `P0` — roster schema + validator; rubric-hash freeze; self-judge rejection
- [ ] `P1` — the metric schema: `unmeasured` structurally distinct from `0.0`; `hook=None` raises
- [ ] `P6` — the executor hook: subject → run → G0 event stream folded into the eight fields
      _(P1 was split in two on 2026-08-04 by owner decision — the original measured 673 lines
      against a budget of 550. P6 is numbered out of sequence because contract ids must match
      `[A-Z]\d+`; `P1a`/`P1b` are not valid ids. Order is set by deps, not by number: P2 now
      depends on both.)_
- [ ] `P2` — fold the planner rubric into the navigation record; one scale, no composite
- [ ] `P3` — ledger + lineage emission, serialised execution, wedge detection by liveness
- [ ] `P4` — two-model live bench, non-author verified (closes the epic)
- [ ] `P5` — first new base: E4B alone, existing SFT method, full R16 sequence

## Exit

All phase gates green, verified by a non-author agent; close with a VISION-CHECK note (plan §0.5):
KR1.6 moved, measured evidence (the two-subject ranking on the frozen rubric), one honest sentence on
drift. **GRPO stays blocked** by R15 regardless of base; 12B stays deferred pending P5's result.
