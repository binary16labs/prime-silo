// S20 — what is on a backup drive that is not already on F:. Every Scenario in delivery/tasks/S20.md
// maps to a test here, run against real files in temp folders through the real walker.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { compareRoots, createComparer, fullHash, onlyCsv, partialHash } from "../server/coordination/lib/estate_compare.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import { walkerAdapter } from "../server/coordination/lib/estate_map_files.mjs";

const made = [];
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "s20-"))) - 1];
const write = (root, rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
};
const walker = walkerAdapter();
const list = (root) => walker.list(root);
const twoRoots = () => ({ drive: tmp(), target: tmp() });

// --- Scenario: a file F: already holds is not reported ----------------------------------------------

test("the same bytes under a different name are on the target, by full hash", async () => {
  const { drive, target } = twoRoots();
  write(drive, "Photos/2019/beach.jpg", "the same bytes");
  write(target, "Archive/renamed.jpg", "the same bytes");
  const r = await compareRoots({ from: drive, to: target, list });
  assert.equal(r.onTarget.files, 1);
  assert.equal(r.onlyHere.files, 0);
  assert.deepEqual(r.only, []);
});

// --- Scenario: same size, different bytes is not a copy ---------------------------------------------

test("same size and different bytes is only on the drive", async () => {
  const { drive, target } = twoRoots();
  write(drive, "a.txt", "AAAA");
  write(target, "b.txt", "BBBB");
  const r = await compareRoots({ from: drive, to: target, list });
  assert.equal(r.onTarget.files, 0);
  assert.equal(r.onlyHere.files, 1);
  assert.equal(r.only[0].path, path.join(drive, "a.txt"));
});

test("a partial-hash match is not a copy until the full hash agrees", async () => {
  // Over 8 MB, the partial hash reads only the first and last 4 MB: these two agree there and
  // differ in the middle, so only the full pass can tell them apart.
  const { drive, target } = twoRoots();
  const make = (mid) => Buffer.concat([Buffer.alloc(4_194_304, 1), Buffer.from(mid), Buffer.alloc(4_194_304, 2)]);
  const a = write(drive, "big.bin", make("middle one"));
  const b = write(target, "big.bin", make("middle two"));
  assert.equal(await partialHash(a, fs.statSync(a).size), await partialHash(b, fs.statSync(b).size));
  assert.notEqual(await fullHash(a), await fullHash(b));
  const r = await compareRoots({ from: drive, to: target, list });
  assert.equal(r.onTarget.files, 0, "a partial match alone is never called a copy");
  assert.equal(r.onlyHere.files, 1);
});

test("a full hash that cannot be finished leaves the file unconfirmed, never on the target", async () => {
  const { drive, target } = twoRoots();
  write(drive, "x.txt", "same");
  write(target, "y.txt", "same");
  const hashers = { partialHash, fullHash: async () => Promise.reject(new Error("EBUSY")) };
  const r = await compareRoots({ from: drive, to: target, list, hashers });
  assert.equal(r.unconfirmed.files, 1);
  assert.equal(r.onTarget.files, 0);
  assert.equal(r.onlyHere.files, 0);
});

test("a file whose size matches nothing on the target is never opened", async () => {
  const { drive, target } = twoRoots();
  write(drive, "unique.txt", "a size nothing else has");
  write(target, "other.txt", "x");
  const opened = [];
  const spy = (f, s) => (opened.push(f), partialHash(f, s));
  const r = await compareRoots({ from: drive, to: target, list, hashers: { partialHash: spy, fullHash } });
  assert.equal(r.onlyHere.files, 1);
  assert.deepEqual(opened, []);
});

test("thousands of files at one size are looked up, not compared pairwise", async () => {
  // 20,000 files a side, all one size, all different: pairwise that is 400 million comparisons
  const n = 20_000;
  const side = (prefix) =>
    async function* () {
      for (let i = 0; i < n; i++) yield { path: `${prefix}${i}`, size: 7 };
    };
  const lists = { "G:": side("G:/f"), "F:": side("F:/f") };
  const hashers = { partialHash: async (p) => p, fullHash: async (p) => p };
  const started = Date.now();
  const r = await compareRoots({ from: "G:", to: "F:", list: (root) => lists[root](), hashers });
  assert.equal(r.onlyHere.files, n);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

// --- Scenario: a private file is counted, not listed ------------------------------------------------

test("a private drive-only file is in the totals and in no list, folder or CSV", async () => {
  const { drive, target } = twoRoots();
  write(drive, "Jobs/CV 2026.docx", "private");
  write(drive, "Photos/beach.jpg", "public");
  // the owner's own CV rule, as the hub parses it from quarantine.json
  const r = await compareRoots({ from: drive, to: target, list, rules: [/(^|[^a-z])cv([^a-z]|$)/iu] });
  assert.equal(r.onlyHere.files, 2, "both are in the totals");
  assert.equal(r.privateCounted.files, 1);
  assert.deepEqual(r.only.map((f) => path.basename(f.path)), ["beach.jpg"]);
  assert.ok(!r.folders.some((f) => /Jobs/u.test(f.folder)), "not even its folder is named");
  assert.doesNotMatch(onlyCsv(r), /CV 2026/u);
});

test("the drive-only files are grouped into their largest folders", async () => {
  const { drive, target } = twoRoots();
  write(drive, "Photos/2019/a.jpg", "x".repeat(300));
  write(drive, "Photos/2019/b.jpg", "y".repeat(200));
  write(drive, "Docs/c.txt", "z".repeat(10));
  const r = await compareRoots({ from: drive, to: target, list });
  assert.deepEqual(
    r.folders.map((f) => [path.relative(drive, f.folder), f.files, f.bytes]),
    [[path.join("Photos", "2019"), 2, 500], ["Docs", 1, 10]]
  );
});

// --- the hub's routes -------------------------------------------------------------------------------

async function hub({ quarantine = ["passport"], roots }) {
  const home = tmp();
  const api = createEstateApi({
    quarantine,
    producer: { machine: "T480", dbPath: path.join(home, "estate", "estate-map-T480.db"), roots: () => roots, list }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/estate`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body ? { method: "POST", body: JSON.stringify(body) } : {});
    return { status: res.status, text: await res.text() };
  };
  return { api, call, close: () => new Promise((r) => server.close(r)) };
}

test("the hub compares on request, keeps the result, and serves the list as CSV", async () => {
  const { drive, target } = twoRoots();
  write(drive, "keep/only-here.txt", "only on the drive");
  write(drive, "dup.txt", "on both");
  write(target, "dup-renamed.txt", "on both");
  const h = await hub({ roots: [drive, target] });
  try {
    assert.equal((await h.call("/compare", { from: drive, to: target })).status, 202);
    let s;
    for (let i = 0; i < 200; i++) {
      s = JSON.parse((await h.call(`/compare?to=${encodeURIComponent(target)}`)).text);
      if (!s.running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const r = s.results[drive];
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.onlyHere.files, 1);
    assert.equal(r.onTarget.files, 1);
    const csv = await h.call(`/compare.csv?from=${encodeURIComponent(drive)}&to=${encodeURIComponent(target)}`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /only-here\.txt",17/u);
    assert.doesNotMatch(csv.text, /dup/u);
  } finally {
    await h.close();
  }
});

test("a comparison is refused without a policy, for roots not offered, and for one root twice", async () => {
  const { drive, target } = twoRoots();
  const none = await hub({ quarantine: null, roots: [drive, target] });
  try {
    assert.equal((await none.call("/compare", { from: drive, to: target })).status, 412);
  } finally {
    await none.close();
  }
  const h = await hub({ roots: [drive, target] });
  try {
    assert.equal((await h.call("/compare", { from: "Z:", to: target })).status, 400);
    assert.equal((await h.call("/compare", { from: drive, to: drive })).status, 400);
    assert.equal((await h.call("/compare", {})).status, 400, "no roots named at all");
  } finally {
    await h.close();
  }
});

test("comparisons name files, so every compare route answers this machine only", async () => {
  const { drive, target } = twoRoots();
  const home = tmp();
  const api = createEstateApi({
    quarantine: [],
    producer: { machine: "T480", dbPath: path.join(home, "estate", "x.db"), roots: () => [drive, target], list }
  });
  const answer = (method, url, remoteAddress) =>
    new Promise((resolve) => {
      const req = Object.assign(new PassThrough(), { method, url, socket: { remoteAddress }, headers: { host: "127.0.0.1" } });
      const res = { writeHead: (s) => ((res.status = s), res), end: () => resolve(res.status) };
      api.tryHandle(req, res);
      req.end(JSON.stringify({ from: drive, to: target }));
    });
  for (const [method, url] of [["GET", "/api/estate/compare"], ["GET", "/api/estate/compare.csv?from=a&to=b"], ["POST", "/api/estate/compare"]])
    assert.equal(await answer(method, url, "192.168.68.125"), 403, `${method} ${url}`);
});

// --- claude-s20-verifier's FAIL ---------------------------------------------------------------------

test("a different drive at the same letter is not shown the last drive's result", async () => {
  // Backup drives take the next free letter. Here the "letter" is a folder path: drive A is the
  // folder that is there first, drive B a new folder created at the same path.
  const parent = tmp();
  const letter = path.join(parent, "G");
  const target = tmp();
  fs.mkdirSync(letter);
  write(letter, "a.txt", "drive A");
  const c = createComparer({ dir: tmp(), rules: [], list });
  await c.start(letter, target).done;
  assert.equal(c.latest(letter, target).onlyHere.files, 1, "drive A was compared");

  fs.renameSync(letter, path.join(parent, "A-unplugged"));
  fs.mkdirSync(letter); // drive B, same letter, never compared
  write(letter, "b.txt", "drive B");
  assert.equal(c.latest(letter, target), null, "drive B reads 'not compared yet', not drive A's result");
  assert.ok(!fs.existsSync(c.csvPath(letter, target)), "and offers no list of drive A's files");

  fs.rmSync(letter, { recursive: true });
  fs.renameSync(path.join(parent, "A-unplugged"), letter); // drive A comes back
  assert.equal(c.latest(letter, target).onlyHere.files, 1, "and its own result comes back with it");
});

test("a file is never its own copy", async () => {
  // what overlapping roots, or a second letter for F:, produce: one file listed on both sides
  const root = tmp();
  const f = write(root, "only.txt", "the only copy");
  const both = async function* () {
    yield { path: f, size: fs.statSync(f).size };
  };
  const r = await compareRoots({ from: "G:", to: "F:", list: both });
  assert.equal(r.onTarget.files, 0);
  assert.equal(r.onlyHere.files, 1);
});

test("roots that overlap are refused; roots that merely share a prefix are not", async () => {
  const parent = tmp();
  const inner = path.join(parent, "x");
  const sibling = path.join(parent, "xy");
  fs.mkdirSync(inner);
  fs.mkdirSync(sibling);
  const h = await hub({ roots: [parent, inner, sibling] });
  try {
    assert.equal((await h.call("/compare", { from: inner, to: parent })).status, 400);
    assert.equal((await h.call("/compare", { from: parent, to: inner })).status, 400);
    assert.equal((await h.call("/compare", { from: inner, to: sibling })).status, 202);
  } finally {
    await h.close();
  }
});

test("a failed run leaves no list to download", async () => {
  const { drive, target } = twoRoots();
  write(drive, "a.txt", "x");
  let fail = false;
  const flaky = async function* (root) {
    if (fail) throw new Error("the drive went away");
    yield* list(root);
  };
  const c = createComparer({ dir: tmp(), rules: [], list: flaky });
  await c.start(drive, target).done;
  assert.ok(fs.existsSync(c.csvPath(drive, target)));
  fail = true;
  await c.start(drive, target).done;
  assert.equal(c.latest(drive, target).ok, false);
  assert.ok(!fs.existsSync(c.csvPath(drive, target)), "the old list described a different run");
});

test("files that could not be read or confirmed are named in the list, with why", async () => {
  const { drive, target } = twoRoots();
  write(drive, "x.txt", "same");
  write(target, "y.txt", "same");
  const r = await compareRoots({ from: drive, to: target, list, hashers: { fullHash: async () => Promise.reject(new Error("EBUSY")) } });
  assert.match(onlyCsv(r), /x\.txt",4,unconfirmed/u);
});

test("one comparison at a time", async () => {
  let release;
  const hold = new Promise((r) => (release = r));
  const slow = async function* () {
    await hold;
  };
  const c = createComparer({ dir: tmp(), rules: [], list: slow });
  // roots that exist: a result belongs to the drive itself, so an unreadable root starts nothing
  const [g, h, f] = [tmp(), tmp(), tmp()];
  const a = c.start(g, f);
  const b = c.start(h, f);
  assert.equal(a.started, true);
  assert.deepEqual(b, { started: false, since: a.since });
  release();
  await a.done;
  assert.equal(c.status(), null);
});
