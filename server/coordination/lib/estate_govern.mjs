// Estate governance (EP-N / N5) — approve-to-sync. The N4 drift delta becomes a signed
// PROPOSAL (clean sids + a privacy attestation that quarantined sids are excluded); only an
// owner-approved proposal stages the clean delta into the hub via the N0 syncSource (idempotent,
// delta-only, KEL-logged) and emits a B1 approval event. Nothing moves on load — approval is the
// trigger. Human-signed: the signature is the owner's, given out-of-band; applySync refuses to
// move any data without it. Spec: architecture/SOLUTION-estate.md §8.2.
// Privacy (R31): a quarantined sid never enters a proposal (defense-in-depth over N4).
import crypto from "node:crypto";

const asSet = (v) => (v instanceof Set ? v : new Set(v || []));

// proposeSync(delta, { satellite, quarantine }) — build an UNAPPROVED proposal from an N4
// driftDelta ({ clean:[sid], quarantined:{count} }). Carries ONLY clean sids; never auto-approved.
export function proposeSync(delta = {}, { satellite = null, quarantine = [] } = {}) {
  const q = asSet(quarantine);
  const raw = delta.clean || [];
  // R31 defense-in-depth: even if the drift's clean list carried a quarantined sid, drop it here.
  const clean = raw.filter((sid) => !q.has(sid));
  const droppedHere = raw.length - clean.length;
  const quarantinedExcluded = (delta.quarantined?.count ?? 0) + droppedHere;
  const id =
    "prop:" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ satellite, clean }))
      .digest("hex")
      .slice(0, 16);
  return {
    id,
    satellite,
    clean,
    count: clean.length,
    privacy: {
      attested: true,
      quarantinedExcluded,
      invariant: "R31: quarantined sessions are excluded from any sync proposal"
    },
    approved: false,
    signature: null
  };
}

// signProposal(proposal, signature) — the owner's approval. signature is opaque (who/when).
export function signProposal(proposal, signature) {
  if (!signature) throw new Error("signProposal: an owner signature is required");
  return { ...proposal, approved: true, signature };
}

// applySync(proposal, source, deps) — stage ONLY the approved clean sessions into the hub via
// syncSource (idempotent). Refuses to move data unless the proposal is approved AND signed.
// deps = { syncSource, bus, kelLog, stagingRoot }. An approval event is emitted ONLY when the
// sync actually moved new content (a re-apply is a true no-op: no event).
export function applySync(proposal = {}, source = {}, deps = {}) {
  const { syncSource, bus, kelLog = null, stagingRoot = null } = deps;
  if (!proposal.approved || !proposal.signature) {
    return {
      applied: false,
      reason: "unapproved: no owner signature — nothing synced",
      synced: [],
      noop: true
    };
  }
  if (typeof syncSource !== "function")
    throw new Error("applySync: a syncSource dependency is required");
  const cleanSet = new Set(proposal.clean || []);
  const sessions = (source.sessions || []).filter((s) => cleanSet.has(s.sid));
  const result = syncSource(
    kelLog,
    stagingRoot,
    { ...source, sessions },
    { codeCommit: "", configHash: "" }
  );
  const movedNew = result?.sessionsNew ?? sessions.length;
  let event = null;
  if (movedNew > 0) {
    event = {
      kind: "estate.sync.approved",
      proposal: proposal.id,
      satellite: proposal.satellite,
      signature: proposal.signature,
      synced: sessions.map((s) => s.sid),
      count: movedNew,
      at: Date.now()
    };
    bus?.publish?.("estate", event);
  }
  return {
    applied: true,
    synced: event ? sessions.map((s) => s.sid) : [],
    noop: !event,
    event,
    syncResult: result
  };
}
