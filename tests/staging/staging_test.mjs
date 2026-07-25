// L1 acceptance — portable CAS staging. Scenarios map 1:1 to delivery/tasks/L1.md gherkin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initManifest,
  stageSession,
  openStaging,
  resolveBlob,
  blobFilesFor
} from "../../server/coordination/lib/staging.mjs";
import { readKelEvents } from "../../server/coordination/lib/kel.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-staging-"));

function session(over = {}) {
  return {
    sid: "sess_1",
    machine: "t480",
    process: "claude-code",
    project: "prime-silo",
    task_context: "EP-L/L1",
    valid_time: "2026-07-25T00:00:00Z",
    authorship: "house",
    content: "raw session bytes A",
    links: { cards: ["card:1"], concepts: ["concept:x"] },
    ...over
  };
}

test("Scenario: the same session synced twice is stored once", () => {
  const r = root();
  initManifest(r, { machine: "t480", hardware: { gpu: "gfx1200" }, hlcNodeId: "mA" });
  initManifest(r, { machine: "nuc", hardware: { gpu: "none" }, hlcNodeId: "mB" });

  const a = stageSession(r, session({ sid: "sess_A", machine: "t480", content: "IDENTICAL" }));
  const b = stageSession(r, session({ sid: "sess_B", machine: "nuc", content: "IDENTICAL" }));

  // identical content → identical hash → one blob, second is a de-dup hit
  assert.equal(a.hash, b.hash);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(blobFilesFor(r, a.hash).length, 1); // exactly one blob on disk

  // both index records point at the one blob
  for (const rec of [a.index, b.index]) assert.ok(rec.blobs.includes(`sha256:${a.hash}`));
});

test("Scenario: the drive attaches to any machine with no config", () => {
  const r = root();
  initManifest(r, { machine: "t480", hardware: { gpu: "gfx1200" }, hlcNodeId: "mA" });
  stageSession(r, session({ sid: "sess_X" }));

  // open with NO env / no per-machine configuration passed
  const opened = openStaging(r);
  assert.ok(opened.roots.blobs && opened.roots.index && opened.roots.eventlog);
  assert.ok(opened.machines.includes("t480"));
  assert.ok(opened.sessions.some((s) => s.sid === "sess_X"));
});

test("Scenario: a staged session is self-describing", () => {
  const r = root();
  initManifest(r, { machine: "t480", hardware: { gpu: "gfx1200" }, hlcNodeId: "mA" });
  const s = stageSession(r, session({ sid: "sess_D", process: "antigravity", task_context: "EP-L/L4" }));

  const rec = JSON.parse(fs.readFileSync(s.indexPath, "utf8"));
  assert.equal(rec.machine, "t480");
  assert.equal(rec.process, "antigravity");
  assert.equal(rec.project, "prime-silo");
  assert.equal(rec.task_context, "EP-L/L4");
  assert.equal(rec.sid, "sess_D");
  assert.deepEqual(rec.links.cards, ["card:1"]);
  assert.ok(rec.blobs.length === 1);
});

test("Scenario: staging needs no machine online (offline, KEL event emitted)", () => {
  const r = root();
  initManifest(r, { machine: "t480", hardware: { gpu: "gfx1200" }, hlcNodeId: "mA" });
  // pure filesystem, no network — completes and is admissible later via a session_staged KEL event
  const s = stageSession(r, session({ sid: "sess_off" }));
  assert.ok(fs.existsSync(resolveBlob(r, s.hash)));
  assert.ok(fs.existsSync(s.indexPath));

  const kel = readKelEvents(path.join(r, "eventlog", "events.jsonl"));
  assert.equal(kel.ok, true);
  const staged = kel.events.find((e) => e.type === "session_staged" && e.sid === "sess_off");
  assert.ok(staged, "a session_staged KEL event was emitted");
  assert.equal(staged.subject.content_hash, `sha256:${s.hash}`);
});

test("de-dup addressing: blob path is content-addressed (algo/hh/hash)", () => {
  const r = root();
  initManifest(r, { machine: "t480", hardware: {}, hlcNodeId: "mA" });
  const s = stageSession(r, session({ sid: "sess_h", content: "abc" }));
  const rel = path.relative(r, resolveBlob(r, s.hash)).split(path.sep).join("/");
  assert.match(rel, new RegExp(`^blobs/sha256/${s.hash.slice(0, 2)}/${s.hash}$`));
});
