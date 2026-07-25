// Flywheel daemon (L10 / EP-L) — the loop orchestrator. Advances the closed loop
//   staged → synthesis → dataset → train → serve → agents → sessions
// triggered hybridly (fs-watch on D: staging reactively + a cron sweep backstop), with EVERY
// mutating turn gated by the L7 single-winner claim so two machines never advance at once (R22).
// A full-hybrid liveness watchdog (liveness.mjs) supervises the running turn; on a wedge the
// dead-man switch aborts CLEAN — stop the job, release the lease, emit run_failed, alert — so a
// wedged eGPU never leaves the box stuck (R28/R29/R35). Design: SOLUTION §4.5 + §4.6; steers 5/11.
//
// The daemon ORCHESTRATES; it does not reimplement stage skills (L11 guard / L12–L13 promotion /
// L14 dashboard are out of scope). fs-watch, cron and subprocess control are injected so the loop
// mechanics are testable and the OS wiring stays a thin, swappable edge.
import fs from "node:fs";
import path from "node:path";
import { claimLoopTurn, releaseLoopTurn, FLYWHEEL_TURN } from "./loop_claim.mjs";
import { stalledAcross } from "./liveness.mjs";

// --- G0-shaped run events (reused format: one JSON object per line) ---------
export function emitRunEvent(runEventsLog, evt) {
  fs.mkdirSync(path.dirname(runEventsLog), { recursive: true });
  fs.appendFileSync(runEventsLog, JSON.stringify({ ts: new Date().toISOString(), ...evt }) + "\n");
}
export function readRunEvents(runEventsLog) {
  if (!fs.existsSync(runEventsLog)) return [];
  return fs
    .readFileSync(runEventsLog, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

// --- one loop turn, gated by the L7 single-winner claim ---------------------
// Both trigger sources (fs-watch, cron) funnel through here, so the backstop can never double-run a
// turn the reactive path already took. Returns { ok, ran, source, reason }. `runStage` is the actual
// stage advance (a stage skill); the daemon calls it, it does not reimplement it.
export function advanceTurn(coordDir, agent, { source = "fs-watch", runStage, ttlMs, runEventsLog, runId = `turn-${Date.now()}` } = {}) {
  const claim = claimLoopTurn(coordDir, agent, ttlMs != null ? { ttlMs } : {});
  if (!claim.ok) return { ok: false, ran: false, source, reason: claim.reason }; // someone else has the turn
  try {
    if (runEventsLog) emitRunEvent(runEventsLog, { type: "run_started", run_id: runId, agent, source });
    if (runStage) runStage();
    if (runEventsLog) emitRunEvent(runEventsLog, { type: "run_succeeded", run_id: runId, agent, source });
    return { ok: true, ran: true, source, runId, takeover: claim.takeover };
  } finally {
    releaseLoopTurn(coordDir, agent, { source, run_id: runId }); // free the next winner, always
  }
}

// --- dead-man switch: abort a wedged turn CLEAN -----------------------------
// Stops the job, releases the lease (so the next turn can proceed), emits an honest run_failed, and
// raises an alert. The point is that a wedge NEVER leaves the box locked out of future turns.
export function deadManAbort(coordDir, agent, { runEventsLog, runId, stopJob, alert, reason = "wedge" } = {}) {
  const stopped = stopJob ? !!stopJob() : true; // stop the wedged job/subprocess tree
  const released = releaseLoopTurn(coordDir, agent, { reason: "dead-man-abort", run_id: runId });
  if (runEventsLog) emitRunEvent(runEventsLog, { type: "run_failed", run_id: runId, agent, reason });
  const alerted = alert ? !!alert({ runId, reason, agent }) : true;
  return { aborted: true, stopped, leaseReleased: released.ok, alerted, reason };
}

// --- supervise a running turn: watchdog + dead-man ---------------------------
// `samples` (or `sampler()` producing them) are resource snapshots taken across the turn. If the
// watchdog finds a wedge (resource-flat across the window — NOT log-based), fire the dead-man switch.
export function superviseTurn(coordDir, agent, { samples, sampler, stallMs = 60_000, runEventsLog, runId, stopJob, alert } = {}) {
  const series = samples ?? (sampler ? sampler() : []);
  const verdict = stalledAcross(series, { stallMs });
  if (!verdict.stalled) return { stalled: false, aborted: false };
  const abort = deadManAbort(coordDir, agent, { runEventsLog, runId, stopJob, alert, reason: verdict.reason });
  return { stalled: true, ...abort };
}
