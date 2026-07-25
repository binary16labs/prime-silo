// L3 acceptance — durability. Scenarios map 1:1 to delivery/tasks/L3.md gherkin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replicate, integrityCheck, restoreFromReplica } from "../../server/coordination/lib/durability.mjs";
import { initManifest, stageSession, resolveBlob } from "../../server/coordination/lib/staging.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dura-"));

function seedPrimary() {
  const primary = tmp();
  initManifest(primary, { machine: "t480", hardware: { gpu: "gfx1200" }, hlcNodeId: "mA" });
  // two sessions → two blobs + a ≥2-line KEL (so a line-0 tamper has a successor to betray it;
  // a single-line tamper is the documented last-line-undetectable limit, not a durability bug).
  for (const [sid, content] of [["sess_1", "raw session bytes one"], ["sess_2", "raw session bytes two"]])
    stageSession(primary, {
      sid, machine: "t480", process: "claude-code", project: "prime-silo",
      task_context: "EP-L/L3", valid_time: "2026-07-25T00:00:00Z", authorship: "house",
      content, links: {}
    });
  return primary;
}

test("Scenario: the substrate is replicated (byte-identical blobs + log lines)", () => {
  const primary = seedPrimary();
  const replica = tmp();
  const res = replicate(primary, replica);
  assert.ok(res.files > 0);

  // every blob is byte-identical
  const rel = "blobs/sha256";
  const machineHash = fs.readdirSync(path.join(primary, rel));
  for (const hh of machineHash) {
    for (const h of fs.readdirSync(path.join(primary, rel, hh))) {
      const a = fs.readFileSync(path.join(primary, rel, hh, h));
      const b = fs.readFileSync(path.join(replica, rel, hh, h));
      assert.deepEqual(b, a);
    }
  }
  // KEL log lines byte-identical
  const pl = fs.readFileSync(path.join(primary, "eventlog", "events.jsonl"), "utf8");
  const rl = fs.readFileSync(path.join(replica, "eventlog", "events.jsonl"), "utf8");
  assert.equal(rl, pl);
});

test("Scenario: corruption is detected, not silent (checksum names the blob)", () => {
  const primary = seedPrimary();
  const replica = tmp();
  replicate(primary, replica);

  // clean replica passes
  assert.equal(integrityCheck(replica).ok, true);

  // corrupt one replica blob (content no longer hashes to its content-addressed name)
  const rel = "blobs/sha256";
  const hh = fs.readdirSync(path.join(replica, rel))[0];
  const h = fs.readdirSync(path.join(replica, rel, hh))[0];
  fs.writeFileSync(path.join(replica, rel, hh, h), "TAMPERED");

  const chk = integrityCheck(replica);
  assert.equal(chk.ok, false);
  assert.ok(chk.mismatches.some((m) => m.blob.endsWith(h)));
});

test("Scenario: restore works from the replica alone (matches pre-failure state)", () => {
  const primary = seedPrimary();
  const replica = tmp();
  replicate(primary, replica);

  const before = restoreFromReplica(primary).map((s) => `${s.sid}:${s.blobs[0]}`).sort();
  // primary now unavailable — rebuild from the replica alone
  const restored = restoreFromReplica(replica).map((s) => `${s.sid}:${s.blobs[0]}`).sort();
  assert.deepEqual(restored, before);
  assert.ok(restored.length >= 1);
});

test("integrity: KEL chain break in the replica is reported", () => {
  const primary = seedPrimary();
  const replica = tmp();
  replicate(primary, replica);
  // tamper a KEL log line in the replica
  const p = path.join(replica, "eventlog", "events.jsonl");
  const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  const o = JSON.parse(lines[0]); o.machine = "evil"; lines[0] = JSON.stringify(o);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  const chk = integrityCheck(replica);
  assert.equal(chk.ok, false);
  assert.ok(chk.kelBroken);
});
