// N4 acceptance — cross-machine drift delta. Every Scenario in delivery/tasks/N4.md maps to a
// test named after it. Pure functions over injected inputs: no fs, no network, no hardware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { driftDelta, executionDrift } from "../../server/coordination/lib/estate_drift.mjs";

test("Scenario: actionable delta excludes overlap", () => {
  const hub = ["h1", "h2"];
  const satellite = [
    { sid: "s2", contentHash: "h2" }, // already in the hub → excluded
    { sid: "s3", contentHash: "h3" },
    { sid: "s4", contentHash: "h4" }
  ];
  const d = driftDelta(hub, satellite, []);
  assert.deepEqual(d.clean.sort(), ["s3", "s4"], "clean = sids the hub lacks");
  assert.equal(d.overlap, 1, "the already-present session is counted as overlap, not delta");
  assert.equal(d.quarantined.count, 0);
  assert.equal(d.total, 3);
});

test("Scenario: quarantined sessions are counted, never surfaced", () => {
  const hub = ["h1"];
  const satellite = [
    { sid: "s3", contentHash: "h3" },
    { sid: "q", contentHash: "hq", quarantined: true }, // job/CV — held out
    { sid: "q2", contentHash: "hq2" } // quarantined via the injected set
  ];
  const d = driftDelta(hub, satellite, ["q2"]);
  assert.equal(d.quarantined.count, 2, "both quarantined sessions are counted");
  assert.ok(
    !d.clean.includes("q") && !d.clean.includes("q2"),
    "no quarantined sid appears in clean"
  );
  assert.deepEqual(d.clean, ["s3"], "only the clean, absent session is a sync candidate");
  // R31: the returned shape must not leak a quarantined sid or its content anywhere
  assert.equal(JSON.stringify(d).includes("hq"), false, "no quarantined content-hash surfaces");
  assert.equal(JSON.stringify(d).includes('"q"'), false, "no quarantined sid surfaces");
});

test("Scenario: execution drift by content-hash", () => {
  const hub = ["e1"];
  const satelliteRegister = [
    { id: "x", hash: "e1" }, // hub already recorded it
    { id: "y", hash: "e2" } // ran on the satellite, hub has not seen it
  ];
  const drift = executionDrift(hub, satelliteRegister);
  assert.deepEqual(drift, [{ id: "y", hash: "e2" }], "only the unseen execution is returned");
});

test("Scenario: privacy holds even when a quarantined session is otherwise a clean delta", () => {
  // a quarantined session absent from the hub would be a 'clean' candidate but for R31 —
  // it must be counted and withheld, never promoted into clean.
  const d = driftDelta([], [{ sid: "cv", contentHash: "hcv", quarantined: true }], []);
  assert.deepEqual(d.clean, [], "a quarantined absent session is never a sync candidate");
  assert.equal(d.quarantined.count, 1);
});
