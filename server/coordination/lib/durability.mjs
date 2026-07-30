// Durability of the portable substrate (L3 / EP-L). R17 makes D: the single point of truth;
// append-only is not backed up. This replicates the staging + KEL substrate to a second LOCAL
// target, verifies integrity by checksum (blobs are content-addressed; the KEL is chain-hashed),
// and rebuilds a projection from the replica alone (the restore drill). Backup is a local copy,
// not a cloud dependency — stays local-first (R21/R34). Extends R41. Design: SOLUTION §4.2.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openStaging } from "./staging.mjs";
import { readKelEvents } from "./kel.mjs";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const SUBTREES = ["blobs", "eventlog", "index", "manifests"];

function copyTree(src, dst) {
  let files = 0;
  if (!fs.existsSync(src)) return files;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      files += copyTree(s, d);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d); // byte-identical copy
      files++;
    }
  }
  return files;
}

// Replicate the whole substrate to a second local target (byte-identical).
export function replicate(primaryRoot, replicaRoot) {
  let files = 0;
  for (const sub of SUBTREES)
    files += copyTree(path.join(primaryRoot, sub), path.join(replicaRoot, sub));
  return { files, replicaRoot };
}

// Integrity: every blob must re-hash to its content-addressed name; the KEL chain must verify.
export function integrityCheck(root) {
  const mismatches = [];
  const blobsRoot = path.join(root, "blobs", "sha256");
  if (fs.existsSync(blobsRoot)) {
    for (const hh of fs.readdirSync(blobsRoot)) {
      const dir = path.join(blobsRoot, hh);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const actual = sha256(fs.readFileSync(p));
        if (actual !== name) mismatches.push({ blob: p, expected: name, actual });
      }
    }
  }
  const kelPath = path.join(root, "eventlog", "events.jsonl");
  let kelBroken = false;
  if (fs.existsSync(kelPath)) kelBroken = readKelEvents(kelPath).ok === false;

  return { ok: mismatches.length === 0 && !kelBroken, mismatches, kelBroken };
}

// Restore drill: rebuild the staged-session projection (sid + blob refs) from a root alone.
// Run against the replica when the primary is unavailable; equals the pre-failure inventory.
export function restoreFromReplica(root) {
  return openStaging(root).sessions.map((s) => ({ sid: s.sid, blobs: s.blobs }));
}
