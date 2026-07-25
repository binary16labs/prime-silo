// Bi-temporal projectors (L8 / EP-L) — rebuild the stores as projections of the KEL truth log.
// Design: SOLUTION §4.1 (projection) + §5.1/§5.6 (envelope, converters); steers 1/10. R1–R3, R7, R32.
//
// The KEL is truth; Neo4j/Chroma/memo-ray/cards are REBUILDABLE projections (steer 1). A projector
// folds the log (optionally at a bi-temporal slice), applies the L0 up-converter registry so old
// records stay replayable (R32), and hands the resulting subject→state map to a *sink*. A sink is a
// thin pure function `projectionMap -> store`: the card sink is the deterministic reference proving
// the engine; Neo4j/Chroma/memo-ray adapters conform to the same signature (additive — never replace
// the live write path, R36). Privacy/quarantine + keep-both-and-flag conflict handling is L9's job.
import crypto from "node:crypto";
import { readKelEvents, foldProjection, applyConverters } from "./kel.mjs";

// --- sinks: projectionMap (subjectId -> {payload, event}) -> store -----------
// Card sink — the reference deterministic projection: a plain object subjectId -> payload,
// with keys in sorted order so the serialization (and its hash) is stable.
export function cardSink(projectionMap) {
  const store = {};
  for (const id of [...projectionMap.keys()].sort()) store[id] = projectionMap.get(id).payload;
  return store;
}

// Graph sink — a thin adapter proving the projection-sink interface is plug-and-play. A real
// Neo4j/Chroma writer conforms to this same `(projectionMap) -> store` signature; here it is
// smoke-only (cards remain the deterministic reference sink, per the L8 out-of-scope note).
export function graphSink(projectionMap) {
  const nodes = [];
  const edges = [];
  for (const id of [...projectionMap.keys()].sort()) {
    const { payload } = projectionMap.get(id);
    nodes.push({ id, kind: payload?.kind ?? "card" });
    for (const c of payload?.concepts ?? []) edges.push({ from: id, to: c, rel: "MENTIONS" });
  }
  return { nodes, edges };
}

// --- deterministic content hash of a store (drives the knowledge_watermark) --
// Canonical JSON: object keys sorted recursively, so the same logical store always hashes the same.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}
export function projectionHash(store) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(store)), "utf8").digest("hex").slice(0, 32);
}

// Bookkeeping event types that live in the KEL but are NOT knowledge — they fold into the delta
// engine / execution register, never into a knowledge projection. A projection folds knowledge
// assertions (and their tombstones), not cursors. New bookkeeping types extend this set.
export const NON_PROJECTED_TYPES = new Set(["cursor_advanced"]);

// --- rebuild-from-log: the replay guarantee (R32). Deterministic: delete + re-fold is identical. --
// `asOfValidTime` / `asOfTxnTime` slice the bi-temporal axes (undefined = now/all). By default only
// knowledge events are projected; pass `types` to opt into an explicit allowlist instead.
// `eventFilter` is an ADDITIVE governance hook (L9): a pure `(evt) => boolean` applied before the
// fold so a projector can drop e.g. teleported/quarantined sids at every bi-temporal point (R4/R31).
// Default undefined = no filtering, so the L8 default path is unchanged (R36 additivity).
export function rebuild(logFile, { asOfValidTime, asOfTxnTime, converters = {}, sink = cardSink, types, eventFilter } = {}) {
  const { events } = readKelEvents(logFile);
  const knowledge = events.filter(
    (e) => (types ? types.includes(e.type) : !NON_PROJECTED_TYPES.has(e.type)) && (!eventFilter || eventFilter(e))
  );
  const proj = foldProjection(knowledge, { asOfValidTime, asOfTxnTime, converters });
  return sink(proj);
}

// --- incremental reprojection (R8/R10 via L4 cursors) ------------------------
// Given a prior card store and only the events of the changed input(s), overlay them onto the store,
// touching only the affected subjects — not the whole store. `newEvents` are the latest (higher
// txn_time) events for the changed session, so overlay == a full refold for those subjects.
export function reprojectIncremental(prevStore, newEvents, { converters = {} } = {}) {
  const store = { ...prevStore };
  // apply in txn-time then HLC order so the latest assertion wins, matching foldProjection.
  const ordered = [...newEvents]
    .map((e) => applyConverters(e, converters))
    .sort(
      (a, b) =>
        Date.parse(a.txn_time) - Date.parse(b.txn_time) ||
        (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0)
    );
  const touched = new Set();
  for (const e of ordered) {
    const id = e.subject.id;
    touched.add(id);
    if (e.type === "tombstoned") delete store[id];
    else store[id] = e.payload ?? {};
  }
  // return keys in sorted order (match cardSink) + the touched list in first-seen sorted order.
  const sorted = {};
  for (const k of Object.keys(store).sort()) sorted[k] = store[k];
  return { store: sorted, touched: [...touched].sort() };
}
