// Estate inventory (SS1/23) — what actually exists, compared with what the ledger claims.
// Spec: architecture/SPEC-knowledge-eventlog.md · artifacts.mjs · evidence.mjs
//
// Two closure defects have been NOT MEASURABLE since the evidence pack was built, for the
// same reason: you cannot count what is outside a ledger by reading the ledger. Both need a
// look at the world. This module takes that look, and reconciles the two.
//
//   orphan-artifact   — bytes on disk that no event accounts for.
//   unrecorded-action — a placement the ledger asserts, whose file is gone. Something
//                       changed the estate and wrote nothing down; the absence IS the
//                       evidence, and it is the only form an unrecorded action can take
//                       that an inside-out system can honestly detect.
//
// The load-bearing decision is SCOPE, and it is what stops this from becoming the very
// dishonesty it exists to remove.
//
//   A SWEEP RECONCILES ONLY WHAT IT COULD SEE. Reconciliation is keyed on PATH, not on
//   machine: a placement is judged if and only if its path lies under a root this sweep
//   actually walked. The estate store sits on a share, so a t480 sweep legitimately sees
//   optimus's placements under F:\ — while a placement at C:\ on another node is neither
//   "present" nor "missing", it is UNSEEN, and it is reported that way. Marking an
//   unreachable path "missing" would manufacture a defect out of not looking; marking it
//   "fine" would hide a real one. Only the third answer is true.
//
//   THE SCOPE TRAVELS WITH THE RESULT. "0 orphans" means nothing without the boundary it
//   was measured in. Every result carries the roots that were walked and the count it could
//   not judge, so a reader can never mistake a narrow clean sweep for a wide one.
import fs from "node:fs";
import path from "node:path";
import { ARTIFACT_TYPES, buildArtifacts } from "./artifacts.mjs";

const bare = (h) => String(h || "").replace(/^sha256:/, "");

// Windows gives us backslashes, ledgers hold whatever the writer used, and F:/x and F:\x are
// the same file. Compare on a normalised, case-folded form — on Windows paths are
// case-insensitive, and a reconciliation that missed for a capital letter would report a
// present file as an unrecorded deletion.
const norm = (p) =>
  path
    .resolve(String(p || ""))
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

const isUnder = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + "/");
};

function walk(dir, out = [], { limit = 200000 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable is not empty; the caller records the root as walked-with-error
  }
  for (const e of entries) {
    if (out.length >= limit) return out;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, { limit });
    else if (e.isFile()) {
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({ path: full, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out;
}

// --- the sweep: observe, do not judge --------------------------------------------------
//
// Deliberately separate from reconcile(). Observation is a fact about the world; comparison
// is an opinion about the ledger. Keeping them apart means a snapshot can be re-reconciled
// later against a ledger that has since grown, without re-walking a disk.
export function sweepEstate(root, { include = [] } = {}) {
  const blobsRoot = path.join(root, "blobs", "sha256");
  const placementsRoot = path.join(root, "placements");

  const roots = [];
  const addRoot = (p, kind) => {
    const exists = fs.existsSync(p);
    roots.push({ path: p, kind, exists });
    return exists;
  };

  const blobs = [];
  if (addRoot(blobsRoot, "blobs")) {
    for (const f of walk(blobsRoot)) {
      // The store names a blob by its hash; the two-character shard above it is just fanout.
      // Trusting the NAME rather than re-hashing is deliberate: re-reading every blob would
      // turn a sweep into hours of I/O, and integrity is already the CAS's own guarantee at
      // write time. A sweep answers "what is here", not "are the bytes still right".
      blobs.push({ hash: path.basename(f.path), path: f.path, size: f.size, mtime: f.mtime });
    }
  }

  const files = [];
  const fileRoots = [placementsRoot, ...include];
  for (const r of fileRoots) if (addRoot(r, "files")) files.push(...walk(r));

  return {
    swept_at: new Date().toISOString(),
    root,
    // Everything a later reader needs to know how far this result reaches.
    scope: {
      roots,
      walked: roots.filter((r) => r.exists).map((r) => r.path),
      missing_roots: roots.filter((r) => !r.exists).map((r) => r.path)
    },
    blobs,
    files
  };
}

// --- reconcile: the ledger's claims against the observation -----------------------------
export function reconcile(inventory, events = []) {
  const artifactEvents = events.filter((e) => String(e.type || "").startsWith("artifact_"));
  const state = buildArtifacts(artifactEvents);

  const walked = inventory.scope.walked;
  const seen = (p) => walked.some((r) => isUnder(p, r));

  // --- blobs -------------------------------------------------------------------------
  //
  // "Accounted for" means SOME event references these bytes, not specifically an acquisition.
  // The first sweep to run with --record proved why: it stored its own snapshot in the CAS and
  // then reported that snapshot as an orphan, because nothing had acquired it — the audit
  // contaminating the thing it audits. The `sweep_recorded` event names the hash and accounts
  // for it perfectly well. So any reference anywhere in the ledger counts, which is both the
  // literal definition of the defect and robust against the next writer that puts bytes in the
  // store by some other route.
  const referencedHashes = new Set();
  for (const e of events) {
    for (const m of JSON.stringify(e).matchAll(/\b[0-9a-f]{64}\b/g)) referencedHashes.add(m[0]);
  }
  const acquiredHashes = new Set(
    artifactEvents
      .filter((e) => e.type === ARTIFACT_TYPES.acquired)
      .map((e) => bare(e.subject?.content_hash || e.subject?.id?.split(":").pop()))
      .filter(Boolean)
  );
  const heldHashes = new Set(inventory.blobs.map((b) => bare(b.hash)));

  const orphanBlobs = inventory.blobs.filter((b) => !referencedHashes.has(bare(b.hash)));
  // Missing blobs stay keyed on ACQUISITION, not on any reference: the claim being tested is
  // "we hold these bytes", and only an acquisition makes that claim. An event that merely
  // mentions a hash promises nothing about the store holding it.
  const blobsWalked = inventory.scope.roots.some((r) => r.kind === "blobs" && r.exists);
  const missingBlobs = blobsWalked
    ? [...acquiredHashes].filter((h) => !heldHashes.has(h)).map((hash) => ({ hash }))
    : [];

  // --- placements --------------------------------------------------------------------
  // buildArtifacts has already retired evicted placements, so what remains is what the
  // ledger currently ASSERTS is on disk. Each is judged only if its path was walked.
  const claimed = state.flatMap((a) =>
    a.placements.map((p) => ({ hash: a.hash, machine: p.machine, path: p.path, at: p.at }))
  );
  const claimedInScope = claimed.filter((c) => seen(c.path));
  const unseen = claimed.filter((c) => !seen(c.path));

  const observedPaths = new Set(inventory.files.map((f) => norm(f.path)));
  const missingPlacements = claimedInScope.filter((c) => !observedPaths.has(norm(c.path)));

  // Files under a swept root that no live placement accounts for. Blobs are excluded — they
  // are the store's own storage, judged above on their own terms.
  const claimedPaths = new Set(claimed.map((c) => norm(c.path)));
  const orphanFiles = inventory.files.filter((f) => !claimedPaths.has(norm(f.path)));

  const bytes = (rows) => rows.reduce((n, r) => n + (r.size || 0), 0);

  return {
    swept_at: inventory.swept_at,
    scope: inventory.scope,
    counts: {
      blobs_held: inventory.blobs.length,
      files_seen: inventory.files.length,
      placements_claimed: claimed.length,
      placements_in_scope: claimedInScope.length,
      placements_unseen: unseen.length
    },
    // orphan-artifact: bytes present that nothing accounts for.
    orphans: {
      blobs: orphanBlobs,
      files: orphanFiles,
      count: orphanBlobs.length + orphanFiles.length,
      bytes: bytes(orphanBlobs) + bytes(orphanFiles)
    },
    // unrecorded-action: the ledger asserts it is there; it is not. Something acted silently.
    unrecorded: {
      missing_placements: missingPlacements,
      missing_blobs: missingBlobs,
      count: missingPlacements.length + missingBlobs.length
    },
    // Never folded into either verdict: not looked at is not the same as looked at and fine.
    unseen
  };
}

// The subject id for a sweep, so the run itself is a thing lineage can carry.
export const subjectId = Object.freeze({
  sweep: (machine, at) => `sweep:${machine}:${at}`
});
