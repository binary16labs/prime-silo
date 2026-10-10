// S21 — the librarian. Every Scenario in delivery/tasks/S21.md maps to a test here or in
// estate_compare_test.mjs, run against real files in temp folders.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  catalogue,
  catalogueLookup,
  createLibrarian,
  duplicateSets,
  duplicatesCsv,
  kindOf,
  libraryPath,
  libraryState
} from "../server/coordination/lib/library.mjs";
import { hashFile } from "../server/coordination/lib/nas_catalog.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";

const made = [];
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "s21-"))) - 1];
const OLD = new Date(Date.now() - 3_600_000); // older than the settle window
const write = (root, rel, data, when = OLD) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, when, when);
  return f;
};
const rowsOf = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT path, size, sha256, kind FROM files ORDER BY path").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const countingHash = () => {
  const read = [];
  return { read, hash: (f) => (read.push(f), hashFile(f)) };
};
const tree = () => {
  const root = tmp();
  write(root, "Photos/2019/a.jpg", "photo a");
  write(root, "Photos/2019/b.jpg", "photo b");
  write(root, "Docs/c.pdf", "a document");
  write(root, "Docs/deep/d.txt", "deeper");
  write(root, "models/m.gguf", "weights");
  return root;
};

test("a catalogue holds every file with its size, hash and kind", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  const r = await catalogue({ root, dbPath });
  assert.equal(r.finished, true);
  const rows = rowsOf(dbPath);
  assert.deepEqual(
    rows.map((x) => [x.path, x.kind]),
    [["Docs/c.pdf", "documents"], ["Docs/deep/d.txt", "documents"], ["Photos/2019/a.jpg", "images"], ["Photos/2019/b.jpg", "images"], ["models/m.gguf", "models"]]
  );
  assert.equal(rows[0].sha256, await hashFile(path.join(root, "Docs", "c.pdf")));
  assert.equal(kindOf("x.MKV"), "video");
  assert.equal(kindOf("noext"), "other");
});

test("a folder's files are read together, before the walk moves on", async () => {
  const root = tree();
  const { read, hash } = countingHash();
  await catalogue({ root, dbPath: path.join(tmp(), "lib.db"), hash });
  const folders = read.map((f) => path.dirname(path.relative(root, f)));
  const runs = folders.filter((d, i) => d !== folders[i - 1]);
  assert.equal(new Set(runs).size, runs.length, `each folder is visited once: ${folders.join(", ")}`);
});

// --- Scenario: a stopped catalogue resumes without re-reading ----------------------------------------

test("a stopped pass resumes: only files not yet committed are read, and it ends as an uninterrupted pass would", async () => {
  const root = tmp();
  for (let i = 0; i < 12; i++) write(root, `f/${String(i).padStart(2, "0")}.txt`, `file ${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  const ctl = new AbortController();
  const first = countingHash();
  const stopAfter5 = (f) => {
    if (first.read.length === 5) ctl.abort();
    return first.hash(f);
  };
  const r1 = await catalogue({ root, dbPath, hash: stopAfter5, batch: 2, signal: ctl.signal });
  assert.equal(r1.stopped, true);
  const committed = rowsOf(dbPath).map((x) => path.join(root, ...x.path.split("/")));
  assert.ok(committed.length >= 4 && committed.length < 12, `${committed.length} committed`);

  const second = countingHash();
  const r2 = await catalogue({ root, dbPath, hash: second.hash });
  assert.equal(r2.finished, true);
  assert.equal(r2.pass, r1.pass, "the same pass, resumed");
  assert.ok(!second.read.some((f) => committed.includes(f)), "nothing committed is read again");
  assert.equal(second.read.length, 12 - committed.length);

  const whole = path.join(tmp(), "whole.db");
  await catalogue({ root, dbPath: whole });
  assert.deepEqual(rowsOf(dbPath), rowsOf(whole));
});

test("a later pass reads only what changed, and a finished pass removes what has gone", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  write(root, "Docs/c.pdf", "a document, revised", new Date(Date.now() - 600_000));
  fs.rmSync(path.join(root, "models", "m.gguf"));
  const { read, hash } = countingHash();
  const r = await catalogue({ root, dbPath, hash });
  assert.deepEqual(read, [path.join(root, "Docs", "c.pdf")]);
  assert.equal(r.removed, 1);
  assert.ok(!rowsOf(dbPath).some((x) => x.path === "models/m.gguf"));
});

// --- Scenario: an unfinished pass never forgets a file -----------------------------------------------

test("a pass stopped before reaching a file keeps that file's row", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  const before = rowsOf(dbPath);
  for (const f of ["Photos/2019/a.jpg", "models/m.gguf"]) write(root, f, `changed ${f}`, new Date(Date.now() - 600_000));
  const ctl = new AbortController();
  const stopAtOnce = (f) => (ctl.abort(), hashFile(f));
  const r = await catalogue({ root, dbPath, hash: stopAtOnce, signal: ctl.signal });
  assert.equal(r.stopped, true);
  assert.deepEqual(rowsOf(dbPath).map((x) => x.path), before.map((x) => x.path), "every row is still there");
});

test("rows under a folder that cannot be read are kept, and an unreadable root never finishes", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  const n = rowsOf(dbPath).length;
  // Docs refuses to be listed (a permission change, a failing sector): unread is not gone
  const real = fsp.readdir;
  fsp.readdir = async (d, ...a) => {
    if (path.basename(String(d)) === "Docs") throw Object.assign(new Error("denied"), { code: "EPERM" });
    return real(d, ...a);
  };
  let r;
  try {
    r = await catalogue({ root, dbPath });
  } finally {
    fsp.readdir = real;
  }
  assert.equal(r.finished, true);
  assert.equal(r.removed, 0);
  assert.equal(rowsOf(dbPath).length, n, "Docs' two rows are still there");
  const gone = await catalogue({ root: path.join(root, "gone"), dbPath }).catch((e) => e);
  assert.match(String(gone.message), /cannot be read/u, "a missing root is an error, not an empty drive");
  assert.equal(rowsOf(dbPath).length, n, "and it removed nothing");
});

test("the store folder inside the drive is never catalogued", async () => {
  const root = tree();
  write(root, "estate-store/library/library-x.db", "not a file of the owner's");
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath, skip: [path.join(root, "estate-store")] });
  assert.ok(!rowsOf(dbPath).some((x) => x.path.startsWith("estate-store")));
});

test("files still being written are left for the next pass", async () => {
  const root = tree();
  write(root, "Downloads/big.iso.part", "half", new Date(Date.now() - 600_000));
  write(root, "Downloads/fresh.zip", "just copied", new Date());
  const dbPath = path.join(tmp(), "lib.db");
  const r = await catalogue({ root, dbPath });
  assert.equal(r.pending, 2);
  assert.ok(!rowsOf(dbPath).some((x) => x.path.startsWith("Downloads")));
});

// --- the history (owner's answer, 2026-10-10) --------------------------------------------------------

test("the first pass logs one summary per batch; per-file history starts after a finished pass", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath, batch: 2 });
  const log = dbPath.replace(/\.db$/u, ".jsonl");
  const first = readKelEvents(log);
  assert.equal(first.ok, true);
  assert.ok(first.events.length >= 3, "a summary per committed batch");
  assert.ok(first.events.every((e) => e.type === "sweep_recorded" && e.payload.scope === "library"));
  assert.match(first.events.at(-1).payload.digest, /^[0-9a-f]{64}$/u);

  write(root, "new/e.txt", "added later");
  fs.rmSync(path.join(root, "models", "m.gguf"));
  write(root, "Jobs/CV 2026.docx", "private", OLD);
  await catalogue({ root, dbPath, rules: [/(^|[^a-z])cv([^a-z]|$)/iu] });
  const later = readKelEvents(log).events.slice(first.events.length);
  const types = later.map((e) => e.type).filter((t) => t !== "sweep_recorded");
  assert.equal(types.length, 2, `one placed, one evicted: ${types.join(", ")}`);
  assert.doesNotMatch(JSON.stringify(later), /CV 2026/u, "a private file has no per-file event");
});

// --- Scenario: duplicates come from the catalogue, not the disk --------------------------------------

test("duplicates are a catalogue query: one set, its wasted bytes, and no file on the drive opened", async () => {
  const root = tree();
  write(root, "Backup/old/a-copy.jpg", "photo a");
  write(root, "empty1.txt", "");
  write(root, "empty2.txt", "");
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  const opened = [];
  const real = fs.openSync;
  fs.openSync = (p, ...a) => (String(p).startsWith(root) && opened.push(p), real(p, ...a));
  let sets;
  try {
    sets = duplicateSets(dbPath, root);
  } finally {
    fs.openSync = real;
  }
  assert.deepEqual(opened, []);
  assert.equal(sets.length, 1, "two empty files are not a duplicate worth naming");
  assert.equal(sets[0].copies, 2);
  assert.equal(sets[0].wasted, "photo a".length);
  assert.deepEqual(sets[0].paths.map((p) => path.relative(root, p)).sort(), [path.join("Backup", "old", "a-copy.jpg"), path.join("Photos", "2019", "a.jpg")]);
});

// --- Scenario: a private file is counted, not listed -------------------------------------------------

test("a private duplicate is in the totals and in no list, CSV or state", async () => {
  const root = tree();
  write(root, "Jobs/CV 2026.docx", "cv bytes");
  write(root, "Jobs/old/CV 2026 copy.docx", "cv bytes");
  write(root, "Jobs/CV notes.txt", "photo b"); // a private copy of a public file
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  const rules = [/(^|[^a-z])cv([^a-z]|$)/iu];
  const state = libraryState(dbPath, root, rules);
  assert.equal(state.duplicates.sets, 2, "both sets are counted");
  assert.equal(state.duplicates.private, 3);
  assert.equal(state.duplicates.wasted, "cv bytes".length + "photo b".length);
  const text = JSON.stringify(state) + duplicatesCsv(duplicateSets(dbPath, root, rules));
  assert.doesNotMatch(text, /CV/u);
  assert.match(text, /b\.jpg/u, "the public copy is still named");
});

test("a catalogue that never finished is refused to a comparison; none at all is null", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal(catalogueLookup(dbPath, root), null);
  const ctl = new AbortController();
  await catalogue({ root, dbPath, signal: ctl.signal, hash: (f) => (ctl.abort(), hashFile(f)) });
  assert.match(catalogueLookup(dbPath, root).refused, /never finished/u);
  await catalogue({ root, dbPath });
  const look = catalogueLookup(dbPath, root);
  try {
    assert.ok(look.finishedAt);
    assert.equal(look.hasSize("photo a".length), true);
    assert.equal(look.byHash(await hashFile(path.join(root, "Photos", "2019", "a.jpg")))[0].full, path.join(root, "Photos", "2019", "a.jpg"));
  } finally {
    look.close();
  }
});

test("a catalogue belongs to the drive, not the path it was reached by", () => {
  const dir = tmp();
  const a = tmp();
  const b = tmp();
  assert.notEqual(libraryPath(dir, a), libraryPath(dir, b));
  assert.equal(libraryPath(dir, path.join(tmp(), "missing")), null);
});

// --- the librarian and the hub's routes --------------------------------------------------------------

test("one pass at a time, and Stop keeps what was committed", async () => {
  const root = tree();
  let release;
  const hold = new Promise((r) => (release = r));
  const lib = createLibrarian({ dir: tmp(), hash: async (f) => (await hold, hashFile(f)) });
  const a = lib.start(root);
  assert.equal(a.started, true);
  assert.deepEqual(lib.start(root), { started: false, since: a.since });
  assert.equal(lib.stop(), true);
  release();
  const r = await a.done;
  assert.equal(r.stopped, true);
  assert.equal(lib.status().running, null);
  assert.equal(lib.status().last.stopped, true);
  assert.equal(lib.stop(), false, "nothing to stop");
});

async function hub({ quarantine = ["passport"], roots, libraryDir = tmp() }) {
  const home = tmp();
  const api = createEstateApi({
    quarantine,
    producer: { machine: "T480", dbPath: path.join(home, "estate", "estate-map-T480.db"), roots: () => roots, libraryDir }
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
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("the hub catalogues on request, shows the duplicates, and serves them as CSV", async () => {
  const root = tree();
  write(root, "Backup/a-again.jpg", "photo a");
  const h = await hub({ roots: [root] });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    let s;
    for (let i = 0; i < 300; i++) {
      s = JSON.parse((await h.call("/library")).text);
      if (!s.running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(s.last.finished, true, JSON.stringify(s.last));
    const c = s.catalogues[root];
    assert.equal(c.files, 6);
    assert.equal(c.duplicates.sets, 1);
    const csv = await h.call(`/library.csv?root=${encodeURIComponent(root)}`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /a-again\.jpg/u);
    assert.equal((await h.call("/library/stop", {})).status, 409, "nothing running");
  } finally {
    await h.close();
  }
});

test("the library refuses without a policy, for roots not offered, and from another machine", async () => {
  const root = tree();
  const libraryDir = tmp();
  await catalogue({ root, dbPath: libraryPath(libraryDir, root) }); // a catalogue there to leak
  const none = await hub({ quarantine: null, roots: [root], libraryDir });
  try {
    assert.equal((await none.call("/library", { root })).status, 412);
    assert.equal(JSON.parse((await none.call("/library")).text).catalogues[root], null, "no policy, nothing named");
  } finally {
    await none.close();
  }
  const h = await hub({ roots: [root] });
  try {
    assert.equal((await h.call("/library", { root: "Z:" })).status, 400);
    assert.equal((await h.call("/library.csv?root=Z:")).status, 404);
  } finally {
    await h.close();
  }
  const api = createEstateApi({ quarantine: [], producer: { machine: "T480", dbPath: path.join(tmp(), "x.db"), roots: () => [root], libraryDir: tmp() } });
  for (const [method, url] of [["GET", "/api/estate/library"], ["GET", "/api/estate/library.csv?root=x"], ["POST", "/api/estate/library/stop"], ["POST", "/api/estate/compare/stop"]]) {
    const status = await new Promise((resolve) => {
      const res = { writeHead: (s) => ((res.status = s), res), end: () => resolve(res.status) };
      api.tryHandle({ method, url, socket: { remoteAddress: "192.168.68.125" }, headers: {}, on() {} }, res);
    });
    assert.equal(status, 403, `${method} ${url}`);
  }
});
