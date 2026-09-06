// POST /api/gov_raise — put something forward for a decision.
//
// The generating end of the governance spine. Signing (gov_sign) was the only writer until
// now, so the queue could only be seeded by hand and every `caused_by` edge in the estate had
// nothing legitimate to point at. This is where proposals actually come from.
//
// Raising is deliberately NOT the mirror image of signing, because the two carry different
// power. A signature authorises; a proposal asks. So the rules differ:
//
//   AUTHORSHIP IS "frontier", HARD-CODED. Everything that reaches an HTTP endpoint is a
//   program making a request. A human's intent enters this ledger through a SIGNATURE, which
//   is verified and attributed; calling a request "human" because someone was logged in when
//   a program sent it is the same category error as letting a client name its own signer. A
//   human whose proposal is recorded as frontier loses nothing — it still needs their
//   signature. An agent recorded as human would be a lie with consequences. The asymmetry is
//   the safe one, so it is the one taken. Who asked is recorded separately, as `requested_by`.
//
//   RAISING IS IDEMPOTENT, AND A SETTLED PROPOSAL CANNOT BE RE-RAISED. Agents notice the same
//   thing repeatedly. Without idempotence the queue fills with duplicates, signing becomes
//   rubber-stamping, and the signature stops meaning anything — approval fatigue is the
//   realistic way a register like this dies, well before any technical fault. Re-raising an
//   OPEN proposal refreshes it in place; re-raising one already signed or declined is refused.
//
//   A PROPOSAL WITHOUT A RATIONALE IS REFUSED. The signer needs to know why before deciding,
//   and "the agent suggested it" is not a why. Evidence is optional; a reason is not.
import os from "node:os";
import {
  proposalRaisedEvent,
  loadGovernance,
  subjectId,
  GOVERNANCE_TYPES
} from "../coordination/lib/governance.mjs";
import { appendKelEvent } from "../coordination/lib/kel.mjs";
import { governanceLogPath, ensureParent } from "../lib/estate_store.js";

// The id becomes part of a subject id (`proposal:<id>`), and provenance.mjs will only accept
// a subject id with no whitespace. Validating here means a bad id is a 400 at the door rather
// than an edge nobody can reference later.
const ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;

const asList = (v) =>
  (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((s) => String(s)).filter(Boolean);

function requester(context) {
  const fromSession = String(context?.user?.username || "").trim();
  if (fromSession) return fromSession;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

export async function post(context) {
  const body = context?.body && typeof context.body === "object" ? context.body : {};

  const proposalId = String(body.proposalId || "").trim();
  const title = String(body.title || "").trim();
  const rationale = String(body.rationale || "").trim();

  if (!ID.test(proposalId)) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          "proposalId must be a slug: lowercase letters, digits, dot, dash or underscore, 1-81 chars"
      }
    };
  }
  if (!title) return { status: 400, body: { ok: false, error: "title is required" } };
  if (!rationale) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "rationale is required — a signer decides on the why, not on the title"
      }
    };
  }

  const { file } = governanceLogPath();
  const gov = loadGovernance(file);

  // Same refusal as gov_sign: never append onto a chain that no longer verifies. A proposal
  // written after a break would be evidence resting on a record we know has been altered.
  if (gov.ok === false) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `governance chain is broken at line ${gov.badLine}; refusing to append`
      }
    };
  }

  const existing = gov.proposals.find((p) => p.id === proposalId);
  if (existing && existing.state !== "open") {
    // Terminal. Re-raising a decision already made is how a queue starts asking for the same
    // signature twice; the caller should choose a new id if the situation has genuinely changed.
    return {
      status: 409,
      body: {
        ok: false,
        error: `proposal '${proposalId}' was already ${existing.state}; raise a new id if this is a new situation`,
        state: existing.state
      }
    };
  }

  // An unchanged re-raise writes nothing. The fold would collapse it to one queue item either
  // way, so the duplicate is invisible in the UI while the ledger grows without bound — an
  // agent noticing the same thing every five minutes would bury the real history in restatement.
  // Silence is the correct response to "still true", and it keeps the log worth reading.
  const evidence = asList(body.evidence);
  if (
    existing &&
    existing.title === title &&
    existing.rationale === rationale &&
    JSON.stringify(existing.evidence ?? []) === JSON.stringify(evidence)
  ) {
    return {
      headers: { "Cache-Control": "no-store" },
      status: 200,
      body: {
        ok: true,
        proposalId,
        subject: subjectId.proposal(proposalId),
        unchanged: true,
        note: "already open with identical content; nothing appended"
      }
    };
  }

  let evt;
  try {
    evt = proposalRaisedEvent({
      proposalId,
      machine: String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase(),
      title,
      rationale,
      evidence,
      domain: String(body.domain || "work"),
      cost: body.cost ?? null,
      reversible: typeof body.reversible === "boolean" ? body.reversible : null,
      authorship: "frontier", // invariant: a request is not a person (see header)
      // The subjects whose state prompted this. provenance.mjs rejects prose here, so a bad
      // edge is a 400 now rather than a dangling parent in the lineage graph forever.
      derivedFrom: asList(body.derivedFrom),
      causedBy: body.causedBy ?? null
    });
  } catch (e) {
    return { status: 400, body: { ok: false, error: e.message } };
  }

  // Who asked is a fact about the request, not about authorship — recorded, never conflated.
  evt.payload.requested_by = requester(context);

  const res = appendKelEvent(ensureParent(file), evt);
  if (!res.ok) {
    return { status: 500, body: { ok: false, error: res.reason || "append failed" } };
  }

  return {
    headers: { "Cache-Control": "no-store" },
    status: existing ? 200 : 201,
    body: {
      ok: true,
      proposalId,
      subject: subjectId.proposal(proposalId),
      refreshed: Boolean(existing), // an open proposal was updated rather than duplicated
      authorship: evt.authorship,
      requested_by: evt.payload.requested_by,
      at: evt.valid_time,
      type: GOVERNANCE_TYPES.raised
    }
  };
}
