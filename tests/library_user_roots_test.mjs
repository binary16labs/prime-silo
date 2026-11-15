// U1 — the owner's data, catalogued where it is, Downloads first. Every Scenario of U1 maps to a test
// here; the panel's half is in estate_map_panel_test.mjs. Real temp trees, a fake registry (the
// producer's `offered`), and a read spy wherever "never opened" is claimed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { catalogue, windowsCloudOnly } from "../server/coordination/lib/library.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import { listRoot, driveIdentity } from "../server/coordination/lib/estate_compare.mjs";
import { addUserRoot, offeredRoots, openRegistry } from "../server/coordination/lib/drive_registry.mjs";
import { hashFile } from "../server/coordination/lib/nas_catalog.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "u1-"))) - 1];
// outside AppData, for the registry's own judgement: os.tmpdir() IS under AppData on Windows
const outside = () => made[made.push(fs.mkdtempSync(path.join(REPO, ".u1-tmp-"))) - 1];
const OLD = new Date(Date.now() - 3_600_000);
const write = (root, rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, OLD, OLD);
  return f;
};
const fold = (p) => path.resolve(p).toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rowsIn = (dbPath, table = "files") => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10_000 });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const passesIn = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10_000 });
  try {
    return db.prepare("SELECT * FROM passes ORDER BY started_at").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const dbsIn = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^library-.*\.db$/u.test(f)).map((f) => path.join(dir, f)) : [];

// --- the shelf: what is offered, in the owner's order ---------------------------------------------

test("U1: the offered order is Downloads, OneDrive with its sections, the other folders, then data drives", () => {
  const me = "C:\\Users\\me";
  const rows = [
    { attached: true, root: "G:", offers: "whole", medium: "usb", user_roots: [] },
    {
      attached: true,
      root: "C:",
      offers: "user-roots",
      user_roots: [
        { root: `${me}\\OneDrive`, role: "onedrive", in_onedrive: true },
        { root: `${me}\\OneDrive\\Documents`, role: "documents", in_onedrive: true },
        { root: `${me}\\OneDrive\\Desktop`, role: "desktop", in_onedrive: true },
        { root: `${me}\\OneDrive\\Pictures`, role: "pictures", in_onedrive: true },
        { root: `${me}\\Music`, role: "music" },
        { root: `${me}\\Projects`, role: "added", added_by_owner: true },
        { root: `${me}\\AppData\\Roaming`, role: "added", added_by_owner: true },
        { root: `${me}\\Downloads`, role: "downloads" }
      ]
    },
    { attached: true, root: "D:", offers: "whole", medium: "internal", user_roots: [] },
    { attached: false, root: null, offers: "whole", medium: "usb", user_roots: [] }
  ];
  const got = offeredRoots(rows);
  assert.deepEqual(
    got.map((e) => e.role ?? e.root),
    ["downloads", "onedrive", "music", "added", "G:", "D:"],
    "Downloads first; AppData never; the system drive never whole; an unplugged drive not offered"
  );
  assert.deepEqual(got[1].sections, ["documents", "desktop", "pictures"], "redirected folders are OneDrive's sections");
  assert.equal(got[1].in_onedrive, true);
  assert.deepEqual(
    got.filter((e) => e.kind === "drive").map((e) => [e.root, e.removable]),
    [["G:", true], ["D:", false]]
  );
});

test("U1: an added folder inside a root, or holding one, is refused with the root it overlaps", () => {
  const base = outside();
  const a = path.join(base, "Downloads");
  fs.mkdirSync(path.join(a, "inner"), { recursive: true });
  const db = openRegistry(path.join(tmp(), "drives.db"));
  try {
    const identity = driveIdentity(base);
    const at = new Date().toISOString();
    db.prepare("INSERT INTO drives (identity, root, first_seen, last_seen, attached) VALUES (?, ?, ?, ?, 1)").run(
      identity,
      base,
      at,
      at
    );
    assert.deepEqual(addUserRoot(db, identity, a), { added: a });
    assert.match(addUserRoot(db, identity, path.join(a, "inner")).refused ?? "", /overlaps .*Downloads/u);
    assert.match(addUserRoot(db, identity, base).refused ?? "", /overlaps .*Downloads/u, "nor one that holds a root");
    assert.deepEqual(addUserRoot(db, identity, a), { added: a }, "the same root again is not an overlap");
  } finally {
    db.close();
  }
});

// --- the hub ----------------------------------------------------------------------------------------

async function hubU1({ offered, cloudOnly = async () => ({ cloud: new Set(), unknown: [] }), store = tmp(), home = tmp(), list = listRoot }) {
  const api = createEstateApi({
    quarantine: [],
    producer: {
      machine: "T480",
      dbPath: path.join(home, "estate", "estate-map-T480.db"),
      roots: () => offered.map((e) => e.root),
      offered: () => offered,
      estateStore: store,
      lister: null,
      cloudOnly,
      list
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
  const library = async () => (await call("/library")).json;
  const settle = async (done = (s) => !s.running && (!s.queue || s.queue.finished)) => {
    for (let i = 0; i < 1500; i++) {
      const s = await library();
      if (done(s)) return s;
      await wait(10);
    }
    throw new Error("the library never settled");
  };
  return {
    call,
    library,
    settle,
    home,
    store,
    homeLib: path.join(home, "estate", "library"),
    storeLib: path.join(store, "library"),
    close: () => new Promise((r) => server.close(r))
  };
}

// a machine: Downloads, OneDrive holding Documents, Music, and a removable data drive
const machine = () => {
  const downloads = tmp();
  write(downloads, "setup.exe", "an installer");
  write(downloads, "photo.jpg", "a photo");
  const onedrive = tmp();
  write(onedrive, "Documents/cv.txt", "a document");
  write(onedrive, "Pictures/beach.jpg", "a beach");
  const music = tmp();
  write(music, "song.mp3", "a song");
  const data = tmp();
  write(data, "Photos/photo.jpg", "a photo");
  const offered = [
    { root: downloads, kind: "user", role: "downloads", in_onedrive: false, removable: false, sections: [] },
    { root: onedrive, kind: "user", role: "onedrive", in_onedrive: true, removable: false, sections: ["documents", "pictures"] },
    { root: music, kind: "user", role: "music", in_onedrive: false, removable: false, sections: [] },
    { root: data, kind: "drive", role: null, removable: true, sections: [] }
  ];
  return { downloads, onedrive, music, data, offered };
};

test("U1: Catalogue my data starts with Downloads, one root at a time, and never touches the operating system", async () => {
  const m = machine();
  const asked = [];
  const h = await hubU1({ offered: m.offered, cloudOnly: async (root) => (asked.push(root), { cloud: new Set(), unknown: [] }) });
  try {
    const shown = await h.library();
    assert.deepEqual(shown.roots, [m.downloads, m.onedrive, m.music, m.data], "offered in the owner's order");
    for (const r of shown.roots) assert.doesNotMatch(r, /\\(Windows|Program Files|ProgramData)(\\|$)/iu);

    assert.equal((await h.call("/library/all", {})).status, 202);
    const s = await h.settle();
    assert.deepEqual(s.queue.done.map((d) => d.root), [m.downloads, m.onedrive, m.music, m.data], "Downloads first");
    assert.ok(s.queue.done.every((d) => d.finished), JSON.stringify(s.queue.done));

    // ONE AT A TIME: each pass started after the one before it finished
    const order = [m.downloads, m.onedrive, m.music].map((root) => {
      const db = dbsIn(h.homeLib).find((f) => rowsIn(f).some((r) => fs.existsSync(path.join(root, r.path))));
      return passesIn(db)[0];
    });
    for (let i = 1; i < order.length; i++)
      assert.ok(order[i].started_at >= order[i - 1].finished_at, "never two passes at once");

    // WHERE THEY LIVE: the user roots on the machine, the removable drive in the store
    assert.equal(dbsIn(h.homeLib).length, 3, "Downloads, OneDrive and Music in BENNY_HOME");
    assert.equal(dbsIn(h.storeLib).length, 1, "the removable drive in the estate store");
    assert.deepEqual(asked, [m.downloads, m.onedrive, m.music], "every user root is asked about the cloud; a drive never is");

    // the button comes back once the queue has finished, and its results stay to be read
    assert.equal((await h.call("/library/all", {})).status, 202, "a finished queue can be pressed again");
    await h.settle();
  } finally {
    await h.close();
  }
});

test("U1: a folder redirected into OneDrive is catalogued once, and no file is in two catalogues", async () => {
  const m = machine();
  const h = await hubU1({ offered: m.offered });
  try {
    await h.call("/library/all", {});
    await h.settle();
    const seen = new Map();
    for (const db of [...dbsIn(h.homeLib), ...dbsIn(h.storeLib)])
      for (const r of rowsIn(db)) seen.set(`${db}|${r.path}`, r.path);
    const owners = (rel) => [...seen.entries()].filter(([, p]) => p === rel).length;
    assert.equal(owners("Documents/cv.txt"), 1, "Documents' file is in exactly one catalogue: OneDrive's");
    // every full path once: the four roots share no folder, so no file can be catalogued twice
    const full = [...dbsIn(h.homeLib), ...dbsIn(h.storeLib)].flatMap((db) => rowsIn(db).map((r) => r.path + "@" + db));
    assert.equal(new Set(full).size, full.length);
    const total = [...dbsIn(h.homeLib), ...dbsIn(h.storeLib)].reduce((n, db) => n + rowsIn(db).length, 0);
    assert.equal(total, 6, "six files on the machine, six rows across its catalogues");
  } finally {
    await h.close();
  }
});

test("U1: Windows, Program Files, ProgramData, AppData and the system drive are refused by every route", async () => {
  const m = machine();
  const h = await hubU1({ offered: m.offered });
  try {
    const bad = ["C:\\Windows", "C:\\Program Files", "C:\\ProgramData", "C:\\Users\\me\\AppData\\Roaming", "C:", "C:\\"];
    for (const root of bad) {
      const r = await h.call("/library", { root });
      assert.equal(r.status, 400, `${root}: ${r.text}`);
      assert.notEqual((await h.call(`/library.csv?root=${encodeURIComponent(root)}`)).status, 200);
      const find = await h.call(`/library/find?root=${encodeURIComponent(root)}&q=x`);
      assert.ok(find.status >= 400, `${root} find: ${find.status}`);
      assert.equal((await h.call("/library/check", { root, path: `${root}\\x` })).status, 400);
      assert.equal((await h.call("/compare", { from: root, to: m.data })).status, 400);
    }
    assert.match((await h.call("/library", { root: "C:\\Windows" })).json.error, /Windows' own/u);
    assert.equal(dbsIn(h.homeLib).length + dbsIn(h.storeLib).length, 0, "and nothing was catalogued");
  } finally {
    await h.close();
  }
});

test("U1: a root that fails is recorded with why and the queue moves on", async () => {
  const m = machine();
  const gone = path.join(tmp(), "unplugged");
  const offered = [m.offered[0], { root: gone, kind: "drive", role: null, removable: true, sections: [] }, m.offered[2]];
  const h = await hubU1({ offered });
  try {
    await h.call("/library/all", {});
    const s = await h.settle();
    assert.deepEqual(s.queue.done.map((d) => d.root), [m.downloads, gone, m.music]);
    assert.match(s.queue.done[1].why ?? "", /cannot be read/u);
    assert.ok(s.queue.done[2].finished, "and the root after it is catalogued");
  } finally {
    await h.close();
  }
});

test("U1: Stop stops the pass and the queue, keeps what was done, and a restart loses only the queue", async () => {
  const m = machine();
  let release;
  const held = new Promise((r) => (release = r));
  const probe = async (root) => {
    if (root === m.onedrive) await held; // OneDrive's pass waits here, running, until Stop has been pressed
    return { cloud: new Set(), unknown: [] };
  };
  const home = tmp();
  const store = tmp();
  const h = await hubU1({ offered: m.offered, cloudOnly: probe, home, store });
  try {
    await h.call("/library/all", {});
    await h.settle((s) => s.running?.root === m.onedrive);
    assert.equal((await h.call("/library/stop", {})).status, 202);
    release();
    const s = await h.settle((x) => !x.running);
    assert.equal(s.queue, null, "the queue is cleared");
    await wait(200);
    assert.equal((await h.library()).running, null, "and nothing else is started");
    assert.equal(dbsIn(h.homeLib).length, 2, "Downloads finished and OneDrive's stopped pass are kept; Music never began");
    assert.equal(dbsIn(h.storeLib).length, 0, "the data drive never began");
  } finally {
    await h.close();
  }
  // a new hub on the same home: no queue, and OneDrive's pass resumes rather than starting again
  const again = await hubU1({ offered: m.offered, home, store });
  try {
    assert.equal((await again.library()).queue, null, "the queue lives in memory only");
    assert.equal((await again.call("/library", { root: m.onedrive })).status, 202);
    await again.settle();
    const one = dbsIn(again.homeLib).find((f) => rowsIn(f).some((r) => r.path === "Documents/cv.txt"));
    const passes = passesIn(one);
    assert.equal(passes.length, 1, "the stopped pass resumed");
    assert.ok(passes[0].finished_at);
  } finally {
    await again.close();
  }
});

test("U1: a catalogue is found in either place, whichever the rule would put it in now", async () => {
  const m = machine();
  const store = tmp();
  const home = tmp();
  // Downloads as a user root: its catalogue goes on the machine, never to the store
  const first = await hubU1({ offered: m.offered, store, home });
  try {
    await first.call("/library", { root: m.downloads });
    await first.settle();
    assert.equal(dbsIn(first.homeLib).length, 1, "on the machine, in BENNY_HOME");
    assert.equal(dbsIn(first.storeLib).length, 0, "and not in the store");
  } finally {
    await first.close();
  }
  // the same folder seen as a removable drive, whose NEW catalogue would go to the store
  const h = await hubU1({ offered: [{ ...m.offered[0], kind: "drive", role: null, removable: true }], store, home });
  try {
    const s = await h.settle((x) => x.catalogues?.[m.downloads]?.last?.finished_at);
    assert.equal(s.catalogues[m.downloads].last.seen, 2, "the machine's catalogue still answers");
    await h.call("/library", { root: m.downloads });
    await h.settle();
    assert.equal(dbsIn(h.storeLib).length, 0, "and a new pass updates it rather than begin a second");
  } finally {
    await h.close();
  }
});

// --- OneDrive files that are not on this disk are never opened ---------------------------------------

test("U1: online-only files are listed by name, size and date, and none is opened", async () => {
  const root = tmp();
  write(root, "local.jpg", "on this disk");
  const cloudFile = write(root, "Pictures/beach.jpg", "only in the cloud");
  const read = [];
  const spy = (f) => (read.push(fold(f)), hashFile(f));
  const dbPath = path.join(tmp(), "lib.db");
  const probe = async () => ({ cloud: new Set([fold(cloudFile)]), unknown: [] });
  for (let pass = 0; pass < 2; pass++) await catalogue({ root, dbPath, hash: spy, cloudOnly: probe });
  assert.ok(!read.includes(fold(cloudFile)), "the cloud-only file is never read");
  assert.ok(read.includes(fold(path.join(root, "local.jpg"))), "a local file still is");
  assert.deepEqual(
    rowsIn(dbPath, "online_only").map((r) => [r.path, r.size]),
    [["Pictures/beach.jpg", "only in the cloud".length]]
  );
  assert.ok(!rowsIn(dbPath).some((r) => r.path === "Pictures/beach.jpg"), "and it has no fingerprint row");
  assert.equal(passesIn(dbPath).at(-1).online_only, 1, "the pass counts it");
});

test("U1: a file that comes back onto the disk leaves the online-only list and is fingerprinted", async () => {
  const root = tmp();
  const f = write(root, "Pictures/beach.jpg", "only in the cloud");
  const dbPath = path.join(tmp(), "lib.db");
  await catalogue({ root, dbPath, cloudOnly: async () => ({ cloud: new Set([fold(f)]), unknown: [] }) });
  assert.equal(rowsIn(dbPath, "online_only").length, 1);
  await catalogue({ root, dbPath, cloudOnly: async () => ({ cloud: new Set(), unknown: [] }) });
  assert.equal(rowsIn(dbPath, "online_only").length, 0, "no longer listed as online-only");
  assert.ok(rowsIn(dbPath).some((r) => r.path === "Pictures/beach.jpg"), "and now it has a fingerprint");
});

test("U1: if Windows cannot say which files are in the cloud, nothing in the root is read", async () => {
  const root = tmp();
  write(root, "a.jpg", "a");
  const read = [];
  const dbPath = path.join(tmp(), "lib.db");
  await assert.rejects(
    catalogue({ root, dbPath, hash: (f) => (read.push(f), hashFile(f)), cloudOnly: async () => { throw new Error("no listing"); } }),
    /could not say which files .* are only in the cloud, so nothing was read/u
  );
  assert.equal(read.length, 0);

  // and a folder the listing could not see is not read either
  const unseen = write(root, "Locked/b.jpg", "b");
  await catalogue({ root, dbPath, hash: (f) => (read.push(fold(f)), hashFile(f)), cloudOnly: async () => ({ cloud: new Set(), unknown: [fold(path.dirname(unseen))] }) });
  assert.ok(!read.includes(fold(unseen)));
  assert.equal(passesIn(dbPath).at(-1).unreadable, 1);
});

test("U1: the real Windows probe sees an offline file by its attributes, and the pass never opens it", { skip: process.platform !== "win32" }, async () => {
  const root = tmp();
  write(root, "here.txt", "here");
  const away = write(root, "Sub/away.txt", "away");
  // the offline attribute is one of the three OneDrive sets on a file that is not on this disk
  assert.equal(spawnSync("attrib", ["+O", away]).status, 0, "attrib +O");
  const probe = await windowsCloudOnly(root);
  assert.deepEqual([...probe.cloud], [fold(away)], "only the offline file");
  const read = [];
  await catalogue({ root, dbPath: path.join(tmp(), "lib.db"), hash: (f) => (read.push(fold(f)), hashFile(f)), cloudOnly: windowsCloudOnly });
  assert.deepEqual(read, [fold(path.join(root, "here.txt"))]);
});

// --- Compare: what in Downloads is not on F: ---------------------------------------------------------

test("U1: what in Downloads is not on F: is one press, and F: is read from its catalogue", async () => {
  const m = machine();
  const listed = [];
  const list = (root, ...rest) => (listed.push(root), listRoot(root, ...rest));
  const h = await hubU1({ offered: m.offered, list });
  try {
    await h.call("/library", { root: m.data });
    await h.settle();
    assert.equal((await h.call("/compare", { from: m.downloads, to: m.data })).status, 202);
    let s;
    for (let i = 0; i < 1500; i++) {
      s = (await h.call(`/compare?to=${encodeURIComponent(m.data)}`)).json;
      if (!s.running && s.results[m.downloads]) break;
      await wait(10);
    }
    const r = s.results[m.downloads];
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.onlyHere.files, 1, "setup.exe is only in Downloads; photo.jpg is already on the drive");
    assert.equal(s.labels[m.downloads], "downloads", "the panel can name it Downloads");
    assert.deepEqual(listed, [m.downloads], "only Downloads was listed: the drive was asked through its catalogue");
    // OneDrive is never compared from: reading a cloud-only file downloads it
    const one = await h.call("/compare", { from: m.onedrive, to: m.data });
    assert.equal(one.status, 400);
    assert.match(one.json.error, /OneDrive/u);
    assert.equal((await h.call("/library/check", { root: m.onedrive, path: path.join(m.onedrive, "x") })).status, 400);
  } finally {
    await h.close();
  }
});
