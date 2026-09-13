// The NAS catalog is the only record of what is on the shared drive and how it got there, so
// these tests drive the real scan (disk, SQLite, hash-chained log) through the lifecycle a file
// actually has: a client drops it with a receipt, it gets renamed, rewritten, and deleted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  scanNas,
  reconcile,
  findFiles,
  catalogStats,
  catalogDir,
  nasLogFile
} from "../server/coordination/lib/nas_catalog.mjs";
import { readKelEvents, appendKelEvents, appendKelEvent } from "../server/coordination/lib/kel.mjs";
import { buildArtifacts } from "../server/coordination/lib/artifacts.mjs";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nas-catalog-"));
  const share = path.join(base, "nas");
  const estate = path.join(base, "estate-store");
  fs.mkdirSync(share, { recursive: true });
  return { base, share, estate };
}

const write = (share, rel, body) => {
  const full = path.join(share, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

// settleMs 0 so freshly written test files count as finished copies
const scan = (ctx, extra = {}) =>
  scanNas({ root: ctx.share, estateRoot: ctx.estate, machine: "t480", settleMs: 0, ...extra });

test("a client drop with a receipt is recorded with its origin, in the catalog and the log", async () => {
  const ctx = setup();
  write(ctx.share, "models/qwen.gguf", "weights-v1");
  write(
    ctx.share,
    ".receipts/r1.json",
    JSON.stringify({
      dest: "models\\qwen.gguf",
      origin_machine: "OPTIMUS",
      origin_path: "C:\\dl\\qwen.gguf",
      reason: "move off the laptop"
    })
  );

  const r = await scan(ctx);
  assert.equal(r.counts.added, 1);

  const [row] = findFiles(path.join(catalogDir(ctx.estate), "catalog.db"), { query: "qwen" });
  assert.equal(row.category, "models");
  assert.equal(row.origin_machine, "optimus");
  assert.equal(row.reason, "move off the laptop");

  const log = readKelEvents(nasLogFile(ctx.estate, "t480"));
  assert.ok(log.ok, "chain must verify");
  assert.deepEqual(
    log.events.map((e) => e.type),
    ["artifact_acquired", "artifact_placed", "sweep_recorded"]
  );
  const placed = log.events[1];
  assert.equal(placed.payload.origin_machine, "optimus");
  assert.equal(placed.authorship, "human");

  // the receipt was archived, not left to be applied again or deleted
  assert.equal(fs.existsSync(path.join(ctx.share, ".receipts", "r1.json")), false);
  assert.ok(fs.readdirSync(path.join(catalogDir(ctx.estate), "receipts")).length === 1);
});

test("rename is a move of the same artifact, keeps its origin, and the fold shows one placement", async () => {
  const ctx = setup();
  write(ctx.share, "downloads/setup.exe", "installer");
  write(
    ctx.share,
    ".receipts/r.json",
    JSON.stringify({ dest: "downloads/setup.exe", origin_machine: "optimus", reason: "keep" })
  );
  await scan(ctx);

  fs.renameSync(
    path.join(ctx.share, "downloads", "setup.exe"),
    path.join(ctx.share, "downloads", "setup-1.2.exe")
  );
  const r = await scan(ctx);
  assert.deepEqual([r.counts.added, r.counts.moved, r.counts.removed], [0, 1, 0]);

  const [row] = findFiles(path.join(catalogDir(ctx.estate), "catalog.db"), { query: "setup" });
  assert.equal(row.path, "downloads/setup-1.2.exe");
  assert.equal(row.origin_machine, "optimus", "a move must not lose where the file came from");

  const { events } = readKelEvents(nasLogFile(ctx.estate, "t480"));
  const [artifact] = buildArtifacts(events);
  assert.equal(artifact.placements.length, 1);
  assert.match(artifact.placements[0].path, /setup-1\.2\.exe$/u);
});

test("rewritten content is a change: old hash evicted, new artifact acquired and placed", async () => {
  const ctx = setup();
  const csv = write(ctx.share, "datasets/rows.csv", "a,b\n1,2\n");
  const earlier = new Date(Date.now() - 120_000);
  fs.utimesSync(csv, earlier, earlier);
  await scan(ctx);
  write(ctx.share, "datasets/rows.csv", "a,b\n1,2\n3,4\n");
  // mtime resolution on some filesystems is coarse; force a visibly different (past) mtime
  const later = new Date(Date.now() - 60_000);
  fs.utimesSync(csv, later, later);

  const r = await scan(ctx);
  assert.equal(r.counts.changed, 1);
  const { events } = readKelEvents(nasLogFile(ctx.estate, "t480"));
  const live = buildArtifacts(events).filter((a) => a.placements.length);
  assert.equal(live.length, 1, "only the new content is placed");
});

test("deletion evicts the placement; an unchanged share hashes nothing and logs nothing", async () => {
  const ctx = setup();
  write(ctx.share, "images/a.png", "png-bytes");
  write(ctx.share, "images/b.png", "png-bytes-2");
  await scan(ctx);
  const linesAfterFirst = fs
    .readFileSync(nasLogFile(ctx.estate, "t480"), "utf8")
    .split("\n").length;

  const quiet = await scan(ctx);
  assert.equal(quiet.counts.bytes_hashed, 0, "unchanged size+mtime must reuse the recorded hash");
  assert.equal(quiet.events, 0);
  assert.equal(
    fs.readFileSync(nasLogFile(ctx.estate, "t480"), "utf8").split("\n").length,
    linesAfterFirst
  );

  fs.rmSync(path.join(ctx.share, "images", "a.png"));
  const r = await scan(ctx);
  assert.equal(r.counts.removed, 1);
  const stats = catalogStats(path.join(catalogDir(ctx.estate), "catalog.db"));
  assert.equal(stats.byCategory.find((c) => c.category === "images").files, 1);
  assert.ok(readKelEvents(nasLogFile(ctx.estate, "t480")).ok);
});

test("a file still being copied is neither recorded nor treated as removed", async () => {
  const ctx = setup();
  write(ctx.share, "models/big.gguf", "partial");
  write(ctx.share, "downloads/thing.zip.crdownload", "half");
  const r = await scanNas({
    root: ctx.share,
    estateRoot: ctx.estate,
    machine: "t480",
    settleMs: 60_000
  });
  assert.equal(r.counts.added, 0);
  assert.equal(r.counts.pending, 2);

  // once recorded, a file that is being overwritten (fresh mtime) must not be reported removed
  await scan(ctx);
  write(ctx.share, "models/big.gguf", "being-rewritten");
  const during = await scanNas({
    root: ctx.share,
    estateRoot: ctx.estate,
    machine: "t480",
    settleMs: 60_000
  });
  assert.equal(during.counts.removed, 0);
});

test("reconcile: two copies of one file vanishing and one reappearing is one move and one removal", () => {
  const prev = [
    { path: "a/x.bin", sha256: "h1", size: 3 },
    { path: "b/x.bin", sha256: "h1", size: 3 }
  ];
  const { changes } = reconcile(prev, [{ rel: "c/x.bin", sha256: "h1", size: 3 }]);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ["moved", "removed"]);
});

test("batch append chains exactly like single appends and refuses a bad batch whole", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kel-batch-"));
  const mk = (i) => ({
    id: `e${i}`,
    schema_version: "1.0.0",
    type: "node_observed",
    valid_time: "2026-09-13T00:00:00Z",
    txn_time: "2026-09-13T00:00:00Z",
    time_confidence: "known",
    hlc: "x",
    machine: "t480",
    authorship: "house",
    sid: "node:t480",
    subject: { id: "node:t480" },
    payload: { i }
  });
  const single = path.join(dir, "single.jsonl");
  const batch = path.join(dir, "batch.jsonl");
  appendKelEvent(single, mk(0));
  appendKelEvent(batch, mk(0));
  for (let i = 1; i < 5; i++) appendKelEvent(single, mk(i));
  assert.ok(appendKelEvents(batch, [1, 2, 3, 4].map(mk)).ok);
  assert.equal(fs.readFileSync(batch, "utf8"), fs.readFileSync(single, "utf8"));

  const before = fs.readFileSync(batch, "utf8");
  const bad = { ...mk(9) };
  delete bad.machine;
  assert.equal(appendKelEvents(batch, [mk(5), bad]).ok, false);
  assert.equal(fs.readFileSync(batch, "utf8"), before, "nothing from a rejected batch may land");
});
