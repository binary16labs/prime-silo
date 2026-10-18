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
  libraryPath,
  libraryState
} from "../server/coordination/lib/library.mjs";
import { hashFile } from "../server/coordination/lib/nas_catalog.mjs";
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
