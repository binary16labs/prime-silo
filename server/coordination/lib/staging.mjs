// Portable CAS staging (L1 / EP-L) — the single point of truth for un-synthesized raw input.
// Spec: architecture/SPEC-knowledge-eventlog.md (§ Staging) · Design: SOLUTION §4.2 / §5.2 (steer 2).
//
// Full hybrid, three ideas composed (not chosen between):
//   blobs/<algo>/<hh>/<hash>            content-addressed store — identity = hash, de-dup (R20)
//   index/<machine>/<date>/<sid>.json   human-navigable pointer records into the blobs (R19)
//   manifests/<machine>.json            self-describing, so the drive attaches anywhere (R18)
// Local-first / offline (R21): pure filesystem, no network, no machine need be online. Each staged
// session emits a `session_staged` KEL event (L0) so it is admissible to synthesis later.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ulid, appendKelEvent } from "./kel.mjs";

export const STAGING_SCHEMA_VERSION = "1.0.0";
const ROOTS = { blobs: "blobs", index: "index", manifests: "manifests", eventlog: "eventlog" };

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const dayBucket = (iso) => new Date(iso).toISOString().slice(0, 10); // yyyy-mm-dd

// --- self-describing manifest: lets the pipeline resume with no per-machine config (R18) ---
export function initManifest(root, { machine, hardware = {}, hlcNodeId }) {
  const p = path.join(root, ROOTS.manifests, `${machine}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const manifest = {
    machine,
    hardware,
    hlc_node_id: hlcNodeId ?? machine,
    staging_root: path.basename(root),
    blobs_root: ROOTS.blobs,
    index_root: ROOTS.index,
    kel_root: ROOTS.eventlog,
    last_hlc: null,
    backup_target: null,
    schema_version: STAGING_SCHEMA_VERSION
  };
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// --- content-addressed blob store (de-dup by hash — R20) ---
export function blobPath(root, hash) {
  return path.join(root, ROOTS.blobs, "sha256", hash.slice(0, 2), hash);
}
export function resolveBlob(root, hash) {
  return blobPath(root, hash);
}
export function blobFilesFor(root, hash) {
  const p = blobPath(root, hash);
  return fs.existsSync(p) ? [p] : [];
}
export function casStore(root, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const hash = sha256(buf);
  const p = blobPath(root, hash);
  if (fs.existsSync(p)) return { hash, path: p, deduped: true }; // same content synced twice → one blob
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return { hash, path: p, deduped: false };
}

// --- stage one session: blob + human-navigable index record + a session_staged KEL event ---
export function stageSession(root, session) {
  const {
    sid,
    machine,
    process: proc,
    project,
    task_context,
    valid_time,
    authorship,
    content,
    links = {}
  } = session;

  const blob = casStore(root, content);

  const record = {
    sid,
    machine,
    process: proc,
    project,
    task_context,
    captured_at: new Date().toISOString(),
    valid_time,
    blobs: [`sha256:${blob.hash}`],
    authorship,
    links: { cards: links.cards ?? [], concepts: links.concepts ?? [] },
    poison_gate: "pending", // inbound integrity gate is L2; not yet admitted to synthesis
    schema_version: STAGING_SCHEMA_VERSION
  };
  const indexPath = path.join(root, ROOTS.index, machine, dayBucket(valid_time), `${sid}.json`);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(record, null, 2) + "\n");

  // emit a session_staged KEL event so the session is admissible to synthesis later (reuse L0)
  const now = new Date().toISOString();
  appendKelEvent(path.join(root, ROOTS.eventlog, "events.jsonl"), {
    id: ulid(),
    schema_version: STAGING_SCHEMA_VERSION,
    type: "session_staged",
    valid_time,
    txn_time: now,
    time_confidence: valid_time ? "known" : "inferred",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship,
    sid,
    subject: { kind: "session", id: sid, content_hash: `sha256:${blob.hash}` },
    payload: { project, task_context, process: proc, links: record.links }
  });

  return { hash: blob.hash, deduped: blob.deduped, index: record, indexPath, blobPath: blob.path };
}

// --- plug-and-play open: resolve roots + inventory from the drive, no per-machine config (R18/R20) ---
export function openStaging(root) {
  const manifestsDir = path.join(root, ROOTS.manifests);
  const machines = fs.existsSync(manifestsDir)
    ? fs
        .readdirSync(manifestsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    : [];
  // roots come from a manifest when present, else the well-known defaults — either way, no env needed
  let roots = { ...ROOTS };
  if (machines.length) {
    const m = JSON.parse(fs.readFileSync(path.join(manifestsDir, `${machines[0]}.json`), "utf8"));
    roots = {
      blobs: m.blobs_root ?? ROOTS.blobs,
      index: m.index_root ?? ROOTS.index,
      manifests: ROOTS.manifests,
      eventlog: m.kel_root ?? ROOTS.eventlog
    };
  }
  const sessions = [];
  const indexDir = path.join(root, roots.index);
  if (fs.existsSync(indexDir)) {
    for (const mach of fs.readdirSync(indexDir)) {
      const md = path.join(indexDir, mach);
      if (!fs.statSync(md).isDirectory()) continue;
      for (const day of fs.readdirSync(md)) {
        const dd = path.join(md, day);
        if (!fs.statSync(dd).isDirectory()) continue;
        for (const f of fs.readdirSync(dd))
          if (f.endsWith(".json"))
            sessions.push(JSON.parse(fs.readFileSync(path.join(dd, f), "utf8")));
      }
    }
  }
  return { root, roots, machines, sessions };
}
