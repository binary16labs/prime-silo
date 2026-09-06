// GET /api/lineage_trail?sid=... — one subject's whole history, step by step.
//
// This is the time-travel read: every event that ever touched the subject, in transaction
// order, each with the projection the system would have returned at that moment.
//
// A subject from a ledger whose chain does not verify is still returned — refusing would hide
// the fact that it exists — but it arrives flagged `quarantined`, and the surface must not
// present a quarantined trail as evidence.
import { buildLineage, subjectTrail } from "../coordination/lib/lineage.mjs";
import { collectLedgers } from "../coordination/lib/evidence.mjs";
import { resolveEstateStore } from "../lib/estate_store.js";

export async function get(context) {
  const sid = String(context?.query?.sid || "").trim();
  if (!sid) return { status: 400, body: { ok: false, error: "sid is required" } };

  const { root, source } = resolveEstateStore();
  const ledgers = collectLedgers(root);
  const index = buildLineage(ledgers);
  const trail = subjectTrail(index, sid);

  // Not found is a real answer, and a different one from "the store is missing" — the store
  // row travels with the 404 so the operator can tell which of the two they are looking at.
  if (!trail) {
    return {
      status: 404,
      body: { ok: false, error: `no subject '${sid}' in any ledger`, store: { root, source } }
    };
  }

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: { ok: true, store: { root, source }, trail }
  };
}
