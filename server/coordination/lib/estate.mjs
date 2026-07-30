// Estate projection (EP-N / N0) — the physical estate (machines, drives, sessions,
// snapshots) folded from the KEL, one more rebuildable projection of the same shape
// as L0/L5. Content-hash keyed so a session held on two drives is ONE entry referenced
// by both (dedup is intrinsic — the D: portable copy and the F: backup collapse to one
// blob per unique content). Spec: architecture/SOLUTION-estate.md §3.1.
//
// Estate facts are entities in their own dedicated estate KEL log, so they reuse the L0
// envelope's existing `entity_asserted` type verbatim (no schema change); the estate
// grain is carried by subject.kind + payload.estate_kind and, crucially, by the subject
// id prefix (machine:/drive:/session:/snapshot:) which the fold buckets on.
//
// Pure over its inputs: builders return KEL envelopes (the sync engine appends them),
// buildEstate folds events → state, serializeEstate is deterministic so the derived
// estate.jsonl rebuilds byte-identical from the same log.
import fs from "node:fs";
import path from "node:path";
import { ulid, readKelEvents, foldProjection, CURRENT_SCHEMA_VERSION } from "./kel.mjs";

// estate facts ride the L0 envelope's existing entity type (no schema enum change)
export const ESTATE_KEL_TYPE = "entity_asserted";
export const ESTATE_KINDS = Object.freeze({
  machine: "machine",
  drive: "drive",
  session: "session",
  snapshot: "snapshot"
});

// subject id schemes — session keys on CONTENT (sha256), never sid, so identical
// content from different sids/machines/drives is a single subject (the dedup guarantee).
export const subjectId = Object.freeze({
  machine: (name) => `machine:${name}`,
  drive: (machine, label) => `drive:${machine}:${label}`,
  session: (contentHash) => `session:${contentHash}`, // contentHash already "sha256:<hex>"
  snapshot: (machine, label, date) => `snapshot:${machine}:${label}:${date}`
});

// is this KEL event an estate fact? (keyed off the subject id prefix, not the type — the
// estate log may be dedicated, but this stays robust if it ever shares a log)
export function isEstateSubjectId(id) {
  return typeof id === "string" && /^(machine|drive|session|snapshot):/.test(id);
}

function envelope({ estateKind, machine, subject, payload, valid_time }) {
  const now = new Date().toISOString();
  const vt = valid_time || now;
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: ESTATE_KEL_TYPE,
    valid_time: vt,
    txn_time: now,
    time_confidence: valid_time ? "known" : "inferred",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship: "house", // estate telemetry is house-generated
    sid: subject.id,
    subject,
    payload: { estate_kind: estateKind, ...payload }
  };
}

export function estateMachineEvent({ machine, role, payload = {} }) {
  return envelope({
    estateKind: ESTATE_KINDS.machine,
    machine,
    subject: { kind: "machine", id: subjectId.machine(machine) },
    payload: { machine, role, ...payload }
  });
}

export function estateSessionEvent({
  machine,
  contentHash,
  sid,
  project = null,
  quarantined = false
}) {
  return envelope({
    estateKind: ESTATE_KINDS.session,
    machine,
    subject: { kind: "session", id: subjectId.session(contentHash), content_hash: contentHash },
    payload: { sid, project, quarantined: !!quarantined, content_hash: contentHash }
  });
}

export function estateDriveEvent({
  machine,
  label,
  role,
  fingerprint,
  sessionHashes,
  bytes = 0,
  verdict = "INTACT"
}) {
  const hashes = [...new Set(sessionHashes)].sort();
  return envelope({
    estateKind: ESTATE_KINDS.drive,
    machine,
    subject: { kind: "drive", id: subjectId.drive(machine, label) },
    payload: {
      machine,
      label,
      role,
      fingerprint,
      verdict,
      count: hashes.length,
      bytes,
      session_hashes: hashes
    }
  });
}

export function estateSnapshotEvent({ machine, label, date, fingerprint, count = 0, bytes = 0 }) {
  return envelope({
    estateKind: ESTATE_KINDS.snapshot,
    machine,
    subject: { kind: "snapshot", id: subjectId.snapshot(machine, label, date) },
    payload: { machine, label, date, fingerprint, count, bytes }
  });
}

// state = fold(events). Groups the folded projection by subject kind and inverts the
// drive→session_hashes lists so every session lists the drives that reference it
// (one content-hash entry, N drives) — the overlap-dedup guarantee made observable.
export function buildEstate(events, opts = {}) {
  const proj = foldProjection(events, opts);
  const machines = {};
  const drives = {};
  const sessions = {};
  const snapshots = {};
  for (const [id, { payload }] of proj) {
    if (!isEstateSubjectId(id)) continue; // ignore cursors / non-estate subjects
    if (id.startsWith("machine:")) machines[payload.machine] = { role: payload.role ?? null };
    else if (id.startsWith("drive:"))
      drives[`${payload.machine}:${payload.label}`] = {
        machine: payload.machine,
        label: payload.label,
        role: payload.role ?? null,
        fingerprint: payload.fingerprint ?? null,
        verdict: payload.verdict ?? null,
        count: payload.count ?? 0,
        bytes: payload.bytes ?? 0,
        session_hashes: payload.session_hashes ?? [],
        sessions: []
      };
    else if (id.startsWith("session:"))
      sessions[payload.content_hash] = {
        sid: payload.sid ?? null,
        project: payload.project ?? null,
        quarantined: !!payload.quarantined,
        drives: []
      };
    else if (id.startsWith("snapshot:"))
      snapshots[`${payload.machine}:${payload.label}:${payload.date}`] = {
        machine: payload.machine,
        label: payload.label,
        date: payload.date,
        fingerprint: payload.fingerprint ?? null,
        count: payload.count ?? 0,
        bytes: payload.bytes ?? 0
      };
  }
  // invert drive.session_hashes -> session.drives (dedup: one session, many drives)
  for (const [driveKey, d] of Object.entries(drives)) {
    for (const h of d.session_hashes || []) {
      if (sessions[h]) sessions[h].drives.push(driveKey);
      d.sessions.push(h);
    }
  }
  for (const s of Object.values(sessions)) s.drives.sort();
  return { machines, drives, sessions, snapshots };
}

// Deterministic serialization — sorted keys at every level so rebuild-from-log is
// byte-identical (no timestamps derived here; state comes from the events verbatim).
export function serializeEstate(estate) {
  return JSON.stringify(sortDeep(estate), null, 2) + "\n";
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

// Rebuild the derived estate.jsonl from the KEL alone (steer 1: projections rebuild
// from the log). Returns { ok, estate } and writes outPath deterministically.
export function rebuildEstateFile(kelLog, outPath, opts = {}) {
  const r = readKelEvents(kelLog);
  if (!r.ok) return { ok: false, reason: r.reason, badLine: r.badLine };
  const estate = buildEstate(r.events, opts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serializeEstate(estate));
  return { ok: true, estate };
}
