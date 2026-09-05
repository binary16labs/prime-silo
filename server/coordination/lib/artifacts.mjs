// Artifact ledger (L1 over the CAS) — acquire once, place anywhere.
// Spec: architecture/SPEC-knowledge-eventlog.md (§ Staging) · builds on staging.mjs.
//
// The estate downloaded the same 123 MB installer twice in one day — once to F: on the
// t480, once to C: on the ASUS — and recorded neither. The bytes were already in a
// content-addressed store that de-dups by construction; what was missing was the ledger
// that turns storage into distribution.
//
// A session is staged once and finished. An artifact has an ongoing relationship with
// every machine that materialises it, so the grain here is a PLACEMENT: a claim that a
// named machine holds this blob at this path. Placements are events, which is why
// "which nodes have this, and where?" is a fold over the log rather than a walk across
// three machines.
//
// Two properties are deliberate and worth stating, because both are easy to lose:
//
//   Eviction retires a placement, never the blob. Reclaiming space on a laptop must not
//   be able to destroy the only copy of something.
//
//   The saving comes from asking BEFORE fetching. You only learn a file's hash by reading
//   it, so de-dup after the fact still costs the transfer. acquireArtifact therefore takes
//   `expectedHash` (releases publish one — .sha256 sidecars, sha512 in the metadata YAML)
//   and, when the blob is already held, never opens the source at all.
//
// Builders are pure and return KEL envelopes (estate.mjs / governance.mjs house style);
// the orchestrators below are the only functions here that touch disk.
import fs from "node:fs";
import path from "node:path";
import { ulid, CURRENT_SCHEMA_VERSION, appendKelEvent } from "./kel.mjs";
import { blobPath, hasBlob, casStoreStream } from "./staging.mjs";

export const ARTIFACT_TYPES = Object.freeze({
  acquired: "artifact_acquired",
  verified: "artifact_verified",
  placed: "artifact_placed",
  evicted: "artifact_evicted"
});

const bare = (hash) => String(hash || "").replace(/^sha256:/, "");
export const subjectId = Object.freeze({
  artifact: (hash) => `artifact:sha256:${bare(hash)}`
});

export function isArtifactSubjectId(id) {
  return typeof id === "string" && id.startsWith("artifact:");
}

function envelope({ type, hash, machine, authorship, payload, valid_time }) {
  const now = new Date().toISOString();
  const subject = {
    kind: "artifact",
    id: subjectId.artifact(hash),
    content_hash: `sha256:${bare(hash)}`
  };
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type,
    valid_time: valid_time || now,
    txn_time: now,
    time_confidence: valid_time ? "known" : "inferred",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship,
    sid: subject.id,
    subject,
    payload
  };
}

// --- builders (pure) ---------------------------------------------------------------

export function artifactAcquiredEvent({
  hash,
  machine,
  sourceUri,
  size,
  label = "",
  mediaType = null,
  publisher = null,
  deduped = false,
  fetched = true,
  authorship = "human",
  valid_time = null
}) {
  if (!hash) throw new Error("artifactAcquiredEvent: hash is required");
  if (!machine) throw new Error("artifactAcquiredEvent: machine is required");
  return envelope({
    type: ARTIFACT_TYPES.acquired,
    hash,
    machine,
    authorship,
    valid_time,
    // `deduped` and `fetched` are both recorded because the interesting distinction is
    // between them: deduped-and-fetched is transfer we wasted, deduped-and-not-fetched is
    // transfer we avoided. Without both flags the waste gauge cannot tell them apart.
    payload: {
      source_uri: sourceUri,
      size,
      label,
      media_type: mediaType,
      publisher,
      deduped,
      fetched
    }
  });
}

export function artifactVerifiedEvent({
  hash,
  machine,
  method = "sha256",
  expected = null,
  actual = null,
  ok = true,
  authorship = "house",
  valid_time = null
}) {
  if (!hash) throw new Error("artifactVerifiedEvent: hash is required");
  if (!machine) throw new Error("artifactVerifiedEvent: machine is required");
  return envelope({
    type: ARTIFACT_TYPES.verified,
    hash,
    machine,
    authorship, // verification is deterministic machinery, not judgement (R38)
    valid_time,
    payload: { method, expected, actual, ok }
  });
}

export function artifactPlacedEvent({
  hash,
  machine,
  path: at,
  purpose = "",
  authorship = "house",
  valid_time = null
}) {
  if (!hash) throw new Error("artifactPlacedEvent: hash is required");
  if (!machine) throw new Error("artifactPlacedEvent: machine is required");
  if (!at)
    throw new Error(
      "artifactPlacedEvent: path is required — a placement with no location is not a claim"
    );
  return envelope({
    type: ARTIFACT_TYPES.placed,
    hash,
    machine,
    authorship,
    valid_time,
    payload: { path: at, purpose }
  });
}

export function artifactEvictedEvent({
  hash,
  machine,
  path: at,
  reason = "",
  authorship = "house",
  valid_time = null
}) {
  if (!hash) throw new Error("artifactEvictedEvent: hash is required");
  if (!machine) throw new Error("artifactEvictedEvent: machine is required");
  return envelope({
    type: ARTIFACT_TYPES.evicted,
    hash,
    machine,
    authorship,
    valid_time,
    payload: { path: at, reason }
  });
}

// --- orchestrators (these touch disk) ------------------------------------------------

// Acquire an artifact into the store, fetching only if we do not already hold it.
// `open` is injected (async () => Readable) so this is testable without a network and so
// the caller decides how bytes arrive — http, a mounted share, a carried disk.
export async function acquireArtifact(
  root,
  logFile,
  {
    sourceUri,
    label = "",
    mediaType = null,
    publisher = null,
    expectedHash = null,
    expectedSize = null,
    machine,
    authorship = "human",
    open
  }
) {
  if (!machine) throw new Error("acquireArtifact: machine is required");

  // The whole feature: if the publisher told us the hash and we already hold those bytes,
  // the source is never opened. This is the difference between de-dup and not downloading.
  if (expectedHash && hasBlob(root, expectedHash)) {
    const hash = bare(expectedHash);
    const evt = artifactAcquiredEvent({
      hash,
      machine,
      sourceUri,
      size: expectedSize ?? statSize(blobPath(root, hash)),
      label,
      mediaType,
      publisher,
      deduped: true,
      fetched: false, // the source was never opened — this is the saving, not the waste
      authorship
    });
    appendKelEvent(logFile, evt);
    return {
      hash,
      deduped: true,
      fetched: false,
      bytes: 0,
      path: blobPath(root, hash),
      event: evt
    };
  }

  if (typeof open !== "function")
    throw new Error(
      "acquireArtifact: `open` (async () => Readable) is required when the blob is not held"
    );

  const stored = await casStoreStream(root, await open(), { expectedHash, expectedSize });

  const acquired = artifactAcquiredEvent({
    hash: stored.hash,
    machine,
    sourceUri,
    size: stored.bytes,
    label,
    mediaType,
    publisher,
    deduped: stored.deduped,
    fetched: true, // we opened the source; if deduped is also true those bytes were wasted
    authorship
  });
  appendKelEvent(logFile, acquired);

  // casStoreStream already refused a mismatch before admitting the bytes, so reaching here
  // IS the verification result — recording it makes that check auditable rather than implicit.
  appendKelEvent(
    logFile,
    artifactVerifiedEvent({
      hash: stored.hash,
      machine,
      expected: expectedHash ? bare(expectedHash) : null,
      actual: stored.hash,
      ok: true
    })
  );

  return {
    hash: stored.hash,
    deduped: stored.deduped,
    fetched: true,
    bytes: stored.bytes,
    path: stored.path,
    event: acquired
  };
}

// Materialise a held blob at a path on this machine and record the placement.
export async function placeArtifact(
  root,
  logFile,
  { hash, machine, path: target, purpose = "", overwrite = false }
) {
  if (!machine) throw new Error("placeArtifact: machine is required");
  if (!target) throw new Error("placeArtifact: path is required");
  const src = blobPath(root, bare(hash));
  if (!fs.existsSync(src)) throw new Error(`placeArtifact: blob not held — ${bare(hash)}`);

  if (fs.existsSync(target) && !overwrite) {
    const evt = artifactPlacedEvent({ hash, machine, path: target, purpose });
    appendKelEvent(logFile, evt);
    return { placed: false, alreadyThere: true, path: target, event: evt };
  }

  // Only create the parent if it is missing. On Windows a drive or share root
  // (F:\, \\host\share) already exists but mkdir on it raises EPERM rather than
  // EEXIST — so an unguarded recursive mkdir makes "place it at the root of the
  // NAS" fail for a reason that has nothing to do with the caller.
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  await fs.promises.copyFile(src, target);
  const evt = artifactPlacedEvent({ hash, machine, path: target, purpose });
  appendKelEvent(logFile, evt);
  return { placed: true, alreadyThere: false, path: target, event: evt };
}

// Remove a local copy. The blob is untouched by design — see the header.
export function evictPlacement(root, logFile, { hash, machine, path: target, reason = "" }) {
  if (!machine) throw new Error("evictPlacement: machine is required");
  let removed = false;
  if (target && fs.existsSync(target)) {
    fs.rmSync(target, { force: true });
    removed = true;
  }
  const evt = artifactEvictedEvent({ hash, machine, path: target, reason });
  appendKelEvent(logFile, evt);
  return { removed, blobRetained: fs.existsSync(blobPath(root, bare(hash))), event: evt };
}

function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

// --- projections (pure folds over events) --------------------------------------------

const hashOf = (evt) =>
  typeof evt?.subject?.content_hash === "string" ? bare(evt.subject.content_hash) : null;

export function buildArtifacts(events = []) {
  const byHash = new Map();
  const ensure = (hash) => {
    if (!byHash.has(hash))
      byHash.set(hash, {
        hash,
        label: "",
        size: null,
        source_uri: null,
        media_type: null,
        publisher: null,
        verified: false,
        placements: []
      });
    return byHash.get(hash);
  };

  for (const evt of events) {
    const hash = hashOf(evt);
    if (!hash) continue;
    const a = ensure(hash);
    const p = evt.payload || {};
    switch (evt.type) {
      case ARTIFACT_TYPES.acquired:
        a.label = p.label || a.label;
        a.size = p.size ?? a.size;
        a.source_uri = p.source_uri ?? a.source_uri;
        a.media_type = p.media_type ?? a.media_type;
        a.publisher = p.publisher ?? a.publisher;
        break;
      case ARTIFACT_TYPES.verified:
        a.verified = a.verified || p.ok === true;
        break;
      case ARTIFACT_TYPES.placed: {
        const existing = a.placements.find((x) => x.machine === evt.machine && x.path === p.path);
        if (!existing)
          a.placements.push({
            machine: evt.machine,
            path: p.path,
            at: evt.valid_time,
            purpose: p.purpose || ""
          });
        break;
      }
      case ARTIFACT_TYPES.evicted:
        a.placements = a.placements.filter(
          (x) => !(x.machine === evt.machine && (!p.path || x.path === p.path))
        );
        break;
      default:
        break;
    }
  }
  return [...byHash.values()];
}

export function placementsOf(events = [], hash) {
  const want = bare(hash);
  const found = buildArtifacts(events).find((a) => a.hash === want);
  return found ? found.placements : [];
}

export function artifactsOn(events = [], machine) {
  return buildArtifacts(events)
    .filter((a) => a.placements.some((p) => p.machine === machine))
    .map((a) => ({
      hash: a.hash,
      label: a.label,
      size: a.size,
      path: a.placements.find((p) => p.machine === machine)?.path ?? null
    }));
}

// Bytes transferred that we already held — the waste gauge. Today's duplicate installer
// reads 123.3 MB here; a healthy estate trends this to zero.
export function duplicateSpend(events = []) {
  let bytes = 0;
  let count = 0;
  for (const evt of events) {
    if (evt?.type !== ARTIFACT_TYPES.acquired) continue;
    if (evt.payload?.deduped !== true) continue;
    // A deduped acquisition that still opened the source is waste; one that skipped the
    // fetch is the saving. Only the former moved bytes we already had.
    if (evt.payload?.fetched === true) {
      bytes += Number(evt.payload?.size || 0);
      count += 1;
    }
  }
  return { bytes, count };
}

// The other half of the same ledger: transfer we avoided because the hash was known and
// the bytes were already held. Worth publishing next to the waste — it is what the store
// is actually for.
export function transferAvoided(events = []) {
  let bytes = 0;
  let count = 0;
  for (const evt of events) {
    if (evt?.type !== ARTIFACT_TYPES.acquired) continue;
    if (evt.payload?.deduped === true && evt.payload?.fetched === false) {
      bytes += Number(evt.payload?.size || 0);
      count += 1;
    }
  }
  return { bytes, count };
}
