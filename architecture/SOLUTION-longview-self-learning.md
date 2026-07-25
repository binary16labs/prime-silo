# Solution Design — LONGVIEW self-learning system (the flywheel)

**Status:** NOT STARTED — this is the **design-session mandate / handoff**, authored by the
requirements session so the design session has a defined starting point and definition-of-done.
The design session fills §3–§7 below; do not treat the empty sections as decisions already made.

**Companion (read first, authoritative):**
[`REQUIREMENTS-longview-self-learning.md`](REQUIREMENTS-longview-self-learning.md) — R1–R45 + the
11 open questions. This solution doc traces every design choice back to an R#.

**Handoff author:** claude-opus (requirements+review session), 2026-07-25. **Design author:** _TBD._

---

## 1. Mandate (what this session produces)

Per the owner instruction that requirements and design are separate sessions, the requirements doc
states *what* and *why*; **this session states *how*** and breaks it into deliverable tasks. Produce:

1. **Solution design** — the architecture that satisfies R1–R45 (bi-temporal + additive + delta
   substrate; execution register; portable staging; the closed measured loop; agent loops).
2. **Schema / DDL** — concrete stores and shapes: the bi-temporal keys, staging manifest + blob
   layout on **D:**, execution-register schema, delta watermark/cursor placement.
3. **Task breakdown** — work contracts for the delivery board (`SPEC-work-contracts` format;
   red-first gates; `author≠verifier`), sequenced by the wave phasing below.

Out of scope (unchanged from requirements §3): replacing the model/training method — **EP-T stands**;
any cloud dependency — **local-first is a hard constraint**.

## 2. Definition of ready (gate BEFORE design proceeds)

Per requirements §7, design is "ready" once the owner has:
- accepted/amended/rejected each **R1–R45**;
- given a steer on each of the **11 open questions** (§6 + §9.3), or explicitly deferred it here;
- confirmed the §9.5 phasing (Tier 1 → wave 1) and the R17 "stage raw to D: now" quick win.

**Status of that gate at handoff:** the requirements doc is still `DRAFT for owner review` — the R#
sign-offs and open-question steers are **not yet recorded**. The design session should either work
against confirmed steers, or, where it must proceed, record its assumption explicitly and flag it
back for owner confirmation (do not silently decide an open question).

## 3. Decisions to make (the 11 open questions — design fills these)

The design session resolves these; each becomes a design choice traced to its open question. _(Leave
the owner steer inline once given; otherwise mark **ASSUMED** and flag.)_

| # | Question (short) | Steer / decision | Traces |
|---|------------------|------------------|--------|
| 1 | Bi-temporal storage: temporal columns vs event-sourced projection | _TBD_ | R1–R4 |
| 2 | Staging format on D: (blob+manifest vs dir-per-machine-per-day; memo-ray reconciliation) | _TBD_ | R17–R20 |
| 3 | Delta watermark granularity + cursor location | _TBD_ | R8 |
| 4 | Execution-register: unify vs federate (train JSONs + LOG + LONGVIEW ledger + lineage) | _TBD_ | R12–R16 |
| 5 | Loop trigger/orchestration + cross-machine claim (single-winner) | _TBD_ | R28, R43 |
| 6 | Compound-value headline metric | _TBD_ | R26 |
| 7 | Multi-machine identity + clock skew (logical vs wall) | _TBD_ | R11 |
| 8 | Bi-temporal backfill of existing corpus without fabricating valid-times | _TBD_ | R2, R3 |
| 9 | Semantic conflict resolution (contradictory facts, same valid-time) | _TBD_ | R11 |
| 10 | Schema evolution across bi-temporal history (replayability) | _TBD_ | R32 |
| 11 | Loop-level liveness / dead-man switch + resource-thermal abort | _TBD_ | R35 |

## 4. Architecture — _design session authors_
_(Reuse, do not rebuild, the foundation in requirements §2: LONGVIEW ADR-005 pipeline; memo-ray /
Chroma / Neo4j / cards; leak-gate + teleport; execution register + OpenLineage; EP-T T2/T3/T4/T5 +
`house-trainer`; the delivery board.)_

## 5. Schema / DDL — _design session authors_

## 6. Task breakdown (delivery-board work contracts) — _design session authors_

## 7. Phasing (from requirements §8 + §9.5 — design sequences tasks onto these)

1. **Wave 1 — substrate:** R17–R21 staging + R8–R11 delta + R12–R16 execution tagging, **plus the
   Tier-1 guards slotted here (§9.5):** R40 poison gate + R41 durability with staging; R38 authorship
   *tagging* + R39 *record-served* at capture time; R42/R43 (storage/compaction, single-winner claim).
2. **Wave 2 — bi-temporal + additive knowledge:** R1–R7 over the substrate; time-travel; privacy-
   honoring history.
3. **Wave 3 — closed loop + agent loops:** R22–R30; the R38 fraction-cap+verifier gate and R39
   promotion gate *activate* here; R44/R45 (multi-metric promotion rule, additive eval growth); the
   compound-value dashboard (R26).

## 8. Delivery doctrine (how this gets built — from requirements §9.4)

Dogfood the flywheel to build it: **house model carries the high-volume specified work** (synthesis
phases, dataset/delta builds via `house-trainer`/`longview-pipeline`); **frontier sessions carry
design, gate-writing, and verification**. Capture every session with authorship tags (R38); only
frontier-verified house sessions enter training (R38+R44); track the house-carried fraction per loop
turn as an explicit optimization target (R30). This delivery *is* wave-3 behavior exercised early —
so R38's guard is in force from the first house-authored session, not deferred.

---

*Handoff ends. The design session owns §3–§6; §1/§2/§7/§8 are the mandate it works within. When
design is drafted, flip Status to `draft` and record the design author.*
