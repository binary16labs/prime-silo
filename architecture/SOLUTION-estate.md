# SOLUTION — The Estate: multi-machine session/backup governance (EP-N)

**Status:** DRAFT (plan source for EP-N / milestone M7, authored 2026-07-27).
**Traces:** O2 (one coordinated, deterministic delivery system — KR2.2 unified telemetry/lineage stream;
KR2.4 verification observability) + O1.KR1.5 (the training corpus this estate keeps coherent).
**Builds on:** the EP-L flywheel substrate (`SOLUTION-longview-self-learning.md`) and the B1 coordination
API/SSE bus. **Reuses; does not rebuild.**

## 1. The problem

The estate now spans two machines — a **hub** (T480: the eGPU trainer, D: runner, F: fixed backup) and a
**satellite** (ASUS: sessions pulled over SMB). The raw material for LONGVIEW + the house trainer lives in
several places at once: `~/.claude/projects` on each machine, the `~/.mem0ray` store, the `sessions_v1`
workspace on D:, and dated snapshots on F:. Two failure modes follow:

1. **Drift is invisible.** Which machine has which sessions? Is the F: backup still byte-identical to what
   D: is running? Is a snapshot stale? Today this is answered by ad-hoc `robocopy`/fingerprint scripts, not
   a governed, glanceable surface.
2. **Overlap is reprocessed.** The portable ingest copy on D: and the F: backup contain **the same
   sessions**. Naively they would be synthesized/trained twice. We need **delta-only** processing keyed on
   content, so identical content is handled exactly once regardless of how many drives hold it.

## 2. The one idea (same as EP-L)

The flywheel already gives us a content-addressed, delta-aware, durability-checked substrate. The Estate is
**one more projection of the same shape** — an append-only estate log folded to state — plus a governance
**console** that composes UI primitives that already exist. Nothing new is invented at the storage layer.

| Need                          | Reused substrate (already built + verified)                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Dedupe overlap by content     | **L1 CAS staging** — content-hash blobs; identical content → one blob                    |
| Process only new material     | **L4 delta cursors** — per-content-hash, idempotent, resumable                           |
| Cascade integrity F→D→eGPU    | **L3 durability** — replicate → checksum → restore-drill                                 |
| Truth log / audit trail       | **L0 KEL** — every sync/backup/quarantine is an append-only event                        |
| Cross-machine comparable runs | **L5 execution register**                                                                |
| Live push to the console      | **B1 SSE bus** (`server/coordination/lib/bus.mjs`)                                       |
| Privacy                       | **leak-gate + quarantine** — job/CV sids never enter cards/dataset (see the ASUS screen) |

## 3. Design

### 3.1 Estate model — `estate.jsonl` projection (N0)

`estate.mjs` folds the machine registry, per-drive fingerprint manifests, backup snapshots and the
content-hash session inventory into one rebuildable projection (the L0/L5 doctrine). Grain: `machine`,
`drive`, `snapshot`, `session` (content-hash keyed → dedup is intrinsic), `sync_event`.

### 3.2 Sync engine — `estate_sync.mjs` (N0)

`syncSource(source)` = enumerate a source (a machine's `~/.claude/projects`, a drive snapshot) → CAS-store
each session blob via L1 (dedup) → write a per-drive fingerprint manifest → compute the delta via L4
cursors → emit KEL `sync_*` events. **Cascade doctrine:** F: is the source of truth, D: the working replica,
eGPU the compute; replication is delta-only and idempotent (re-runs copy nothing). The "massive overlap"
between the D: portable copy and the F: backup collapses to one blob per unique content.

### 3.3 Probes — `estate_probe.mjs` (N1)

Pure functions over injected probe inputs (so they test without live hardware): machine reachability
(hub/satellite topology), drive drift verdict from manifests (INTACT / DRIFT / CORRUPT), eGPU + host
metrics (VRAM, CPU-time liveness — never a tqdm line, per the liveness lesson), per-machine session stats.

### 3.4 Console — `server/pages/estate.html` (N2, N3)

A governance surface that **composes existing primitives**, not new ones:

- `<navi-key>` (`app/.../visual/navi`) — the arc-button/dot-matrix **hub** with the satellite.
- `<lineage-timeline>` (`app/.../visual/timeline`) — the per-card **drill-down** (minimap + splines).
- the **Dial** / **Terminal-cinema** set-pieces (anime.js v4, `animejs-scrollcraft`) for pipeline + logs.
- **Motion is meaning (C0):** every animation is driven by a real estate/SSE event via the B1 bus, never a
  timer; final state is in the markup so the page is complete with JS disabled; theme-aware; reduced-motion
  safe. Cards are glance (state stripe + one metric + sparkline) → drill → explain-provenance.
- **Tie-ins (N3):** the delivery board tasks lane and the LONGVIEW pipeline read into the same console, so
  drift, work, and synthesis are one surface — greater than the sum of the parts.

## 4. Phases → contracts (M7)

- `N0` — estate model + delta sync engine (CAS dedup + L4 delta + KEL events) — _human-signed_ (moves data).
- `N1` — machine/drive/eGPU probes + hub-satellite topology + drift verdicts — agent-ok.
- `N2` — estate console page composing navi-key + lineage-timeline + dial, SSE-driven — agent-ok.
- `N3` — interactive drill-down cards + board & LONGVIEW tie-in — _human-signed_ (promotes the surface).

## 5. Invariants

- **Additive / no default break (R36):** new page + additive API mount; existing routes untouched.
- **Privacy (R31):** quarantined sids (incl. the 4 ASUS job/CV sessions) never surface a session's content
  in the console or enter any dataset path — the estate model carries the quarantine flag, not the payload.
- **No LAN LM probe during a run:** the console reads the estate projection + SSE, never calls the LM host.
- **Honest observability:** every number derives from the estate log + disk — no hidden state (the LONGVIEW
  dashboard doctrine).

## 6. Exit (VISION-CHECK)

All four phase gates green + non-author verification. Measured evidence: the D: portable copy and F: backup
dedupe to one blob per content (delta-only proven); drift verdicts computed from real fingerprints; the
console renders hub+satellite, the cascade, and live per-machine session stats from the estate log alone.
Which KRs moved: KR2.2 (telemetry/lineage stream extended to the physical estate), KR2.4 (governance
surface). One honest sentence on residual drift.

---

# Phase 2 — The Governance Cockpit (M8, authored 2026-07-28)

> Rev note: Phase 1 (M7, N0–N3) made the estate **observable**. Phase 2 makes it **governable and
> self-directing** — the cockpit detects cross-machine drift, gates its sync behind human approval, and hands
> the approved delta to the LONGVIEW flywheel as a planned next cycle. Owner directive 2026-07-28: build the
> governance layer first, then the live transport ("both in sequence"); author to the board (EP-N reopened).

## 7. The problem (Phase 2)

Today the estate console is a **viewer**: it renders whatever estate KEL exists, and a satellite's sessions
reach the hub only through a manual out-of-band ingest (the D:\asus_ingest copy). Three gaps remain before it
is a control plane:

1. **No drift signal between machines.** Nothing computes _what the satellite has that the hub's corpus does
   not_ — the actionable delta — so the owner can't see what a sync would bring.
2. **No governed sync.** Moving a satellite's sessions into the training corpus is a privacy- and
   trust-sensitive act (job/CV quarantine, R31); it must be a human-approved, delta-only, idempotent
   operation, not an ambient copy.
3. **The loop isn't closed to planning.** An approved sync should tell the owner _what's coming_ — projected
   cards → Stream-A rows → whether the dataset crosses its rebuild threshold — so the next flywheel turn is
   planned, not discovered after the fact.

## 8. Design (Phase 2)

### 8.1 Drift-delta engine — `estate_drift.mjs` (N4)

Pure functions over the estate model (reuses N0 CAS content-hashes + N1 `sessionStats`). For each satellite,
`driftDelta(hubHashes, satelliteSessions, quarantine)` returns the **actionable delta**: sessions the
satellite holds whose content-hash is absent from the hub corpus, partitioned into `clean` (mappable) and
`quarantined` (job/CV — counted, never content). Deterministic, no fs/net — inputs injected — so it is
gate-testable and reused by both the console and the planner. Also `executionDrift` for L5 register entries
(what ran on the satellite that the hub hasn't recorded), same content-hash discipline.

### 8.2 Approve-to-sync governance — `estate_govern.mjs` + API route (N5) _(human-signed — moves data)_

The drift delta is presented as a **proposed sync**, not an action. `proposeSync(delta)` builds a signed
proposal (clean sids + a privacy attestation that quarantined sids are excluded BEFORE the owner sees it);
`applySync(proposal, syncSource)` stages only the approved clean delta into the hub via N0 `syncSource`
(idempotent, delta-only, KEL-logged) and emits an approval event on the B1 bus. The gate proves: a proposal
that includes a quarantined sid is rejected (RED); no sync executes without an `approved:true` signature;
re-applying an approved proposal is a no-op (idempotence). Nothing is copied on load — approval is the trigger.

### 8.3 Next-cycle flywheel planner — `estate_plan.mjs` (N6)

From the pending + approved drift, `planNextCycle(delta, datasetManifest, evalReport)` projects the next
flywheel turn: `+N clean sessions → ~M cards (minus thin-rate) → ~K Stream-A rows → dataset drift crosses the
rebuild threshold? → recommended action (map | rebuild | train)`. This is the "knowing what's coming" surface
— it renders on the cockpit AND feeds the :8788 flywheel's feedback banner, so the two dashboards share one
projection. Read-only; references the dataset manifest + eval report, never mutates them.

### 8.4 Live network discovery / transport — `estate_register.mjs` + register route (N7) _(human-signed — network surface)_

When prime-silo starts on a satellite (ASUS) on the same network, it **registers** with the driver node
(T480): a heartbeat + a session-fingerprint manifest (content-hashes only, never payload) pushed to a hub
register endpoint (or over the B1 bus). The hub records last-seen + reachability and recomputes drift live,
so a satellite coming online updates the cockpit without a manual ingest. Auth: a shared per-estate key
(reuses the benny keystore); loopback/LAN-only; the manifest carries hashes + quarantine flags, so privacy
holds on the wire. This is the piece that makes "just start prime-silo on the ASUS and it detects" literal.

### 8.5 Console — `server/pages/estate.html` grows the cockpit (extended by N4–N7, additive)

The existing console gains, additively: a **drift panel** (per satellite: clean/quarantined delta counts,
glance→drill), an **approve-to-sync** affordance (owner-only, shows the proposal + privacy attestation, one
signed action), a **next-cycle planner** card (the projection above), and **live node reachability** on the
hub/satellite topology (last-seen, driver-node badge). Motion-is-meaning, theme-aware, works JS-disabled for
the static counts; no default route changes (R36).

## 9. Phases → contracts (M8)

- `N4` estate_drift.mjs — drift-delta + execution-drift engine (pure, reuses N0 CAS + N1 stats) _(agent-ok)_
- `N5` estate_govern.mjs + API — approve-to-sync: proposal, privacy attestation, idempotent apply via N0
  syncSource, B1 approval event _(human-signed — moves data into the corpus)_
- `N6` estate_plan.mjs — next-cycle flywheel planner; projection shared with the :8788 flywheel _(agent-ok)_
- `N7` estate_register.mjs + register route — live satellite discovery/heartbeat/manifest push, LAN-auth
  _(human-signed — opens a network surface)_

## 10. Invariants (Phase 2)

- **Privacy (R31):** quarantined sids are excluded from any proposal, never crossed the wire as content, and
  the drift engine emits their count only — same discipline as N3, now enforced at the sync boundary.
- **Human-signed sync (P-stops):** no data enters the corpus without an owner-approved, signed proposal; the
  gate fails if a sync can execute unapproved.
- **Delta-only / idempotent:** all sync goes through N0 `syncSource` (CAS + L4 cursors) — re-apply is a no-op.
- **Additive (R36):** additive API routes + additive console panels; existing routes and the LONGVIEW
  dashboards untouched.
- **No LAN LM probe:** the cockpit reads the estate projection + manifests + SSE; it never calls the LM host.

## 11. Exit (Phase 2 VISION-CHECK)

All four gates (`scripts/gates/n4..n7`) green + non-author verification. Measured evidence: drift computed as
the true content-hash delta (overlap excluded); a sync cannot execute without an owner signature and a
quarantined sid is rejected (privacy gate); an approved sync is idempotent (re-apply no-op); the planner's
projection matches the flywheel's; a satellite registering over the LAN updates the cockpit's drift live.
KRs moved: KR2.4 (governance action, not just view), KR1.5 (the flywheel gains a planned intake). One honest
sentence on residual drift.
