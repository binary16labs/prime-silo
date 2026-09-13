# EP-S — The Estate Map (Prime-Silo maps, protects and centralises the whole estate)

**Objective:** O2 (+ O4) · **Goals:** P2,P3,P4,P9 · **Milestone:** M10
**Plan source:** `../../architecture/SOLUTION-estate-map.md` (design, authored 2026-09-13). Extends EP-N
(`SOLUTION-estate.md`: hub/satellite, N5 signed approve-to-sync, N7 register) from sessions and backups to
**everything on every machine**: files, applications, media.

Owner directive 2026-09-13: manage the estate from the Prime-Silo UI rather than by running scripts; Prime-Silo
is the container that maps the entire estate; once mapped, ensure integrity, then centralise, then run a
manageable storage process; use fast MFT-based mappers for the index.

**The one idea:** every Windows node already runs a self-supervising Prime-Silo. Let it observe its own machine
(MFT-fast file index, installed apps, media), push a summary to the hub (nodes push, the hub never reaches in),
fold one map, and turn every change to the estate into a proposal a human signs and a node executes, recorded in
the vocabulary the estate already folds (`sweep_recorded`, `artifact_*`).

## Phases → task contracts (M10)

- [ ] `S0` — map model: node index schema, collector interface, snapshot → CAS + `sweep_recorded` _(agent-ok)_
- [ ] `S1` — file adapters (Everything / WizTree / walker) + pre-registered benchmark; Everything install _(human-signed — installs an MFT-reading service on every node)_
- [ ] `S2` — applications, services, scheduled tasks, listening ports collector _(agent-ok)_
- [ ] `S3` — node push + hub fold + `/api/estate/map` over the N7 register _(human-signed — network surface)_
- [ ] `S4` — Estate Map panel in the Prime-Silo UI _(agent-ok)_
- [ ] `S5` — integrity: cross-machine duplicates, sole copies, backup coverage, verification sweeps _(agent-ok)_
- [ ] `S6` — storage policy + centralisation planner that raises proposals only _(agent-ok)_
- [ ] `S7` — governed executor: signed move → copy, verify, place, evict _(human-signed — moves data)_
- [ ] `S8` — retire the 2026-09-13 tactical scripts behind an elevation broker _(human-signed — elevation path)_

## Exit

All phase gates green and verified by a non-author agent. The map of both Windows nodes renders in the
Prime-Silo UI from pushed snapshots alone; the pre-registered criteria in the plan §7 are reported with measured
numbers (including any that failed); a signed centralisation of a real models folder from optimus to the NAS
completes with destination-hash verification before source eviction; `estate/*.ps1` are no longer needed for any
routine operation. VISION-CHECK: which KRs moved (KR2.2 lineage extended to files/apps; KR2.4 governed action)
and one honest sentence on what is still unmapped. Privacy invariant held (R31): no file content leaves a node,
quarantined paths leave only as hash + category.
