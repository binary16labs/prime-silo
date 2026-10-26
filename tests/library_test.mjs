// S21 — the librarian. Every Scenario in delivery/tasks/S21.md maps to a test here or in
// estate_compare_test.mjs, run against real files in temp folders.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  catalogue,
  catalogueLookup,
  checkPaths,
  createLibrarian,
  duplicateSets,
  duplicatesCsv,
  findFiles,
  kindOf,
  buildFolderRollup,
  duplicateNeighbours,
  folderView,
  rollupKey,
  catalogueFor,
  markRollup,
  policyKey,
  rollupKeyFor,
  NEIGHBOURS_CAP_FILES,
  FOLDER_PAGE_MAX,
  SQL,
  privateTo,
  rollupRows,
  openLibrary,
  libraryPath,
  libraryState
} from "../server/coordination/lib/library.mjs";
import { hashFile } from "../server/coordination/lib/nas_catalog.mjs";
import { DatabaseSync } from "node:sqlite";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";

const made = [];
test.after(() => {
  for (const d of made)
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    return db
      .prepare("SELECT path, size, sha256, kind FROM files ORDER BY path")
      .all()
      .map((r) => ({ ...r }));
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
    [
      ["Docs/c.pdf", "documents"],
      ["Docs/deep/d.txt", "documents"],
      ["Photos/2019/a.jpg", "images"],
      ["Photos/2019/b.jpg", "images"],
      ["models/m.gguf", "models"]
    ]
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
  assert.equal(
    new Set(runs).size,
    runs.length,
    `each folder is visited once: ${folders.join(", ")}`
  );
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
  for (const f of ["Photos/2019/a.jpg", "models/m.gguf"])
    write(root, f, `changed ${f}`, new Date(Date.now() - 600_000));
  const ctl = new AbortController();
  const stopAtOnce = (f) => (ctl.abort(), hashFile(f));
  const r = await catalogue({ root, dbPath, hash: stopAtOnce, signal: ctl.signal });
  assert.equal(r.stopped, true);
  assert.deepEqual(
    rowsOf(dbPath).map((x) => x.path),
    before.map((x) => x.path),
    "every row is still there"
  );
});

test("rows under a folder that cannot be read are kept, and an unreadable root never finishes", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  const n = rowsOf(dbPath).length;
  // Docs refuses to be listed (a permission change, a failing sector): unread is not gone
  const real = fsp.readdir;
  fsp.readdir = async (d, ...a) => {
    if (path.basename(String(d)) === "Docs")
      throw Object.assign(new Error("denied"), { code: "EPERM" });
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
  assert.match(
    String(gone.message),
    /cannot be read/u,
    "a missing root is an error, not an empty drive"
  );
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
  assert.ok(
    first.events.every((e) => e.type === "sweep_recorded" && e.payload.scope === "library")
  );
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
  assert.deepEqual(sets[0].paths.map((p) => path.relative(root, p)).sort(), [
    path.join("Backup", "old", "a-copy.jpg"),
    path.join("Photos", "2019", "a.jpg")
  ]);
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
    assert.equal(
      look.byHash(await hashFile(path.join(root, "Photos", "2019", "a.jpg")))[0].full,
      path.join(root, "Photos", "2019", "a.jpg")
    );
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

async function hub({ quarantine = ["passport"], roots, estateStore = tmp() }) {
  const home = tmp();
  const api = createEstateApi({
    quarantine,
    producer: {
      machine: "T480",
      dbPath: path.join(home, "estate", "estate-map-T480.db"),
      roots: () => roots,
      estateStore
    }
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
  return { call, estateStore, close: () => new Promise((r) => server.close(r)) };
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
    let c;
    for (let i = 0; i < 300; i++) {
      c = JSON.parse((await h.call("/library")).text).catalogues[root];
      if (!c.computing) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(c.files, 6);
    assert.equal(c.duplicates.sets, 1);
    const csv = await h.call(`/library.csv?root=${encodeURIComponent(root)}`); // ready: state was
    assert.equal(csv.status, 200);
    assert.match(csv.text, /a-again\.jpg/u);
    assert.equal((await h.call("/library/stop", {})).status, 409, "nothing running");
  } finally {
    await h.close();
  }
});

test("the library refuses without a policy, for roots not offered, and from another machine", async () => {
  const root = tree();
  const estateStore = tmp();
  await catalogue({ root, dbPath: libraryPath(path.join(estateStore, "library"), root) }); // a catalogue there to leak
  const none = await hub({ quarantine: null, roots: [root], estateStore });
  try {
    assert.equal((await none.call("/library", { root })).status, 412);
    assert.equal(
      JSON.parse((await none.call("/library")).text).catalogues[root],
      null,
      "no policy, nothing named"
    );
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
  const api = createEstateApi({
    quarantine: [],
    producer: {
      machine: "T480",
      dbPath: path.join(tmp(), "x.db"),
      roots: () => [root],
      estateStore: tmp()
    }
  });
  for (const [method, url] of [
    ["GET", "/api/estate/library"],
    ["GET", "/api/estate/library.csv?root=x"],
    ["POST", "/api/estate/library/stop"],
    ["POST", "/api/estate/compare/stop"]
  ]) {
    const status = await new Promise((resolve) => {
      const res = { writeHead: (s) => ((res.status = s), res), end: () => resolve(res.status) };
      api.tryHandle(
        { method, url, socket: { remoteAddress: "192.168.68.125" }, headers: {}, on() {} },
        res
      );
    });
    assert.equal(status, 403, `${method} ${url}`);
  }
});

// --- claude-s21-verifier's FAIL (round 1) ------------------------------------------------------------

const moveAway = async (from, to) => {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== "EPERM" || i > 40) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
};

const stopAfter = (n) => {
  const ctl = new AbortController();
  const read = [];
  return {
    signal: ctl.signal,
    read,
    hash: (f) => (read.push(f), read.length === n && ctl.abort(), hashFile(f))
  };
};

test("D1: a file moved or deleted between a stop and the resume leaves no row behind", async () => {
  const root = tmp();
  for (let i = 0; i < 12; i++) write(root, `a/${String(i).padStart(2, "0")}.txt`, `file ${i}`);
  write(root, "z/keep.txt", "the folder walked last");
  const dbPath = path.join(tmp(), "lib.db");
  const s = stopAfter(7);
  assert.equal(
    (await catalogue({ root, dbPath, batch: 2, signal: s.signal, hash: s.hash })).stopped,
    true
  );
  // between the nights: a committed file moves into a folder not yet walked, another is deleted
  fs.renameSync(path.join(root, "a", "00.txt"), path.join(root, "z", "00-moved.txt"));
  fs.rmSync(path.join(root, "a", "01.txt"));
  const r = await catalogue({ root, dbPath });
  assert.equal(r.finished, true);
  const whole = path.join(tmp(), "whole.db");
  await catalogue({ root, dbPath: whole });
  assert.deepEqual(
    rowsOf(dbPath).map((x) => x.path),
    rowsOf(whole).map((x) => x.path),
    "equal to an uninterrupted pass"
  );
  assert.equal(duplicateSets(dbPath, root).length, 0, "no phantom duplicate of the moved file");
});

test("D1: a rename that only changes case leaves one row, in the new case", async () => {
  const root = tmp();
  for (let i = 0; i < 6; i++) write(root, `p/${i}.txt`, `f${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  const s = stopAfter(3);
  await catalogue({ root, dbPath, batch: 1, signal: s.signal, hash: s.hash });
  const first = rowsOf(dbPath)[0].path;
  const renamed = first.replace(/\.txt$/u, ".TXT");
  fs.renameSync(path.join(root, ...first.split("/")), path.join(root, ...renamed.split("/")));
  await catalogue({ root, dbPath });
  const paths = rowsOf(dbPath).map((x) => x.path);
  assert.ok(paths.includes(renamed) && !paths.includes(first), paths.join(", "));
  assert.equal(paths.length, 6);
});

test("D2: a drive that goes away mid-pass never finishes the catalogue", async () => {
  const parent = tmp();
  const root = path.join(parent, "F");
  for (let i = 0; i < 9; i++) write(root, `d/${i}.txt`, `file ${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  let n = 0;
  const unplugAfter2 = async (f) => {
    const h = await hashFile(f);
    if (++n === 2) await moveAway(root, path.join(parent, "unplugged"));
    return h;
  };
  const r = await catalogue({ root, dbPath, batch: 1, hash: unplugAfter2 }).catch((e) => e);
  assert.match(String(r.message), /went away/u, "an error, not finished:true");
  assert.match(
    catalogueLookup(dbPath, root).refused,
    /never finished/u,
    "and a comparison still refuses it"
  );
  assert.ok(rowsOf(dbPath).length >= 1, "what was read and committed is kept");
});

test("D2: a drive that goes away after its last file is read does not finish either", async () => {
  const parent = tmp();
  const root = path.join(parent, "F");
  for (let i = 0; i < 4; i++) write(root, `${i}.txt`, `file ${i}`); // one folder: nothing left to list
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  write(root, "new.txt", "added since");
  let n = 0;
  const unplugAtTheEnd = async (f) => {
    const h = await hashFile(f);
    if (++n === 1) await moveAway(root, path.join(parent, "unplugged")); // new.txt is the only read
    return h;
  };
  const r = await catalogue({ root, dbPath, hash: unplugAtTheEnd }).catch((e) => e);
  assert.match(String(r.message), /went away/u);
  assert.equal(rowsOf(dbPath).length, 4, "no removal and no half-batch committed");
});

test("D2: a different drive at the same letter mid-pass is not catalogued into this one", async () => {
  const parent = tmp();
  const root = path.join(parent, "F");
  for (let i = 0; i < 6; i++) write(root, `d/${i}.txt`, `drive A ${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  let n = 0;
  const swapAfter2 = async (f) => {
    const h = await hashFile(f);
    if (++n === 2) {
      fs.renameSync(root, path.join(parent, "A"));
      for (let i = 0; i < 6; i++) write(root, `d/${i}.txt`, `drive B ${i}`); // drive B, same letter
    }
    return h;
  };
  const r = await catalogue({ root, dbPath, batch: 3, hash: swapAfter2 }).catch((e) => e);
  assert.match(String(r.message), /went away/u);
  const shas = new Set(rowsOf(dbPath).map((x) => x.sha256));
  for (let i = 0; i < 6; i++)
    assert.ok(!shas.has(await hashFile(path.join(root, "d", `${i}.txt`))), "no row of drive B");
});

test("D2: folders that cannot be read are counted", async () => {
  const root = tree();
  const real = fsp.readdir;
  fsp.readdir = async (d, ...a) => {
    if (path.basename(String(d)) === "Docs")
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    return real(d, ...a);
  };
  let r;
  try {
    r = await catalogue({ root, dbPath: path.join(tmp(), "lib.db") });
  } finally {
    fsp.readdir = real;
  }
  assert.equal(r.unreadable_dirs, 1);
});

test("D3: the summary is worked out off the hub's thread, kept, and re-made when the rules change", async () => {
  const root = tree();
  write(root, "Jobs/old.jpg", "photo a"); // a copy of Photos/2019/a.jpg
  const store = tmp();
  const lib = createLibrarian({ dir: path.join(store, "library"), skip: [store], rules: [] });
  await lib.start(root).done;
  const started = Date.now();
  const first = lib.state(root);
  assert.ok(Date.now() - started < 200, "answered at once");
  assert.equal(first.computing, true);
  assert.equal(first.last.finished_at !== null, true, "the pass itself is known at once");
  assert.equal(lib.csvPath(root), null, "no list until it is worked out");
  let s;
  for (let i = 0; i < 300 && (s = lib.state(root)).computing; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.duplicates.sets, 1);
  assert.match(fs.readFileSync(lib.csvPath(root), "utf8"), /old\.jpg/u);
  // the owner adds a rule: nothing worked out under the old rules may be shown again
  const strict = createLibrarian({
    dir: path.join(store, "library"),
    skip: [store],
    rules: [/jobs/iu]
  });
  const after = strict.state(root);
  assert.equal(after.computing, true);
  assert.equal(after.duplicates ?? null, null, "not the old answer, which named Jobs/old.jpg");
  assert.equal(strict.csvPath(root), null);
  let t;
  for (let i = 0; i < 300 && (t = strict.state(root)).computing; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.duplicates.private, 1);
  assert.doesNotMatch(fs.readFileSync(strict.csvPath(root), "utf8"), /old\.jpg/u);
});

test("D4: the hub skips the whole estate store when it sits on the drive", async () => {
  const root = tree();
  const store = path.join(root, "estate-store");
  write(store, "nas/catalog.db", "the store's own files");
  write(store, "eventlog/nas-t480.jsonl", "{}");
  const h = await hub({ roots: [root], estateStore: store });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 300 && JSON.parse((await h.call("/library")).text).running; i++)
      await new Promise((r) => setTimeout(r, 10));
  } finally {
    await h.close();
  }
  const db = libraryPath(path.join(store, "library"), root);
  assert.ok(
    !rowsOf(db).some((x) => x.path.startsWith("estate-store")),
    rowsOf(db)
      .map((x) => x.path)
      .join(", ")
  );
});

// --- claude-s21-verifier-2's FAIL (round 2) ----------------------------------------------------------

const waitState = async (lib, root, done = (x) => !x.computing) => {
  let s;
  for (let i = 0; i < 400 && !done((s = lib.state(root))); i++)
    await new Promise((r) => setTimeout(r, 20));
  return s;
};

test("D5: a catalogue another connection holds locked is waited for, not a 'database is locked' error", async () => {
  const root = tree();
  const store = tmp();
  const lib = createLibrarian({ dir: path.join(store, "library"), skip: [store] });
  await lib.start(root).done;
  await waitState(lib, root);
  // an exclusive lock held for 300 ms by ANOTHER thread, as the summary worker's open can be
  const db = libraryPath(path.join(store, "library"), root);
  const holder = new Worker(
    `const { DatabaseSync } = require("node:sqlite"); const { parentPort, workerData } = require("node:worker_threads");
     const h = new DatabaseSync(workerData);
     h.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; UPDATE passes SET seen = seen; COMMIT;");
     parentPort.postMessage("locked"); setTimeout(() => { h.close(); parentPort.postMessage("released"); }, 300);`,
    { eval: true, workerData: db }
  );
  await new Promise((r) => holder.once("message", r)); // "locked"
  const started = Date.now();
  const s = lib.state(root); // used to throw SQLITE_BUSY at once, and the hub answered 500
  assert.ok(s && s.last, "answered once the lock was released");
  assert.ok(Date.now() - started >= 200, "it waited rather than failing");
  await new Promise((r) => holder.once("exit", r));
});

test("D6: a duplicates list made under other rules is never served, even when its summary failed to save", async () => {
  const root = tree();
  write(root, "Jobs/a-private-copy.jpg", "photo a"); // a copy of Photos/2019/a.jpg, private under the strict rules
  const store = tmp();
  const dir = path.join(store, "library");
  const strict = createLibrarian({ dir, skip: [store], rules: [/jobs/iu] });
  await strict.start(root).done;
  await waitState(strict, root);
  assert.doesNotMatch(fs.readFileSync(strict.csvPath(root), "utf8"), /a-private-copy/u);
  // the lax librarian (no rules) works out its own summary, but its summary.json cannot be saved
  const json = `${libraryPath(dir, root)}.summary.json`;
  fs.chmodSync(json, 0o444);
  try {
    const lax = createLibrarian({ dir, skip: [store], rules: [] });
    lax.state(root); // starts lax's worker
    await new Promise((r) => setTimeout(r, 1500)); // its CSV is written; its JSON replace fails
  } finally {
    fs.chmodSync(json, 0o644);
  }
  const served = strict.csvPath(root);
  if (served)
    assert.doesNotMatch(
      fs.readFileSync(served, "utf8"),
      /a-private-copy/u,
      "the strict hub serves only its own list"
    );
  const st = strict.state(root);
  if (!st.computing) assert.equal(st.duplicates.private, 1);
});

test("an older-format catalogue is migrated, not broken by", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, sha256 TEXT NOT NULL,
              kind TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, pass TEXT NOT NULL);
            CREATE TABLE passes (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, stopped_at TEXT,
              seen INTEGER NOT NULL DEFAULT 0, hashed INTEGER NOT NULL DEFAULT 0, bytes_hashed INTEGER NOT NULL DEFAULT 0,
              pending INTEGER NOT NULL DEFAULT 0, unreadable INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
              digest TEXT NOT NULL DEFAULT '');
            INSERT INTO files VALUES ('gone/old.txt', 3, 0, 'x', 'documents', 'a', 'a', 'p0');`);
  old.close();
  const r = await catalogue({ root, dbPath });
  assert.equal(r.finished, true);
  assert.equal(
    r.removed,
    1,
    "the old row of a file no longer there is removed by the finished pass"
  );
  assert.equal(rowsOf(dbPath).length, 5);
});

test("a finished pass keeps the rows of files that are settling or could not be read", async () => {
  const root = tree();
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath });
  write(root, "Docs/c.pdf", "being rewritten now", new Date()); // inside the settle window
  const unreadable = path.join(root, "Photos", "2019", "a.jpg");
  write(root, "Photos/2019/a.jpg", "photo a, edited", new Date(Date.now() - 600_000));
  const r = await catalogue({
    root,
    dbPath,
    hash: (f) => (f === unreadable ? Promise.reject(new Error("EBUSY")) : hashFile(f))
  });
  assert.equal(r.finished, true);
  assert.equal(r.removed, 0);
  const paths = rowsOf(dbPath).map((x) => x.path);
  assert.ok(paths.includes("Docs/c.pdf") && paths.includes("Photos/2019/a.jpg"), paths.join(", "));
});

test("the summary is worked out again after every new pass", async () => {
  const root = tree();
  const store = tmp();
  const lib = createLibrarian({ dir: path.join(store, "library"), skip: [store] });
  await lib.start(root).done;
  assert.equal((await waitState(lib, root)).duplicates.sets, 0);
  write(root, "Backup/a-again.jpg", "photo a");
  await lib.start(root).done;
  assert.equal(
    (await waitState(lib, root, (x) => !x.computing && x.duplicates?.sets === 1)).duplicates.sets,
    1
  );
});

test("the store folder is skipped whatever case its path is written in", async () => {
  const root = tree();
  write(root, "Estate-Store/library/x.db", "store");
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath, skip: [path.join(root, "estate-store").toUpperCase()] });
  assert.ok(!rowsOf(dbPath).some((x) => x.path.toLowerCase().startsWith("estate-store")));
});

test("progress never carries a file's name", async () => {
  const root = tree();
  const seen = [];
  await catalogue({
    root,
    dbPath: path.join(tmp(), "lib.db"),
    batch: 1,
    onProgress: (p) => seen.push(JSON.stringify(p))
  });
  assert.ok(seen.length > 0);
  assert.doesNotMatch(seen.join("\n"), /a\.jpg|c\.pdf|d\.txt|m\.gguf|Photos|Docs/u);
});

test("the hub applies its privacy rules to the library, and serves no list without a policy", async () => {
  const root = tree();
  write(root, "Passport/scan-copy.jpg", "photo a");
  const h = await hub({ roots: [root] }); // quarantine ["passport"]
  try {
    await h.call("/library", { root });
    let c;
    for (let i = 0; i < 400; i++) {
      const s = JSON.parse((await h.call("/library")).text);
      c = s.catalogues[root];
      if (!s.running && c && !c.computing) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(c.duplicates.private, 1);
    assert.doesNotMatch(JSON.stringify(c), /scan-copy/u);
    const csv = await h.call(`/library.csv?root=${encodeURIComponent(root)}`);
    assert.doesNotMatch(csv.text, /scan-copy/u);
  } finally {
    await h.close();
  }
  const none = await hub({ quarantine: null, roots: [root] });
  try {
    assert.equal((await none.call(`/library.csv?root=${encodeURIComponent(root)}`)).status, 404);
  } finally {
    await none.close();
  }
});

test("while a new summary is worked out, the last one is shown whole: its count beside its own date", async () => {
  const root = tree();
  const store = tmp();
  const lib = createLibrarian({ dir: path.join(store, "library"), skip: [store] });
  await lib.start(root).done;
  const first = await waitState(lib, root);
  write(root, "new/e.txt", "added");
  await lib.start(root).done;
  const during = lib.state(root); // the worker for the new pass has only just been started
  assert.equal(during.computing, true);
  assert.equal(during.last.id, first.last.id, "the date shown is the pass the counts came from");
  assert.equal(during.files, first.files);
});

// --- claude-s21-verifier-3's FAIL (round 3) ----------------------------------------------------------

test("D7: a list removed between the check and the download is a 202, never a crash", async () => {
  const root = tree();
  write(root, "Backup/a-again.jpg", "photo a");
  const h = await hub({ roots: [root] });
  const real = fs.createReadStream;
  try {
    await h.call("/library", { root });
    for (let i = 0; i < 400; i++) {
      const s = JSON.parse((await h.call("/library")).text);
      if (!s.running && s.catalogues[root] && !s.catalogues[root].computing) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // another hub's worker removes the list at the worst moment: after the check, before the open
    fs.createReadStream = (f, ...a) => (fs.rmSync(f, { force: true }), real(f, ...a));
    const res = await h.call(`/library.csv?root=${encodeURIComponent(root)}`);
    assert.equal(res.status, 202, "try again, not a dead hub");
  } finally {
    fs.createReadStream = real;
    await h.close();
  }
});

test("D7: hubs with different rules on one store never remove each other's lists", async () => {
  const root = tree();
  write(root, "Jobs/a-private-copy.jpg", "photo a");
  const store = tmp();
  const dir = path.join(store, "library");
  const strict = createLibrarian({ dir, skip: [store], rules: [/jobs/iu] });
  await strict.start(root).done;
  await waitState(strict, root);
  const strictList = strict.csvPath(root);
  assert.ok(strictList);
  const lax = createLibrarian({ dir, skip: [store], rules: [] });
  await waitState(lax, root);
  assert.ok(fs.existsSync(strictList), "the lax hub's worker left the strict hub's list alone");
  assert.doesNotMatch(fs.readFileSync(strictList, "utf8"), /a-private-copy/u);
});

test("an old list under the same rules is removed once the new summary is saved, with any half-written one", async () => {
  const root = tree();
  const store = tmp();
  const dir = path.join(store, "library");
  const lib = createLibrarian({ dir, skip: [store] });
  await lib.start(root).done;
  await waitState(lib, root);
  const first = lib.csvPath(root);
  // S21-era, found in a mutation run: unchecked, a null here writes `null.tmp` into the REPO ROOT
  // and the assertion below becomes fs.existsSync(null), which passes vacuously. The truthy
  // coercion this epic keeps meeting.
  assert.ok(first, "the pass must name its own list before this test means anything");
  fs.writeFileSync(`${first}.tmp`, "a list a killed worker left half-written");
  write(root, "Backup/a-again.jpg", "photo a");
  await lib.start(root).done;
  await waitState(lib, root, (x) => !x.computing && x.duplicates?.sets === 1);
  assert.ok(!fs.existsSync(first), "the previous pass's list is gone");
  assert.ok(!fs.existsSync(`${first}.tmp`), "and so is the half-written one");
  assert.ok(lib.csvPath(root));
});

// --- S22: the questions an agent asks of the catalogue ------------------------------------------
// S21 answers "what is on this drive" for the panel. S22 answers three questions for Benny, and the
// privacy judgement must happen HERE, in the hub, before any name leaves it: an agent's answer can
// be harvested into a training trace (EP-A P5), so a name withheld from the panel but handed to a
// tool would leak by the longer route. Each test below pairs a name that IS returned with one that
// must only ever be counted.

const QUERY_TREE = () => {
  const root = tmp();
  write(root, "Photos/2019/holiday-beach.jpg", "beach bytes");
  write(root, "Photos/2019/holiday-passport-scan.jpg", "passport bytes"); // private by rule
  write(root, "Photos/2024/holiday-later.jpg", "later bytes");
  write(root, "Docs/holiday-itinerary.pdf", "itinerary");
  return root;
};

test("Scenario: finding a file names only what the rules allow", async () => {
  const root = QUERY_TREE();
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);

  const r = findFiles(dbPath, root, ["passport"], { q: "holiday", limit: 50 });
  const named = r.matches.map((m) => path.basename(m.full)).sort();
  assert.deepEqual(named, ["holiday-beach.jpg", "holiday-itinerary.pdf", "holiday-later.jpg"]);
  assert.equal(r.withheld, 1, "the private match is counted");
  assert.equal(r.total, 4, "the total says how many matched before the rules");
  assert.ok(r.matches.every((m) => typeof m.size === "number" && m.kind));
  // the paired negative: the private name appears NOWHERE in the answer, not even in a field we
  // did not think to check
  assert.equal(JSON.stringify(r).includes("passport"), false);

  // kind narrows, case does not matter
  const imgs = findFiles(dbPath, root, ["passport"], { q: "HOLIDAY", kind: "images" });
  assert.deepEqual(imgs.matches.map((m) => path.basename(m.full)).sort(), [
    "holiday-beach.jpg",
    "holiday-later.jpg"
  ]);
  // limit caps what is named but not what is counted
  const one = findFiles(dbPath, root, ["passport"], { q: "holiday", limit: 1 });
  assert.equal(one.matches.length, 1);
  assert.equal(one.total, 4);
});

test("Scenario: 'is this already on F:' reads only the thing asked about", async () => {
  const root = QUERY_TREE();
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);

  const elsewhere = tmp();
  const same = write(elsewhere, "mixed/holiday-beach.jpg", "beach bytes"); // byte-identical to F:
  const novel = write(elsewhere, "mixed/notes.txt", "nothing like it");

  const spy = countingHash();
  const r = await checkPaths(dbPath, root, ["passport"], {
    paths: [path.join(elsewhere, "mixed")],
    hash: spy.hash
  });
  const by = Object.fromEntries(r.files.map((f) => [path.basename(f.path), f]));
  assert.equal(by["holiday-beach.jpg"].verdict, "on-root");
  assert.deepEqual(
    by["holiday-beach.jpg"].at.map((a) => path.basename(a)),
    ["holiday-beach.jpg"]
  );
  assert.equal(by["notes.txt"].verdict, "absent");
  assert.equal(r.total, 2);

  // NO FILE ON THE CATALOGUED DRIVE IS OPENED FOR ITS DATA: every hash read is under the folder
  // asked about. This is the whole point of having a catalogue.
  assert.ok(spy.read.length > 0, "it did hash the files it was asked about");
  for (const f of spy.read)
    assert.ok(f.startsWith(elsewhere), `hashed something outside the folder asked about: ${f}`);
  assert.equal(
    spy.read.some((f) => f.startsWith(root)),
    false
  );
  (void same, novel);
});

test("Scenario: a file changed on F: since cataloguing is not a copy", async () => {
  const root = QUERY_TREE();
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);

  const elsewhere = tmp();
  write(elsewhere, "holiday-beach.jpg", "beach bytes");

  // the catalogue still says those bytes are at this path, but the file there is no longer them
  write(root, "Photos/2019/holiday-beach.jpg", "beach bytes CHANGED", new Date());

  const r = await checkPaths(dbPath, root, ["passport"], {
    paths: [path.join(elsewhere, "holiday-beach.jpg")]
  });
  assert.equal(r.files[0].verdict, "changed", JSON.stringify(r.files[0]));
  assert.notEqual(r.files[0].verdict, "on-root", "a stale row must never read as a safe copy");
});

test("Scenario: no finished catalogue is said, not hidden", async () => {
  const root = QUERY_TREE();
  const dbPath = path.join(tmp(), "lib.db");

  // (a) no catalogue at all
  assert.equal(findFiles(dbPath, root, [], { q: "holiday" }), null);
  assert.equal(await checkPaths(dbPath, root, [], { paths: [root] }), null);

  // (b) a catalogue that exists but has never finished — the dangerous case, because "no match"
  // would mean "not reached yet" rather than "not on the drive"
  const stop = stopAfter(1); // it aborts through its own hash, so both must be wired
  await catalogue({ root, dbPath, signal: stop.signal, hash: stop.hash }).catch(() => {});
  const f = findFiles(dbPath, root, [], { q: "holiday" });
  const c = await checkPaths(dbPath, root, [], { paths: [root] });
  assert.match(f.refused, /never finished/u);
  assert.match(c.refused, /never finished/u);
  assert.equal(f.matches, undefined, "a refusal is never an empty list");
  assert.equal(c.files, undefined);
});

// --- S22: the routes, and the audit the questions leave behind ----------------------------------

test("Scenario: the query routes refuse without a policy, and say when the store is unset", async () => {
  const root = QUERY_TREE();

  // no policy: the catalogue would list private files, so nothing is answered (R31)
  const open = await hub({ quarantine: null, roots: [root] });
  try {
    for (const p of [
      `/library/find?root=${encodeURIComponent(root)}&q=holiday`,
      `/library/duplicates?root=${encodeURIComponent(root)}`
    ])
      assert.equal((await open.call(p)).status, 412, p);
    const chk = await open.call("/library/check", { path: root });
    assert.equal(chk.status, 412);
  } finally {
    await open.close();
  }

  // ESTATE_STORE unset: said, not guessed, and nothing is read from a built-in path
  const unset = await hub({ roots: [root], estateStore: "" });
  try {
    const r = await unset.call(`/library/find?root=${encodeURIComponent(root)}&q=holiday`);
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.text).error, /ESTATE_STORE is not set/u);
    assert.match(JSON.parse(r.text).error, /node space set/u, "it says how to set it");
    // the paired positive: with a store configured the same request is answered. Closed, or the
    // listening server keeps the test process alive for ever.
    const configured = await hub({ roots: [root] });
    try {
      assert.notEqual(
        (await configured.call(`/library/find?root=${encodeURIComponent(root)}&q=holiday`)).status,
        503
      );
    } finally {
      await configured.close();
    }
  } finally {
    await unset.close();
  }
});

test("Scenario: the routes answer the agent's questions and never name a private file", async () => {
  const root = QUERY_TREE();
  const h = await hub({ roots: [root] });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const enc = encodeURIComponent(root);
    const found = await h.call(`/library/find?root=${enc}&q=holiday&surface=skill`);
    assert.equal(found.status, 200);
    const body = JSON.parse(found.text);
    assert.equal(body.matches.length, 3);
    assert.equal(body.withheld, 1);
    // the whole body, not a field we thought to check
    assert.equal(found.text.includes("passport"), false, "no private name in the JSON");

    const checked = await h.call("/library/check", {
      root,
      path: path.join(root, "Docs"),
      surface: "skill"
    });
    assert.equal(checked.status, 200);
    assert.equal(JSON.parse(checked.text).files[0].verdict, "on-root");

    // a root this machine does not offer is refused rather than answered about
    assert.equal((await h.call("/library/find?root=Z:&q=x")).status, 400);
  } finally {
    await h.close();
  }
});

test("Scenario: an agent's question is audited without its words", async () => {
  const root = QUERY_TREE();
  const h = await hub({ roots: [root] });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const SECRET = "passport";
    const enc = encodeURIComponent(root);
    assert.equal((await h.call(`/library/find?root=${enc}&q=${SECRET}&surface=skill`)).status, 200);

    // the drive's own library log, beside its catalogue
    const dir = path.join(h.estateStore, "library");
    const log = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    assert.ok(log, `a library log exists in ${dir}: ${fs.readdirSync(dir)}`);
    const raw = fs.readFileSync(path.join(dir, log), "utf8");
    const read = readKelEvents(path.join(dir, log));
    assert.equal(read.ok, true, "the log still chains");
    const queries = read.events.filter((e) => e.type === "library_queried");
    assert.equal(queries.length, 1, "one event per question");
    assert.equal(queries[0].payload.surface, "skill");
    assert.equal(queries[0].payload.kind, "find");
    assert.equal(queries[0].payload.returned, 0, "the private-only query named nothing");
    assert.equal(queries[0].payload.withheld, 1, "and says one was withheld");
    assert.ok(queries[0].payload.pass, "it names the pass it answered from");

    // THE QUERY TEXT IS NOWHERE IN THE LOG BYTES: "find my CV" is itself private, and so is a path
    assert.equal(raw.includes(SECRET), false, "the query text must not be in the log");
    assert.equal(raw.includes("holiday"), false, "nor any file name from the answer");
  } finally {
    await h.close();
  }
});

// --- claude-s22-verifier's round-1 FAIL: three defects, each reproduced before its fix ----------

test("S22-D1: a private name on the side being ASKED ABOUT is withheld too", async () => {
  // The verifier's finding, and the one that defeated the contract's purpose: checkPaths judged the
  // catalogue side (`at`) and echoed its own walk's paths straight back, so pointing it at a folder
  // named every quarantined file inside it — over MCP, the surface whose traces can be harvested.
  // One judge must give one answer, whichever question is asked.
  const root = tmp();
  write(root, "Open/public.txt", "public bytes");
  write(root, "Private/bank-statement.pdf", "secret bytes");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath, rules: [/private/iu] })).finished, true);

  const onDrive = await checkPaths(dbPath, root, [/private/iu], { paths: [root] });
  const named = onDrive.files.map((f) => f.path);
  assert.ok(
    named.some((n) => n.includes("public.txt")),
    "the public file is still named"
  );
  for (const n of named)
    assert.equal(/private/iu.test(n), false, `a quarantined path was named: ${n}`);
  assert.equal(JSON.stringify(onDrive).toLowerCase().includes("bank-statement"), false);
  assert.ok(onDrive.withheld >= 1, "and the withholding is counted, not silent");

  // the same, off the catalogued drive: the rules judge the path, wherever it lives
  const elsewhere = tmp();
  write(elsewhere, "Private/CV/payslip.pdf", "nothing alike");
  const off = await checkPaths(dbPath, root, [/private/iu], { paths: [elsewhere] });
  assert.equal(JSON.stringify(off).toLowerCase().includes("payslip"), false);
  assert.ok(off.withheld >= 1);

  // D4, the verifier's surviving mutation: the catalogue side must stay filtered as well
  const twin = tmp();
  write(twin, "copy.pdf", "secret bytes"); // the same bytes as the quarantined row
  const found = await checkPaths(dbPath, root, [/private/iu], {
    paths: [path.join(twin, "copy.pdf")]
  });
  assert.equal(found.files[0].verdict, "on-root", "it still knows the bytes are there");
  assert.deepEqual(found.files[0].at, [], "but names no quarantined location");
  assert.equal(found.files[0].withheld, 1, "counting it instead");
});

test("S22-D2: duplicates refuses an unfinished catalogue, like every other question", async () => {
  // find and check both route through finishedCatalogue; duplicatesPage never consulted it, so it
  // answered from a partial catalogue with no mention that it had never finished. The Scenario says
  // "any question of it", and this landed in the gap nobody ruled on.
  const root = tmp();
  write(root, "a.jpg", "same bytes");
  write(root, "b.jpg", "same bytes");
  const dir = tmp();
  const lib = createLibrarian({ dir, rules: [] });
  const dbPath = libraryPath(dir, root);
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await waitState(lib, root);

  // the paired positive first: a finished catalogue answers
  const ok = lib.duplicatesPage(root, { offset: 0, limit: 5 });
  assert.ok(ok.sets.length >= 1, `a finished catalogue answers: ${JSON.stringify(ok)}`);

  // now the same catalogue, with no pass ever finished
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE passes SET finished_at = NULL");
  db.close();
  const refused = lib.duplicatesPage(root, { offset: 0, limit: 5 });
  assert.match(refused.refused ?? "", /never finished/u, JSON.stringify(refused));
  assert.equal(refused.sets, undefined, "a refusal is never a list");
});

test("S22-D3: an unset store cannot kill the hub through the comparer", async () => {
  // The store literal became "", so `producer && store && createLibrarian(...)` was "" — the
  // shipped state of every install until the owner runs `node space set`, this contract's own
  // Handoff. createComparer still called librarian.lookup, so pressing Compare threw inside an
  // uncaught readBody().then() and the hub PROCESS exited. The 503 guard covered /library* only.
  const a = tmp();
  const b = tmp();
  write(a, "x.txt", "x");
  write(b, "y.txt", "y");
  const h = await hub({ roots: [a, b], estateStore: "" });
  try {
    const r = await h.call("/compare", { from: a, to: b });
    // whatever it answers, it must ANSWER: a thrown lookup used to take the process with it
    assert.ok([202, 409, 412, 503].includes(r.status), `compare answered ${r.status}: ${r.text}`);
    // and the hub is still alive afterwards
    assert.equal((await h.call("/library")).status, 503, "the hub still serves requests");
    // let the comparison it started finish INSIDE the test: its result is written asynchronously,
    // and a temp tree removed under it throws after the test has ended, which node reports as an
    // unhandled rejection against the whole file
    for (let i = 0; i < 400; i++) {
      const s = JSON.parse((await h.call(`/compare?to=${encodeURIComponent(b)}`)).text);
      if (!s.running) break;
      await new Promise((done) => setTimeout(done, 10));
    }
  } finally {
    await h.close();
  }
});

// --- claude-s22-verifier-2's round-2 FAIL ------------------------------------------------------
// The lesson both defects share: I fixed D2 at the layer its test could reach (the function) and
// never at the layer its Scenario talks about (the route). These tests go through the route.

test("S22-D5: every question refuses an unfinished catalogue AT ITS ROUTE, not just in the function", async () => {
  const root = tmp();
  write(root, "a.jpg", "same bytes");
  write(root, "b.jpg", "same bytes");
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const enc = encodeURIComponent(root);
    // the paired positive: a finished catalogue answers. duplicates is polled because its list is
    // written by the worker, so 202 "still being worked out" is a legitimate intermediate answer.
    assert.equal((await h.call(`/library/find?root=${enc}&q=a`)).status, 200);
    let first;
    for (let i = 0; i < 400; i++) {
      first = await h.call(`/library/duplicates?root=${enc}`);
      if (first.status !== 202) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(first.status, 200, first.text);

    // now no pass has ever finished
    const db = new DatabaseSync(libraryPath(path.join(store, "library"), root));
    db.exec("UPDATE passes SET finished_at = NULL");
    db.close();

    const find = await h.call(`/library/find?root=${enc}&q=a`);
    const dups = await h.call(`/library/duplicates?root=${enc}`);
    const chk = await h.call("/library/check", { root, path: path.join(root, "a.jpg") });
    for (const [name, r] of [
      ["find", find],
      ["duplicates", dups],
      ["check", chk]
    ]) {
      assert.equal(r.status, 409, `${name} answered ${r.status}: ${r.text}`);
      assert.match(JSON.parse(r.text).error, /never finished/u, name);
    }
    // and the hub is still there: the refusal used to be a TypeError on d.sets.length
    assert.equal((await h.call("/library")).status, 200, "the hub survived answering");
  } finally {
    await h.close();
  }
});

test("S22-D6: the check surface audits what it actually withheld", async () => {
  const root = tmp();
  write(root, "Open/public.txt", "public");
  for (const n of ["one", "two", "three"]) write(root, `Private/${n}.pdf`, `secret ${n}`);
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store, quarantine: ["private"] });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const r = await h.call("/library/check", { root, path: root, surface: "skill" });
    assert.equal(r.status, 200);
    const answer = JSON.parse(r.text);
    assert.ok(answer.withheld >= 3, `the answer withholds the private files: ${r.text}`);

    const dir = path.join(store, "library");
    const log = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    const events = readKelEvents(path.join(dir, log)).events.filter(
      (e) => e.type === "library_queried"
    );
    const checked = events.find((e) => e.payload.kind === "check");
    assert.ok(checked, "the question was audited");
    // 0 of 3 is not a count. This is the same figure I refused to write for duplicates in the very
    // same commit, shipped on the other surface: the audit must agree with the answer it describes.
    assert.equal(
      checked.payload.withheld,
      answer.withheld,
      `audited ${checked.payload.withheld}, answered ${answer.withheld}`
    );
  } finally {
    await h.close();
  }
});

test("S22-D7: the walk cap is enforced, not just reported", async () => {
  // TDD item 1 claims "the given folder is walked only up to the cap". Verifier-2 removed the cap
  // from add() entirely and no test died, so the claim rested on nothing.
  const root = tmp();
  write(root, "x.txt", "x");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);

  const many = tmp();
  for (let i = 0; i < 12; i++) write(many, `f${i}.txt`, `body ${i}`);
  const r = await checkPaths(dbPath, root, [], { paths: [many], cap: 5 });
  assert.equal(r.files.length, 5, "it stops at the cap");
  assert.equal(r.total, 5);
  assert.equal(r.capped, true, "and says it stopped");

  const under = await checkPaths(dbPath, root, [], { paths: [many], cap: 50 });
  assert.equal(under.files.length, 12);
  assert.equal(under.capped, false, "a walk inside the cap is not reported as capped");
});

test("S22-D8: the duplicates audit states no figure it cannot stand behind", async () => {
  // Round 2 changed this from 0 to null with a comment and no test, which verifier-2's surviving
  // mutation proved. The worker's list has already dropped private copies and their count is not
  // carried here, so a number would be invented.
  const root = tmp();
  write(root, "a.jpg", "same bytes");
  write(root, "b.jpg", "same bytes");
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    let dups;
    for (let i = 0; i < 400; i++) {
      dups = await h.call(`/library/duplicates?root=${encodeURIComponent(root)}&surface=mcp`);
      if (dups.status === 200) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(dups.status, 200, dups.text);

    const dir = path.join(store, "library");
    const log = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    const events = readKelEvents(path.join(dir, log)).events.filter(
      (e) => e.type === "library_queried"
    );
    const d = events.find((e) => e.payload.kind === "duplicates");
    assert.ok(d, "the question was audited");
    assert.equal(d.payload.withheld, null, "null, not 0: this surface does not know the figure");
    assert.equal(
      "withheld" in d.payload,
      true,
      "and the key is present, so the silence is explicit"
    );
  } finally {
    await h.close();
  }
});

test("S22-D9: a file that stats but will not open is a verdict, never a dead hub", async () => {
  // claude-s22-verifier-3's D7, found by accident: an ordinary locked file - an open .pst, a VM
  // disk, a SQLite file in use - made checkPaths reject, and the check route's readBody().then()
  // had no catch, so the hub PROCESS exited rather than answering. The damning part is that the
  // WRITE path already survives exactly this: the catalogue pass catches a rejecting hash and
  // counts it `unreadable` (the test at "a file that cannot be read is counted, not fatal").
  // Same module, same error, same diff - guarded on the way in, fatal on the way out.
  const root = tmp();
  write(root, "ok.txt", "same size!!");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);

  const asked = tmp();
  write(asked, "locked.txt", "same size!!"); // same size, so the cheap gate passes and it is hashed
  write(asked, "fine.txt", "same size!!");

  const locked = path.join(asked, "locked.txt");
  const r = await checkPaths(dbPath, root, [], {
    paths: [asked],
    hash: (f) =>
      f === locked
        ? Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))
        : hashFile(f)
  });

  const by = Object.fromEntries(r.files.map((f) => [path.basename(f.path), f.verdict]));
  assert.equal(
    by["locked.txt"],
    "unreadable",
    `the locked file is a verdict: ${JSON.stringify(r.files)}`
  );
  assert.equal(by["fine.txt"], "on-root", "and the rest of the answer still arrives");
  assert.equal(r.files.length, 2, "nothing is dropped");
});

test("S22-D10: the check route answers even when the work beneath it throws", async () => {
  // The shaper maps shapes and contains nothing: the check route's readBody().then() had no catch,
  // so a rejection there was an unhandled rejection and the process left. Whatever else is wrong,
  // a request must END - with an answer the caller can read.
  const root = tmp();
  write(root, "a.txt", "aaa");
  const h = await hub({ roots: [root] });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // a path that cannot be statted at all: the walk keeps it and every later step must cope
    const r = await h.call("/library/check", {
      root,
      path: path.join(root, "does", "not", "exist")
    });
    assert.ok([200, 409, 500].includes(r.status), `it answered ${r.status}: ${r.text}`);
    assert.ok(r.text.length > 0, "with a body");
    // and the hub is still serving
    assert.equal((await h.call("/library")).status, 200, "the hub survived the request");
  } finally {
    await h.close();
  }
});

test("S22-D11: a caller cannot write its own text into the audit log", async () => {
  // The SURFACES guard was in the code and nothing tested it (claude-s22-verifier-3's survivor).
  // It is the only thing keeping caller-supplied text out of a tamper-evident log, which design
  // point 10 forbids: the event records how the question arrived, not what the caller called itself.
  const root = tmp();
  write(root, "a.txt", "aaa");
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const enc = encodeURIComponent(root);
    const SMUGGLED = "ZEBRAFISH-not-a-surface";
    assert.equal((await h.call(`/library/find?root=${enc}&q=a&surface=${SMUGGLED}`)).status, 200);
    assert.equal(
      (await h.call("/library/check", { root, path: path.join(root, "a.txt"), surface: SMUGGLED }))
        .status,
      200
    );
    // the paired positive: a surface the hub recognises IS recorded
    assert.equal((await h.call(`/library/find?root=${enc}&q=a&surface=skill`)).status, 200);

    const dir = path.join(store, "library");
    const log = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    const raw = fs.readFileSync(path.join(dir, log), "utf8");
    assert.equal(raw.includes(SMUGGLED), false, "the caller's text is nowhere in the log bytes");
    const events = readKelEvents(path.join(dir, log)).events.filter(
      (e) => e.type === "library_queried"
    );
    const surfaces = events.map((e) => e.payload.surface);
    assert.ok(surfaces.includes("skill"), `a known surface is recorded: ${surfaces}`);
    for (const s of surfaces)
      assert.ok(
        ["panel", "skill", "mcp", "unknown"].includes(s),
        `unrecognised surface recorded: ${s}`
      );
    assert.ok(
      surfaces.includes("unknown"),
      "and an unrecognised one becomes 'unknown', not silence"
    );
  } finally {
    await h.close();
  }
});

// --- S26: the folder rollup -------------------------------------------------------------------
// A list of 237,508 duplicate sets is not a decision anyone makes. A folder that knows how much of
// itself exists somewhere else is. These pin what "somewhere else" means, because it is the figure
// the owner will act on, and getting it subtly wrong would send them to the wrong tree.

const rollupOf = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT * FROM folders")
        .all()
        .map((r) => [r.path, { ...r }])
    );
  } finally {
    db.close();
  }
};

test("S26: every file is attributed to each of its ancestor folders exactly once", async () => {
  const root = tmp();
  write(root, "a/b/one.txt", "1111");
  write(root, "a/b/two.txt", "22");
  write(root, "a/three.txt", "333");
  write(root, "top.txt", "4");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);

  const f = rollupOf(dbPath);
  assert.equal(f[""].files, 4, "the drive root holds every file");
  assert.equal(f[""].bytes, 4 + 2 + 3 + 1);
  assert.equal(f["a"].files, 3, "a/ holds its own subtree only");
  assert.equal(f["a"].bytes, 4 + 2 + 3);
  assert.equal(f["a/b"].files, 2);
  assert.equal(f["a/b"].bytes, 6);
  // the paired negative: a folder that does not exist is not invented
  assert.equal(f["a/b/c"], undefined);
});

test("S26: duplicated OUTSIDE a folder and duplicated WITHIN it are different figures", async () => {
  // The distinction the owner acts on: a tree duplicated against another tree can be retired, a
  // tree duplicated inside itself cannot — and on the real F: the biggest single pair is a folder
  // duplicated against itself, so conflating them would point at the wrong job.
  const root = tmp();
  write(root, "keep/photo.jpg", "same bytes");
  write(root, "copy/photo.jpg", "same bytes"); // the same content, another tree
  write(root, "twice/one.jpg", "doubled");
  write(root, "twice/again.jpg", "doubled"); // the same content, same tree
  write(root, "only/unique.jpg", "nothing alike");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);
  const f = rollupOf(dbPath);

  assert.equal(f["keep"].dup_out_files, 1, "keep/ has a copy elsewhere");
  assert.equal(f["keep"].dup_in_files, 0, "and none of its own");
  assert.equal(f["copy"].dup_out_files, 1);

  assert.equal(f["twice"].dup_out_files, 0, "twice/ is duplicated only inside itself");
  assert.equal(f["twice"].dup_in_files, 1, "one of the two is redundant, which is the reclaim");

  assert.equal(f["only"].dup_out_files, 0, "a sole copy is duplicated nowhere");
  assert.equal(f["only"].dup_in_files, 0);

  // at the drive root every copy is inside, so nothing is "elsewhere"
  assert.equal(f[""].dup_out_files, 0, "nothing is outside the root");
  // RECLAIMABLE, not total. Four copies in two sets means two redundant files, and on the real
  // catalogue this makes the root's figure equal the independently measured 267.6 GB.
  assert.equal(f[""].dup_in_files, 2, "two of the four copies are redundant");
});

test("S26: the rollup names where the other copies are", async () => {
  const root = tmp();
  write(root, "here/x.jpg", "shared");
  write(root, "there/x.jpg", "shared");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);
  const { where } = duplicateNeighbours(dbPath, root, [], "here");
  assert.ok(
    where.some((w) => w.path === "there"),
    `here/ points at there/: ${JSON.stringify(where)}`
  );
  assert.equal(
    where.some((w) => w.path === "here"),
    false,
    "and never at itself"
  );
});

test("S26: a private copy is counted but its FOLDER is never pointed at", async () => {
  // The gap my first private test left, found by mutation: it used a private file with no
  // duplicate, so the "where the other copies are" list never ran. Pointing at the folder holding
  // a quarantined copy names its location, which is the same leak by a longer route — S22's D1.
  const root = tmp();
  write(root, "open/holiday.jpg", "shared bytes");
  write(root, "secret/passport-scan.jpg", "shared bytes"); // the same bytes, a private path
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath, rules: ["passport"] })).finished, true);
  await buildFolderRollup(dbPath, root, ["passport"]);
  const f = rollupOf(dbPath);
  assert.equal(f["open"].dup_out_files, 1, "the public copy still knows it is duplicated");
  const n = duplicateNeighbours(dbPath, root, ["passport"], "open");
  assert.deepEqual(n.where, [], `but is pointed at nothing: ${JSON.stringify(n)}`);
  assert.equal(n.withheld, 1, "and says one was withheld rather than hiding it");
  assert.equal(JSON.stringify(f).includes("passport"), false, "the private name is nowhere");
  // the folder `secret` keeps its own row: the rule matched the FILE, not the folder, and a
  // browsable tree needs its folders. What must not happen is a public folder POINTING at it,
  // because "your private file is a copy of this photo" is the content of that file.
  assert.ok(f["secret"], "the folder itself is still navigable");
  assert.equal(f["secret"].private, 1, "with its private file counted");

  // the paired positive: a PUBLIC second copy is pointed at, so the check above is not vacuous
  const open2 = tmp();
  write(open2, "one/x.jpg", "two bytes");
  write(open2, "two/x.jpg", "two bytes");
  const db2 = path.join(tmp(), "lib2.db");
  assert.equal((await catalogue({ root: open2, dbPath: db2, rules: ["passport"] })).finished, true);
  await buildFolderRollup(db2, open2, ["passport"]);
  const pub = duplicateNeighbours(db2, open2, ["passport"], "one");
  assert.equal(pub.where.length, 1);
  assert.equal(pub.where[0].path, "two");
  assert.equal(pub.where[0].files, 1);
});

test("S26: a private file is counted in its folder and never named", async () => {
  const root = tmp();
  write(root, "mixed/public.txt", "public");
  write(root, "mixed/passport-scan.txt", "secret");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath, rules: ["passport"] })).finished, true);
  await buildFolderRollup(dbPath, root, ["passport"]);
  const f = rollupOf(dbPath);
  assert.equal(f["mixed"].files, 2, "both files are counted");
  assert.equal(f["mixed"].private, 1, "and the private one is counted as private");
  const dump = JSON.stringify(f);
  assert.equal(dump.includes("passport"), false, "no private name anywhere in the rollup");
});

test("S26: the rollup is built by the worker, and the request path never builds it", async () => {
  // The invariant, not the timing: 157 s on the real F: is fine in a worker and fatal on the hub's
  // request thread, which is where claude-s21-verifier's D3 lived. So asking for a folder before the
  // worker has finished must return `computing` — never a figure worked out inline to be helpful.
  const root = tmp();
  write(root, "a/one.jpg", "same");
  write(root, "b/one.jpg", "same");
  const dir = tmp();
  const lib = createLibrarian({ dir, rules: [] });
  const dbPath = libraryPath(dir, root);
  assert.equal((await catalogue({ root, dbPath })).finished, true);

  // before any worker has run there is no rollup, and the answer says so rather than inventing one
  assert.equal(rollupKey(dbPath), null, "no rollup yet");
  const early = lib.folder(root, { path: "" });
  assert.equal(early.computing, true, `computing, not a figure: ${JSON.stringify(early)}`);
  assert.equal(early.folders, undefined, "and not a half-answer");

  // the worker runs on the first state() call and writes both the summary and the rollup
  await waitState(lib, root);
  for (let i = 0; i < 400 && rollupKey(dbPath) === null; i++)
    await new Promise((r) => setTimeout(r, 25));
  assert.ok(rollupKey(dbPath), "the worker wrote the rollup");
  const view = lib.folder(root, { path: "" });
  assert.ok(
    view.folders.length >= 2,
    `and the folder answers: ${JSON.stringify(view).slice(0, 200)}`
  );
});

test("S26: opening a folder gives its children, their weight and where their copies are", async () => {
  const root = tmp();
  write(root, "keep/a.jpg", "aaaa");
  write(root, "keep/b.jpg", "bb");
  write(root, "keep/deep/c.jpg", "cccccc");
  write(root, "elsewhere/a.jpg", "aaaa");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);

  const top = folderView(dbPath, root, [], "");
  assert.deepEqual(
    top.folders.map((f) => f.name).sort(),
    ["elsewhere", "keep"],
    "the drive root lists its top folders"
  );
  assert.deepEqual(top.files, [], "and no files sit at the root here");
  assert.deepEqual(top.breadcrumb, [], "the root has no breadcrumb");

  const keep = folderView(dbPath, root, [], "keep");
  assert.deepEqual(
    keep.folders.map((f) => f.name),
    ["deep"],
    "subfolders are children, not descendants"
  );
  assert.deepEqual(
    keep.files.map((f) => f.name).sort(),
    ["a.jpg", "b.jpg"],
    "files are its own only"
  );
  assert.equal(keep.self.files, 3, "its own figure counts the whole subtree");
  assert.deepEqual(keep.breadcrumb, [{ name: "keep", path: "keep" }]);
  assert.equal(keep.self.dup_out_files, 1, "one of its files exists elsewhere");
  assert.equal(keep.self.all_elsewhere, false, "but not all of it, so it is no retire candidate");

  const only = folderView(dbPath, root, [], "elsewhere");
  assert.equal(only.self.all_elsewhere, true, "every file of this one is copied elsewhere");

  // a folder that is not in the catalogue is missing, not empty
  assert.equal(folderView(dbPath, root, [], "nope").missing, true);
});

test("S26: a quarantined file or folder is counted in the view and never named", async () => {
  const root = tmp();
  write(root, "open/fine.txt", "fine");
  write(root, "open/passport-scan.txt", "secret");
  write(root, "passport-vault/x.txt", "more");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath, rules: ["passport"] })).finished, true);
  await buildFolderRollup(dbPath, root, ["passport"]);

  const top = folderView(dbPath, root, ["passport"], "");
  assert.deepEqual(
    top.folders.map((f) => f.name),
    ["open"],
    "the quarantined folder is not listed"
  );
  assert.equal(top.withheld, 1, "but it is counted");

  const open = folderView(dbPath, root, ["passport"], "open");
  assert.deepEqual(
    open.files.map((f) => f.name),
    ["fine.txt"]
  );
  assert.equal(open.withheld, 1, "the private file is counted, not named");
  assert.equal(open.self.files, 2, "and the folder's own total includes it");
  assert.equal(JSON.stringify(top).includes("passport"), false);
  assert.equal(JSON.stringify(open).includes("passport"), false);
});

test("S26: the folder route walks the tree, and answers with the drive gone", async () => {
  const root = tmp();
  write(root, "keep/a.jpg", "aaaa");
  write(root, "keep/deep/b.jpg", "bb");
  write(root, "elsewhere/a.jpg", "aaaa");
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const enc = encodeURIComponent(root);
    let top;
    for (let i = 0; i < 400; i++) {
      top = await h.call(`/library/folder?root=${enc}`);
      if (top.status !== 202) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(top.status, 200, top.text);
    const body = JSON.parse(top.text);
    assert.deepEqual(body.folders.map((f) => f.name).sort(), ["elsewhere", "keep"]);
    assert.equal(body.self.files, 3);

    // a child, and its own breadcrumb
    const kid = JSON.parse((await h.call(`/library/folder?root=${enc}&path=keep`)).text);
    assert.deepEqual(
      kid.folders.map((f) => f.name),
      ["deep"]
    );
    assert.deepEqual(kid.breadcrumb, [{ name: "keep", path: "keep" }]);

    // a trailing or leading separator is trimmed rather than making a different folder
    const same = JSON.parse((await h.call(`/library/folder?root=${enc}&path=/keep/`)).text);
    assert.deepEqual(same.folders, kid.folders, "the same folder either way");

    // THE DRIVE NEED NOT BE THERE: every figure came from the catalogue, so removing the tree
    // changes nothing about the answer
    const before = (await h.call(`/library/folder?root=${enc}&path=keep`)).text;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    const after = await h.call(`/library/folder?root=${enc}&path=keep`);
    assert.equal(after.status, 200, "still answered with the drive gone");
    // EVERY FIGURE is identical — but the answer now says it was resolved by the recorded NAME
    // rather than by the drive's identity, which is D4: trusting a name is a last resort for a
    // drive that cannot be identified, and the owner cannot tell they are reading a possibly
    // different disk's catalogue unless the answer says so.
    const seen = JSON.parse(after.text);
    assert.equal(seen.by_name, true, "resolved by name, and saying so");
    delete seen.by_name;
    assert.deepEqual(seen, JSON.parse(before), "and every figure identical");

    // a folder nobody catalogued is missing, which is not an empty folder
    assert.equal((await h.call(`/library/folder?root=${enc}&path=nope`)).status, 404);
  } finally {
    await h.close();
  }
});

test("S26: walking the tree writes no audit event, unlike the questions an agent asks", async () => {
  // S22's design point 10 audits what an AGENT is told. The owner clicking through their own folders
  // is not that, and an event per click would bury the ones that matter in a tamper-evident log.
  const root = tmp();
  write(root, "a/one.txt", "one");
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store });
  try {
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 400; i++) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const enc = encodeURIComponent(root);
    for (let i = 0; i < 400; i++) {
      if ((await h.call(`/library/folder?root=${enc}`)).status !== 202) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const dir = path.join(store, "library");
    const log = fs.readdirSync(dir).find((x) => x.endsWith(".jsonl"));
    const count = () =>
      readKelEvents(path.join(dir, log)).events.filter((e) => e.type === "library_queried").length;

    const before = count();
    for (const p of ["", "a", "a"]) await h.call(`/library/folder?root=${enc}&path=${p}`);
    assert.equal(count(), before, "three folder views, no events");

    // the paired positive: a question an agent asks IS audited, so the check above is not vacuous
    assert.equal((await h.call(`/library/find?root=${enc}&q=one&surface=mcp`)).status, 200);
    assert.equal(count(), before + 1, "and find still writes exactly one");
  } finally {
    await h.close();
  }
});

test("S26: the NEAR side is judged, not only the far copy", async () => {
  // D1, found by a verifier going one step past my own test. My test only ever asked neighbours of
  // the PUBLIC side, so the near side was never guarded: asking the neighbours of a folder that
  // HOLDS a quarantined file named the folder holding its twin, which identifies that private
  // file's CONTENT — "your private scan is a copy of this photo". Two clicks in the panel, and the
  // route writes no audit event. It is S22's D1 again, in the direction my comment did not cover.
  const root = tmp();
  write(root, "Scans/my-passport.jpg", "identical bytes"); // private by rule
  write(root, "Album/2019/holiday-crete.jpg", "identical bytes"); // public, the same bytes
  write(root, "Scans/receipt.jpg", "an unshared receipt"); // public, in the same folder
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath, rules: ["passport"] })).finished, true);
  await buildFolderRollup(dbPath, root, ["passport"]);

  const n = duplicateNeighbours(dbPath, root, ["passport"], "Scans");
  assert.deepEqual(
    n.where,
    [],
    `asking from the private side must point nowhere: ${JSON.stringify(n)}`
  );
  assert.equal(
    JSON.stringify(n).includes("Album"),
    false,
    "and must not name the folder holding the twin"
  );
  assert.equal(n.withheld, 1, "one near file withheld, said rather than hidden");

  // the paired positive, so the assertion above cannot pass vacuously: make the same file public
  // and the same question DOES name Album/2019
  const open = duplicateNeighbours(dbPath, root, [], "Scans");
  assert.equal(open.where.length, 1, JSON.stringify(open));
  assert.equal(open.where[0].path, "Album/2019");
  assert.equal(open.withheld, 0);
});

test("S26: the drive root is refused rather than answered wrongly", async () => {
  // D3. `under` was empty at the root, so the inside/outside test never fired and every folder on
  // the drive was reported as holding outside copies of the root's own content: 25,600 folders in
  // the verifier's fixture, 33 seconds at 500k rows. Wrong, not merely slow. The rollup already
  // answers the root's question, and the panel only stayed off this by an x-show on a figure that
  // is structurally 0 at the root — any loopback caller could ask.
  const root = tmp();
  write(root, "a/x.jpg", "shared");
  write(root, "b/x.jpg", "shared");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);

  const atRoot = duplicateNeighbours(dbPath, root, [], "");
  assert.match(atRoot.refused ?? "", /root has no outside/u, JSON.stringify(atRoot));
  assert.equal(atRoot.where, undefined, "no answer at all, rather than a wrong one");
  // and a folder inside it still answers
  assert.equal(duplicateNeighbours(dbPath, root, [], "a").where[0].path, "b");
});

test("S26: a sibling whose name starts the same is not swallowed", async () => {
  // D2's fix changed `substr(path, 1, ?) = ?` — a full table scan on the hub's synchronous request
  // thread, 5.7 seconds at 500k rows — to a range over the path primary key. A range is only right
  // if its upper bound is: "Album/" to "Album0" must contain Album's children and nothing of
  // Album2's, or the fix would trade 12 seconds for a wrong answer.
  const root = tmp();
  write(root, "Album/in.jpg", "album bytes");
  write(root, "Album2/in.jpg", "album2 bytes");
  write(root, "Elsewhere/album.jpg", "album bytes"); // the twin of Album's file only
  write(root, "Far/album2.jpg", "album2 bytes"); // the twin of Album2's file only
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);

  assert.deepEqual(
    duplicateNeighbours(dbPath, root, [], "Album").where.map((w) => w.path),
    ["Elsewhere"],
    "Album sees its own twin and nothing of Album2's"
  );
  assert.deepEqual(
    duplicateNeighbours(dbPath, root, [], "Album2").where.map((w) => w.path),
    ["Far"],
    "and Album2 sees only its own"
  );
});

// --- D4 and D5: a recorded name is a last resort, and a stale policy is refused ----------------

const metaRoot = (dbPath, root) => {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE folders_meta SET root = ? WHERE id = 1").run(root);
  db.close();
};

const catalogued = async (store, root, rules = []) => {
  fs.mkdirSync(store, { recursive: true });
  const at = libraryPath(store, root);
  assert.equal((await catalogue({ root, dbPath: at, rules })).finished, true);
  await buildFolderRollup(at, root, rules);
  markRollup(at, rollupKeyFor(at, rules), root);
  return at;
};

test("S26: identity wins while the drive is there, so no other disk's figures are served", async () => {
  // D4. catalogueFor fell back to the recorded root NAME whenever no catalogue existed under the
  // drive's identity — INCLUDING when the drive was attached and perfectly identifiable. Point a
  // catalogue's recorded root at a second, never-catalogued, ATTACHED drive and it handed back the
  // first drive's folder names, sizes and duplicate figures with nothing saying so. estate-library
  // .md already claimed "identity still wins when the drive IS there"; it did not.
  const one = tmp();
  write(one, "keep/x.jpg", "drive one bytes");
  const store = path.join(tmp(), "library");
  const dbOne = await catalogued(store, one);

  const two = tmp(); // attached, real, never catalogued
  write(two, "untouched.txt", "drive two");
  metaRoot(dbOne, two); // drive one's catalogue now claims to be drive two's

  const attached = catalogueFor(store, two);
  assert.notEqual(
    attached.db,
    dbOne,
    `an identifiable drive never borrows another's catalogue: ${JSON.stringify(attached)}`
  );
  assert.equal(fs.existsSync(attached.db), false, "so it simply has none");
  assert.equal(attached.byName, undefined);

  // THE PAIRED POSITIVE, and the reason the fallback exists at all: once drive two is gone and
  // cannot be identified, the recorded name is all there is — and the answer says so.
  fs.rmSync(two, { recursive: true, force: true, maxRetries: 5 });
  const absent = catalogueFor(store, two);
  assert.equal(absent.db, dbOne, "a drive that cannot be identified falls back to the name");
  assert.equal(absent.byName, true, "and the answer is marked as resolved by name");
});

test("S26: two catalogues recording one name are refused, not guessed between", async () => {
  // A disk that has been F: twice leaves two catalogues both recording F:, which is the normal case
  // rather than the odd one. Whichever readdir yielded first is not an answer.
  const gone = path.join(tmp(), "detached-drive"); // never created: unidentifiable
  const store = path.join(tmp(), "library");
  fs.mkdirSync(store, { recursive: true });
  for (const name of ["library-aaa.db", "library-bbb.db"]) {
    const src = tmp();
    write(src, "a/x.jpg", `bytes for ${name}`);
    const at = path.join(store, name);
    assert.equal((await catalogue({ root: src, dbPath: at })).finished, true);
    await buildFolderRollup(at, src, []);
    markRollup(at, `a-pass|${policyKey([])}`, gone); // both claim the same absent drive
  }
  const r = catalogueFor(store, gone);
  assert.match(r.ambiguous ?? "", /names 2 catalogues/u, JSON.stringify(r));
  assert.match(r.ambiguous ?? "", /attach it/u, "and says what would resolve it");
  assert.equal(r.db, undefined, "no guess at all");
});

test("S26: a rollup counted under another privacy policy is refused, not served", async () => {
  // D5. detached() took the key from rollupKey(db) and folder() then compared it with itself, so the
  // policy half was never checked: a rollup built under one quarantine policy was served to a hub
  // running another, and the folder holding a quarantined file reported private: 0. Names are still
  // withheld live, so this is counts rather than naming — and design point 6 says COUNTED.
  const drive = tmp();
  write(drive, "mixed/public.txt", "public");
  write(drive, "mixed/my-passport.txt", "private under one policy only");
  const store = path.join(tmp(), "library");
  const at = await catalogued(store, drive, ["passport"]);
  fs.rmSync(drive, { recursive: true, force: true, maxRetries: 5 }); // now unidentifiable

  // same policy: the figures are served, and they are the ones the rollup was built with
  const same = createLibrarian({ dir: store, rules: ["passport"] }).folder(drive, {
    path: "mixed"
  });
  assert.equal(same?.self?.private, 1, `counted under its own policy: ${JSON.stringify(same)}`);
  assert.equal(same?.by_name, true, "and resolved by name, which it says");

  // a different policy: refused rather than reporting private: 0
  const other = createLibrarian({ dir: store, rules: ["tax-return"] }).folder(drive, {
    path: "mixed"
  });
  assert.match(other?.refused ?? "", /different privacy policy/u, JSON.stringify(other));
  assert.equal(other?.self, undefined, "no figures at all, rather than wrong ones");
  assert.ok(at);
});

test("S26: the event loop keeps running while the rollup is built", async () => {
  // D7. I reported this defect myself — 45 minutes on the real F: with the event loop frozen solid,
  // a 250 ms timer that never fired once — and then shipped a gate that stays GREEN when the yield
  // is removed. A fix for a freeze, with nothing watching that it still yields, is a fix that lasts
  // until the next refactor.
  //
  // Synthetic rows rather than real files: the yield is every 20,000 rows, and the point is the
  // event loop, not the disk.
  const drive = tmp();
  write(drive, "seed.txt", "one real file so the catalogue exists");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);

  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO files (path, size, mtime_ms, sha256, kind, first_seen, last_seen, run) " +
      "VALUES (?, ?, 1, ?, 'other', 'x', 'x', 'r')"
  );
  // 60,000 rows across 600 folders, every one a duplicate of another so both figures do real work
  for (let i = 0; i < 60000; i += 1)
    ins.run(`f${i % 600}/sub/file-${i}.bin`, 1024, `sha-${i % 30000}`);
  db.exec("COMMIT");
  db.close();

  let ticks = 0;
  const beat = setInterval(() => {
    ticks += 1;
  }, 25);
  try {
    await buildFolderRollup(dbPath, drive, []);
  } finally {
    clearInterval(beat);
  }
  // the hub answers requests from this same loop: if it never ticks, every surface is frozen
  assert.ok(ticks > 0, `the loop must breathe while the rollup runs: ${ticks} ticks`);
});

test("S26: a folder listing cannot be asked for the whole drive at once", async () => {
  // D7, the other unprotected half: `limit` is capped so one request cannot pull every row of a
  // 1.1-million-file catalogue onto the hub's thread. Nothing tested the cap.
  const drive = tmp();
  for (let i = 0; i < 12; i += 1) write(drive, `top/f${i}/x.txt`, `bytes ${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);
  await buildFolderRollup(dbPath, drive, []);

  const huge = folderView(dbPath, drive, [], "top", { offset: 0, limit: 10 ** 9 });
  assert.ok(
    huge.folders.length <= 12,
    `a limit beyond the folder count returns what exists: ${huge.folders.length}`
  );
  const page = folderView(dbPath, drive, [], "top", { offset: 0, limit: 5 });
  assert.equal(page.folders.length, 5, "and a page is a page");
  assert.equal(
    folderView(dbPath, drive, [], "top", { offset: 10, limit: 5 }).folders.length,
    2,
    "the last page is short rather than wrapping"
  );
});

test("S26: a rule matching a folder covers everything under it", async () => {
  // D9. isQuarantined only ever judged the path it was handed, so a rule anchored on a FOLDER hid
  // that folder's row at its parent and then named every file inside it on direct navigation: the
  // folder was private and its contents were not. S26 is the first surface to claim folder names
  // are part of the judgement, so this is where the claim has to be made true.
  const root = tmp();
  write(root, "Scans/passport.jpg", "a scan");
  write(root, "Scans/deeper/licence.jpg", "another scan");
  write(root, "Open/holiday.jpg", "a holiday");
  const dbPath = path.join(tmp(), "lib.db");
  // a genuine RegExp, anchored: it matches the folder and none of its children. A plain string
  // rule is a substring match, which would have caught the children by accident.
  const rules = [/Scans$/u];
  assert.equal((await catalogue({ root, dbPath, rules })).finished, true);
  await buildFolderRollup(dbPath, root, rules);

  // the folder row is withheld at its parent — that part always worked
  const top = folderView(dbPath, root, rules, "", { offset: 0, limit: 50 });
  assert.equal(
    top.folders.some((f) => f.name === "Scans"),
    false,
    `the private folder is not named: ${JSON.stringify(top.folders)}`
  );
  assert.ok(top.withheld >= 1, "and it is counted rather than vanishing");

  // and now navigating straight into it names nothing either
  const inside = folderView(dbPath, root, rules, "Scans", { offset: 0, limit: 50 });
  const named = JSON.stringify(inside ?? {});
  assert.equal(named.includes("passport"), false, `no file inside it is named: ${named}`);
  assert.equal(named.includes("licence"), false, "including below a subfolder");
  assert.equal(named.includes("deeper"), false, "and not the subfolder either");

  // the paired positive: the public folder is listed and its file named, so the checks above are
  // not passing because folderView simply names nothing
  const open = folderView(dbPath, root, rules, "Open", { offset: 0, limit: 50 });
  assert.ok(
    JSON.stringify(open.files).includes("holiday"),
    `the public file is still named: ${JSON.stringify(open.files)}`
  );
});

// --- round 3: the nine mutations that survived round 2 -----------------------------------------
// Every one of them sat on a fix this contract had just made, and six were on the round-2 fixes
// themselves. The pattern across all nine is the same: assertions that pin SHAPE where the thing
// that matters is a VALUE, and fixtures where several wrong implementations give the same answer.

const planFor = (dbPath, sql, args) => {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args)
      .map((r) => r.detail)
      .join(" | ");
  } finally {
    db.close();
  }
};

test("S26: no surface here may SCAN the files table", async () => {
  // THE MUTATION THAT MATTERED MOST: reverting the whole index-range fix to `substr(path, 1, ?) = ?`
  // left every test green. A timing assertion would be flaky on a loaded machine; the query PLAN is
  // deterministic, and "SCAN files" is exactly the thing this epic has now got wrong three times.
  const drive = tmp();
  for (let i = 0; i < 20; i += 1) write(drive, `keep/sub/f${i}.txt`, `bytes ${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);
  await buildFolderRollup(dbPath, drive, []);

  // SQL.* is the string the CODE runs. Round 3 planned a literal written in this test body, which
  // is a tautology: reverting both routes to substr() left it green, and a verifier proved it.
  const neighbours = planFor(dbPath, SQL.neighbourMine, ["keep", "keep/", "keep0"]);
  assert.equal(
    /SCAN files/u.test(neighbours),
    false,
    `the neighbours lookup must use the path index: ${neighbours}`
  );
  assert.match(neighbours, /SEARCH files/u);

  const children = planFor(dbPath, SQL.childFiles(SQL.range("keep")), [
    ...SQL.bounds("keep"),
    6,
    200,
    0
  ]);
  assert.equal(
    /SCAN files/u.test(children),
    false,
    `the folder route's children must use the path index too: ${children}`
  );

  // THE DRIVE ROOT, which the Scenario covers and round 3 never planned: there is no prefix to
  // range on, so without the partial index its file query scans every row on the drive — 226 ms at
  // 500k, about half a second at F: — and the root is the folder the panel opens first.
  // The root is the one folder with no prefix to range on, so the property is not "no SCAN" — a
  // partial index holding ONLY the root's own files is traversed whole, and SQLite calls that a
  // scan too. The property is that it reads the root's rows and not the drive's, which means the
  // plan must name files_root. Asserting the absence of a word would have passed on the plan that
  // walks every row in files_size to satisfy ORDER BY.
  // and the code must CHOOSE it: planning the bounded string proves the string is bounded, not
  // that folderView ever reaches it — the same gap, found twice by a verifier and once by my own
  // mutation of this very test.
  const db = new DatabaseSync(dbPath);
  assert.equal(SQL.hasRootIndex(db), true, "a catalogue written now carries the root index");
  db.close();
  assert.equal(SQL.childFilesFor("", true), "rootFiles", "the root takes the bounded spelling");
  assert.equal(SQL.childFilesFor("keep", true), "childFiles", "a named folder takes the range");
  assert.equal(SQL.childFilesFor("", false), "childFiles", "and an old catalogue falls back");

  const atRoot = planFor(dbPath, SQL.rootFiles, [200, 0]);
  assert.match(atRoot, /files_root/u, `the root must read its own index: ${atRoot}`);
  assert.equal(
    /files_size/u.test(atRoot),
    false,
    `and not walk every row on the drive to sort: ${atRoot}`
  );

  // the paired negative: without that index the same question walks files_size, which is the
  // 226 ms at 500k rows this replaced
  const unbounded = planFor(dbPath, SQL.childFiles(SQL.range("")), [1, 200, 0]);
  assert.match(
    unbounded,
    /files_size/u,
    `the spelling this replaced really does walk every row: ${unbounded}`
  );

  // the paired negative: the pattern this replaced really does scan, so the check is not vacuous
  const scanned = planFor(dbPath, "SELECT path, sha256 FROM files WHERE substr(path, 1, ?) = ?", [
    5,
    "keep/"
  ]);
  assert.match(scanned, /SCAN files/u, `substr() scans, which is why it is gone: ${scanned}`);
});

test("S26: a folder too big to compare without blocking is refused, not attempted", async () => {
  // 93.5 SECONDS. Round 2 indexed the lookup and left the work on the hub's synchronous thread,
  // where the near-side guard made it one row per file and the ancestor judgement made each one
  // dearer: a 250,000-file folder — the shape the panel offers first — took sixteen times longer
  // than the 5.7-second scan it replaced. The rollup already stores every folder's subtree file
  // count, so the size of the work is one indexed lookup away.
  const drive = tmp();
  write(drive, "small/a.txt", "shared bytes");
  write(drive, "elsewhere/b.txt", "shared bytes");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);
  await buildFolderRollup(dbPath, drive, []);

  // under the cap: answered
  assert.equal(duplicateNeighbours(dbPath, drive, [], "small").where[0].path, "elsewhere");

  // over it: refused, by VALUE — the sentence names the count and the cap, because "too big" with
  // no figure is not something an owner can act on
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE folders SET files = ? WHERE path = ?").run(NEIGHBOURS_CAP_FILES + 1, "small");
  db.close();
  const over = duplicateNeighbours(dbPath, drive, [], "small");
  assert.match(
    over.refused ?? "",
    new RegExp(`${NEIGHBOURS_CAP_FILES + 1} files`, "u"),
    JSON.stringify(over)
  );
  assert.match(over.refused ?? "", new RegExp(`${NEIGHBOURS_CAP_FILES}`, "u"));
  assert.equal(over.where, undefined, "refused outright, not truncated");
  assert.ok(NEIGHBOURS_CAP_FILES > 0 && NEIGHBOURS_CAP_FILES <= 5000, "a cap, not a formality");
});

test("S26: one page is one page, however much a caller asks for", async () => {
  // A verifier lifted the route's cap from 1,000 to a billion and every test stayed green, then
  // asked folderView for 5,001 rows and got 5,001. The cap now lives with the query.
  const drive = tmp();
  for (let i = 0; i < 12; i += 1) write(drive, `top/f${i}/x.txt`, `bytes ${i}`);
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);
  await buildFolderRollup(dbPath, drive, []);

  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO folders (path, files, bytes, private, dup_out_files, dup_out_bytes, " +
      "dup_in_files, dup_in_bytes) VALUES (?, 1, 1, 0, 0, 0, 0, 0)"
  );
  for (let i = 0; i < 2000; i += 1) ins.run(`top/g${i}`);
  db.exec("COMMIT");
  db.close();

  // by VALUE: exactly the cap, not "at most the number that happened to exist"
  assert.equal(
    folderView(dbPath, drive, [], "top", { offset: 0, limit: 10 ** 9 }).folders.length,
    FOLDER_PAGE_MAX,
    "a caller asking for the drive gets a page of it"
  );
  assert.equal(folderView(dbPath, drive, [], "top", { offset: 0, limit: 5 }).folders.length, 5);
  assert.ok(FOLDER_PAGE_MAX >= 100 && FOLDER_PAGE_MAX <= 5000, "a cap, not a formality");
});

test("S26: the rollup breathes often enough to keep a hub answering", async () => {
  // `assert.ok(ticks > 0)` pinned the EXISTENCE of a yield, not its rate: yielding every 50,000
  // rows gives one breath in 60,000 and passes, which at F:'s 1.1 million rows is a hub frozen
  // between breaths. The rate is what the owner feels, so the rate is what is asserted.
  const drive = tmp();
  write(drive, "seed.txt", "one real file");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);

  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO files (path, size, mtime_ms, sha256, kind, first_seen, last_seen, run) " +
      "VALUES (?, ?, 1, ?, 'other', 'x', 'x', 'r')"
  );
  for (let i = 0; i < 60000; i += 1)
    ins.run(`f${i % 600}/sub/file-${i}.bin`, 1024, `sha-${i % 30000}`);
  db.exec("COMMIT");
  db.close();

  let ticks = 0;
  const beat = setInterval(() => {
    ticks += 1;
  }, 25);
  try {
    await buildFolderRollup(dbPath, drive, []);
  } finally {
    clearInterval(beat);
  }
  // two passes over 60,000 rows yielding every 20,000 is six breaths at least; one is a frozen hub
  // that happens to exhale once
  assert.ok(ticks >= 4, `the loop must breathe REPEATEDLY, not once: ${ticks} ticks`);
});

test("S26: the range bound is exact at the character that distinguishes it", async () => {
  // Album and Album2 do not distinguish `folder+"0"` from `folder+"1"` or `folder+"2"` — the one
  // sibling that does is Album0, and the fixture omitted it. Several wrong bounds gave the same
  // answer, which is the whole vacuous-fixture pattern.
  const root = tmp();
  write(root, "Album/in.jpg", "album bytes");
  write(root, "Album0/in.jpg", "album0 bytes");
  write(root, "Album1/in.jpg", "album1 bytes");
  write(root, "Album2/in.jpg", "album2 bytes");
  write(root, "Far/album.jpg", "album bytes");
  write(root, "Far0/album0.jpg", "album0 bytes");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath })).finished, true);
  await buildFolderRollup(dbPath, root, []);

  for (const [folder, expect] of [
    ["Album", ["Far"]],
    ["Album0", ["Far0"]]
  ])
    assert.deepEqual(
      duplicateNeighbours(dbPath, root, [], folder).where.map((w) => w.path),
      expect,
      `${folder} sees only its own twin`
    );
  // and none of the same-prefix siblings leaks into the other's answer
  assert.deepEqual(duplicateNeighbours(dbPath, root, [], "Album1").where, []);

  // THE SAME BOUND THROUGH THE OTHER ROUTE. Both read SQL.bounds now, but this fixture only ever
  // exercised the neighbours side, so the shared spelling was still half-covered: a verifier
  // changed it to `${at}1` and folderView("Album") listed a root-level FILE named Album0 among
  // Album's own contents, with the gate green.
  const view = folderView(dbPath, root, [], "Album", { offset: 0, limit: 50 });
  assert.deepEqual(
    view.files.map((f) => f.name),
    ["in.jpg"],
    `Album holds its own file and no sibling's: ${JSON.stringify(view.files)}`
  );
  assert.deepEqual(view.folders, [], "and no sibling folder as a child");
});

test("S26: a folder rule covers every depth beneath it, not just one", async () => {
  // The D9 test asked folderView(Scans) and nothing deeper, so judging only the IMMEDIATE parent
  // passed. The shipped code was right at every depth; the test could not see it.
  const root = tmp();
  write(root, "Scans/one.jpg", "a");
  write(root, "Scans/deeper/two.jpg", "b");
  write(root, "Scans/deeper/deepest/three.jpg", "c");
  write(root, "Open/four.jpg", "d");
  const dbPath = path.join(tmp(), "lib.db");
  const rules = [/[\\/]Scans$/u];
  assert.equal((await catalogue({ root, dbPath, rules })).finished, true);
  await buildFolderRollup(dbPath, root, rules);

  for (const at of ["Scans", "Scans/deeper", "Scans/deeper/deepest"]) {
    const v = folderView(dbPath, root, rules, at, { offset: 0, limit: 50 });
    const body = JSON.stringify(v ?? {});
    for (const name of ["one.jpg", "two.jpg", "three.jpg"])
      assert.equal(body.includes(name), false, `${at} must name no file: ${body}`);
    assert.deepEqual(v.files, [], `and list none: ${body}`);
    assert.deepEqual(v.folders, [], "nor any child folder the caller did not already name");
    assert.ok(v.withheld >= 1, "counted instead");
  }
  // the paired positive at the same depth, so this is not folderView naming nothing anywhere
  assert.ok(
    JSON.stringify(
      folderView(dbPath, root, rules, "Open", { offset: 0, limit: 50 }).files
    ).includes("four.jpg")
  );
});

test("S26: a rollup built before a later pass is refused, not dated as current", async () => {
  // NEW-4. Round 2 excused the pass half as impossible to re-derive for an absent drive. passOf()
  // reads the pass from the CATALOGUE — the same witness the policy half was fixed against — so a
  // rollup from an earlier pass was served stale while wearing the NEW pass's finishedAt date.
  const drive = tmp();
  write(drive, "keep/one.txt", "first");
  const store = path.join(tmp(), "library");
  const at = await catalogued(store, drive, []);
  const absent = path.join(tmp(), "not-here");
  metaRoot(at, absent);

  const current = createLibrarian({ dir: store, rules: [] }).folder(absent, { path: "keep" });
  assert.equal(current?.self?.files, 1, `a current rollup answers: ${JSON.stringify(current)}`);

  // a later FINISHED pass and a file the rollup never saw
  const db = new DatabaseSync(at);
  db.prepare(
    "INSERT INTO passes (id, started_at, finished_at) VALUES ('later', '2099-01-01T00:00:00Z', " +
      "'2099-01-01T01:00:00Z')"
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO files (path, size, mtime_ms, sha256, kind, first_seen, last_seen, run) " +
      "VALUES ('keep/two.txt', 5, 1, 'sha-two', 'other', 'x', 'x', 'later')"
  ).run();
  db.close();

  const stale = createLibrarian({ dir: store, rules: [] }).folder(absent, { path: "keep" });
  assert.match(
    stale?.refused ?? "",
    /earlier pass or a different privacy policy/u,
    JSON.stringify(stale)
  );
  assert.equal(stale?.self, undefined, "no figures at all, rather than stale ones dated current");
  assert.equal(
    JSON.stringify(stale ?? {}).includes("2099"),
    false,
    "and never the new pass's date on the old pass's figures"
  );
});

test("S26: the order two sibling folders are judged in cannot change the verdict", async () => {
  // The memo introduced in round 3 had NO test that could tell a correct cache from a leak: a
  // verifier made dirPrivate return the first cached verdict for ANY directory and all 83 tests
  // stayed green. Public folder judged first and every quarantined file reads public, so it is
  // NAMED in every listing — D1 and D9 reopened at once. No fixture had two sibling directories
  // with DIFFERENT verdicts where the order of judgement decides the answer. This is that fixture.
  const root = tmp();
  write(root, "Open/holiday.jpg", "public bytes");
  write(root, "Scans/passport.jpg", "private bytes");
  const rules = [/[\\/]Scans$/u];

  for (const order of [
    ["Open/holiday.jpg", "Scans/passport.jpg"],
    ["Scans/passport.jpg", "Open/holiday.jpg"]
  ]) {
    const isPrivate = privateTo(rules);
    const seen = order.map((rel) => [rel, isPrivate(path.join(root, rel))]);
    assert.deepEqual(
      Object.fromEntries(seen),
      { "Open/holiday.jpg": false, "Scans/passport.jpg": true },
      `judged ${order[0]} first: ${JSON.stringify(seen)}`
    );
  }

  // and through the surfaces, both ways round
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root, dbPath, rules })).finished, true);
  await buildFolderRollup(dbPath, root, rules);
  const top = folderView(dbPath, root, rules, "", { offset: 0, limit: 50 });
  assert.deepEqual(
    top.folders.map((f) => f.name),
    ["Open"],
    `the public sibling is named and the private one is not: ${JSON.stringify(top.folders)}`
  );
  assert.equal(top.withheld, 1);
});

test("S26: the privacy memo caches directories, not files", async () => {
  // The whole point of round 3's privateTo, and a property no assertion about ANSWERS can hold: a
  // verifier handed the memo each FILE path instead of its directory, got identical verdicts on
  // 20,000 paths, grew the cache 442 to 20,442 entries, ran 2.0x slower — and stayed green.
  const isPrivate = privateTo([/[\\/]Secret$/u]);
  for (let i = 0; i < 5000; i += 1) isPrivate(`C:\\drive\\Photos\\2019\\f${i}.jpg`);
  assert.ok(
    isPrivate.dirs.size <= 8,
    `5,000 files in one tree must cache a handful of directories, not thousands: ${isPrivate.dirs.size}`
  );
  // the paired positive: it really is caching, and really does answer
  assert.ok(isPrivate.dirs.size >= 1);
  assert.equal(isPrivate("C:\\drive\\Secret\\x.jpg"), true);
  assert.equal(isPrivate("C:\\drive\\Photos\\2019\\f1.jpg"), false);
});

test("S26: no rollup yet means no comparison, never a thrown route", async () => {
  // Round 3 put the cap's lookup ABOVE the try: with no folders table — the window between a
  // catalogue finishing and the worker writing the rollup — it threw `no such table`, leaked the
  // database handle and escaped the route, which is S22's D5 and D10 in the guard added to fix a
  // finding. And `held !== null` meant a MISSING row skipped the refusal, so a 30,000-file folder
  // did the full 2,990 ms of work: a cap enforced against a figure nobody checked is not a cap.
  const drive = tmp();
  write(drive, "keep/a.txt", "shared");
  write(drive, "other/b.txt", "shared");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);

  // no rollup at all: the table does not exist
  const none = duplicateNeighbours(dbPath, drive, [], "keep");
  assert.equal(none.computing, true, `answered, not thrown: ${JSON.stringify(none)}`);
  assert.match(none.why ?? "", /no folder rollup yet/u);
  assert.equal(none.where, undefined, "and no comparison was done");

  await buildFolderRollup(dbPath, drive, []);
  assert.equal(duplicateNeighbours(dbPath, drive, [], "keep").where[0].path, "other");

  // a rollup that exists but has no row for this folder is the same answer, not a bypass
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM folders WHERE path = ?").run("keep");
  db.close();
  const gone = duplicateNeighbours(dbPath, drive, [], "keep");
  assert.equal(gone.computing, true, `a missing row is not a licence: ${JSON.stringify(gone)}`);
  assert.equal(gone.where, undefined);
});

test("S26: the neighbours route checks the rollup is current, as the folder route does", async () => {
  // The cap is read from the rollup, and round 3 enforced it against a figure the route had never
  // verified: a rollup for an older pass can say a 250,000-file folder holds ten. The lie used to
  // test the guard was the way past the guard.
  const drive = tmp();
  write(drive, "keep/a.txt", "shared");
  write(drive, "other/b.txt", "shared");
  const store = path.join(tmp(), "library");
  const at = await catalogued(store, drive, []);
  const absent = path.join(tmp(), "not-here");
  metaRoot(at, absent);

  const lib = createLibrarian({ dir: store, rules: [] });
  assert.equal(
    lib.neighbours(absent, { path: "keep" })?.where?.[0]?.path,
    "other",
    "current answers"
  );

  const db = new DatabaseSync(at);
  db.prepare(
    "INSERT INTO passes (id, started_at, finished_at) VALUES ('later', '2099-01-01T00:00:00Z', " +
      "'2099-01-01T01:00:00Z')"
  ).run();
  db.close();
  const stale = createLibrarian({ dir: store, rules: [] }).neighbours(absent, { path: "keep" });
  assert.match(
    stale?.refused ?? "",
    /earlier pass or a different privacy policy/u,
    JSON.stringify(stale)
  );
  assert.equal(stale?.where, undefined, "no comparison against a figure nobody checked");
});

test("S26: a catalogue written before this contract still answers at the root", async () => {
  // THE BRANCH THE OWNER'S OWN DRIVE USES. F: was catalogued by S21 and has no files_root until its
  // next pass, so the fallback is the live path — and it was the one thing here with no guard:
  // every test built a fresh catalogue, asserted hasRootIndex true, and tested the choice function
  // by handing it a literal false. INDEXED BY on a missing index is an error, not a hint.
  const drive = tmp();
  for (let i = 0; i < 4; i += 1) write(drive, `top${i}.txt`, `root file ${i}`);
  write(drive, "sub/deeper.txt", "not a root file");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);
  await buildFolderRollup(dbPath, drive, []);

  const fresh = folderView(dbPath, drive, [], "", { offset: 0, limit: 50 });
  assert.deepEqual(fresh.files.map((f) => f.name).sort(), [
    "top0.txt",
    "top1.txt",
    "top2.txt",
    "top3.txt"
  ]);

  // now take the index away, as an S21-era catalogue has it
  const db = new DatabaseSync(dbPath);
  db.exec("DROP INDEX files_root");
  assert.equal(SQL.hasRootIndex(db), false, "and the code can tell");
  // the bounded spelling genuinely cannot run against it — this is why the choice exists
  assert.throws(() => db.prepare(SQL.rootFiles), /files_root/u);
  db.close();

  const old = folderView(dbPath, drive, [], "", { offset: 0, limit: 50 });
  assert.deepEqual(
    old.files.map((f) => f.name).sort(),
    ["top0.txt", "top1.txt", "top2.txt", "top3.txt"],
    `the fallback answers the same: ${JSON.stringify(old.files)}`
  );
  assert.deepEqual(
    old.folders.map((f) => f.name),
    ["sub"],
    "and its children too"
  );
});

test("S26: the sentence the hub composed is the sentence the caller reads", async () => {
  // The 202 said "the duplicates are still being worked out" whatever was missing — substantively
  // wrong for a folder route waiting on the folder ROLLUP — and the `why` composed beside it
  // reached nobody but the test that asserted it existed.
  const drive = tmp();
  write(drive, "keep/a.txt", "shared");
  write(drive, "other/b.txt", "shared");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);

  const r = duplicateNeighbours(dbPath, drive, [], "keep");
  assert.equal(r.computing, true);
  assert.match(r.why ?? "", /folder rollup/u, `it says what is missing: ${JSON.stringify(r)}`);
  assert.equal(
    /duplicates/u.test(r.why ?? ""),
    false,
    "and does not blame the duplicates list, which is not what it is waiting for"
  );
});

test("S26: a caller waiting on the rollup reads the hub's own sentence, not a hardcoded one", async () => {
  // THROUGH THE ROUTE, because that is the only place the passthrough exists: my first attempt
  // asserted the composed `why` on the function's return value, which a verifier had already shown
  // reaches nobody — mutating the shaper back to its hardcoded string left that test green. The
  // same read-a-copy mistake, inside the fix for it.
  //
  // And deterministic rather than racy: wait until the rollup IS current, then take it away. A test
  // that only reaches the 202 when the worker happens to lose is a test that proves nothing on a
  // fast machine.
  const root = tmp();
  write(root, "keep/a.txt", "shared");
  write(root, "other/b.txt", "shared");
  const store = tmp();
  const h = await hub({ roots: [root], estateStore: store, quarantine: [] });
  try {
    const enc = encodeURIComponent(root);
    assert.equal((await h.call("/library", { root })).status, 202);
    for (let i = 0; i < 300; i += 1) {
      if (!JSON.parse((await h.call("/library")).text).running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // patient on purpose: this waits on a worker thread, and the gate runs it alongside six other
    // suites. Once the rollup IS current the rest is deterministic — dropping the table cannot be
    // undone by anything, because the key in folders_meta already matches.
    let ready = false;
    for (let i = 0; i < 1200 && !ready; i += 1) {
      ready = (await h.call(`/library/folder?root=${enc}&path=keep`)).status === 200;
      if (!ready) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, "the rollup must land before this test can take it away; it never did");

    const dbPath = libraryPath(path.join(store, "library"), root);
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE folders");
    db.close();

    const r = await h.call(`/library/neighbours?root=${enc}&path=keep`);
    assert.equal(r.status, 202, `no rollup means 202, never a thrown route: ${r.text}`);
    const said = JSON.parse(r.text).error ?? "";
    assert.match(said, /folder rollup/u, `the hub's own sentence reaches the caller: ${said}`);
    assert.equal(
      /duplicates/u.test(said),
      false,
      "and not the duplicates list, which is not what it is waiting for"
    );
  } finally {
    await h.close();
  }
});

test("S26: neither navigation surface throws, whatever state the rollup is in", async () => {
  // THE CHOKE POINT, not another instance. Round 3 found duplicateNeighbours throwing on a missing
  // rollup; round 4 fixed that one function; a verifier then found folderView reading `folders`
  // unguarded ONE FUNCTION AWAY — the same defect, the same distance from the same lesson. Fixing
  // instances one at a time is how that happens, so this sweeps every state and both surfaces and
  // asserts the only thing that matters: a route answers, it never exits the hub (S22's D7).
  const drive = tmp();
  write(drive, "root-file.txt", "at the root");
  write(drive, "keep/a.txt", "shared");
  write(drive, "keep/deep/b.txt", "deeper");
  write(drive, "other/a.txt", "shared");
  const dbPath = path.join(tmp(), "lib.db");
  assert.equal((await catalogue({ root: drive, dbPath })).finished, true);

  const paths = ["", "keep", "keep/deep", "nope", "keep/nope", "/", ".", "..", "a'b", "k%", "k_"];
  const ruleSets = [[], ["keep"], [/[\\/]keep$/u]];
  const sweep = (state) => {
    for (const at of paths)
      for (const rules of ruleSets) {
        for (const [name, fn] of [
          ["neighbours", () => duplicateNeighbours(dbPath, drive, rules, at, { limit: 8 })],
          ["folder", () => folderView(dbPath, drive, rules, at, { offset: 0, limit: 50 })]
        ]) {
          let r;
          assert.doesNotThrow(
            () => {
              r = fn();
            },
            `${state}: ${name}(${JSON.stringify(at)}) must answer, not throw`
          );
          // and the answer is a shape the route's shaper knows how to turn into a status
          if (r !== null)
            assert.ok(
              r.refused || r.computing || r.missing || "where" in r || "self" in r,
              `${state}: ${name}(${JSON.stringify(at)}) answered something the shaper cannot shape: ${JSON.stringify(r)?.slice(0, 120)}`
            );
        }
      }
  };

  sweep("no rollup at all");
  await buildFolderRollup(dbPath, drive, []);
  sweep("rollup written");

  // an S21-era catalogue, which is what the owner's F: is until its next pass
  let db = new DatabaseSync(dbPath);
  db.exec("DROP INDEX files_root");
  db.close();
  sweep("no files_root");

  // the rows gone while the key remains — a restore of an older file, a manual drop, corruption
  db = new DatabaseSync(dbPath);
  db.exec("DROP TABLE folders");
  db.close();
  sweep("rollup rows removed, key intact");

  // the paired positive: with everything in place the sweep is not passing because nothing works
  await buildFolderRollup(dbPath, drive, []);
  assert.equal(folderView(dbPath, drive, [], "keep", { offset: 0, limit: 50 }).self.files, 2);
  assert.equal(duplicateNeighbours(dbPath, drive, [], "keep").where[0].path, "other");
});

test("S26: a missing rollup is an answer; a real error is still an error", () => {
  // The other half of the fix, and a mutation showed nothing held it: widening the catch to
  // everything left all 87 tests green. A helper that turns every failure into "try again in a
  // minute" hides the next real defect behind a cheerful 202 — which is how the 45-minute freeze
  // and the swallowed worker error both stayed invisible in this epic.
  const dbPath = path.join(tmp(), "bare.db");
  openLibrary(dbPath).close();
  const db = new DatabaseSync(dbPath);
  try {
    // the two it must absorb
    for (const [sql, why] of [
      ["SELECT * FROM folders WHERE path = ?", "no such table"],
      ["SELECT path FROM files INDEXED BY files_nope WHERE path = ?", "no such index"]
    ]) {
      const r = rollupRows(db, sql, ["x"], "F:");
      assert.equal(r.computing, true, `${why} is an answer: ${JSON.stringify(r)}`);
      assert.match(r.why ?? "", /no folder rollup yet/u);
      assert.equal(r.rows, undefined);
    }

    // and the ones it must not: a syntax error, a missing COLUMN, and the wrong argument count are
    // defects in this code, not states of the catalogue
    assert.throws(
      () => rollupRows(db, "SELECT * FROM folders WHERE", ["x"], "F:"),
      /syntax|incomplete/iu
    );
    assert.throws(
      () => rollupRows(db, "SELECT nope FROM files WHERE path = ?", ["x"], "F:"),
      /no such column/iu
    );
    // a table that exists but is not the rollup: the message is neither "no such table" nor
    // "no such index", so it must not be dressed up as "try again in a minute"
    assert.throws(
      () => rollupRows(db, "SELECT * FROM passes WHERE nope = ?", ["x"], "F:"),
      /no such column/iu
    );

    // the paired positive: when the table IS there it returns rows, not a verdict
    const ok = rollupRows(db, "SELECT path FROM files WHERE path = ?", ["x"], "F:");
    assert.deepEqual(ok.rows, []);
    assert.equal(ok.computing, undefined);
  } finally {
    db.close();
  }
});

test("S26: the rollup table is read in exactly one place", () => {
  // ENFORCED AT SOURCE, because the alternative is an argument about control flow: folderView has
  // two reads of `folders`, the first already answers when the table is gone, so the second is
  // unreachable TODAY — and that is a claim about the order of two statements which the next edit
  // can falsify in silence.
  //
  // My first version of this check scanned for inline `FROM folders` text and a mutation walked
  // straight past it, because the queries are `SQL.*` constants and a direct `db.prepare(SQL.
  // childFolders(...))` carries no SQL text at the call site. Scanning for the shape of the query
  // instead of the shape of the CALL is the same read-a-copy mistake one level up, so this names
  // the call spellings: every prepared rollup query must be the one inside rollupRows.
  const src = fs.readFileSync(
    new URL("../server/coordination/lib/library.mjs", import.meta.url),
    "utf8"
  );
  const code = src
    .split(/\r?\n/u)
    .filter((l) => !/^\s*(\/\/|--|\*)/u.test(l))
    .join("\n");

  for (const spelling of [
    ".prepare(SQL.childFolders",
    ".prepare(SQL.folderRow",
    '.prepare("SELECT * FROM folders',
    ".prepare(`SELECT * FROM folders"
  ])
    assert.equal(
      code.includes(spelling),
      false,
      `a rollup query is prepared outside rollupRows: ${spelling}`
    );

  // and the helper is the one that does prepare them, exactly once
  assert.equal((code.match(/const rollupRows = /gu) ?? []).length, 1, "one helper, not a copy");
  assert.equal(
    (code.match(/rollupRows\(/gu) ?? []).length,
    3,
    "and every rollup read goes through it: the self row, the children, and the cap's lookup"
  );

  // the paired negative, so this cannot pass by the strings simply never occurring: the SQL the
  // helper is handed really is the folders SQL
  assert.match(code, /folderRow:\s*"SELECT files FROM folders WHERE path = \?"/u);
  assert.match(code, /childFolders: \(range\) =>/u);
});
