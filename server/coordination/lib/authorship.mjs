// Authorship provenance + record-served tagging (L6 / EP-L) — capture-time.
// Every staged session (L1) and execution record (L5) carries authorship in {human, frontier, house},
// so the training signal's origin is auditable from the first house-authored session. This is the
// WAVE-1 half of R38 (tagging) and R39 (recording which model is served + what it replaced). The
// fraction-cap + verifier gate (R38 → L11) and the human-signed promotion gate + rollback (R39 → L12)
// activate in wave 3 — this task tags and records only, it does not enforce policy. Design: SOLUTION §4.6/§5.5.
import fs from "node:fs";
import path from "node:path";

export const AUTHORSHIP = ["human", "frontier", "house"];
export const SERVED_SCHEMA_VERSION = "1.0.0";

export function validateAuthorship(a) {
  return AUTHORSHIP.includes(a);
}

// Refuse a record that is not provenance-tagged (used strictly where a record could become a
// training row — the R38 collapse-guard depends on knowing the origin).
export function requireAuthorship(record) {
  if (!record || !validateAuthorship(record.authorship))
    return { ok: false, reason: `authorship must be one of ${AUTHORSHIP.join("|")}` };
  return { ok: true };
}

// Record which model is served behind the router and what it replaced (the revert target).
// Shape per SOLUTION §5.5; the human_signature + decision_rule are filled by the wave-3 promotion
// gate (L12/L13) — here we only record served + predecessor so rollback is always possible.
export function recordServed(
  pointerPath,
  { served, replaces = null, decisionVector = null, humanSignature = null, rollbackTo } = {}
) {
  const now = new Date().toISOString();
  const ptr = {
    type: "model_promotion",
    served,
    replaces,
    rollback_to: rollbackTo ?? replaces,
    decision_vector: decisionVector,
    decision_rule: null,
    human_signature: humanSignature,
    valid_time: now,
    txn_time: now,
    schema_version: SERVED_SCHEMA_VERSION
  };
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  fs.writeFileSync(pointerPath, JSON.stringify(ptr, null, 2) + "\n");
  return ptr;
}

export function readServed(pointerPath) {
  return JSON.parse(fs.readFileSync(pointerPath, "utf8"));
}
