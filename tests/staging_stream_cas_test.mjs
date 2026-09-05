// Streaming CAS — the "download once" primitive.
//
// casStore hashes through a single Buffer, which is correct for a session transcript and
// wrong for the objects the artifact ledger has to hold: the Prime-Silo runtime bundle is
// 598 MB and the installer 123 MB, on a 16 GB laptop that is simultaneously running Neo4j
// and a model server. Buffering those competes with the workloads the estate exists for.
//
// Two properties have to hold or the store is not trustworthy:
//
//   1. A partial write is never observable as a valid blob. The failure mode is nasty
//      precisely because it is quiet — a truncated installer that is present, hashed under
//      a name nobody asked for, and installed. Hence: write to a temp file, verify, then
//      rename (atomic within a volume).
//   2. Identical bytes cost nothing the second time. That is the whole feature; a test
//      that only proves "it stored something" would pass even if de-dup were dead.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  casStore,
  casStoreStream,
  hasBlob,
  blobPath
} from "../server/coordination/lib/staging.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cas-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
// chunked on purpose: a single-chunk stream would not exercise the incremental hash
const streamOf = (buf, chunk = 7) => {
  const parts = [];
  for (let i = 0; i < buf.length; i += chunk) parts.push(buf.subarray(i, i + chunk));
  return Readable.from(parts);
};

test("streamed bytes land under their own hash", async () => {
  const root = tmpRoot();
  try {
    const payload = Buffer.from("prime-silo runtime bundle stand-in".repeat(64));
    const res = await casStoreStream(root, streamOf(payload));
    assert.equal(res.hash, sha(payload));
    assert.equal(res.deduped, false);
    assert.equal(res.bytes, payload.length);
    assert.deepEqual(fs.readFileSync(res.path), payload);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the same bytes a second time move nothing", async () => {
  const root = tmpRoot();
  try {
    const payload = Buffer.from("an installer, fetched twice in one day");
    const first = await casStoreStream(root, streamOf(payload));
    assert.equal(first.deduped, false);

    // the paired positive control: if de-dup were dead this would also report false
    const second = await casStoreStream(root, streamOf(payload));
    assert.equal(second.deduped, true);
    assert.equal(second.path, first.path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasBlob answers before any transfer, and accepts either hash form", async () => {
  const root = tmpRoot();
  try {
    const payload = Buffer.from("Prime-Silo-1.23-windows-x64.exe");
    const hash = sha(payload);
    assert.equal(hasBlob(root, hash), false); // must be false BEFORE, or the check is dead
    await casStoreStream(root, streamOf(payload));
    assert.equal(hasBlob(root, hash), true);
    assert.equal(hasBlob(root, `sha256:${hash}`), true); // KEL subjects carry the prefix
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a wrong expected hash is refused and leaves no blob and no temp file", async () => {
  const root = tmpRoot();
  try {
    const payload = Buffer.from("substituted bytes");
    await assert.rejects(
      () =>
        casStoreStream(root, streamOf(payload), {
          expectedHash: sha(Buffer.from("what we asked for"))
        }),
      /hash mismatch/
    );
    // nothing admitted...
    assert.equal(hasBlob(root, sha(payload)), false);
    // ...and nothing left behind either
    const tmpDir = path.join(root, "blobs", "tmp");
    const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated download is refused by size", async () => {
  const root = tmpRoot();
  try {
    const payload = Buffer.from("half an installer");
    await assert.rejects(
      () => casStoreStream(root, streamOf(payload), { expectedSize: payload.length + 100 }),
      /size mismatch/
    );
    assert.equal(hasBlob(root, sha(payload)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stream that fails mid-flight admits nothing", async () => {
  const root = tmpRoot();
  try {
    const broken = new Readable({
      read() {
        this.push(Buffer.from("first chunk"));
        this.destroy(new Error("connection reset"));
      }
    });
    await assert.rejects(() => casStoreStream(root, broken), /connection reset/);
    const blobsDir = path.join(root, "blobs", "sha256");
    const stored = fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir) : [];
    assert.deepEqual(stored, [], "an interrupted transfer must not leave a blob");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("streamed and buffered paths agree on identity", async () => {
  // casStore stays for sessions; both must address the same bytes the same way, or the
  // store would fork into two namespaces that never de-dup against each other.
  const root = tmpRoot();
  try {
    const payload = Buffer.from("one session, two code paths");
    const buffered = casStore(root, payload);
    const streamed = await casStoreStream(root, streamOf(payload));
    assert.equal(streamed.hash, buffered.hash);
    assert.equal(streamed.deduped, true);
    assert.equal(blobPath(root, streamed.hash), buffered.path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
