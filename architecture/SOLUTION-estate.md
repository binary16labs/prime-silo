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

| Need | Reused substrate (already built + verified) |
|---|---|
| Dedupe overlap by content | **L1 CAS staging** — content-hash blobs; identical content → one blob |
| Process only new material | **L4 delta cursors** — per-content-hash, idempotent, resumable |
| Cascade integrity F→D→eGPU | **L3 durability** — replicate → checksum → restore-drill |
| Truth log / audit trail | **L0 KEL** — every sync/backup/quarantine is an append-only event |
| Cross-machine comparable runs | **L5 execution register** |
| Live push to the console | **B1 SSE bus** (`server/coordination/lib/bus.mjs`) |
| Privacy | **leak-gate + quarantine** — job/CV sids never enter cards/dataset (see the ASUS screen) |

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
- `N0` — estate model + delta sync engine (CAS dedup + L4 delta + KEL events) — *human-signed* (moves data).
- `N1` — machine/drive/eGPU probes + hub-satellite topology + drift verdicts — agent-ok.
- `N2` — estate console page composing navi-key + lineage-timeline + dial, SSE-driven — agent-ok.
- `N3` — interactive drill-down cards + board & LONGVIEW tie-in — *human-signed* (promotes the surface).

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
