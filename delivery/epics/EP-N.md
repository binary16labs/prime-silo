# EP-N — The Estate (multi-machine session/backup governance)

**Objective:** O2 (+ O1) · **Goals:** P2,P3,P9 · **Milestone:** M7
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
