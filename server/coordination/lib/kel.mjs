// Knowledge event log (KEL) — the flywheel's truth substrate (L0 / EP-L).
// Spec: architecture/SPEC-knowledge-eventlog.md · Schema: ../schema/kel-event.schema.json
//
// Reuses the B0 coordination-ledger doctrine (server/coordination/lib/ledger.mjs)
// verbatim rather than inventing a new persistence model: append-only, one JSON
// object per line, prev = sha256(previous raw line)[0..16], state = fold(events),
// and — per the G0 non-blocking rule (SPEC-run-events.md) — writers never raise
// for I/O reasons; they degrade to a logged no-op. On top of that it adds the
// bi-temporal + provenance envelope and a fold-to-projection with a versioned
// up-converter registry so old records stay replayable (steer 10 / R32).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envelopeSchema = JSON.parse(
  fs.readFileSync(path.join(here, "..", "schema", "kel-event.schema.json"), "utf8")
);

export const CURRENT_SCHEMA_VERSION = "1.0.0";

// --- ulid (same construction as the ledger, so ids are cross-comparable) ---
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()) {
  let t = now,
    ts = "";
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let rnd = "";
  for (const b of crypto.randomBytes(16)) rnd += B32[b % 32];
  return ts + rnd.slice(0, 16);
}

const lineHash = (raw) =>
  crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);

// --- envelope validation (enforces exactly the JSON-Schema subset the schema uses) ---
function checkSchema(obj, schema) {
  if (schema.type === "object" && (typeof obj !== "object" || obj === null || Array.isArray(obj)))
    return "not an object";
  for (const key of schema.required ?? [])
    if (!(key in obj)) return `missing required field '${key}'`;
  for (const [key, val] of Object.entries(obj)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown field '${key}'`;
      continue;
    }
    if (prop.enum && !prop.enum.includes(val)) return `'${key}' not one of ${prop.enum.join("|")}`;
    if (prop.type === "string" && typeof val !== "string") return `'${key}' must be a string`;
    if (prop.type === "object" && (typeof val !== "object" || val === null || Array.isArray(val)))
      return `'${key}' must be an object`;
    if (prop.type === "array" && !Array.isArray(val)) return `'${key}' must be an array`;
    if (prop.minLength && typeof val === "string" && val.length < prop.minLength)
      return `'${key}' too short`;
    if (prop.pattern && typeof val === "string" && !new RegExp(prop.pattern).test(val))
      return `'${key}' malformed`;
  }
  return null;
}

export function validateKelEvent(evt) {
  const err = checkSchema(evt, envelopeSchema);
  if (err) return { ok: false, reason: err };
  for (const f of ["valid_time", "txn_time"])
    if (Number.isNaN(Date.parse(evt[f]))) return { ok: false, reason: `'${f}' is not a real date` };
  if (!evt.subject || typeof evt.subject.id !== "string" || evt.subject.id.length === 0)
    return { ok: false, reason: "subject.id missing" };
  return { ok: true };
}

function rawLines(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

// --- append: validate → chain → append. Never raises for I/O (G0 rule). ---
export function appendKelEvent(logFile, evt, { logger = console } = {}) {
  const v = validateKelEvent(evt);
  if (!v.ok) return { ok: false, reason: v.reason }; // rejected (caller bug), not a degrade
  try {
    const lines = rawLines(logFile);
    const prev = lines.length === 0 ? "genesis" : lineHash(lines.at(-1));
    const line = JSON.stringify({ ...evt, prev });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + "\n");
    return { ok: true, line };
  } catch (e) {
    if (typeof logger.warn === "function")
      logger.warn(`[kel] append degraded (${e.code || e.message}); event not written`);
    return { ok: false, degraded: true, reason: e.code || e.message };
  }
}

// --- read + verify the tamper-evident chain. badLine is 1-based: the line whose
//     prev-hash no longer matches its predecessor (i.e. the successor of an edit). ---
export function readKelEvents(logFile) {
  const lines = rawLines(logFile);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    let evt;
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      return { ok: false, badLine: i + 1, reason: "unparseable", events };
    }
    const expected = i === 0 ? "genesis" : lineHash(lines[i - 1]);
    if (evt.prev !== expected) return { ok: false, badLine: i + 1, reason: "chain-break", events };
    events.push(evt);
  }
  return { ok: true, events };
}

// --- versioned up-converters: keep old records replayable (steer 10 / R32) ---
export function applyConverters(evt, converters = {}, target = CURRENT_SCHEMA_VERSION) {
  let cur = evt;
  const seen = new Set();
  while (cur.schema_version !== target) {
    if (seen.has(cur.schema_version)) break; // cycle guard
    seen.add(cur.schema_version);
    let fn = converters[`${cur.schema_version}->${target}`];
    let toV = target;
    if (!fn) {
      const step = Object.keys(converters).find((k) => k.startsWith(`${cur.schema_version}->`));
      if (!step) break; // no conversion path; leave as-is (best effort)
      fn = converters[step];
      toV = step.split("->")[1];
    }
    cur = { ...fn(cur), schema_version: toV };
  }
  return cur;
}

// --- state = fold(events); projections are rebuilt from the log (steer 1). ---
// Bi-temporal: asOfValidTime answers "what was true at T", asOfTxnTime answers
// "what did we know at T". Latest transaction-time wins per subject; tombstones remove.
export function foldProjection(
  events,
  { asOfValidTime, asOfTxnTime, converters = {}, target = CURRENT_SCHEMA_VERSION } = {}
) {
  const vt = asOfValidTime != null ? Date.parse(asOfValidTime) : Infinity;
  const tt = asOfTxnTime != null ? Date.parse(asOfTxnTime) : Infinity;
  const candidates = events
    .filter((e) => Date.parse(e.valid_time) <= vt && Date.parse(e.txn_time) <= tt)
    .map((e) => applyConverters(e, converters, target))
    .sort(
      (a, b) =>
        Date.parse(a.txn_time) - Date.parse(b.txn_time) ||
        (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0)
    );
  const proj = new Map();
  for (const e of candidates) {
    if (e.type === "tombstoned") {
      proj.delete(e.subject.id);
      continue;
    }
    proj.set(e.subject.id, { payload: e.payload ?? {}, event: e });
  }
  return proj;
}
