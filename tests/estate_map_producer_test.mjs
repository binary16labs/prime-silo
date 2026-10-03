// S17 — the map gets a producer. Every Scenario in delivery/tasks/S17.md maps to a test here, and
// each is driven through the hub's real routes rather than by calling the pieces it is made of.
import assert from "node:assert/strict";
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
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "s17-home-"));

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

async function hub({ quarantine = ["cv", "payroll"], roots = ["C:", "F:"], collectors = fakeFiles(), dir = home() } = {}) {
  const api = createEstateApi({
    quarantine,
    producer: { machine: MACHINE, dbPath: mapDbPath(dir, MACHINE), roots: () => roots, collectors }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/estate`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body ? { method: "POST", body: JSON.stringify(body) } : {});
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
  // A volume name three segments deep is not a volume (S3's allowlist). runSweep does not judge
  // names; mapPayloadProblem does, inside acceptMap. So if this is refused, the local sweep went
  // through the same function a satellite's push does.
  const h = await hub({ roots: ["F:\\a\\b\\c"] });
  try {
    assert.equal((await h.call("/sweep", { volumes: ["F:\\a\\b\\c"] })).status, 202);
    const done = await h.settled();
    assert.equal(done.last.ok, false, "a map the wire would refuse is refused from the hub too");
    assert.match(done.last.reason, /volume name \(R31\)/u);
    assert.deepEqual(Object.keys((await h.call("/map")).body.machines), []);
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
  const answer = (remoteAddress) =>
    new Promise((resolve) => {
      const req = Object.assign(new PassThrough(), {
        method: "POST",
        url: "/api/estate/sweep",
        socket: { remoteAddress }
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
