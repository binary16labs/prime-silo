// Estate probes (EP-N / N1) — turn raw, INJECTED inputs into the estate's live view:
// drive drift verdicts, hub/satellite topology, resource-based liveness, and per-machine
// session stats. Pure functions: no filesystem, no network, no hardware — the caller
// supplies fingerprints/samples/reachability so this is fully testable and deterministic.
// Spec: architecture/SOLUTION-estate.md §3.3. Consumes the N0 estate model, never mutates it.

// --- drive drift ----------------------------------------------------------------
// Mirrors the F:/D: verify tool's verdicts. Integrity (does the snapshot still match
// its own manifest?) takes precedence over drift (has the live source moved on?):
//   CORRUPT  — the snapshot bytes no longer match what its manifest recorded
//   DRIFT    — snapshot is intact but the live source has advanced past it
//   INTACT   — snapshot matches its manifest AND the live source (in-sync)
export function driveDrift({ manifestFingerprint, snapshotFingerprint, liveFingerprint } = {}) {
  if (manifestFingerprint == null) return "UNKNOWN";
  if (snapshotFingerprint != null && snapshotFingerprint !== manifestFingerprint) return "CORRUPT";
  if (liveFingerprint != null && liveFingerprint !== manifestFingerprint) return "DRIFT";
  return "INTACT";
}

// --- topology -------------------------------------------------------------------
// machines: [{ name, role }] where role is "hub" | "satellite".
// reachability: { [name]: boolean } injected (no real network probe here).
// Exactly one hub is well-formed; the rest are satellites carrying their reachability.
export function topology(machines = [], reachability = {}) {
  const nodes = machines.map((m) => ({
    name: m.name,
    role: m.role,
    reachable: Object.prototype.hasOwnProperty.call(reachability, m.name)
      ? !!reachability[m.name]
      : null
  }));
  const hubs = nodes.filter((n) => n.role === "hub");
  const satellites = nodes.filter((n) => n.role === "satellite");
  return {
    hub: hubs[0]?.name ?? null,
    satellites: satellites.map((s) => s.name),
    nodes,
    wellFormed: hubs.length === 1
  };
}

// --- liveness -------------------------------------------------------------------
// Two probe samples { cpuMs, artifacts, logMtime } taken ~seconds apart. A job is ALIVE
// only when it is doing work — CPU-time advanced OR a new artifact appeared. logMtime is
// DELIBERATELY ignored: a tqdm/log line is not proof of life (the eGPU-wedge lesson).
export function liveness(a = {}, b = {}) {
  const cpuAdvanced = Number(b.cpuMs ?? 0) > Number(a.cpuMs ?? 0);
  const artifactsAdvanced = Number(b.artifacts ?? 0) > Number(a.artifacts ?? 0);
  const alive = cpuAdvanced || artifactsAdvanced;
  return { alive, stalled: !alive, cpuAdvanced, artifactsAdvanced };
}

// --- per-machine session stats --------------------------------------------------
// estate: the N0 model { sessions: { <hash>: { sid, quarantined, drives:["machine:label"] } } }.
// A session counts toward every machine that holds it (via a drive on that machine).
// Quarantined sessions (job/CV) are counted but EXCLUDED from the usable total.
export function sessionStats(estate = {}) {
  const perMachine = {};
  for (const s of Object.values(estate.sessions || {})) {
    const machines = new Set((s.drives || []).map((d) => String(d).split(":")[0]));
    for (const m of machines) {
      const row = (perMachine[m] ??= { total: 0, usable: 0, quarantined: 0 });
      row.total++;
      if (s.quarantined) row.quarantined++;
      else row.usable++;
    }
  }
  return perMachine;
}
