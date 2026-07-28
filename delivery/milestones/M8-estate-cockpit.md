# M8 — The Estate Phase 2: the Governance Cockpit → **v2.7.0**

**Scope (committed, design source `architecture/SOLUTION-estate.md` §7–§11):** EP-N Phase 2 —
`N4` drift-delta engine (`estate_drift.mjs`: the actionable content-hash delta a satellite holds that the hub
corpus lacks, clean/quarantined-partitioned, + execution drift) · `N5` approve-to-sync governance
(`estate_govern.mjs` + API: a signed proposal with a privacy attestation, idempotent apply via N0
`syncSource`, B1 approval event) · `N6` next-cycle flywheel planner (`estate_plan.mjs`: projects approved
drift into the next turn — sessions→cards→Stream-A rows→rebuild threshold→action — a projection shared with
the :8788 flywheel) · `N7` live satellite discovery (`estate_register.mjs` + register route: a satellite
starting prime-silo on the LAN registers via heartbeat + fingerprint-manifest push so drift updates live).
Turns the Phase-1 observability console into a control plane that governs cross-machine sync and plans the
next flywheel cycle.

**Trigger:** EP-N Phase 1 (M7, N0–N3 DONE) delivering the estate model + sync engine + probes + console, and
B1 (the SSE bus) for live push and the approval event. Owner directive 2026-07-28: governance layer first,
live transport second ("both in sequence"); author to the board. Contracts authored at this checkpoint by
Claude (frontier authoring); `authority: human-signed` items — **N5** (the sync that moves data into the
training corpus) and **N7** (the network register surface) — await owner signature before execution, per the
human-signed-stops doctrine.

**Dependencies out:** additive over EP-N Phase 1 and B1. Reuses N0 CAS + L4 delta cursors (delta-only,
idempotent sync), N1 `sessionStats`/`driveDrift` (drift inputs), N2/N3 estate API + `estate.html` (the
surface it extends, additively), L5 register (execution drift), and the B1 `bus.mjs` for the approval event
and live reachability. Breaks no default path (R36): additive API routes + additive console panels; existing
routes and the LONGVIEW dashboards untouched. Privacy (R31): quarantined sids are excluded from any proposal
and never cross the wire as content — the manifest carries hashes + quarantine flags only.

**Exit:** same DoD pattern as M1–M7 — phase gates (`scripts/gates/n4..n7`) + non-author verification +
proven: drift is the true content-hash delta (overlap excluded); a sync cannot execute without an owner
signature and a proposal containing a quarantined sid is rejected; an approved sync is idempotent (re-apply
no-op); the planner's projection matches the flywheel's; a satellite registering over the LAN updates the
cockpit's drift live. Closes EP-N Phase 2. VISION-CHECK: which KRs moved (KR2.4 governance-as-action,
KR1.5 a planned flywheel intake) + one honest sentence on residual drift.
