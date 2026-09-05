// The artifact ledger — acquire once, place anywhere.
//
// The estate fetched the same 123 MB installer twice in one day and recorded neither. The
// CAS already de-duped by construction, so the bytes were only stored once — but the
// TRANSFER happened twice, and that is the cost that actually hurts on a metered or slow
// link. De-dup after the fact is not the feature; not opening the source is.
//
// So the load-bearing test here is the one that asserts the source was NEVER OPENED. A
// suite that only checked "stored once" would pass on the broken behaviour we already had.
// The `open` fetcher is injected precisely so a test can count how many times it was called.
//
// The second invariant is about safety rather than cost: eviction must retire a placement
// and never the blob. A laptop reclaiming disk must not be able to destroy the only copy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { hasBlob, blobPath } from "../server/coordination/lib/staging.mjs";
import {
  acquireArtifact,
  placeArtifact,
  evictPlacement,
  buildArtifacts,
  placementsOf,
  artifactsOn,
  duplicateSpend,
  transferAvoided
} from "../server/coordination/lib/artifacts.mjs";

const PAYLOAD = Buffer.from("Prime-Silo-1.23-windows-x64.exe stand-in payload".repeat(32));
const HASH = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

function ctx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-"));
  return { root, log: path.join(root, "eventlog", "artifacts.jsonl") };
}
// counts opens so a test can prove the source was not touched
function fetcher(payload = PAYLOAD) {
  const state = { opens: 0 };
  return {
    state,
    open: async () => {
      state.opens += 1;
      return Readable.from([payload]);
    }
  };
}
const events = (log) => readKelEvents(log).events;

test("a first acquisition fetches, stores and records both acquisition and verification", async () => {
  const { root, log } = ctx();
  const f = fetcher();
  try {
    const res = await acquireArtifact(root, log, {
      sourceUri: "https://example.invalid/Prime-Silo-1.23-windows-x64.exe",
      label: "Prime-Silo 1.23.0 installer",
      machine: "t480",
      expectedSize: PAYLOAD.length,
      open: f.open
    });
    assert.equal(f.state.opens, 1);
    assert.equal(res.hash, HASH);
    assert.equal(res.fetched, true);
    assert.equal(res.deduped, false);
    assert.equal(hasBlob(root, HASH), true);

    const types = events(log).map((e) => e.type);
    assert.deepEqual(types, ["artifact_acquired", "artifact_verified"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a known hash we already hold never opens the source", async () => {
  // This is the feature. If it regresses, everything still "works" and the estate quietly
  // pays for every transfer twice — which is exactly the bug this ledger exists to end.
  const { root, log } = ctx();
  const first = fetcher();
  try {
    await acquireArtifact(root, log, {
      sourceUri: "https://example.invalid/installer.exe",
      machine: "t480",
      open: first.open
    });
    assert.equal(first.state.opens, 1);

    const second = fetcher();
    const res = await acquireArtifact(root, log, {
      sourceUri: "https://example.invalid/installer.exe",
      machine: "optimus",
      expectedHash: HASH, // the publisher told us — releases ship .sha256 sidecars
      open: second.open
    });
    assert.equal(second.state.opens, 0, "the source must not be opened when the bytes are held");
    assert.equal(res.fetched, false);
    assert.equal(res.deduped, true);
    assert.equal(res.bytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without a known hash the fetch is unavoidable, and the waste is recorded", async () => {
  // Honest limitation: you only learn a hash by reading the bytes. When a source publishes
  // none, the second fetch still happens — and must show up in the gauge rather than hide.
  const { root, log } = ctx();
  try {
    await acquireArtifact(root, log, { sourceUri: "u", machine: "t480", open: fetcher().open });
    await acquireArtifact(root, log, { sourceUri: "u", machine: "optimus", open: fetcher().open });

    const waste = duplicateSpend(events(log));
    assert.equal(waste.count, 1);
    assert.equal(waste.bytes, PAYLOAD.length);
    assert.equal(transferAvoided(events(log)).count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the two gauges separate transfer avoided from transfer wasted", async () => {
  const { root, log } = ctx();
  try {
    await acquireArtifact(root, log, { sourceUri: "u", machine: "t480", open: fetcher().open });
    await acquireArtifact(root, log, {
      sourceUri: "u",
      machine: "optimus",
      expectedHash: HASH,
      expectedSize: PAYLOAD.length,
      open: fetcher().open
    });
    const evts = events(log);
    assert.equal(duplicateSpend(evts).bytes, 0, "nothing was wasted");
    assert.equal(transferAvoided(evts).bytes, PAYLOAD.length, "a whole transfer was avoided");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("placements answer where every copy is, without touching a disk", async () => {
  const { root, log } = ctx();
  try {
    await acquireArtifact(root, log, { sourceUri: "u", machine: "t480", open: fetcher().open });
    const a = path.join(root, "out", "t480", "installer.exe");
    const b = path.join(root, "out", "optimus", "installer.exe");
    await placeArtifact(root, log, { hash: HASH, machine: "t480", path: a, purpose: "install" });
    await placeArtifact(root, log, { hash: HASH, machine: "optimus", path: b, purpose: "install" });

    assert.deepEqual(fs.readFileSync(a), PAYLOAD);
    const where = placementsOf(events(log), HASH)
      .map((p) => p.machine)
      .sort();
    assert.deepEqual(where, ["optimus", "t480"]);
    assert.equal(artifactsOn(events(log), "optimus")[0].path, b);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("eviction retires the placement and keeps the blob", async () => {
  // The safety property: reclaiming space must never be able to destroy the only copy.
  const { root, log } = ctx();
  try {
    await acquireArtifact(root, log, { sourceUri: "u", machine: "t480", open: fetcher().open });
    const at = path.join(root, "out", "installer.exe");
    await placeArtifact(root, log, { hash: HASH, machine: "t480", path: at });

    const res = evictPlacement(root, log, {
      hash: HASH,
      machine: "t480",
      path: at,
      reason: "disk"
    });
    assert.equal(res.removed, true);
    assert.equal(res.blobRetained, true);
    assert.equal(fs.existsSync(at), false);
    assert.equal(fs.existsSync(blobPath(root, HASH)), true, "the blob must survive eviction");
    assert.deepEqual(placementsOf(events(log), HASH), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("placing bytes we do not hold is refused rather than silently creating an empty file", async () => {
  const { root, log } = ctx();
  try {
    await assert.rejects(
      () =>
        placeArtifact(root, log, { hash: HASH, machine: "t480", path: path.join(root, "x.exe") }),
      /blob not held/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the projection carries provenance and verification through the fold", async () => {
  const { root, log } = ctx();
  try {
    await acquireArtifact(root, log, {
      sourceUri: "https://github.com/binary16labs/prime-silo/releases/download/v1.23.0/x.exe",
      label: "Prime-Silo 1.23.0 installer",
      mediaType: "application/vnd.microsoft.portable-executable",
      publisher: "binary16labs/prime-silo",
      machine: "t480",
      open: fetcher().open
    });
    const [art] = buildArtifacts(events(log));
    assert.equal(art.hash, HASH);
    assert.equal(art.verified, true);
    assert.equal(art.publisher, "binary16labs/prime-silo");
    assert.match(art.source_uri, /v1\.23\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the ledger is a valid, verifiable KEL chain", async () => {
  const { root, log } = ctx();
  try {
    await acquireArtifact(root, log, { sourceUri: "u", machine: "t480", open: fetcher().open });
    await placeArtifact(root, log, { hash: HASH, machine: "t480", path: path.join(root, "o.exe") });
    const read = readKelEvents(log);
    assert.equal(read.ok, true, "chain must verify");
    assert.equal(read.events.length, 3);
    for (const e of read.events) assert.equal(e.subject.kind, "artifact");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
