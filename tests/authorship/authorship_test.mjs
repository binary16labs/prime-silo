// L6 acceptance — authorship provenance + record-served tagging. Scenarios ↔ delivery/tasks/L6.md.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTHORSHIP,
  validateAuthorship,
  requireAuthorship,
  recordServed,
  readServed
} from "../../server/coordination/lib/authorship.mjs";
import { buildRegister, fromG0Run } from "../../server/coordination/lib/exec_register.mjs";
import { initManifest, stageSession } from "../../server/coordination/lib/staging.mjs";
import { readKelEvents } from "../../server/coordination/lib/kel.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "auth-"));

test("Scenario: every capture carries authorship (staged session + execution record)", () => {
  const root = tmp();
  initManifest(root, { machine: "t480", hardware: {}, hlcNodeId: "mA" });
  const s = stageSession(root, {
    sid: "sess_h",
    machine: "t480",
    process: "house-trainer",
    project: "prime-silo",
    task_context: "EP-L/L6",
    valid_time: "2026-07-25T00:00:00Z",
    authorship: "house",
    content: "raw",
    links: {}
  });
  // the staged index record carries authorship
  assert.equal(JSON.parse(fs.readFileSync(s.indexPath, "utf8")).authorship, "house");
  // the session_staged KEL event carries authorship
  const kel = readKelEvents(path.join(root, "eventlog", "events.jsonl"));
  assert.equal(kel.events.find((e) => e.type === "session_staged").authorship, "house");
  // the execution record carries authorship
  const rec = fromG0Run({
    run_id: "r1",
    machine: "t480",
    kind: "offload",
    valid_time: "2026-07-25T00:00:00Z",
    txn_time: "2026-07-25T00:01:00Z",
    hlc: "h",
    authorship: "house",
    events: []
  });
  assert.equal(rec.authorship, "house");
});

test("Scenario: an untagged record is refused", () => {
  const untagged = { exec_id: "x", kind: "offload" }; // no authorship
  const r = requireAuthorship(untagged);
  assert.equal(r.ok, false);
  assert.match(r.reason, /authorship/);
  // strict register build rejects an untagged record too
  const dir = tmp();
  assert.throws(() =>
    buildRegister(
      path.join(dir, "executions.jsonl"),
      {
        coordEvents: [
          {
            id: "01J",
            type: "task_done",
            agent: "claude",
            ts: "2026-07-25T00:00:00Z",
            machine: "t480"
          }
        ]
      },
      { strict: true }
    )
  );
});

test("Scenario: the served position is recorded with its predecessor", () => {
  const dir = tmp();
  const p = path.join(dir, "served.json");
  const ptr = recordServed(p, {
    served: "house/qwen2.5-coder-tuned",
    replaces: "house/qwen2.5-coder-prev"
  });
  assert.equal(ptr.served, "house/qwen2.5-coder-tuned");
  assert.equal(ptr.replaces, "house/qwen2.5-coder-prev");
  assert.equal(ptr.rollback_to, "house/qwen2.5-coder-prev"); // revert target recorded
  assert.equal(readServed(p).served, "house/qwen2.5-coder-tuned");
});

test("authorship is constrained to the three-value set", () => {
  assert.deepEqual([...AUTHORSHIP].sort(), ["frontier", "house", "human"]);
  assert.equal(validateAuthorship("house"), true);
  assert.equal(validateAuthorship("frontier"), true);
  assert.equal(validateAuthorship("human"), true);
  assert.equal(validateAuthorship("alien"), false);
  assert.equal(validateAuthorship(undefined), false);
});
