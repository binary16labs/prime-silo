// N1 acceptance — estate probes. Every Scenario in delivery/tasks/N1.md maps to a test
// named after it. Pure functions over injected inputs: no fs, no network, no hardware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { driveDrift, topology, liveness, sessionStats } from "../../server/coordination/lib/estate_probe.mjs";

test("Scenario: drive drift verdict", () => {
  // in-sync: snapshot matches its manifest and the live source
  assert.equal(driveDrift({ manifestFingerprint: "fp1", snapshotFingerprint: "fp1", liveFingerprint: "fp1" }), "INTACT");
  // live has moved on → DRIFT
  assert.equal(driveDrift({ manifestFingerprint: "fp1", snapshotFingerprint: "fp1", liveFingerprint: "fp2" }), "DRIFT");
  // snapshot no longer matches its own manifest → CORRUPT (takes precedence over drift)
  assert.equal(driveDrift({ manifestFingerprint: "fp1", snapshotFingerprint: "bad", liveFingerprint: "fp2" }), "CORRUPT");
});

test("Scenario: hub and satellite topology", () => {
  const t = topology(
    [{ name: "t480", role: "hub" }, { name: "asus", role: "satellite" }],
    { t480: true, asus: false }
  );
  assert.equal(t.hub, "t480", "exactly the trainer is the hub");
  assert.deepEqual(t.satellites, ["asus"], "the pulled-over-SMB laptop is a satellite");
  assert.equal(t.wellFormed, true, "exactly one hub");
  const asus = t.nodes.find((n) => n.name === "asus");
  assert.equal(asus.reachable, false, "the satellite carries its reachability state");
});

test("Scenario: liveness by resource not log", () => {
  // CPU-time did not advance, no new artifacts, but the log mtime is fresh
  const a = { cpuMs: 1000, artifacts: 3, logMtime: 100 };
  const b = { cpuMs: 1000, artifacts: 3, logMtime: 999999 }; // only the log moved
  const r = liveness(a, b);
  assert.equal(r.alive, false, "a fresh log line is not proof of life");
  assert.equal(r.stalled, true);
  // flip one real resource → alive
  assert.equal(liveness(a, { ...b, cpuMs: 1500 }).alive, true, "advancing CPU-time proves life");
});

test("Scenario: per-machine session stats exclude quarantine", () => {
  const estate = {
    sessions: {
      "sha256:a": { sid: "s1", quarantined: false, drives: ["t480:D", "t480:F"] },
      "sha256:b": { sid: "s2", quarantined: false, drives: ["asus:local"] },
      "sha256:cv": { sid: "q", quarantined: true, drives: ["asus:local"] }
    }
  };
  const stats = sessionStats(estate);
  // t480: one session across two of its drives counts once for the machine
  assert.deepEqual(stats.t480, { total: 1, usable: 1, quarantined: 0 });
  // asus: two sessions, one quarantined → usable excludes it
  assert.deepEqual(stats.asus, { total: 2, usable: 1, quarantined: 1 });
});
