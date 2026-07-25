// Single-winner loop claim (L7 / EP-L). Concurrent machines claim a loop turn under an
// exactly-once protocol so two machines never train/merge against the substrate at once (R43).
// This REUSES the B0 atomic wx-lease VERBATIM (server/coordination/lib/ledger.mjs) — the same
// primitive whose 20-race exactly-one-winner property the b0 gate already proves — for one
// well-known task id. No new mutual-exclusion mechanism is invented. Design: SOLUTION §4.5.
import { claimTask, releaseTask, renewLease } from "./ledger.mjs";

export const FLYWHEEL_TURN = "flywheel-turn";

// Try to become the single machine that runs this loop turn.
// Returns { ok: true, takeover } for the winner, or { ok: false, reason: "already-claimed" }.
export function claimLoopTurn(coordDir, agent, opts = {}) {
  return claimTask(coordDir, FLYWHEEL_TURN, agent, opts);
}

// The owner renews its lease while the turn runs (never shortening expiry) — heartbeat.
export function renewLoopTurn(coordDir, agent, opts = {}) {
  return renewLease(coordDir, FLYWHEEL_TURN, agent, opts);
}

// Release the turn when done (or on clean abort — L10 dead-man switch), freeing the next winner.
export function releaseLoopTurn(coordDir, agent, payload = {}) {
  return releaseTask(coordDir, FLYWHEEL_TURN, agent, { loop: true, ...payload });
}
