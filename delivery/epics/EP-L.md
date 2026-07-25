# EP-L — LONGVIEW flywheel (self-learning substrate)

**Objective:** O1 + O2 · **Goals:** P1,P2,P9 · **Milestone:** M4 (wave 1); waves 2–3 follow
**Plan source:** `../../architecture/SOLUTION-longview-self-learning.md` (design §4–§6, authored
2026-07-25) tracing `REQUIREMENTS-longview-self-learning.md` R1–R45 + the 11 owner steers (§6.1).

Turn LONGVIEW + EP-T into **one compounding, measured loop**: multi-machine sessions → staged raw on
the portable drive → bi-temporal, additive, delta synthesis → knowledge → dataset → tuned model →
served behind the router → agents → better sessions (repeat, measured each turn). The whole must be
worth more than the sum of the parts — a true self-learning system that gets better as we expand.

**The one idea:** the repo already runs three append-only, chain-hashed, `fold(events)→state`,
non-blocking logs (B0 coordination, G0 run-events, delivery LOG). EP-L adds **one more of the same
shape** — the **knowledge event log (KEL)** as truth — and makes Neo4j / Chroma / memo-ray / cards /
the execution register **rebuildable projections** off it. Reuse the doctrine; don't rebuild it.

## Phases → task contracts (wave 1 — the substrate)
- [ ] `L0` — knowledge event log: envelope (bi-temporal + HLC + confidence + authorship + schema-version
  + prev-hash), chain-hash validator, fold-to-state, converter registry *(human-signed — the substrate's
  constitution)*
- [ ] `L1` — CAS staging on D: (blobs + human-navigable index + self-describing manifest), de-dup,
  plug-and-play *(human-signed)*
- [ ] `L2` — inbound poison gate (integrity boundary symmetric to the outbound leak gate) at admission
- [ ] `L3` — durability: replicate staging + KEL, checksum integrity check + restore drill *(human-signed)*
- [ ] `L4` — delta engine: per-content-hash cursors, idempotent/resumable, HLC ordering-tolerant
- [ ] `L5` — unified execution register (`executions.jsonl`) folding G0 + train JSONs + LONGVIEW ledger
  + B0 ledger + KEL lineage; backfilled (DuckDB fallback deferred, measure-first)
- [ ] `L6` — authorship (human/frontier/house) + record-served tagging at capture time
- [ ] `L7` — single-winner loop claim (reuse B0 `wx` lease) + compaction/storage budget

## Later waves (authored at their own checkpoints)
- Wave 2 — bi-temporal projectors + privacy-honoring history (`L8`, `L9`).
- Wave 3 — closed loop + agent loops + safety guards (`L10`–`L14`): flywheel-daemon, model-collapse
  guard, human-signed promotion + rollback, promotion decision function, compound-value triad dashboard.

## Exit
All wave-1 phase gates green, verified by non-author agent; close with a VISION-CHECK note (plan §0.5):
which KRs moved (KR2.2 unified stream extended to knowledge truth; KR1.5 corpus quality), measured
evidence (raw staged + de-duped on D:, delta idempotent, register cross-machine-comparable, projections
rebuild from the log), one honest sentence on drift. Privacy invariant held: leak-gate/quarantine at
every boundary; job-application/CV content never enters knowledge or training (R31).
