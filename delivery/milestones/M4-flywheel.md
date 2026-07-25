# M4 — LONGVIEW flywheel (self-learning substrate) → **v2.3.0**

**Scope (committed, design source `architecture/SOLUTION-longview-self-learning.md` §6 / §7 wave 1):**
EP-L wave-1 substrate — L0 knowledge event log · L1 CAS staging + manifest · L2 inbound poison gate ·
L3 durability + restore drill · L4 delta engine · L5 unified execution register (JSONL) · L6 authorship
+ record-served tagging · L7 single-winner loop claim + compaction budget. Waves 2 (bi-temporal
projectors L8–L9) and 3 (closed loop + guards L10–L14) are authored at their own checkpoints.

**Trigger:** owner accepted `REQUIREMENTS-longview-self-learning.md` R1–R45 + the 11 steers (§6.1) and
the SOLUTION §4–§6 design as-is (2026-07-25). Contracts authored at this checkpoint by Claude
(frontier authoring); `authority: human-signed` items await owner signature before execution.

**Dependencies out:** additive over the existing substrate — reuses B0 (coordination ledger / claim),
G0 (run-event stream), the leak-gate + teleport, and the EP-T corpus. Breaks no default path (R36).
The portable **D:** drive must be attached for staging/register work (L1/L3/L5).

**Exit:** same DoD pattern as M1–M3 — phase gates (`scripts/gates/l0..l7`) + non-author verification +
the wave-1 substrate proven: raw stages to D: (R17), delta is idempotent (R8–R10), every execution is
one queryable record (R12–R16), and the truth log rebuilds every projection (R32). VISION-CHECK note
records which KRs moved and one honest sentence on drift.
