// POST /api/gov_sign — record a human decision on a proposal.
//
// This is the one place in the estate where authorisation is granted, so two rules are enforced
// here and nowhere else.
//
//   THE CLIENT CANNOT CHOOSE WHO SIGNED. The signer is taken from the authenticated session (or,
//   failing that, the OS account the server runs as) and a signer supplied in the request body is
//   ignored outright. A signature you can type someone else's name into is not a signature; it is
//   a text field, and the whole register would inherit that weakness.
//
//   ONLY A HUMAN SIGNS. `authorship: "human"` is hard-coded by proposalSignedEvent — not passed
//   from here, and certainly not from a browser. An agent may raise a proposal and may never
//   authorise one (ADR-001 / R38).
//
// Declining is recorded too. A register that only kept approvals would imply everything proposed
// was accepted, which is a flattering lie about how decisions actually went.
import os from "node:os";
import {
  proposalSignedEvent,
  proposalDeclinedEvent,
  loadGovernance
} from "../coordination/lib/governance.mjs";
import { appendKelEvent } from "../coordination/lib/kel.mjs";
import { governanceLogPath, ensureParent } from "../lib/estate_store.js";

function resolveSigner(context) {
  const fromSession = String(context?.user?.username || "").trim();
  if (fromSession) return { signer: fromSession, source: "session" };
  try {
    return { signer: os.userInfo().username, source: "os-account" };
  } catch {
    return { signer: "", source: "unknown" };
  }
}

export async function post(context) {
  const body = context?.body && typeof context.body === "object" ? context.body : {};
  const proposalId = String(body.proposalId || "").trim();
  const decision = String(body.decision || "sign").trim();
  const note = String(body.note || "").slice(0, 2000);

  if (!proposalId) {
    return { status: 400, body: { ok: false, error: "proposalId is required" } };
  }
  if (decision !== "sign" && decision !== "decline") {
    return { status: 400, body: { ok: false, error: `unknown decision '${decision}'` } };
  }

  const { signer, source } = resolveSigner(context);
  if (!signer) {
    return {
      status: 403,
      body: {
        ok: false,
        error: "no identifiable signer — an unattributed signature authorises nothing"
      }
    };
  }

  const { file } = governanceLogPath();
  const gov = loadGovernance(file);

  // Refuse to append onto a ledger that no longer verifies: a signature written after a break
  // would be evidence resting on a record we already know has been altered.
  if (gov.ok === false) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `governance chain is broken at line ${gov.badLine}; refusing to append`
      }
    };
  }

  const target = gov.proposals.find((p) => p.id === proposalId);
  if (!target) {
    return { status: 404, body: { ok: false, error: `no proposal '${proposalId}'` } };
  }
  if (target.state !== "open") {
    return {
      status: 409,
      body: { ok: false, error: `proposal '${proposalId}' is already ${target.state}` }
    };
  }

  const machine = String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase();
  const evt =
    decision === "sign"
      ? proposalSignedEvent({ proposalId, machine, signer, note })
      : proposalDeclinedEvent({ proposalId, machine, signer, reason: note });

  const res = appendKelEvent(ensureParent(file), evt);
  if (!res.ok) {
    return { status: 500, body: { ok: false, error: res.reason || "append failed" } };
  }

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      ok: true,
      decision,
      proposalId,
      signer,
      signer_source: source, // visible so the operator can see WHERE the identity came from
      at: evt.valid_time,
      authorship: evt.authorship
    }
  };
}
