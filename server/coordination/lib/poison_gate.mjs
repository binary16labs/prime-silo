// Inbound poison gate (L2 / EP-L) — an integrity/validation boundary at admission,
// symmetric to the OUTBOUND leak gate (scripts/longview/lib/leak_gate.mjs). Staged raw
// arriving from many machines must pass this before it is admitted to synthesis/training,
// so a corrupted or injected session on one machine cannot flow into the corpus (R40).
// Spec/design: SOLUTION §4.2. Reads the CAS staging store from L1.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // a single session blob ceiling; oversized = suspicious

// `prev` is a KEL-internal chain hash added by the appender — raw session data NEVER carries it.
// A staged blob that parses as an object with `prev` + a control `type` is trying to pose as a
// chained control event (e.g. a tombstone/schema-migration) rather than opaque session data.
function looksLikeForgedControl(content) {
  let o;
  try {
    o = JSON.parse(content);
  } catch {
    return false; // opaque / non-JSON bytes are fine as data
  }
  return (
    o && typeof o === "object" && !Array.isArray(o) &&
    Object.prototype.hasOwnProperty.call(o, "prev") &&
    typeof o.type === "string"
  );
}

// Pure inspection — no I/O. Returns { admissible, reason? }.
export function poisonGate({ content, declaredContentHash, record, maxBytes = DEFAULT_MAX_BYTES }) {
  if (!record || typeof record.sid !== "string" || record.sid.length === 0)
    return { admissible: false, reason: "malformed-record" };
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content ?? "");
  if (buf.length > maxBytes) return { admissible: false, reason: "oversized" };
  const declared = String(declaredContentHash ?? "").replace(/^sha256:/, "");
  if (declared.length === 0) return { admissible: false, reason: "no-declared-hash" };
  if (sha256(buf) !== declared) return { admissible: false, reason: "hash-mismatch" };
  if (looksLikeForgedControl(buf.toString("utf8")))
    return { admissible: false, reason: "injected-control-record" };
  return { admissible: true };
}

// Rejections are ledgered with a reason (append-only, one JSON object per line).
export function ledgerRejection(stagingRoot, entry) {
  const p = path.join(stagingRoot, "poison-rejections.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  return p;
}

// Admit a staged session by its index record: run the gate against its blob, stamp the
// index record `poison_gate` pass/rejected, ledger any rejection. Reuses the L1 CAS layout.
export function admit(stagingRoot, indexPath, { maxBytes } = {}) {
  const record = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const ref = (record.blobs && record.blobs[0]) || "";
  const hash = ref.replace(/^sha256:/, "");
  const blobPath = path.join(stagingRoot, "blobs", "sha256", hash.slice(0, 2), hash);
  let content = null;
  try {
    content = fs.readFileSync(blobPath);
  } catch {
    const reason = "missing-blob";
    record.poison_gate = "rejected";
    fs.writeFileSync(indexPath, JSON.stringify(record, null, 2) + "\n");
    ledgerRejection(stagingRoot, { sid: record.sid, reason });
    return { admissible: false, reason };
  }
  const r = poisonGate({ content, declaredContentHash: ref, record, maxBytes });
  record.poison_gate = r.admissible ? "pass" : "rejected";
  fs.writeFileSync(indexPath, JSON.stringify(record, null, 2) + "\n");
  if (!r.admissible) ledgerRejection(stagingRoot, { sid: record.sid, reason: r.reason });
  return r;
}
