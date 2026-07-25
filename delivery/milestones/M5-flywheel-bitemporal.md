# M5 — LONGVIEW flywheel: bi-temporal + additive knowledge → **v2.4.0**

**Scope (committed, design source `architecture/SOLUTION-longview-self-learning.md` §7 wave 2):**
EP-L wave-2 — L8 bi-temporal projectors (rebuild Neo4j/Chroma/memo-ray/cards from the KEL; time-travel
query over valid-time and transaction-time) · L9 privacy-honoring history (leak-gate + teleport filter
+ keep-both-and-flag conflict at projection, honored across all bi-temporal time).

**Trigger:** wave-1 substrate (M4) delivering — the KEL (L0) and delta engine (L4) are the projectors'
inputs. Contracts authored at this checkpoint by Claude (frontier authoring); `authority: human-signed`
items (L9, privacy) await owner signature before execution.

**Dependencies out:** builds on M4 (KEL + delta) — additive; reuses the leak-gate/quarantine/teleport
governance (moves, never deletes) and the LONGVIEW stores as projection sinks. Breaks no default path
(R36): projections rebuild alongside the existing stores, never replacing the live write path in place.

**Exit:** same DoD pattern as M1–M4 — phase gates (`scripts/gates/l8..l9`) + non-author verification +
wave-2 proven: "what was true at T" (valid-time) and "what did we know at T" (transaction-time) both
answerable, including reconstructing the exact knowledge state that produced an artifact (R2); every
projection rebuilds from the log (R32); teleported sids stay excluded across all of bi-temporal history
(R4/R31); contradictory facts are kept-both-and-flagged, never auto-picked (steer 9). VISION-CHECK note
records which KRs moved and one honest sentence on drift.
