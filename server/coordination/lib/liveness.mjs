// Liveness watchdog (L10 / EP-L) — prove liveness by RESOURCE, never infer it from logs.
// Design: SOLUTION §4.6; steer 11. R28/R29/R35. Hard-won lesson: a tqdm log line ≠ alive — a
// wedged eGPU job keeps a fresh-looking log while CPU-time goes flat, the working set collapses, and
// no new checkpoints land. So liveness is decided by advancing CPU-time / artifacts / an external
// supervisor heartbeat — the log's mtime is deliberately IGNORED.
//
// Full-hybrid signals (any one advancing ⇒ alive):
//   - cpuTimeMs        — the process is burning CPU (a wedged one is not)
//   - artifactCount / artifactMtimeMs — new/updated checkpoints/results on disk
//   - heartbeatMs      — an external supervisor's last heartbeat, fresh within the stall window
// A wedge = NONE of those advanced across a window of at least `stallMs` wall-time.

// `prev` and `cur` are two samples taken `cur.now - prev.now` apart (ms). Returns
// { alive, stalled, reason }. `stalled` requires the window to be wide enough to be meaningful.
export function liveness(prev, cur, { stallMs = 60_000 } = {}) {
  const cpuAdvanced = cur.cpuTimeMs > prev.cpuTimeMs;
  const artifactsAdvanced =
    cur.artifactCount > prev.artifactCount || cur.artifactMtimeMs > prev.artifactMtimeMs;
  // heartbeat is "fresh" if the external supervisor pinged within the stall window.
  const heartbeatFresh = cur.heartbeatMs != null && cur.now - cur.heartbeatMs <= stallMs;

  // NOTE: cur.logMtimeMs is intentionally NOT consulted — a fresh log must never rescue a wedge.
  const resourceAlive = cpuAdvanced || artifactsAdvanced || heartbeatFresh;
  const wallElapsed = cur.now - prev.now;
  const stalled = !resourceAlive && wallElapsed >= stallMs;

  const reason = resourceAlive
    ? cpuAdvanced
      ? "cpu-advancing"
      : artifactsAdvanced
        ? "artifacts-advancing"
        : "heartbeat-fresh"
    : stalled
      ? "flat-cpu+stale-artifacts+stale-heartbeat"
      : "within-window";
  return { alive: resourceAlive, stalled, reason };
}

// Convenience: scan a series of samples; the turn is stalled if ANY consecutive pair is stalled.
export function stalledAcross(samples, opts) {
  for (let i = 1; i < samples.length; i++) {
    const v = liveness(samples[i - 1], samples[i], opts);
    if (v.stalled) return { stalled: true, at: i, reason: v.reason };
  }
  return { stalled: false };
}
