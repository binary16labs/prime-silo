// S17 — the map gets a producer. Every Scenario in delivery/tasks/S17.md maps to a test here, and
// each is driven through the hub's real routes rather than by calling the pieces it is made of.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import { DEFAULT_MAP_MAX_AGE_MS, foldEstateMap } from "../server/coordination/lib/estate_map_fold.mjs";
import { createSweeper, mapDbPath, sweepRoots } from "../server/coordination/lib/estate_map_producer.mjs";
import { acceptMap } from "../server/coordination/lib/estate_register.mjs";
import { sweepView } from "../app/L0/_all/mod/_prime_silo/estate_map/fold_view.js";

const MACHINE = "T480";
// every temp home is removed at the end: one run used to leave a dozen behind (claude-s17-verifier)
const homes = [];
const home = () => homes[homes.push(fs.mkdtempSync(path.join(os.tmpdir(), "s17-home-"))) - 1];
test.after(() => {
  for (const d of homes) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
// rules that differ every run, so no guard can be honest only for the words a fixture always uses
const word = () => Array.from({ length: 8 }, () => "ghijklmnopqrstuvwxyz"[crypto.randomInt(20)]).join("");
const RULES = [word(), word()];

// A collector that lists what the test says, and can be held open so a sweep is still RUNNING
// while the test looks at the hub.
function fakeFiles({ files = 3, hold = null } = {}) {
  return async (volumes) => [
    {
      name: "files-fake",
      kind: "files",
      volumes,
      async *collect({ volume }) {
        if (hold) await hold;
        for (let i = 0; i < files; i++) yield { path: `${volume}\\docs\\note-${i}.txt`, size: 100, mtimeMs: 0 };
      }
    }
  ];
}

async function hub({ quarantine = RULES, roots = ["C:", "F:"], collectors = fakeFiles(), dir = home() } = {}) {
  const api = createEstateApi({
    quarantine,
    producer: { machine: MACHINE, dbPath: mapDbPath(dir, MACHINE), roots: () => roots, collectors }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/estate`;
  const call = async (p, body, { raw } = {}) => {
    const sent = raw ?? (body ? JSON.stringify(body) : null);
    const res = await fetch(base + p, sent !== null ? { method: "POST", body: sent } : {});
    return { status: res.status, body: await res.json() };
  };
  const settled = async () => {
    for (let i = 0; i < 400; i++) {
      const s = await call("/sweep");
      if (!s.body.running) return s.body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the sweep never ended");
  };
  return { api, call, settled, dir, close: () => new Promise((r) => server.close(r)) };
}

// --- Scenario: the owner's first map is a click ----------------------------------------------------

test("a sweep pressed on the hub puts this machine in the map", async () => {
  const h = await hub();
  try {
    assert.deepEqual(Object.keys((await h.call("/map")).body.machines), [], "no map before the sweep");
    const started = await h.call("/sweep", { volumes: ["F:"] });
    assert.equal(started.status, 202);
    const done = await h.settled();
    assert.equal(done.last.ok, true, done.last.reason);
    const m = (await h.call("/map")).body.machines[MACHINE];
    assert.ok(m, "the machine is in the map");
    assert.deepEqual(m.scope, ["F:"]);
    assert.equal(m.counts.files, 3);
    assert.equal(m.stale, false);
    assert.ok(m.heard_at, "it was HEARD — stamped by acceptMap, which is the only writer of heard_at");
  } finally {
    await h.close();
  }
});

test("the hub's own sweep is judged by the satellites' acceptance, not waved through", async () => {
  // A map may name at most 64 volumes (S3's allowlist bounds every array). Nothing on the way to
  // the sweep counts them; mapPayloadProblem does, inside acceptMap. So if this is refused, the local
  // sweep went through the same function a satellite's push does — not merely a policy check.
  const roots = Array.from({ length: 65 }, (_, i) => `C:\\v${i}`);
  const h = await hub({ roots });
  try {
    assert.equal((await h.call("/sweep", { volumes: roots })).status, 202);
    const done = await h.settled();
    assert.equal(done.last.ok, false, "a map the wire would refuse is refused from the hub too");
    assert.match(done.last.reason, /map scope is too long \(R31\)/u);
    assert.deepEqual(Object.keys((await h.call("/map")).body.machines), []);
  } finally {
    await h.close();
  }
});

test("a root the map could never carry is named with its reason, not offered", async () => {
  const deep = "F:\\a\\b\\c"; // three segments below the drive: not a volume name
  const quarantined = `F:\\${RULES[0]}`; // a root the policy itself refuses
  const h = await hub({ roots: ["C:", deep, quarantined] });
  try {
    const s = (await h.call("/sweep")).body;
    assert.deepEqual(s.roots, ["C:"]);
    assert.deepEqual(s.unusable, [
      { root: deep, reason: "volume name" },
      { root: quarantined, reason: "quarantined volume" }
    ]);
    assert.equal((await h.call("/sweep", { volumes: [deep] })).status, 400, "and it cannot be swept");
    assert.deepEqual(sweepView(s).unusable, [`${deep} cannot be swept: volume name`, `${quarantined} cannot be swept: quarantined volume`]);
    assert.equal(sweepView({ ...s, roots: [] }).can, false, "with nothing usable there is no button");
    assert.match(sweepView({ ...s, roots: [] }).why, /offers no volume the map can carry/u);
  } finally {
    await h.close();
  }
});

test("a body that is not an object is refused, and the hub is still up", async () => {
  const h = await hub();
  try {
    for (const raw of ["null", "[]", "7", '"C:"', "{"]) {
      const r = await h.call("/sweep", null, { raw });
      assert.equal(r.status, 400, raw);
    }
    assert.equal((await h.call("/map")).status, 200, "the hub answered after every one of them");
  } finally {
    await h.close();
  }
});

test("only roots the machine offers can be swept", async () => {
  const h = await hub({ roots: ["C:"] });
  try {
    for (const volumes of [["D:"], ["C:\\Users"], [], "C:"]) {
      const r = await h.call("/sweep", { volumes });
      assert.equal(r.status, 400, JSON.stringify(volumes));
    }
    assert.equal((await h.call("/sweep")).body.running, null, "nothing ran");
  } finally {
    await h.close();
  }
});

test("the roots offered are drives that exist, plus configured roots that exist", () => {
  const present = new Set(["C:\\", "F:\\", "F:\\media"]);
  const roots = sweepRoots({
    configured: ["F:\\media", "G:\\gone"],
    exists: (p) => present.has(p),
    platform: "win32"
  });
  assert.deepEqual(roots, ["C:", "F:", "F:\\media"]);
});

// --- Scenario: no policy, no map — even from the hub itself ----------------------------------------

test("with no policy the hub folds none of its own sweeps and starts none", async () => {
  const dir = home();
  const first = await hub({ dir });
  await first.call("/sweep", { volumes: ["C:"] });
  await first.settled();
  await first.close();
  // the same machine, the same finished sweep on disk, and no policy this time
  const h = await hub({ dir, quarantine: null });
  try {
    assert.deepEqual(Object.keys((await h.call("/map")).body.machines), [], "the sweep on disk is refused");
    const status = (await h.call("/sweep")).body;
    assert.equal(status.policy, false);
    const r = await h.call("/sweep", { volumes: ["C:"] });
    assert.equal(r.status, 412);
    assert.match(r.body.error, /quarantine policy/u);
    const view = sweepView(status);
    assert.equal(view.can, false);
    assert.match(view.why, /coordination\/estate\/quarantine\.json/u, "the panel says why, and where");
  } finally {
    await h.close();
  }
});

test("on boot the hub folds what this machine last swept", async () => {
  const dir = home();
  const first = await hub({ dir });
  await first.call("/sweep", { volumes: ["C:"] });
  await first.settled();
  await first.close();
  const h = await hub({ dir });
  try {
    const m = (await h.call("/map")).body.machines[MACHINE];
    assert.ok(m, "a restarted hub shows its own last sweep without being asked to sweep again");
    assert.deepEqual(m.scope, ["C:"]);
  } finally {
    await h.close();
  }
});

test("a hub that keeps running keeps hearing itself, so it never goes stale to itself", async (t) => {
  const dir = home();
  const first = await hub({ dir });
  await first.call("/sweep", { volumes: ["C:"] });
  await first.settled();
  await first.close();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const api = createEstateApi({
    quarantine: [],
    producer: { machine: MACHINE, dbPath: mapDbPath(dir, MACHINE), roots: () => ["C:"], collectors: fakeFiles() }
  });
  const map = () =>
    new Promise((resolve) => {
      const res = { writeHead: () => res, end: (b) => resolve(JSON.parse(b)) };
      api.tryHandle({ method: "GET", url: "/api/estate/map" }, res);
    });
  // Looked at just past the threshold and then every half hour: a heartbeat slower than the stale
  // threshold left the 40-minute look of the first version green (claude-s17-verifier).
  for (const minutes of [31, 61, 91, 121]) {
    t.mock.timers.tick((minutes === 31 ? 31 : 30) * 60_000);
    const m = (await map()).machines[MACHINE];
    assert.equal(m.stale, false, `${minutes} minutes on, its own heartbeat has kept it heard`);
    assert.ok(m.ageMs >= minutes * 60_000, "while its sweep is still reported as old");
  }
});

// --- Scenario: a heartbeat keeps a node live --------------------------------------------------------

test("a node heard two minutes ago is live however old its sweep is", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const swept = new Date(now - 3 * 3_600_000).toISOString();
  const push = {
    machine: "optimus",
    sweep_id: "01M31Y102Z4631D8992T33C1FW",
    finished_at: swept,
    scope: ["F:"],
    collectors: [{ name: "walker", kind: "files", volume: "F:", status: "ok", rows: 1 }],
    counts: { files: 1, bytes: 1, listed_files: 0, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
    digest: "a".repeat(64),
    snapshot: `sha256:${"b".repeat(64)}`
  };
  const heard = acceptMap({ maps: [] }, push, { machine: "optimus", quarantine: [], now: now - 2 * 60_000 });
  assert.equal(heard.ok, true, heard.reason);
  const live = foldEstateMap(heard.state.maps, { now }).machines.optimus;
  assert.equal(live.stale, false, "pushed two minutes ago: live");
  assert.equal(live.ageMs, 3 * 3_600_000, "and its SWEEP is reported as three hours old");

  // the same sweep re-sent is a heartbeat: it refreshes when it was heard and stores no copy
  const again = acceptMap(heard.state, push, { machine: "optimus", quarantine: [], now });
  assert.equal(again.state.maps.length, 1);
  assert.equal(again.state.maps[0].heard_at, new Date(now).toISOString());

  // and a node that has stopped is stale SINCE it was last heard, not since it swept
  const later = now + DEFAULT_MAP_MAX_AGE_MS + 60_000;
  const quiet = foldEstateMap(again.state.maps, { now: later }).machines.optimus;
  assert.equal(quiet.stale, true);
  assert.equal(quiet.since, new Date(now).toISOString());

  // "already held" is the same id, finish time AND digest: a push reusing an id with other content is
  // kept beside the first for the fold to judge, never swapped in by arriving last
  const imposter = acceptMap(again.state, { ...push, digest: "c".repeat(64) }, { machine: "optimus", quarantine: [], now });
  assert.equal(imposter.state.maps.length, 2);
  assert.equal(imposter.state.maps[0].digest, "a".repeat(64), "the first is untouched");
});

// --- Scenario: the hub stays responsive and single-flight -------------------------------------------

test("while a sweep runs the map answers, and a second sweep is refused with the first's start", async () => {
  let release;
  const hold = new Promise((r) => (release = r));
  const h = await hub({ collectors: fakeFiles({ hold }) });
  try {
    const first = await h.call("/sweep", { volumes: ["C:"] });
    assert.equal(first.status, 202, "the route answers before the sweep ends");
    assert.equal((await h.call("/map")).status, 200, "the map answers while the sweep is held open");
    const status = (await h.call("/sweep")).body;
    assert.deepEqual(status.running.volumes, ["C:"]);
    const second = await h.call("/sweep", { volumes: ["F:"] });
    assert.equal(second.status, 409);
    assert.equal(second.body.since, first.body.since, "refused WITH the running sweep's start time");
    release();
    assert.equal((await h.settled()).last.ok, true);
  } finally {
    release();
    await h.close();
  }
});

test("a second process sweeping the same database is refused, and the lock dies with its holder", async () => {
  let release;
  const hold = new Promise((r) => (release = r));
  const dbPath = mapDbPath(home(), MACHINE);
  const a = createSweeper({ dbPath, machine: MACHINE, quarantine: [], collectors: fakeFiles({ hold }) });
  const b = createSweeper({ dbPath, machine: MACHINE, quarantine: [], collectors: fakeFiles() });
  const ra = await a.start(["C:"]);
  assert.equal(ra.started, true);
  assert.equal((await b.start(["C:"])).started, false, "the other sweeper holds this database");
  release();
  await ra.done;
  const rb = await b.start(["C:"]);
  assert.equal(rb.started, true, "free again once the first sweep ended");
  await rb.done;
});

// --- Scenario: a LAN caller cannot start a sweep ----------------------------------------------------

test("a sweep requested from the LAN is refused and nothing runs", async () => {
  const dir = home();
  const api = createEstateApi({
    quarantine: [],
    producer: { machine: MACHINE, dbPath: mapDbPath(dir, MACHINE), roots: () => ["C:"], collectors: fakeFiles() }
  });
  // The route reads the caller's address off req.socket, exactly as it does for a real request; a
  // LAN address cannot be produced from this machine's loopback, so the request object carries one.
  // It also carries every header a caller controls claiming loopback, because a check that trusted
  // one of them passed the first version of this test, which sent no headers (claude-s17-verifier).
  const answer = (remoteAddress) =>
    new Promise((resolve) => {
      const req = Object.assign(new PassThrough(), {
        method: "POST",
        url: "/api/estate/sweep",
        socket: { remoteAddress },
        headers: {
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.1",
          forwarded: "for=127.0.0.1"
        }
      });
      const res = {
        writeHead: (status) => ((res.status = status), res),
        end: (body) => resolve({ status: res.status, body: JSON.parse(body) })
      };
      api.tryHandle(req, res);
      req.end(JSON.stringify({ volumes: ["C:"] }));
    });
  for (const lan of ["192.168.68.125", "::ffff:10.0.0.4", "172.16.0.9"]) {
    const r = await answer(lan);
    assert.equal(r.status, 403, lan);
  }
  // the same request from this machine is let through — the refusal is about WHERE, not what
  assert.equal((await answer("::ffff:127.0.0.1")).status, 202);
  // and that sweep is waited for, so its database is closed before the temp home is removed
  const status = () =>
    new Promise((resolve) => {
      const res = { writeHead: () => res, end: (b) => resolve(JSON.parse(b)) };
      api.tryHandle({ method: "GET", url: "/api/estate/sweep" }, res);
    });
  while ((await status()).running) await new Promise((r) => setTimeout(r, 10));
});

// --- the panel's words ------------------------------------------------------------------------------

test("the Sweep control says what it is doing and why it cannot", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const ready = sweepView({ machine: "T480", roots: ["C:"], policy: true, running: null, last: null }, { now });
  assert.equal(ready.can, true);
  assert.deepEqual(ready.roots, ["C:"]);

  const running = sweepView(
    { machine: "T480", roots: ["C:"], policy: true, running: { volumes: ["F:"], since: "2026-10-03T11:57:00.000Z" } },
    { now }
  );
  assert.equal(running.can, false, "no second sweep offered while one runs");
  assert.equal(running.running, "Sweeping F: — started 3 minutes ago");

  const refused = sweepView(
    { policy: true, roots: [], last: { ok: false, volumes: ["F:"], at: "x", reason: "volume name (R31)" } },
    { now }
  );
  assert.match(refused.last, /did not reach the map: volume name \(R31\)/u);

  const absent = sweepView({ error: "this hub has no producer configured" });
  assert.equal(absent.can, false);
  assert.match(absent.why, /no producer configured/u);
  assert.equal(sweepView(null).can, false, "a hub that did not answer offers no button");
});
