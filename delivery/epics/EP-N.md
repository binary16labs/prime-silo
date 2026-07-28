# EP-N — The Estate (multi-machine session/backup governance)

**Objective:** O2 (+ O1) · **Goals:** P2,P3,P9 · **Milestone:** M7 (Phase 1 — observe), M8 (Phase 2 — govern)
**Plan source:** `../../architecture/SOLUTION-estate.md` (design, authored 2026-07-27) tracing O2.KR2.2 /
KR2.4 + O1.KR1.5. Builds on EP-L (`SOLUTION-longview-self-learning.md`) and B1.

Make the physical estate — the **hub** (T480: eGPU trainer, D: runner, F: fixed backup) and the
**satellite** (ASUS, pulled over SMB) — **coherent and observable**: content-hash every session once, cascade
backups F→D→eGPU delta-only, watch for drift, and render it as one governance console that ties the board,
the LONGVIEW pipeline, and the backup estate into a single surface. The whole must be worth more than the
parts.

**The one idea (same as EP-L):** don't rebuild — the flywheel already gives a content-addressed
(L1 CAS), delta-aware (L4), durability-checked (L3), append-only-truth (L0) substrate, and B1 gives the SSE
bus. EP-N adds **one more projection** (`estate.jsonl`) + a console that **composes UI primitives that
already exist** (Gemini's `navi-key` arc/dot-matrix + `lineage-timeline`, the anime.js Dial/Terminal
set-pieces).

## Phases → task contracts (M7)
- [ ] `N0` — estate model (`estate.jsonl` projection) + delta sync engine: CAS-dedup overlap, L4 delta
  cursors, KEL sync events; cascade F→D→eGPU is delta-only/idempotent *(human-signed — it moves data)*
- [ ] `N1` — probes: machine reachability (hub/satellite topology), drive drift verdict (INTACT/DRIFT/
  CORRUPT) from fingerprints, eGPU + host metrics (CPU-time liveness), per-machine session stats
- [ ] `N2` — estate console `server/pages/estate.html` composing navi-key + lineage-timeline + dial,
  live over the B1 SSE bus; motion-is-meaning, theme-aware, complete with JS disabled
- [ ] `N3` — interactive drill-down cards (glance→drill→explain) + delivery-board & LONGVIEW tie-in
  *(human-signed — promotes the estate surface to the shared observability plane)*

## Exit
All four phase gates green, verified by a non-author agent; close with a VISION-CHECK note (plan §0.5): which
KRs moved (KR2.2 telemetry/lineage extended to the physical estate; KR2.4 governance surface; KR1.5 corpus
coherence), measured evidence (portable copy + F: backup dedupe to one blob per content — delta-only proven;
drift verdicts from real fingerprints; console renders hub+satellite+cascade+live stats from the estate log
alone), one honest sentence on residual drift. Privacy invariant held: quarantined job/CV sids never surface
content or enter any dataset path (R31); additive — no default route breaks (R36).

## Phase 2 → task contracts (M8) — the Governance Cockpit (reopened 2026-07-28)
Phase 1 made the estate **observable**; Phase 2 makes it **governable and self-directing**. Plan source
extended: `../../architecture/SOLUTION-estate.md` §7–§11. Owner directive: build the governance layer first,
then the live transport ("both in sequence"). Reuses the Phase-1 engine (N0 CAS/sync, N1 probes, N2/N3 API+console).
- [ ] `N4` — drift-delta engine (`estate_drift.mjs`): the actionable delta a satellite holds that the hub
  corpus lacks, by content-hash, partitioned clean/quarantined; + execution drift (L5). Pure, gate-testable *(agent-ok)*
- [ ] `N5` — approve-to-sync (`estate_govern.mjs` + API): a signed proposal with a privacy attestation;
  idempotent apply via N0 `syncSource`; B1 approval event. No sync without an owner signature *(human-signed — moves data)*
- [ ] `N6` — next-cycle flywheel planner (`estate_plan.mjs`): projects the approved drift into the next turn
  (sessions→cards→Stream-A rows→rebuild threshold→action); the projection is shared with the :8788 flywheel *(agent-ok)*
- [ ] `N7` — live satellite discovery (`estate_register.mjs` + route): a satellite starting prime-silo on the
  LAN registers (heartbeat + fingerprint manifest push, LAN-auth), so drift updates live *(human-signed — network surface)*

## Exit (M8)
Gates `n4..n7` green + non-author verification. Proven: drift is the true content-hash delta (overlap excluded);
a sync cannot execute unapproved and a quarantined sid is rejected (R31 at the sync boundary); approved sync is
idempotent; the planner projection matches the flywheel's; a LAN-registering satellite updates the cockpit live.
KRs: KR2.4 (governance action), KR1.5 (planned flywheel intake). VISION-CHECK on close.

## VISION-CHECK (EP-N Phase 1 closed 2026-07-27)
Built N0–N3, all gate-green + mutation-proven, `w0` green throughout. **KRs moved:** KR2.2 (the
telemetry/lineage stream now extends to the physical estate — machines, drives, sessions rendered live
from the estate log), KR2.4 (a governance surface making drift + verification observable). **Measured
evidence:** identical content across the D: portable copy and the F: backup dedupes to one blob (N0
delta-only, proven by the overlap scenario); drift verdicts computed from real fingerprints
(INTACT/DRIFT/CORRUPT, N1); the console renders hub+satellite + the F→D→eGPU cascade + live per-machine
stats from the estate log alone, verified live (N2), with the DRIFT verdict propagating to the cascade and
the board/LONGVIEW folded into one surface (N3). **Privacy (R31) held:** quarantined job/CV sessions surface
only a count, never their content — gate-enforced (N3 privacy mutation) and verified live (drill/asus →
sessions:[]). **Additive (R36):** a new page + additive API mount; no default route changed. **Honest note
on drift:** the four tasks were author-self-verified (owner waived the fresh-context verifier per task) — the
author≠verifier caveat is on record for N0–N3; a later cross-session pass could independently re-derive.
