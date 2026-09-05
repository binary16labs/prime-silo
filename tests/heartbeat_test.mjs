// The estate heartbeat — noticing silence.
//
// On 2026-09-04 the t480's Benny stopped and nothing surfaced it for about twelve hours.
// Every component reported correctly; there was simply nothing asking. So the tests that
// matter here are not "does a probe return true" — they are:
//
//   1. Does an outage get NOTICED, with a start time? "benny is down" is a fact. "benny has
//      been down for eleven hours" is the thing that gets someone's attention, and it is
//      impossible without recording when the state changed rather than when we last looked.
//
//   2. Does a quiet estate stay quiet in the LEDGER? Polling three nodes every minute is
//      ~86,000 observations a day. If those are written, the events that mean something are
//      buried under the ones that mean "still fine" and the hash chain gets expensive to
//      verify. A test that only proved "events are emitted" would pass on that bug.
//
// Probes are injected, so the estate here is a fixture and no network is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import {
  sweep,
  recordHeartbeat,
  buildHealth,
  outages,
  longestSilence,
  HEARTBEAT_TYPES
} from "../server/coordination/lib/heartbeat.mjs";

const TARGETS = [
  {
    machine: "t480",
    host: "10.0.0.1",
    services: [
      { name: "benny", port: 8005, kind: "http", path: "/h" },
      { name: "neo4j", port: 7474, kind: "tcp" }
    ]
  },
  { machine: "optimus", host: "10.0.0.2", services: [{ name: "benny", port: 8005, kind: "tcp" }] }
];

// a fake estate: `down` is a set of "machine/service" keys that should fail
const proberFor = (down = new Set()) => {
  const calls = [];
  const probe = async ({ host, port, name }) => {
    calls.push(`${host}:${port}`);
    const machine = host === "10.0.0.1" ? "t480" : "optimus";
    const isDown = down.has(`${machine}/${name}`);
    return { up: !isDown, ms: 3, reason: isDown ? "ECONNREFUSED" : null };
  };
  return { probe, calls };
};

const logIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hb-")), "heartbeat.jsonl");

test("a sweep reports every service and rolls up node reachability", async () => {
  const { probe } = proberFor(new Set(["t480/benny"]));
  const state = await sweep(TARGETS, { probe });

  assert.equal(state["t480/benny"].up, false);
  assert.equal(state["t480/neo4j"].up, true);
  // the node is still reachable because something on it answered — "the box is gone" and
  // "one service died" are different problems
  assert.equal(state["t480"].up, true);
  assert.equal(state["optimus"].up, true);
});

test("a node with nothing answering reads as unreachable", async () => {
  const { probe } = proberFor(new Set(["optimus/benny"]));
  const state = await sweep(TARGETS, { probe });
  assert.equal(state["optimus"].up, false);
});

test("a quiet estate writes NOTHING to the ledger", async () => {
  // The bug this guards: recording observations instead of transitions. If it regresses the
  // log grows every sweep and the chain fills with "still fine".
  const log = logIn();
  const { probe } = proberFor();
  const first = await sweep(TARGETS, { probe });
  const r1 = recordHeartbeat(log, {}, first); // baseline — first sight of each key
  assert.equal(r1.events.length > 0, true, "the first sweep must establish a baseline");

  const second = await sweep(TARGETS, { probe });
  const r2 = recordHeartbeat(log, first, second);
  assert.equal(r2.quiet, true);
  assert.deepEqual(r2.transitions, []);
  assert.equal(r2.events.length, 0, "an unchanged estate must not append a single event");
});

test("an outage is recorded once, with the moment it started", async () => {
  const log = logIn();
  const healthy = proberFor();
  const broken = proberFor(new Set(["t480/benny"]));

  const s1 = await sweep(TARGETS, { probe: healthy.probe });
  recordHeartbeat(log, {}, s1);
  const before = readKelEvents(log).events.length;

  const s2 = await sweep(TARGETS, { probe: broken.probe });
  const r = recordHeartbeat(log, s1, s2);

  const changed = r.transitions.map((t) => t.key);
  assert.deepEqual(changed, ["t480/benny"], "only the thing that changed is recorded");
  assert.equal(r.events[0].type, HEARTBEAT_TYPES.service);
  assert.equal(r.events[0].payload.from, "up");
  assert.equal(r.events[0].payload.to, "down");
  assert.equal(readKelEvents(log).events.length, before + 1);

  // and it stays one event while the outage continues
  const s3 = await sweep(TARGETS, { probe: broken.probe });
  const r3 = recordHeartbeat(log, s2, s3);
  assert.equal(r3.quiet, true, "an ongoing outage is not re-reported every minute");
});

test("the twelve-hour silence would have been visible", async () => {
  // The actual incident, replayed: benny goes down and nothing else changes for 12 hours.
  const log = logIn();
  const healthy = proberFor();
  const broken = proberFor(new Set(["t480/benny"]));

  const s1 = await sweep(TARGETS, { probe: healthy.probe });
  recordHeartbeat(log, {}, s1);

  const s2 = await sweep(TARGETS, { probe: broken.probe });
  // stamp the transition as having happened 12 hours ago
  const wentDownAt = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  for (const v of Object.values(s2)) v.observed_at = wentDownAt;
  recordHeartbeat(log, s1, s2);

  const evts = readKelEvents(log).events;
  const worst = longestSilence(evts);
  assert.equal(worst.key, "t480/benny");
  assert.ok(worst.hours >= 11.9 && worst.hours <= 12.1, `expected ~12h, got ${worst.hours}`);

  // and nothing healthy is reported as an outage
  assert.deepEqual(
    outages(evts).map((o) => o.key),
    ["t480/benny"]
  );
});

test("recovery clears the outage and restarts the clock", async () => {
  const log = logIn();
  const healthy = proberFor();
  const broken = proberFor(new Set(["t480/benny"]));

  const s1 = await sweep(TARGETS, { probe: healthy.probe });
  recordHeartbeat(log, {}, s1);
  const s2 = await sweep(TARGETS, { probe: broken.probe });
  recordHeartbeat(log, s1, s2);
  assert.equal(outages(readKelEvents(log).events).length, 1);

  const s3 = await sweep(TARGETS, { probe: healthy.probe });
  const r = recordHeartbeat(log, s2, s3);
  assert.equal(r.transitions[0].to, "up");
  assert.deepEqual(outages(readKelEvents(log).events), []);

  const health = buildHealth(readKelEvents(log).events).find((h) => h.key === "t480/benny");
  assert.equal(health.up, true);
  assert.equal(health.since, s3["t480/benny"].observed_at, "since must move on recovery");
});

test("a threshold suppresses blips without hiding real outages", async () => {
  const log = logIn();
  const healthy = proberFor();
  const broken = proberFor(new Set(["t480/benny"]));
  const s1 = await sweep(TARGETS, { probe: healthy.probe });
  recordHeartbeat(log, {}, s1);
  const s2 = await sweep(TARGETS, { probe: broken.probe });
  recordHeartbeat(log, s1, s2);

  const evts = readKelEvents(log).events;
  assert.equal(outages(evts, { thresholdMs: 0 }).length, 1);
  assert.equal(
    outages(evts, { thresholdMs: 5 * 60 * 1000 }).length,
    0,
    "a fresh blip is below the line"
  );
});

test("the observer is recorded separately from the observed", () => {
  // "optimus says the t480 is down" is a different claim from "the t480 says so" — and when
  // a node cannot report on itself, only the first kind is available.
  const log = logIn();
  const state = {
    "t480/benny": {
      machine: "t480",
      service: "benny",
      up: false,
      observed_at: new Date().toISOString()
    }
  };
  const r = recordHeartbeat(log, {}, state, { observer: "optimus" });
  assert.equal(r.events[0].payload.observed_by, "optimus");
  assert.equal(r.events[0].machine, "t480");
  assert.equal(r.events[0].authorship, "house");
});

test("loopback services are never probed across the estate", async () => {
  // The live sweep on 2026-09-05 reported t480/benny and t480/neo4j DOWN over the tailnet
  // while both were up on localhost — they bind loopback by deliberate default. A monitor
  // that raises false alarms on its two most important services teaches you to ignore it,
  // so cross-node probing must exclude them and self-observation must include them.
  const { localTargets, estateTargets, ESTATE_TARGETS } =
    await import("../server/coordination/lib/heartbeat.mjs");

  const remote = estateTargets(ESTATE_TARGETS, { exclude: "t480" });
  const remoteNames = remote.flatMap((t) => t.services.map((s) => s.name));
  assert.equal(remoteNames.includes("benny"), false, "benny must not be probed cross-node");
  assert.equal(remoteNames.includes("neo4j"), false, "neo4j must not be probed cross-node");
  assert.equal(remoteNames.includes("memoray"), true, "memoray does bind off-box");
  assert.equal(
    remote.some((t) => t.machine === "t480"),
    false,
    "a node does not probe itself remotely"
  );

  const mine = localTargets("t480");
  assert.equal(mine[0].host, "127.0.0.1");
  assert.deepEqual(
    mine[0].services.map((s) => s.name).sort(),
    ["benny", "memoray", "neo4j"],
    "a node observes everything it hosts, over loopback"
  );
});

test("a heartbeat that has stopped running is not mistaken for good news", async () => {
  // The original failure in a new costume: if the sweeps stop, there are no transitions, no
  // outages and a clean board — identical to a perfectly healthy estate. The liveness stamp
  // is what separates "nothing is wrong" from "nobody has looked since 09:14".
  const { isHeartbeatStale } = await import("../server/coordination/lib/heartbeat.mjs");
  const now = new Date("2026-09-05T12:00:00.000Z");

  const fresh = isHeartbeatStale({ last_run: "2026-09-05T11:56:00.000Z" }, { now });
  assert.equal(fresh.stale, false);

  const stopped = isHeartbeatStale({ last_run: "2026-09-05T00:00:00.000Z" }, { now });
  assert.equal(stopped.stale, true);
  assert.equal(stopped.reason, "sweeps have stopped");
  assert.equal(stopped.ageMs, 12 * 3600 * 1000);

  // never having run at all is the worst case, not the best one
  assert.equal(isHeartbeatStale({}, { now }).stale, true);
  assert.equal(isHeartbeatStale({}, { now }).reason, "never run");
});

test("heartbeat events form a valid KEL chain", () => {
  const log = logIn();
  const t0 = new Date().toISOString();
  recordHeartbeat(
    log,
    {},
    {
      "t480/benny": { machine: "t480", service: "benny", up: true, observed_at: t0 },
      t480: { machine: "t480", service: null, up: true, observed_at: t0 }
    }
  );
  const read = readKelEvents(log);
  assert.equal(read.ok, true, "chain must verify");
  assert.equal(read.events.length, 2);
  assert.equal(read.events.find((e) => e.type === HEARTBEAT_TYPES.node).subject.kind, "node");
});
