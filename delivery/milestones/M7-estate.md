# M7 — The Estate: multi-machine session/backup governance → **v2.6.0**

**Scope (committed, design source `architecture/SOLUTION-estate.md`):** EP-N — N0 estate model +
delta sync engine (CAS-dedup overlap, L4 delta cursors, KEL sync events; cascade F→D→eGPU delta-only) ·
N1 probes (hub/satellite topology, drive drift verdicts, eGPU + host metrics, per-machine session stats) ·
N2 estate console (`server/pages/estate.html` composing navi-key + lineage-timeline + dial, live over the
B1 SSE bus) · N3 interactive drill-down cards + delivery-board & LONGVIEW tie-in. Turns the ad-hoc
backup/fingerprint scripts into a governed, glanceable observability surface across the two machines.

**Trigger:** EP-L delivering (M4/M5/M6 — the KEL/CAS/delta/durability substrate) + B1 (the SSE bus). Those
are the inputs the estate projection folds and the console streams. Contracts authored at this checkpoint by
Claude (frontier authoring); `authority: human-signed` items (N0 the sync engine that moves data, N3 the
promotion of the surface) await owner signature before execution, per the human-signed-stops doctrine.

**Dependencies out:** additive over EP-L and B1. Reuses L1 CAS staging (dedup), L4 delta cursors
(delta-only), L3 durability doctrine (cascade integrity), L0 KEL (truth/audit), L5 register
(cross-machine comparability), and the B1 `bus.mjs` fan-out for live push. Breaks no default path (R36):
a new page + an additive API mount; existing routes and the LONGVIEW dashboard untouched. Privacy (R31):
the estate model carries a quarantine flag, never a quarantined session's content.

**Exit:** same DoD pattern as M1–M6 — phase gates (`scripts/gates/n0..n3`) + non-author verification +
proven: the D: portable copy and F: backup dedupe to one blob per unique content (delta-only), drift
verdicts are computed from real fingerprints (INTACT/DRIFT/CORRUPT), and the console renders the
hub↔satellite topology, the F→D→eGPU cascade, and live per-machine session stats from the estate log alone
(no hidden state). Closes EP-N. VISION-CHECK: which KRs moved (KR2.2 telemetry/lineage, KR2.4 governance,
KR1.5 corpus coherence) + one honest sentence on drift.
