// Estate drift-delta engine (EP-N / N4) — the ACTIONABLE delta between a satellite and the
// hub: the sessions (and executions) a satellite holds whose content the hub corpus lacks.
// The true content-hash delta with the overlap excluded, so the cockpit and the next-cycle
// planner can show exactly what a sync would bring. Pure functions over INJECTED inputs
// (content-hashes from the N0 estate model, quarantine from the estate flag) — no fs, no
// network, no hardware — so this is deterministic and gate-testable.
// Spec: architecture/SOLUTION-estate.md §8.1. Reuses N0 CAS hashes + N1 sessionStats shape.
// Privacy (R31): quarantined sessions are COUNTED but never surfaced — no sid, project, or
// content-hash of a quarantined session ever appears in the returned shape.

const asSet = (v) => (v instanceof Set ? v : new Set(v || []));

// driftDelta(hubHashes, satelliteSessions, quarantine)
//   hubHashes        — content-hashes the hub corpus already holds (array | Set)
//   satelliteSessions— [{ sid, contentHash, quarantined? }] the satellite holds
//   quarantine       — sids to hold out (array | Set); a session is quarantined if it is in
//                      this set OR carries quarantined:true
// returns { clean:[sid], cleanCount, quarantined:{count}, overlap, total }
export function driftDelta(hubHashes = [], satelliteSessions = [], quarantine = []) {
  const hub = asSet(hubHashes);
  const q = asSet(quarantine);
  const clean = [];
  let quarantinedCount = 0;
  let overlap = 0;

  for (const s of satelliteSessions || []) {
    const sid = s?.sid;
    const contentHash = s?.contentHash;
    const isQuarantined = s?.quarantined === true || q.has(sid);
    // Privacy first (R31): a quarantined session is counted and withheld — it can never
    // reach `clean`, even if it is absent from the hub and would otherwise be a candidate.
    if (isQuarantined) {
      quarantinedCount++;
      continue;
    }
    // Already in the hub corpus → not part of the delta (the overlap we exist to exclude).
    if (hub.has(contentHash)) {
      overlap++;
      continue;
    }
    clean.push(sid);
  }

  return {
    clean,
    cleanCount: clean.length,
    quarantined: { count: quarantinedCount }, // count only — no sid/hash/content (R31)
    overlap,
    total: (satelliteSessions || []).length
  };
}

// executionDrift(hubHashes, satelliteEntries)
// L5-register variant: which executions ran on the satellite that the hub has not recorded.
// Same content-hash discipline. Entries may be { id, hash } or bare hash strings.
export function executionDrift(hubHashes = [], satelliteEntries = []) {
  const hub = asSet(hubHashes);
  const hashOf = (e) => (e && typeof e === "object" ? e.hash : e);
  return (satelliteEntries || []).filter((e) => !hub.has(hashOf(e)));
}
