// U6 — what is only outside F:, from the catalogues alone. Every Scenario of U6 maps to a test here.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { catalogue, libraryPathFor } from "../server/coordination/lib/library.mjs";
import { createSoleReporter, soleContent } from "../server/coordination/lib/estate_sole.mjs";
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
  const fDb = path.join(tmp(), "f.db");
  const sDb = path.join(tmp(), "s.db");
  await catalogue({ root: f, dbPath: fDb });
  await catalogue({ root: src, dbPath: sDb, cloudOnly: async () => ({ cloud: new Set([fold(cloud)]), unknown: [] }) });
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
  const { counts } = soleContent({ sourceDb: e.sDb, sourceRoot: e.src, targetDb: e.fDb });
  assert.deepEqual(counts.cannot_tell, { files: 1, bytes: "in the cloud only".length });
  assert.doesNotMatch(JSON.stringify(counts.on_f), /cloud/u);
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
    const csv = await call(`/library/sole.csv?root=${encodeURIComponent(dl)}`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /only-here\.zip/u);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
