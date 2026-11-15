// U6 — what is only outside F:, from the catalogues alone. Every Scenario of U6 maps to a test here.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { catalogue, libraryPathFor } from "../server/coordination/lib/library.mjs";
import { createSoleReporter, soleContent, sourceId } from "../server/coordination/lib/estate_sole.mjs";
import { DatabaseSync } from "node:sqlite";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import { driveIdentity } from "../server/coordination/lib/estate_compare.mjs";
import { openRegistry, registryPath } from "../server/coordination/lib/drive_registry.mjs";

const made = [];
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "u6-"))) - 1];
const OLD = new Date(Date.now() - 3_600_000);
const write = (root, rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, OLD, OLD);
  return f;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fold = (p) => path.resolve(p).toLowerCase();

// F: holds a beach photo; the source holds the same photo renamed, a new PDF, the same new file
// twice, a private file, an empty file and one file only in the cloud
const estate = async () => {
  const f = tmp();
  write(f, "Photos/beach.jpg", "beach photo bytes");
  const src = tmp();
  write(src, "renamed.jpg", "beach photo bytes");
  write(src, "new.pdf", "a new pdf");
  write(src, "copies/x.bin", "repeated content");
  write(src, "copies/y.bin", "repeated content");
  write(src, "Secret/tax.pdf", "private bytes");
  write(src, "empty.txt", "");
  const cloud = write(src, "Pictures/cloud.jpg", "in the cloud only");
  const emptyCloud = write(src, "Pictures/empty-cloud.jpg", "");
  const fDb = path.join(tmp(), "f.db");
  const sDb = path.join(tmp(), "s.db");
  await catalogue({ root: f, dbPath: fDb });
  await catalogue({ root: src, dbPath: sDb, cloudOnly: async () => ({ cloud: new Set([fold(cloud), fold(emptyCloud)]), unknown: [] }) });
  return { f, src, fDb, sDb };
};

test("U6: content F: holds under another name is on F:; the rest is to copy, its repeats once", async () => {
  const e = await estate();
  const { counts, csv } = soleContent({ sourceDb: e.sDb, sourceRoot: e.src, targetDb: e.fDb, rules: [/secret/iu] });
  assert.deepEqual(counts.on_f, { files: 1, bytes: "beach photo bytes".length }, "renamed.jpg is on F:");
  assert.equal(counts.to_copy.files, 4, "new.pdf, x.bin, y.bin and the private file");
  const rep = "repeated content".length;
  assert.equal(counts.to_copy.repeat_bytes, rep, "y.bin repeats x.bin");
  assert.equal(counts.to_copy.unique_bytes, counts.to_copy.bytes - rep);
  assert.equal(counts.private, 1, "the private file is counted");
  assert.doesNotMatch(csv, /tax\.pdf/u, "and never named");
  assert.match(csv, /new\.pdf/u);
  assert.doesNotMatch(csv, /empty\.txt/u, "empty files are not things to copy");
});

test("U6: cloud-only files are never claimed to be on F: - they are 'cannot tell'", async () => {
  const e = await estate();
  const { counts, csv } = soleContent({ sourceDb: e.sDb, sourceRoot: e.src, targetDb: e.fDb });
  assert.deepEqual(counts.cannot_tell, { files: 1, bytes: "in the cloud only".length }, "the empty cloud file is not counted");
  assert.deepEqual(counts.on_f, { files: 1, bytes: "beach photo bytes".length }, "only renamed.jpg is on F:");
  assert.doesNotMatch(csv, /cloud\.jpg/u, "and a cloud-only file is not on the copy list either");
  assert.deepEqual(counts.kinds.documents, { files: 2, bytes: "a new pdf".length + "private bytes".length }, "kinds are counted");
});

test("U6: the result is worked out off the hub's thread and redone when a catalogue changes", async () => {
  const e = await estate();
  const r = createSoleReporter({ dir: tmp() });
  const ask = () => r.report({ sourceRoot: e.src, sourceDb: e.sDb, targetDb: e.fDb });
  assert.equal(ask().computing, true, "the first ask starts the worker and does not wait for it");
  let a;
  for (let i = 0; i < 300 && (a = ask()).computing; i++) await wait(20);
  assert.equal(a.to_copy.files, 4);
  assert.ok(a.source_at && a.f_at, "both catalogues' dates are on the answer");
  // a new pass on F: makes the saved answer stale
  write(e.f, "Docs/new.pdf", "a new pdf");
  await catalogue({ root: e.f, dbPath: e.fDb });
  assert.equal(ask().computing, true, "stale for F:'s new pass");
  for (let i = 0; i < 300 && (a = ask()).computing; i++) await wait(20);
  assert.equal(a.to_copy.files, 3, "new.pdf is on F: now");
});

test("U6: the hub answers per source in order, a drive that is away included and dated, and serves the list", async () => {
  const f = tmp();
  write(f, "a.jpg", "on f");
  const dl = tmp();
  write(dl, "only-here.zip", "only here bytes");
  const away = tmp();
  write(away, "old/backup.txt", "an old backup");
  const home = tmp();
  const store = tmp();
  const reg = openRegistry(registryPath(home));
  const awayId = driveIdentity(away);
  const at = new Date().toISOString();
  reg.prepare("INSERT INTO drives (identity, root, first_seen, last_seen, attached) VALUES (?, ?, ?, ?, 0)").run(awayId, "G:", at, at);
  reg.close();
  await catalogue({ root: away, dbPath: libraryPathFor(path.join(store, "library"), awayId) });
  const offered = [
    { root: dl, kind: "user", role: "downloads", in_onedrive: false, removable: false, sections: [] },
    { root: f, kind: "drive", role: null, removable: true, sections: [] }
  ];
  const api = createEstateApi({
    quarantine: [],
    producer: { machine: "T480", dbPath: path.join(home, "estate", "estate-map-T480.db"), roots: () => offered.map((e) => e.root), offered: () => offered, estateStore: store, lister: null, cloudOnly: async () => ({ cloud: new Set(), unknown: [] }), target: f }
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
  try {
    for (const root of [f, dl]) {
      await call("/library", { root });
      for (let i = 0; i < 500 && JSON.parse((await call("/library")).text).running; i++) await wait(10);
    }
    let s;
    for (let i = 0; i < 500; i++) {
      s = JSON.parse((await call("/library/sole")).text);
      if (s.sources.length && s.sources.every((x) => !x.computing)) break;
      await wait(20);
    }
    assert.deepEqual(s.sources.map((x) => [x.role, x.attached]), [["downloads", true], [null, false]], JSON.stringify(s));
    assert.equal(s.sources[0].to_copy.files, 1);
    assert.equal(s.sources[1].root, "G:");
    assert.ok(s.sources[1].source_at, "the away drive's catalogue answers, with its date");
    assert.equal(s.sources[1].to_copy.files, 1);
    const csv = await call(`/library/sole.csv?source=${encodeURIComponent(s.sources[0].id)}`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /only-here\.zip/u);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- claude-u6-verifier's round-1 FAIL ----------------------------------------------------------------

const settled = async (ask) => {
  let a;
  for (let i = 0; i < 300 && (a = ask()).computing; i++) await wait(20);
  return a;
};

test("U6 round 2: a catalogue whose last pass did not finish is never answered from", async () => {
  const e = await estate();
  const r = createSoleReporter({ dir: tmp() });
  const ask = () => r.report({ sourceRoot: e.src, sourceDb: e.sDb, targetDb: e.fDb });
  assert.equal((await settled(ask)).to_copy.files, 4);
  // a stopped pass leaves an unfinished row: the cached answer is no longer current
  const db = new DatabaseSync(e.sDb);
  db.prepare("INSERT INTO passes (id, started_at, stopped_at) VALUES ('stopped', ?, ?)").run(
    new Date(Date.now() + 1000).toISOString(),
    new Date().toISOString()
  );
  db.close();
  const a = ask();
  assert.match(a.why ?? "", /did not finish/u, JSON.stringify(a));
  assert.equal(a.to_copy, undefined, "no counts from a half-catalogued source");
});

test("U6 round 2: new privacy rules make the saved answer stale", async () => {
  const e = await estate();
  const dir = tmp();
  const plain = createSoleReporter({ dir });
  const before = await settled(() => plain.report({ sourceRoot: e.src, sourceDb: e.sDb, targetDb: e.fDb }));
  assert.equal(before.private, 0);
  const strict = createSoleReporter({ dir, rules: [/new\.pdf/iu] });
  const ask = () => strict.report({ sourceRoot: e.src, sourceDb: e.sDb, targetDb: e.fDb });
  assert.equal(ask().computing, true, "the answer saved under other rules is not served");
  assert.equal((await settled(ask)).private, 1);
});

test("U6 round 2: privacy is judged on the full path, the source's own folder included", async () => {
  const e = await estate();
  const name = path.basename(e.src);
  const { counts, csv } = soleContent({
    sourceDb: e.sDb,
    sourceRoot: e.src,
    targetDb: e.fDb,
    rules: [new RegExp(name, "iu")]
  });
  assert.equal(counts.private, counts.to_copy.files, "every file under a private folder is private");
  assert.equal(csv.trim().split(/\r?\n/u).length, 1, "and the list holds only its header");
});

test("U6 round 2: a failure rests for its key, then is tried again", async () => {
  const e = await estate();
  const blocker = path.join(tmp(), "not-a-folder");
  fs.writeFileSync(blocker, "a file where the results folder should be");
  const r = createSoleReporter({ dir: blocker, retryMs: 200 });
  const ask = () => r.report({ sourceRoot: e.src, sourceDb: e.sDb, targetDb: e.fDb });
  ask();
  let a;
  for (let i = 0; i < 300 && !(a = ask()).why; i++) await wait(20);
  assert.match(a.why ?? "", /could not be worked out/u);
  fs.rmSync(blocker);
  await wait(250);
  assert.equal((await settled(ask)).to_copy.files, 4, "retried after the rest, and answered");
});

test("U6 round 2: two drives that share a root are two sources with their own lists; no policy is 412", async () => {
  const f = tmp();
  write(f, "a.jpg", "on f");
  const here = tmp();
  write(here, "here-only.zip", "here bytes");
  const away = tmp();
  write(away, "away-only.txt", "away bytes");
  const home = tmp();
  const store = tmp();
  const reg = openRegistry(registryPath(home));
  const awayId = driveIdentity(away);
  const at = new Date().toISOString();
  // the away drive was last seen at the very root the attached one is offered at
  reg
    .prepare("INSERT INTO drives (identity, root, first_seen, last_seen, attached) VALUES (?, ?, ?, ?, 0)")
    .run(awayId, here, at, at);
  reg.close();
  await catalogue({ root: away, dbPath: libraryPathFor(path.join(store, "library"), awayId) });
  const offered = [
    { root: here, kind: "drive", role: null, removable: true, sections: [] },
    { root: f, kind: "drive", role: null, removable: true, sections: [] }
  ];
  const make = (quarantine) =>
    createEstateApi({
      quarantine,
      producer: {
        machine: "T480",
        dbPath: path.join(home, "estate", "estate-map-T480.db"),
        roots: () => offered.map((e) => e.root),
        offered: () => offered,
        estateStore: store,
        lister: null,
        cloudOnly: async () => ({ cloud: new Set(), unknown: [] }),
        target: f
      }
    });
  const serve = async (api) => {
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
  };
  const none = await serve(make(null));
  try {
    assert.equal((await none.call("/library/sole")).status, 412);
    assert.equal((await none.call("/library/sole.csv?source=x")).status, 412);
  } finally {
    await none.close();
  }
  const h = await serve(make([]));
  try {
    for (const root of [f, here]) {
      await h.call("/library", { root });
      for (let i = 0; i < 500 && JSON.parse((await h.call("/library")).text).running; i++) await wait(10);
    }
    let s;
    for (let i = 0; i < 500; i++) {
      s = JSON.parse((await h.call("/library/sole")).text);
      if (s.sources.length === 2 && s.sources.every((x) => !x.computing)) break;
      await wait(20);
    }
    assert.equal(s.sources.length, 2, JSON.stringify(s));
    assert.notEqual(s.sources[0].id, s.sources[1].id, "two catalogues, two ids, though they share a root");
    const byId = async (x) => (await h.call(`/library/sole.csv?source=${encodeURIComponent(x.id)}`)).text;
    const hereList = await byId(s.sources.find((x) => x.attached));
    const awayList = await byId(s.sources.find((x) => !x.attached));
    assert.match(hereList, /here-only\.zip/u);
    assert.doesNotMatch(hereList, /away-only/u);
    assert.match(awayList, /away-only\.txt/u, "the away drive's link serves the away drive's list");
    assert.equal(
      sourceId(libraryPathFor(path.join(store, "library"), awayId)),
      s.sources.find((x) => !x.attached).id
    );
  } finally {
    await h.close();
  }
});

test("U6 round 2: a failure belongs to its key - a new pass is worked out at once, rest or not", async () => {
  const e = await estate();
  const blocker = path.join(tmp(), "not-a-folder");
  fs.writeFileSync(blocker, "a file where the results folder should be");
  const r = createSoleReporter({ dir: blocker, retryMs: 600_000 });
  const ask = () => r.report({ sourceRoot: e.src, sourceDb: e.sDb, targetDb: e.fDb });
  ask();
  let a;
  for (let i = 0; i < 300 && !(a = ask()).why; i++) await wait(20);
  assert.match(a.why ?? "", /could not be worked out/u);
  fs.rmSync(blocker);
  write(e.src, "later.txt", "a later file");
  await catalogue({ root: e.src, dbPath: e.sDb });
  assert.equal(ask().computing, true, "a new pass is a new key: no ten-minute rest for it");
});

test("U6 round 2: a stale registry row never lists an attached drive a second time as away", async () => {
  const f = tmp();
  write(f, "a.jpg", "on f");
  const here = tmp();
  write(here, "here-only.zip", "here bytes");
  const home = tmp();
  const store = tmp();
  const offered = [
    { root: here, kind: "drive", role: null, removable: true, sections: [] },
    { root: f, kind: "drive", role: null, removable: true, sections: [] }
  ];
  const reg = openRegistry(registryPath(home));
  const at = new Date().toISOString();
  // the registry has not caught up: it still says this attached drive is away
  reg
    .prepare("INSERT INTO drives (identity, root, first_seen, last_seen, attached) VALUES (?, ?, ?, ?, 0)")
    .run(driveIdentity(here), here, at, at);
  reg.close();
  const api = createEstateApi({
    quarantine: [],
    producer: {
      machine: "T480",
      dbPath: path.join(home, "estate", "estate-map-T480.db"),
      roots: () => offered.map((e) => e.root),
      offered: () => offered,
      estateStore: store,
      lister: null,
      cloudOnly: async () => ({ cloud: new Set(), unknown: [] }),
      target: f
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
  try {
    for (const root of [f, here]) {
      await call("/library", { root });
      for (let i = 0; i < 500 && JSON.parse((await call("/library")).text).running; i++) await wait(10);
    }
    const s = JSON.parse((await call("/library/sole")).text);
    assert.equal(s.sources.length, 1, JSON.stringify(s.sources.map((x) => [x.root, x.attached])));
    assert.equal(s.sources[0].attached, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
