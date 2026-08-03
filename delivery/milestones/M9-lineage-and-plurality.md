# M9 — Lineage closure + model plurality → **v1.22.0**

**Scope (committed, plan rev 2026-08-03; sources `architecture/REVIEW-delivery-lineage-2026-08-03.md`
and `architecture/SOLUTION-model-plurality.md`):**

**Lineage (EP-B/EP-L — closes KR2.2, makes KR2.4 auditable):** B4 delivery board → B0 ledger, so the
board becomes a projection rather than a second source of truth · B5 wire L5's `fromCoordEvent` into a
live execution-register projection with idempotent backfill · L15 OpenLineage RunEvents for the
delivery lifecycle plus a coordination source in the lineage DAG · L16 move the dashboard out of
`scratch/` into a versioned, gated path.

**Plurality (EP-M — KR1.6):** P0–P4 build the benchmark instrument; P5 trains the first new base
(E4B alone).

**Why:** the 2026-08-03 review found three of four hops open between a delivery decision and the
lineage DAG. KR2.2 already required this and was unmet; KR2.4 asks for an audit "of board/LOG.md /
ledger" that cannot be run while delivery verification lives in markdown prose.

**Not in scope:** GRPO (blocked by R15 pending a data-depth control arm); Gemma-12B training
(deferred until E4B has a measured result).
