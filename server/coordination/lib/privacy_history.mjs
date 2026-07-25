// Privacy-honoring history + keep-both-and-flag conflict (L9 / EP-L). Governance AT PROJECTION.
// Design: SOLUTION §4.1 (conflict/privacy at projection) + §4.7; steer 9. R4, R6, R31.
//
// Three guarantees, all applied when the KEL is folded into a projection (never on the write path):
//   1. TELEPORT EXCLUSION (R4/R31) — a sid in longview/quarantine.json never enters any projection
//      at ANY point in bi-temporal time. Reuses the exact { sids } shape the LONGVIEW teleport tool
//      (scripts/longview/memory.mjs) and inventory reads already honor.
//   2. REVERSIBLE TOMBSTONE (R6) — a privacy deletion appends a `tombstoned` event (which hides the
//      subject from projections) AND journals the removed payload. The append-only KEL is never
//      rewritten/erased; restore re-asserts from the journal. "Moves + journalled", like teleport.
//   3. KEEP-BOTH-AND-FLAG (steer 9/R31) — two events asserting contradictory facts at the SAME
//      valid_time are BOTH projected under a `conflict` marker and a `conflict_flagged` review event
//      is emitted; the projector NEVER auto-picks a winner. A correction at a LATER valid_time is not
//      a conflict — it is a normal bi-temporal update.
import fs from "node:fs";
import { readKelEvents, appendKelEvent, foldProjection, applyConverters, ulid, CURRENT_SCHEMA_VERSION } from "./kel.mjs";
import { NON_PROJECTED_TYPES } from "./projector.mjs";

// --- quarantine (teleport exclusion) ----------------------------------------
// Reads the { sids, updated } shape; a missing/unreadable file is an empty quarantine (fail-open on
// READ — absence of the file must not crash a projection; teleport is the thing that writes it).
export function loadQuarantine(quarantineFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(quarantineFile, "utf8"));
    return { sids: new Set(raw.sids || []), raw };
  } catch {
    return { sids: new Set(), raw: { sids: [] } };
  }
}

// A pure event filter for projector.rebuild's `eventFilter` hook: drop events whose sid is quarantined.
export function quarantineFilter(quarantineFile) {
  const { sids } = loadQuarantine(quarantineFile);
  return (evt) => !sids.has(evt?.sid);
}

// --- reversible privacy deletion (tombstone + journal) ----------------------
// Captures the subject's current payload, journals it, then appends a `tombstoned` event. The
// original assertion line stays in the append-only log (nothing is erased) — the tombstone hides it.
export function privacyDelete(logFile, journalFile, { subjectId, sid, reason = "privacy-deletion", machine = "t480", converters = {} }) {
  const { events } = readKelEvents(logFile);
  const proj = foldProjection(
    events.filter((e) => !NON_PROJECTED_TYPES.has(e.type)),
    { converters }
  );
  const current = proj.get(subjectId);
  if (!current) return { ok: false, reason: "subject-not-present" };
  const now = new Date().toISOString();
  // journal first (so a crash after the tombstone still leaves the payload recoverable).
  fs.appendFileSync(
    journalFile,
    JSON.stringify({ subject_id: subjectId, sid, payload: current.payload, reason, deleted_at: now }) + "\n"
  );
  const r = appendKelEvent(logFile, {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "tombstoned",
    valid_time: now,
    txn_time: now,
    time_confidence: "known",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship: "house",
    sid: sid ?? current.event?.sid ?? "privacy",
    subject: { kind: current.event?.subject?.kind ?? "card", id: subjectId },
    payload: { reason }
  });
  return { ok: r.ok, journalled: true, reason: r.reason };
}

// Restore = re-assert the journalled payload as a NEW event (correction-by-new-event doctrine), so
// the deletion is fully reversible and the whole history stays append-only.
export function restorePrivacyDeletion(logFile, journalFile, { subjectId, machine = "t480" }) {
  let entries;
  try {
    entries = fs.readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { ok: false, reason: "no-journal" };
  }
  const last = [...entries].reverse().find((e) => e.subject_id === subjectId);
  if (!last) return { ok: false, reason: "not-journalled" };
  const now = new Date().toISOString();
  const r = appendKelEvent(logFile, {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "card_asserted",
    valid_time: now,
    txn_time: now,
    time_confidence: "known",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship: "house",
    sid: last.sid ?? "privacy-restore",
    subject: { kind: "card", id: subjectId },
    payload: last.payload
  });
  return { ok: r.ok, restored: true, reason: r.reason };
}

// --- privacy- + conflict-aware projection -----------------------------------
// Returns { store, conflicts }. `store` excludes quarantined sids; a conflicted subject is
// `{ conflict: true, candidates: [...payloads], valid_time }` (NEVER a single auto-picked payload);
// non-conflicting subjects fold to their latest value. Emits a `conflict_flagged` review event per
// conflict to `reviewLog` (if given) — surfaced for a human, not resolved here.
export function projectWithPrivacy(
  logFile,
  { quarantineFile, reviewLog, asOfValidTime, asOfTxnTime, converters = {}, machine = "t480" } = {}
) {
  const keep = quarantineFile ? quarantineFilter(quarantineFile) : () => true;
  const { events } = readKelEvents(logFile);
  const vt = asOfValidTime != null ? Date.parse(asOfValidTime) : Infinity;
  const tt = asOfTxnTime != null ? Date.parse(asOfTxnTime) : Infinity;

  const bySubject = new Map();
  for (const raw of events) {
    if (NON_PROJECTED_TYPES.has(raw.type)) continue; // bookkeeping never projects
    if (!keep(raw)) continue; // teleport exclusion, at every bi-temporal point
    const e = applyConverters(raw, converters);
    if (Date.parse(e.valid_time) > vt || Date.parse(e.txn_time) > tt) continue;
    if (!bySubject.has(e.subject.id)) bySubject.set(e.subject.id, []);
    bySubject.get(e.subject.id).push(e);
  }

  const store = {};
  const conflicts = [];
  const byTxnHlc = (a, b) =>
    Date.parse(a.txn_time) - Date.parse(b.txn_time) || (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0);

  for (const id of [...bySubject.keys()].sort()) {
    const evts = bySubject.get(id);
    // the DECIDING valid_time is the latest one asserted for this subject.
    const maxVt = Math.max(...evts.map((e) => Date.parse(e.valid_time)));
    const atMax = evts.filter((e) => Date.parse(e.valid_time) === maxVt).sort(byTxnHlc);
    const latest = atMax.at(-1);
    if (latest.type === "tombstoned") continue; // reversible privacy deletion hides the subject

    // distinct, contradicting payloads asserted AT the deciding valid_time = a same-time conflict.
    const nonTomb = atMax.filter((e) => e.type !== "tombstoned");
    const seen = new Map();
    for (const e of nonTomb) seen.set(JSON.stringify(e.payload ?? {}), e.payload ?? {});
    const distinct = [...seen.values()];

    if (distinct.length >= 2) {
      store[id] = { conflict: true, candidates: distinct, valid_time: new Date(maxVt).toISOString() };
      const conflict = { subject_id: id, valid_time: new Date(maxVt).toISOString(), candidates: distinct };
      conflicts.push(conflict);
      if (reviewLog) {
        const now = new Date().toISOString();
        appendKelEvent(reviewLog, {
          id: ulid(),
          schema_version: CURRENT_SCHEMA_VERSION,
          type: "conflict_flagged",
          valid_time: conflict.valid_time,
          txn_time: now,
          time_confidence: "known",
          hlc: `${now}-0000-${machine}`,
          machine,
          authorship: "house",
          sid: "conflict-review",
          subject: { kind: "card", id },
          payload: { candidates: distinct, note: "kept-both; awaiting human resolution" }
        });
      }
    } else {
      store[id] = latest.payload ?? {};
    }
  }
  return { store, conflicts };
}
