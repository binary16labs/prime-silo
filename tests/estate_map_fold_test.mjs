// S3 — nodes push their map, the hub folds one estate map.
// Every Scenario in delivery/tasks/S3.md maps to a test here, plus the rules that keep the widened
// register surface honest: only counts and hashes cross, and a node that goes quiet is never empty.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildMapPayload,
  foldEstateMap,
  isNewer,
  machineView,
  mapPayloadProblem
} from "../server/coordination/lib/estate_map_fold.mjs";
import { register } from "../server/coordination/lib/estate_register.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";

const T = (h, m = 0) => `2026-09-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const push = (machine, at, over = {}) => ({
  machine,
  sweep_id: over.sweep_id ?? "01M31Y102Z4631D8992T33C1FW",
  finished_at: at,
  scope: over.scope ?? ["C:\\", "F:\\"],
  collectors: over.collectors ?? [
    { name: "everything", kind: "files", volume: "C:\\", status: "ok", rows: 2_214_964 },
    { name: "everything", kind: "files", volume: "F:\\", status: "ok", rows: 1_117_036 },
    { name: "registry", kind: "apps", volume: null, status: "ok", rows: 65 }
  ],
  counts: over.counts ?? {
    files: 3_331_000, bytes: 1_449_800_000_000, listed_files: 3_331_000,
    apps: 1073, listed_apps: 1073, media: 0, listed_media: 0
  },
  // deliberately NOT in size order: the biggest category must be found by ranking, not by position
  totals: over.totals ?? [
    { kind: "files", collector: "everything", volume: "C:\\", category: "code", items: 900, bytes: 100 },
    { kind: "files", collector: "everything", volume: "F:\\", category: "media", items: 400, bytes: 900 }
  ],
  digest: over.digest ?? "a".repeat(64),
  snapshot: over.snapshot ?? `sha256:${"b".repeat(64)}`
});

// --- Scenario: a node that stops pushing is stale, not empty ---------------------------------------

test("a node that stops pushing is stale since, not empty", () => {
  const fold = foldEstateMap([push("optimus", T(10))], {
    now: Date.parse(T(11)),
    maxAgeMs: 30 * 60_000
  });
  const m = fold.machines.optimus;
  assert.equal(m.stale, true);
  assert.equal(m.since, T(10), "stale SINCE the last thing it said");
  assert.equal(m.ageMs, 3_600_000);
  assert.deepEqual(Object.keys(m.volumes), ["C:\\", "F:\\"], "and its volumes are still shown");
  assert.equal(m.volumes["C:\\"].rows, 2_214_964, "with what it last reported");
  assert.equal(m.counts.apps, 1073);
});

test("a node inside the threshold is not stale and has no since", () => {
  const fold = foldEstateMap([push("t480", T(10, 45))], {
    now: Date.parse(T(11)),
    maxAgeMs: 30 * 60_000
  });
  assert.equal(fold.machines.t480.stale, false);
  assert.equal(fold.machines.t480.since, null);
});

// --- Scenario: a late older sweep does not overwrite a newer one -----------------------------------

test("a delayed older sweep never overwrites a newer one", () => {
  const noon = push("t480", T(12), { sweep_id: "01M31Y102Z4631D8992T33C1FW", digest: "c".repeat(64) });
  const eleven = push("t480", T(11), {
    sweep_id: "01M31Y102Z4631D8992T33C1FV",
    digest: "d".repeat(64),
    collectors: [
      { name: "walker", kind: "files", volume: "F:\\", status: "ok", rows: 7 }
    ]
  });
  for (const order of [[noon, eleven], [eleven, noon]]) {
    const m = foldEstateMap(order, { now: Date.parse(T(12, 1)) }).machines.t480;
    assert.equal(m.at, T(12), `the 12:00 sweep wins, arriving ${order[0] === noon ? "first" : "second"}`);
    assert.equal(m.digest, "c".repeat(64));
    assert.equal(m.volumes["F:\\"].rows, 1_117_036, "F: reflects the 12:00 sweep");
    assert.equal(m.volumes["F:\\"].collector, "everything");
  }
});

test("an older sweep still fills a volume the newer one never covered", () => {
  // the newer sweep only swept C:, so the hub's knowledge of D: is old — but it is knowledge
  const newer = push("t480", T(12), {
    scope: ["C:\\"],
    collectors: [{ name: "everything", kind: "files", volume: "C:\\", status: "ok", rows: 10 }]
  });
  const older = push("t480", T(11), {
    sweep_id: "01M31Y102Z4631D8992T33C1FV",
    collectors: [{ name: "walker", kind: "files", volume: "D:\\", status: "ok", rows: 4 }]
  });
  const m = foldEstateMap([newer, older], { now: Date.parse(T(12, 1)) }).machines.t480;
  assert.equal(m.volumes["C:\\"].rows, 10);
  assert.equal(m.volumes["D:\\"].rows, 4, "a drive the newer sweep did not cover is not forgotten");
  assert.equal(m.volumes["D:\\"].at, T(11), "and says how old it is");
});

test("two sweeps in the same millisecond fold the same whichever arrives first", () => {
  const a = push("t480", T(12), { sweep_id: "01AAAAAAAAAAAAAAAAAAAAAAAA", digest: "1".repeat(64) });
  const b = push("t480", T(12), { sweep_id: "01BBBBBBBBBBBBBBBBBBBBBBBB", digest: "2".repeat(64) });
  const one = foldEstateMap([a, b], { now: Date.parse(T(12)) }).machines.t480;
  const two = foldEstateMap([b, a], { now: Date.parse(T(12)) }).machines.t480;
  assert.deepEqual(one, two, "network ordering cannot change the map");
  assert.equal(one.sweep_id, "01BBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(isNewer(a, b), false);
  assert.equal(isNewer(b, a), true);
});

// --- Scenario: content cannot ride the register ----------------------------------------------------

const ctx = (over = {}) => ({
  key: "k",
  expectedKey: "k",
  remoteAddress: "192.168.0.108",
  hubHashes: [],
  ...over
});

test("a map payload carrying a file body is rejected and records nothing", () => {
  const bad = push("t480", T(12));
  bad.files = [{ path: "C:\\Users\\nsdha\\cv.docx", content: "…" }];
  const r = register({ satellites: {}, maps: [] }, { machine: "t480", map: bad }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown field: files/u);
  assert.deepEqual(r.state.maps, [], "nothing recorded");
  assert.deepEqual(r.state.satellites, {}, "and no last-seen either — the whole push is refused");
});

test("any field the allowlist does not name is refused, whatever it is called", () => {
  for (const field of ["paths", "body", "text", "notes", "extra", "__proto__x"]) {
    const bad = push("t480", T(12));
    bad[field] = "C:\\Users\\nsdha\\Documents\\salary.pdf";
    assert.match(
      mapPayloadProblem(bad) ?? "",
      new RegExp(`unknown field: ${field}`, "u"),
      `${field} must not ride the register`
    );
  }
});

test("a volume name is bounded, so a path cannot hide in one", () => {
  // the one path-shaped string allowed through is the volume a sweep ran on. Unbounded, it is a
  // place to put anything — a whole directory listing, or a file's bytes.
  const long = push("t480", T(12), { scope: ["F:\\" + "a".repeat(300)] });
  assert.match(mapPayloadProblem(long), /scope contains a volume name/u);
  const smuggled = push("t480", T(12), {
    collectors: [
      { name: "walker", kind: "files", volume: "C:\\" + "x".repeat(500), status: "ok", rows: 1 }
    ]
  });
  assert.match(mapPayloadProblem(smuggled), /collector names a volume name/u);
  const empty = push("t480", T(12), { scope: [""] });
  assert.match(mapPayloadProblem(empty), /scope contains a volume name/u);
  const notText = push("t480", T(12), { scope: [{ path: "C:\\secret" }] });
  assert.match(mapPayloadProblem(notText), /scope contains a volume name/u);
});

test("a rejection names the field, never the value", () => {
  const bad = push("t480", T(12));
  bad.secrets = "C:\\Users\\nsdha\\Documents\\cv.docx";
  const reason = mapPayloadProblem(bad);
  assert.match(reason, /secrets/u);
  assert.ok(!reason.includes("cv.docx"), "the rejection is not a side channel");
});

test("a volume the HUB calls private cannot be named by a node", () => {
  const p = push("t480", T(12), { scope: ["C:\\", "F:\\clients\\cv-archive"] });
  assert.equal(mapPayloadProblem(p, []), null, "the node's own rules let it through");
  assert.match(mapPayloadProblem(p, [/cv/iu]), /quarantined volume/u, "the hub's rules do not");
  const r = register({ satellites: {}, maps: [] }, { machine: "t480", map: p }, ctx({ quarantine: [/cv/iu] }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.state.maps, []);
});

test("a collector or total naming a quarantined volume is refused too", () => {
  const byCollector = push("t480", T(12), {
    collectors: [{ name: "walker", kind: "files", volume: "F:\\cv-archive", status: "ok", rows: 1 }]
  });
  assert.match(mapPayloadProblem(byCollector, [/cv/iu]), /collector names a quarantined volume/u);
  const byTotal = push("t480", T(12), {
    totals: [{ kind: "files", collector: "walker", volume: "F:\\cv-archive", category: "docs", items: 1, bytes: 2 }]
  });
  assert.match(mapPayloadProblem(byTotal, [/cv/iu]), /total names a quarantined volume/u);
});

test("a map cannot be pushed on another machine's behalf", () => {
  const r = register({ satellites: {}, maps: [] }, { machine: "optimus", map: push("t480", T(12)) }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /another machine/u);
  assert.deepEqual(r.state.maps, []);
});

test("the existing authentication and LAN gate still guard the map", () => {
  const manifest = { machine: "t480", map: push("t480", T(12)) };
  const unauth = register({ maps: [] }, manifest, ctx({ key: "wrong" }));
  assert.equal(unauth.ok, false);
  assert.equal(unauth.reason, "unauthenticated");
  const wan = register({ maps: [] }, manifest, ctx({ remoteAddress: "203.0.113.9" }));
  assert.equal(wan.ok, false);
  assert.match(wan.reason, /non-LAN/u);
  for (const r of [unauth, wan]) assert.deepEqual(r.state.maps ?? [], []);
});

// --- the shape of what may cross -------------------------------------------------------------------

test("a well-formed map is accepted and kept, not replaced", () => {
  let state = { satellites: {}, maps: [] };
  for (const at of [T(10), T(11), T(12)]) {
    const r = register(state, { machine: "t480", map: push("t480", at) }, ctx());
    assert.equal(r.ok, true, `push at ${at}`);
    state = r.state;
  }
  assert.equal(state.maps.length, 3, "every push is kept; the FOLD decides which sweep wins");
  assert.equal(state.satellites.t480.reachable, true);
});

test("counts must be counts and hashes must be hashes", () => {
  const cases = {
    "map field digest is not well formed": { digest: "not-a-hash" },
    "map field snapshot is not well formed": { snapshot: "file:///C:/Users/nsdha/cv.docx" },
    "map field machine is not well formed": { machine: "../../etc/passwd" },
    "map field sweep_id is not well formed": { sweep_id: "1" }
  };
  for (const [reason, over] of Object.entries(cases)) {
    const p = { ...push("t480", T(12)), ...over };
    assert.equal(mapPayloadProblem(p), reason);
  }
  const negative = push("t480", T(12));
  negative.counts = { ...negative.counts, files: -1 };
  assert.match(mapPayloadProblem(negative), /count files must be a count/u);
  const fractional = push("t480", T(12));
  fractional.collectors = [{ name: "e", kind: "files", volume: "C:\\", status: "ok", rows: 1.5 }];
  assert.match(mapPayloadProblem(fractional), /rows must be a count/u);
});

test("a map missing what the hub needs is refused, not folded half-known", () => {
  for (const key of ["machine", "sweep_id", "finished_at", "digest", "snapshot"]) {
    const p = push("t480", T(12));
    delete p[key];
    assert.equal(mapPayloadProblem(p), `map is missing ${key}`);
  }
});

test("the payload is built by enumerating fields, so a new sweep field cannot start travelling", () => {
  const sweep = {
    machine: "t480",
    id: "01M31Y102Z4631D8992T33C1FW",
    finishedAt: T(12),
    scope: ["C:\\"],
    collectors: [{ name: "everything", kind: "files", volume: "C:\\", status: "ok", rows: 3, note: "x" }],
    counts: { files: 3, bytes: 4, listed_files: 3, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
    digest: "e".repeat(64),
    // a field somebody adds to the sweep later; it must NOT appear on the wire
    workspacePath: "C:\\Users\\nsdha\\OneDrive\\binary16"
  };
  const payload = buildMapPayload(sweep, { snapshot: `sha256:${"f".repeat(64)}` });
  assert.ok(!("workspacePath" in payload));
  assert.ok(!("note" in payload.collectors[0]));
  assert.equal(mapPayloadProblem(payload), null, "and what it does build passes the guard");
  assert.equal(payload.counts.listed_media, 0, "every count is present, defaulting to 0");
});

// --- the per-machine view ---------------------------------------------------------------------------

test("a machine view ranks its biggest categories", () => {
  const fold = foldEstateMap([push("t480", T(12))], { now: Date.parse(T(12)) });
  const view = machineView(fold, "t480", { topCategories: 1 });
  assert.equal(view.categories.length, 1);
  assert.deepEqual(view.categories[0], { category: "media", items: 400, bytes: 900 });
  assert.deepEqual(Object.keys(view.volumes), ["C:\\", "F:\\"]);
});

test("a machine the hub never heard from is unknown, not empty", () => {
  const fold = foldEstateMap([push("t480", T(12))], { now: Date.parse(T(12)) });
  assert.equal(machineView(fold, "optimus"), null);
});

// --- the route, over a real socket -------------------------------------------------------------------

function serve(t, options) {
  const api = createEstateApi(options);
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  return new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
}

const call = (port, path, body) =>
  new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: body ? "POST" : "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") }));
      }
    );
    req.end(body ? JSON.stringify(body) : undefined);
  });

test("a pushed map is served at /api/estate/map and per machine", async (t) => {
  const port = await serve(t, { registerKey: "k", mapMaxAgeMs: 30 * 60_000 });
  const pushed = await call(port, "/api/estate/register", {
    key: "k",
    manifest: { machine: "t480", map: push("t480", new Date().toISOString()) }
  });
  assert.equal(pushed.status, 200);

  const map = await call(port, "/api/estate/map");
  assert.equal(map.status, 200);
  assert.equal(map.body.machines.t480.stale, false);
  assert.equal(map.body.machines.t480.counts.apps, 1073);

  const machine = await call(port, "/api/estate/map/t480");
  assert.equal(machine.status, 200);
  assert.equal(machine.body.volumes["F:\\"].rows, 1_117_036);
  assert.equal(machine.body.categories[0].category, "media");

  const missing = await call(port, "/api/estate/map/optimus");
  assert.equal(missing.status, 404, "a machine that never pushed is not an empty machine");
});

test("a refused push leaves the served map untouched", async (t) => {
  const port = await serve(t, { registerKey: "k", quarantine: [/cv/iu] });
  const bad = push("t480", new Date().toISOString(), { scope: ["F:\\cv-archive"] });
  const refused = await call(port, "/api/estate/register", {
    key: "k",
    manifest: { machine: "t480", map: bad }
  });
  assert.equal(refused.status, 401);
  const map = await call(port, "/api/estate/map");
  assert.deepEqual(map.body.machines, {}, "nothing was recorded");
});
