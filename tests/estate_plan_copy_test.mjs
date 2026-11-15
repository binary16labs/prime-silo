// U7 — the copy plan. Every Scenario of U7 maps to a test here; the panel's half is in
// estate_map_panel_test.mjs. Temp catalogues only: nothing here copies a byte.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { catalogue } from "../server/coordination/lib/library.mjs";
import { DEFAULT_POLICY, createCopyPlanner, planCopy, validatePolicy } from "../server/coordination/lib/estate_plan_copy.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { isAuthorised } from "../server/coordination/lib/governance.mjs";

const made = [];
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "u7-"))) - 1];
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

// F: holds a beach photo and, at the very path a source file would land, DIFFERENT content
const estate = async () => {
  const f = tmp();
  write(f, "Photos/beach.jpg", "beach photo bytes");
  write(f, "consolidated/Downloads/notes.txt", "something else entirely");
  const src = tmp();
  write(src, "renamed.jpg", "beach photo bytes"); // on F: already
  write(src, "notes.txt", "my notes"); // collides by name with different content
  write(src, "a/x.bin", "repeated content");
  write(src, "b/y.bin", "repeated content"); // a repeat of x.bin
  write(src, "proj/node_modules/lib.js", "a dependency"); // excluded
  write(src, "proj/.git/HEAD", "ref: refs/heads/main"); // kept: .git is not excluded
  const cloud = write(src, "Pictures/cloud.jpg", "in the cloud only");
  const fDb = path.join(tmp(), "f.db");
  const sDb = path.join(tmp(), "s.db");
  await catalogue({ root: f, dbPath: fDb });
  await catalogue({ root: src, dbPath: sDb, cloudOnly: async () => ({ cloud: new Set([fold(cloud)]), unknown: [] }) });
  return { f, src, fDb, sDb };
};

test("U7: what F: already holds is never proposed; repeats once; exclusions and cloud-only said; names never overwritten", async () => {
  const e = await estate();
  const p = planCopy({ sourceDb: e.sDb, sourceRoot: e.src, sourceName: "Downloads", targetDb: e.fDb, policy: DEFAULT_POLICY });
  const items = p.items.map((l) => JSON.parse(l));
  const copies = items.filter((i) => i.to);
  assert.ok(!copies.some((i) => i.from === "renamed.jpg"), "F:'s photo is not proposed under another name");
  assert.equal(p.counts.on_f, 1);
  assert.deepEqual(p.counts.repeats, { files: 1, bytes: "repeated content".length }, "y.bin repeats x.bin");
  assert.equal(items.find((i) => i.from === "b/y.bin").same_as, "consolidated/Downloads/a/x.bin");
  assert.deepEqual(p.counts.excluded, { node_modules: { files: 1, bytes: "a dependency".length } });
  assert.ok(copies.some((i) => i.from === "proj/.git/HEAD"), ".git is kept (the owner's answer)");
  assert.deepEqual(p.counts.cannot_tell, { files: 1, bytes: "in the cloud only".length }, "cloud-only is never planned");
  assert.ok(!items.some((i) => /cloud\.jpg/u.test(i.from)));
  assert.equal(items.find((i) => i.from === "notes.txt").to, "consolidated/Downloads/notes (from Downloads).txt", "a planned, visible rename");
  assert.equal(p.counts.renames, 1);
  assert.equal(p.counts.copy.files, copies.length);
  assert.match(p.digest, /^[0-9a-f]{64}$/u);
});

test("U7: the policy can never move the target off the signed drive or the folder out from under it", () => {
  assert.throws(() => validatePolicy({ target: "G:" }), /signed consolidation drive/u);
  assert.throws(() => validatePolicy({ folder: "..\\elsewhere" }), /one plain folder name/u);
  assert.throws(() => validatePolicy({ exclude: ["a/b"] }), /plain names/u);
  assert.deepEqual(validatePolicy({ never: ["Music"] }).never, ["Music"]);
});

test("U7: a plan is current only for both passes, the rules and the policy", async () => {
  const e = await estate();
  const dir = tmp();
  const ask = (planner, policy = DEFAULT_POLICY) =>
    planner.plan({ sourceRoot: e.src, sourceName: "Downloads", sourceDb: e.sDb, targetDb: e.fDb, policy });
  const pl = createCopyPlanner({ dir });
  assert.equal(ask(pl).computing, true, "planned off the hub's thread");
  let a;
  for (let i = 0; i < 300 && (a = ask(pl)).computing; i++) await wait(20);
  const first = a.digest;
  assert.equal(ask(pl, { ...DEFAULT_POLICY, exclude: [] }).computing, true, "a new policy is a new plan");
  write(e.src, "later.txt", "a later file");
  await catalogue({ root: e.src, dbPath: e.sDb });
  for (let i = 0; i < 300 && (a = ask(pl)).computing; i++) await wait(20);
  assert.notEqual(a.digest, first, "a new pass changes the plan's digest");
  assert.equal(ask(pl, { ...DEFAULT_POLICY, never: ["downloads"] }).never, true);
});

// --- the hub -------------------------------------------------------------------------------------------

async function hubU7({ freeBytes = 10 ** 12, quarantine = [] } = {}) {
  const e = await estate();
  const home = tmp();
  const store = tmp();
  const gov = path.join(tmp(), "governance.jsonl");
  const policyFile = path.join(tmp(), "storage-policy.json");
  const offered = [
    { root: e.src, kind: "user", role: "downloads", in_onedrive: false, removable: false, sections: [] },
    { root: e.f, kind: "drive", role: null, removable: true, sections: [] }
  ];
  const api = createEstateApi({
    quarantine,
    producer: {
      machine: "T480",
      dbPath: path.join(home, "estate", "estate-map-T480.db"),
      roots: () => offered.map((x) => x.root),
      offered: () => offered,
      estateStore: store,
      lister: null,
      cloudOnly: async () => ({ cloud: new Set(), unknown: [] }),
      target: e.f,
      governanceLog: gov,
      policyFile,
      freeBytes
    }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/estate`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body ? { method: "POST", body: JSON.stringify(body) } : {});
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { e, gov, policyFile, home, call, close: () => new Promise((r) => server.close(r)) };
}
const ready = async (h) => {
  if (h.quarantine === null) return null;
  for (const root of [h.e.f, h.e.src]) {
    await h.call("/library", { root });
    for (let i = 0; i < 500 && h.call && JSON.parse((await h.call("/library")).text).running; i++) await wait(10);
  }
  let s;
  for (let i = 0; i < 600; i++) {
    s = (await h.call("/library/plan")).json;
    if (s.sources?.length && s.sources.every((x) => !x.computing)) return s;
    await wait(20);
  }
  throw new Error(`the plan never settled: ${JSON.stringify(s)}`);
};

test("U7: a plan is raised for the owner's signature and never signed by the hub", async () => {
  const h = await hubU7();
  try {
    const s = await ready(h);
    const p = s.sources[0];
    assert.equal(p.source, "Downloads");
    assert.equal(p.fits, true);
    assert.equal(p.proposal.state, "not raised");
    const r = await h.call("/library/plan/raise", { source: p.id });
    assert.equal(r.status, 201, r.text);
    const ev = readKelEvents(h.gov).events;
    assert.deepEqual(ev.map((x) => x.type), ["proposal_raised"], "raised - and nothing signed");
    assert.equal(ev[0].authorship, "house");
    assert.ok(ev[0].payload.evidence.includes(`digest:${p.digest}`), "the exact plan rides on the proposal");
    assert.equal(isAuthorised(ev, p.proposal.id), false, "only the owner's signature authorises it");
    assert.equal((await h.call("/library/plan/raise", { source: p.id })).status, 409, "raised once");
    assert.equal((await h.call("/library/plan")).json.sources[0].proposal.state, "open");
  } finally {
    await h.close();
  }
});

test("U7: a signature binds to exactly what was shown - a newer pass makes a new, unsigned plan", async () => {
  const h = await hubU7();
  try {
    const p = (await ready(h)).sources[0];
    await h.call("/library/plan/raise", { source: p.id });
    write(h.e.src, "added-later.txt", "added after raising");
    await h.call("/library", { root: h.e.src });
    for (let i = 0; i < 500 && JSON.parse((await h.call("/library")).text).running; i++) await wait(10);
    let q;
    for (let i = 0; i < 600; i++) {
      q = (await h.call("/library/plan")).json.sources[0];
      if (!q.computing) break;
      await wait(20);
    }
    assert.notEqual(q.proposal.id, p.proposal.id, "a different plan is a different proposal");
    assert.equal(q.proposal.state, "not raised", "the earlier raise does not carry over");
  } finally {
    await h.close();
  }
});

test("U7: a plan that does not fit says so and cannot be raised", async () => {
  const h = await hubU7({ freeBytes: 10 });
  try {
    const p = (await ready(h)).sources[0];
    assert.equal(p.fits, false);
    const r = await h.call("/library/plan/raise", { source: p.id });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /does not fit/u);
  } finally {
    await h.close();
  }
});

test("U7: the owner's policy edits are validated, written and logged; no policy means 412", async () => {
  const h = await hubU7();
  try {
    assert.equal((await h.call("/library/policy", { target: "G:" })).json.policy.target, h.e.f, "the target is pinned to the signed drive");
    assert.equal((await h.call("/library/policy", { folder: "../out" })).status, 400);
    const ok = await h.call("/library/policy", { never: ["Music"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.policyFile, "utf8")).never, ["Music"]);
    assert.ok(fs.readFileSync(path.join(h.home, "estate", "policy-changes.jsonl"), "utf8").includes("Music"), "the edit is logged");
  } finally {
    await h.close();
  }
  const none = await hubU7({ quarantine: null });
  try {
    assert.equal((await none.call("/library/plan")).status, 412);
    assert.equal((await none.call("/library/plan/raise", { source: "x" })).status, 412);
  } finally {
    await none.close();
  }
});

// --- claude-u7-verifier's round-1 FAIL ----------------------------------------------------------------

const planOf = async (h) => {
  for (let i = 0; i < 600; i++) {
    const s = (await h.call("/library/plan")).json;
    if (s.sources?.length && s.sources.every((x) => !x.computing)) return s;
    await wait(20);
  }
  throw new Error("the plan never settled");
};
const recatalogue = async (h, root) => {
  await h.call("/library", { root });
  for (let i = 0; i < 500 && JSON.parse((await h.call("/library")).text).running; i++) await wait(10);
};

test("U7 round 2 (B1): a newer pass that changed nothing still makes a new, unsigned proposal", async () => {
  const h = await hubU7();
  try {
    const p = (await ready(h)).sources[0];
    assert.equal((await h.call("/library/plan/raise", { source: p.id })).status, 201);
    await recatalogue(h, h.e.src);
    const q = (await planOf(h)).sources[0];
    assert.equal(q.digest, p.digest, "the same files would be copied");
    assert.notEqual(q.proposal.id, p.proposal.id, "but a signature on the old pass does not carry over");
    assert.equal(q.proposal.state, "not raised");
    // and F:'s own new pass is part of it too
    await recatalogue(h, h.e.f);
    const r = (await planOf(h)).sources[0];
    assert.notEqual(r.proposal.id, q.proposal.id, "a new pass on F: is a new proposal as well");
  } finally {
    await h.close();
  }
});

test("U7 round 2 (B2, B3): a planned name is never one F: holds - by NTFS's case-insensitive rule, renames included", async () => {
  const e = await estate();
  write(e.f, "consolidated/Downloads/notes (from Downloads).txt", "yet another thing");
  write(e.f, "consolidated/Downloads/A/X.BIN", "upper-case twin, other content");
  await catalogue({ root: e.f, dbPath: e.fDb });
  const p = planCopy({ sourceDb: e.sDb, sourceRoot: e.src, sourceName: "Downloads", targetDb: e.fDb, policy: DEFAULT_POLICY });
  const items = p.items.map((l) => JSON.parse(l));
  assert.equal(items.find((i) => i.from === "notes.txt").to, "consolidated/Downloads/notes (from Downloads 2).txt", "the rename itself is checked");
  assert.equal(items.find((i) => i.from === "a/x.bin").to, "consolidated/Downloads/a/x (from Downloads).bin", "A/X.BIN on F: is the same name on NTFS");
  const all = items.filter((i) => i.to).map((i) => i.to.toLowerCase());
  assert.equal(new Set(all).size, all.length, "no two planned copies share a name");
});

test("U7 round 2 (B4): two added folders, and two same-named sources, plan into different folders", async () => {
  const e = await estate();
  const a = tmp();
  const b = tmp();
  const pa = path.join(a, "Projects");
  const pb = path.join(b, "Projects");
  write(pa, "one.txt", "one");
  write(pb, "two.txt", "two");
  const home = tmp();
  const offered = [
    { root: pa, kind: "user", role: "added", in_onedrive: false, removable: false, sections: [] },
    { root: pb, kind: "user", role: "added", in_onedrive: false, removable: false, sections: [] },
    { root: e.f, kind: "drive", role: null, removable: true, sections: [] }
  ];
  const api = createEstateApi({
    quarantine: [],
    producer: {
      machine: "T480", dbPath: path.join(home, "estate", "m.db"), roots: () => offered.map((x) => x.root), offered: () => offered,
      estateStore: tmp(), lister: null, cloudOnly: async () => ({ cloud: new Set(), unknown: [] }), target: e.f,
      governanceLog: path.join(tmp(), "g.jsonl"), policyFile: path.join(tmp(), "p.json"), freeBytes: 10 ** 12
    }
  });
  const server = http.createServer((req, res) => { if (!api.tryHandle(req, res)) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/estate`;
  const h = {
    call: async (p, body) => {
      const res = await fetch(base + p, body ? { method: "POST", body: JSON.stringify(body) } : {});
      const text = await res.text();
      return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    }
  };
  try {
    for (const root of [e.f, pa, pb]) await recatalogue(h, root);
    const s = await planOf(h);
    const folders = s.sources.map((x) => x.folder.toLowerCase());
    assert.equal(new Set(folders).size, folders.length, JSON.stringify(folders));
    assert.ok(folders.every((f) => f.startsWith("consolidated/added-projects")), "named by their own folder");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("U7 round 2 (B5): an offered root with no catalogue yet is said, never a 500", async () => {
  const h = await hubU7();
  try {
    await recatalogue(h, h.e.f); // F: only; the source is never catalogued
    const r = await h.call("/library/plan");
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.sources[0].why, /not catalogued yet/u);
  } finally {
    await h.close();
  }
});

test("U7 round 2: the refusals - broken chain, nothing to copy, unfinished pass - and the 5% margin", async () => {
  const h = await hubU7();
  try {
    const p = (await ready(h)).sources[0];
    fs.writeFileSync(h.gov, "not a kel line\n");
    const broken = await h.call("/library/plan/raise", { source: p.id });
    assert.equal(broken.status, 409);
    assert.match(broken.json.error, /chain is broken/u);
  } finally {
    await h.close();
  }
  // a source F: already holds entirely has nothing to copy
  const e = await estate();
  const only = tmp();
  write(only, "same.jpg", "beach photo bytes");
  const sDb = path.join(tmp(), "only.db");
  await catalogue({ root: only, dbPath: sDb });
  const empty = planCopy({ sourceDb: sDb, sourceRoot: only, sourceName: "Only", targetDb: e.fDb, policy: DEFAULT_POLICY });
  assert.equal(empty.counts.copy.files, 0);
  // an unfinished pass is refused by the planner
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(e.sDb);
  db.prepare("INSERT INTO passes (id, started_at) VALUES ('open', ?)").run(new Date(Date.now() + 1000).toISOString());
  db.close();
  const pl = createCopyPlanner({ dir: tmp() });
  assert.match(pl.plan({ sourceRoot: e.src, sourceName: "Downloads", sourceDb: e.sDb, targetDb: e.fDb, policy: DEFAULT_POLICY }).why, /did not finish/u);
  // the margin: free space just above the bytes, but under bytes / 0.95, does not fit
  const k = await hubU7({ freeBytes: 1 });
  try {
    const bytes = (await ready(k)).sources[0].copy.bytes;
    await k.close();
    const m = await hubU7({ freeBytes: Math.floor(bytes / 0.97) });
    try {
      assert.equal((await ready(m)).sources[0].fits, false, "inside the 5% margin is said not to fit");
    } finally {
      await m.close();
    }
  } catch (err) {
    await k.close().catch(() => {});
    throw err;
  }
});

test("U7 round 2: the digest covers the repeats' pointers as well as the copies", async () => {
  const e = await estate();
  const before = planCopy({ sourceDb: e.sDb, sourceRoot: e.src, sourceName: "Downloads", targetDb: e.fDb, policy: DEFAULT_POLICY }).digest;
  write(e.src, "c/z.bin", "repeated content"); // one more repeat, nothing new to copy
  await catalogue({ root: e.src, dbPath: e.sDb });
  const after = planCopy({ sourceDb: e.sDb, sourceRoot: e.src, sourceName: "Downloads", targetDb: e.fDb, policy: DEFAULT_POLICY });
  assert.equal(after.counts.repeats.files, 2);
  assert.notEqual(after.digest, before, "a new pointer is a different plan to sign");
});

test("U7 round 2: unknown free space cannot be raised; unknown policy keys are dropped", async () => {
  const h = await hubU7({ freeBytes: () => null });
  try {
    const p = (await ready(h)).sources[0];
    assert.equal(p.fits, null);
    const r = await h.call("/library/plan/raise", { source: p.id });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /cannot be read/u);
  } finally {
    await h.close();
  }
  assert.equal("evil" in validatePolicy({ evil: "x", never: [] }), false);
});
