// Governance projection (SS1/23 Principle 2) — the authorisation spine.
// Spec: architecture/SPEC-knowledge-eventlog.md (envelope) · ADR-001 (determinism boundary).
//
// The estate could always show WHAT ran — the execution register carries commit, model,
// cost and outcome. What it could not show is WHO AUTHORISED IT, because a signature was
// a UI state rather than a fact. "The operator approved it" that lives only in a button
// press is indistinguishable, after the fact, from nobody having approved it at all.
//
// So a signature becomes an event, and authorisation becomes a query over the log rather
// than a claim about the past. ADR-001 then stops being a convention and starts being
// checkable: a run is authorised iff a `proposal_signed` event with authorship "human"
// exists for its proposal.
//
// The load-bearing invariant is narrow and enforced here, in one place:
//
//   ONLY a human may sign. An agent may raise a proposal and may never authorise one.
//
// That is why `proposalSignedEvent` hard-codes authorship rather than accepting it as a
// parameter — a builder that let a caller pass `authorship: "frontier"` would make agent
// self-authorisation a typo away, and the whole register would silently mean nothing.
//
// Pure over its inputs, matching estate.mjs: builders return KEL envelopes and the caller
// appends them, so nothing here touches the filesystem and every function is testable
// without a log.
import { ulid, readKelEvents, CURRENT_SCHEMA_VERSION } from "./kel.mjs";
import { provenance, withProvenance } from "./provenance.mjs";

export const GOVERNANCE_TYPES = Object.freeze({
  raised: "proposal_raised",
  signed: "proposal_signed",
  declined: "proposal_declined"
});

// Subject ids are prefixed so a shared log can be bucketed the way estate.mjs does.
export const subjectId = Object.freeze({
  proposal: (id) => `proposal:${id}`
});

export function isProposalSubjectId(id) {
  return typeof id === "string" && id.startsWith("proposal:");
}

// Only these may act. `house` is deliberately absent from signing: deterministic
// machinery emits facts, it does not exercise judgement (R38).
const PROPOSER_AUTHORSHIP = new Set(["frontier", "human", "house"]);

function envelope({ type, authorship, machine, proposalId, payload, valid_time }) {
  const now = new Date().toISOString();
  const vt = valid_time || now;
  const subject = { kind: "proposal", id: subjectId.proposal(proposalId) };
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type,
    valid_time: vt,
    // steer 8: never fabricate precision — an unknown valid_time IS the txn_time.
    txn_time: now,
    time_confidence: valid_time ? "known" : "inferred",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship,
    sid: subject.id, // envelope requires a non-empty sid; the subject is the join key
    subject,
    payload
  };
}

// --- raise: an agent (or you) puts something forward. Carries the four things a
//     signer needs BEFORE deciding, so the evidence is part of the record and not a
//     link that may rot: why, what it rests on, what it costs, whether it reverses. ---
export function proposalRaisedEvent({
  proposalId,
  machine,
  title,
  rationale,
  evidence = [],
  domain = "work",
  cost = null,
  reversible = null,
  authorship = "frontier",
  valid_time = null,
  // Where this proposal came from. `derivedFrom` are the subjects whose state prompted it
  // — the failing service, the artifact, the node that went quiet. `causedBy` is an earlier
  // decision this one follows from. Both are subject ids; the human-readable version of the
  // same thing belongs in `rationale` and `evidence`, which is why those stay untouched.
  derivedFrom = [],
  causedBy = null
}) {
  if (!proposalId) throw new Error("proposalRaisedEvent: proposalId is required");
  if (!machine) throw new Error("proposalRaisedEvent: machine is required");
  if (!title) throw new Error("proposalRaisedEvent: title is required");
  if (!PROPOSER_AUTHORSHIP.has(authorship))
    throw new Error(`proposalRaisedEvent: unknown authorship '${authorship}'`);
  return envelope({
    type: GOVERNANCE_TYPES.raised,
    authorship,
    machine,
    proposalId,
    valid_time,
    payload: withProvenance(
      { title, rationale, evidence, domain, cost, reversible },
      provenance({ derivedFrom, causedBy, subject: subjectId.proposal(proposalId) })
    )
  });
}

// --- sign: the authorisation. authorship is NOT a parameter, by design (see header). ---
export function proposalSignedEvent({ proposalId, machine, signer, note = "", valid_time = null }) {
  if (!proposalId) throw new Error("proposalSignedEvent: proposalId is required");
  if (!machine) throw new Error("proposalSignedEvent: machine is required");
  if (!signer)
    throw new Error(
      "proposalSignedEvent: signer is required — an unattributed signature authorises nothing"
    );
  return envelope({
    type: GOVERNANCE_TYPES.signed,
    authorship: "human", // invariant: only a human signs
    machine,
    proposalId,
    valid_time,
    payload: { signer, note }
  });
}

// --- decline: also a human act, and also recorded. A declined proposal is evidence of
//     judgement exercised; dropping it would make the register look like everything
//     proposed was approved. ---
export function proposalDeclinedEvent({
  proposalId,
  machine,
  signer,
  reason = "",
  valid_time = null
}) {
  if (!proposalId) throw new Error("proposalDeclinedEvent: proposalId is required");
  if (!machine) throw new Error("proposalDeclinedEvent: machine is required");
  if (!signer) throw new Error("proposalDeclinedEvent: signer is required");
  return envelope({
    type: GOVERNANCE_TYPES.declined,
    authorship: "human",
    machine,
    proposalId,
    valid_time,
    payload: { signer, reason }
  });
}

const proposalIdOf = (evt) =>
  typeof evt?.subject?.id === "string" ? evt.subject.id.replace(/^proposal:/, "") : null;

// --- fold: events → current state. Deterministic and order-dependent on the log, which
//     is the log's own order (append-only), so two readers always agree. ---
export function buildGovernance(events = []) {
  const proposals = new Map();
  for (const evt of events) {
    const id = proposalIdOf(evt);
    if (!id) continue;
    switch (evt.type) {
      case GOVERNANCE_TYPES.raised:
        proposals.set(id, {
          id,
          state: "open",
          raised_at: evt.valid_time,
          raised_by: evt.authorship,
          machine: evt.machine,
          ...evt.payload,
          signature: null
        });
        break;
      case GOVERNANCE_TYPES.signed: {
        const p = proposals.get(id);
        if (!p) break; // a signature for an unknown proposal is not an authorisation
        // A human signature is terminal: later events never silently un-approve it.
        if (p.state === "open") {
          p.state = "signed";
          p.signature = { signer: evt.payload?.signer, at: evt.valid_time, event_id: evt.id };
        }
        break;
      }
      case GOVERNANCE_TYPES.declined: {
        const p = proposals.get(id);
        if (!p) break;
        if (p.state === "open") {
          p.state = "declined";
          p.signature = { signer: evt.payload?.signer, at: evt.valid_time, event_id: evt.id };
        }
        break;
      }
      default:
        break;
    }
  }
  const all = [...proposals.values()];
  return {
    proposals: all,
    open: all.filter((p) => p.state === "open"),
    signed: all.filter((p) => p.state === "signed"),
    declined: all.filter((p) => p.state === "declined")
  };
}

// --- the SS1/23 question, asked directly. A proposal is authorised iff a signature
//     event exists for it AND that event was authored by a human. Both halves matter:
//     the first is presence, the second is what stops an agent approving its own work. ---
export function isAuthorised(events = [], proposalId) {
  return events.some(
    (evt) =>
      evt?.type === GOVERNANCE_TYPES.signed &&
      proposalIdOf(evt) === proposalId &&
      evt.authorship === "human"
  );
}

// --- the closure metric from the traceability matrix: runs that executed with no human
//     authoriser. This is the number the Gov arc publishes; it should trend to zero and
//     any non-zero value names exactly which runs are the defect. ---
export function unauthorisedRuns(events = [], runs = []) {
  return runs
    .filter((run) => !run.proposal_id || !isAuthorised(events, run.proposal_id))
    .map((run) => ({ run_id: run.run_id, proposal_id: run.proposal_id || null }));
}

// --- convenience: read a governance log and fold it in one call. Surfaces a chain break
//     rather than swallowing it — tamper-evidence is worthless if the reader ignores it. ---
export function loadGovernance(logFile) {
  const { ok, events, badLine, reason } = readKelEvents(logFile);
  const state = buildGovernance(events);
  return { ok, badLine: badLine ?? null, reason: reason ?? null, ...state };
}
