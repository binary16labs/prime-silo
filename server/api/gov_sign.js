// POST /api/gov_sign — record a human decision on a proposal.
//
// This is the one place in the estate where authorisation is granted, so two rules are enforced
// here and nowhere else.
//
//   THE CLIENT CANNOT CHOOSE WHO SIGNED. The signer is taken from the authenticated session (or,
//   when the session is the single-user placeholder or absent, the OS account the server runs
//   as) and a signer supplied in the request body is ignored outright. A signature you can type
//   someone else's name into is not a signature; it is a text field, and the whole register
//   would inherit that weakness.
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

// THE SINGLE-USER PRINCIPAL IS A PLACEHOLDER, NOT A PERSON. The desktop app runs in single-user
// mode, where every request resolves to an implicit principal whose name is the constant "user"
// (SINGLE_USER_APP_USERNAME). That name identifies a slot, not whoever is at the keyboard — and
// it was being written into the ledger as the signer, so a reviewer asking "who approved
// release-1-24-1?" read "user". The OS account the app runs under IS the person at this
// machine, and it is resolved here on the server: nothing a request carries can influence it,
// which is what keeps "the client cannot choose who signed" true.
//
// If that account cannot be read, the signature is refused rather than falling back to "user":
// a placeholder recorded as a signer is an unattributed signature wearing a name tag.
//
// `osAccount` is injectable so the rule can be tested without depending on who runs the suite.
export function resolveSigner(context, { osAccount = () => os.userInfo().username } = {}) {
  const user = context?.user || {};
  const fromSession = String(user.username || "").trim();
  const placeholder = user.source === "single-user-app";
  if (fromSession && !placeholder) return { signer: fromSession, source: "session" };
  try {
    const name = String(osAccount() || "").trim();
    if (name) {
      return { signer: name, source: placeholder ? "single-user-app:os-account" : "os-account" };
    }
  } catch {
    // Falls through to the refusal: an unreadable account is not a licence to use the slot name.
  }
  return { signer: "", source: "unknown" };
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
  // The source is written into the event, not just echoed in the response: a reviewer reading
  // the ledger a year from now needs to know whether a name came from a login or from the OS.
  const evt =
    decision === "sign"
      ? proposalSignedEvent({ proposalId, machine, signer, note, signerSource: source })
      : proposalDeclinedEvent({ proposalId, machine, signer, reason: note, signerSource: source });

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
