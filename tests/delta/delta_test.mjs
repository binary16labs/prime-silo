// L4 acceptance — delta engine (per-content-hash cursors). Scenarios ↔ delivery/tasks/L4.md gherkin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cursorKey,
  foldCursors,
  recordCursor,
  processDelta,
  applyInValidTimeOrder
} from "../../server/coordination/lib/delta.mjs";
import { readKelEvents } from "../../server/coordination/lib/kel.mjs";

const logfile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "delta-")), "events.jsonl");
const input = (hash, over = {}) => ({
  content_hash: hash,
  valid_time: "2026-01-01T00:00:00Z",
  hlc: "2026-01-01T00:00:00.000Z-0000-t480",
  ...over
});
const CFG = { stage: "graph", codeCommit: "abc123", configHash: "cfg1" };

test("Scenario: unchanged content is never reprocessed", () => {
  const f = logfile();
  recordCursor(f, { ...CFG, inputContentHash: "hashX", outputs: ["out1"] }); // pre-existing done cursor
  const ran = [];
  const r = processDelta(f, [input("hashX")], {
    ...CFG,
    run: (i) => {
      ran.push(i.content_hash);
      return [];
    }
  });
  assert.deepEqual(r.skipped, ["hashX"]);
  assert.deepEqual(r.processed, []);
  assert.deepEqual(ran, []); // run() was never invoked
});

test("Scenario: a duplicated run converges (one cursor, same outputs)", () => {
  const f = logfile();
  const run = (i) => [`out:${i.content_hash}`];
  const first = processDelta(f, [input("hashY")], { ...CFG, run });
  const second = processDelta(f, [input("hashY")], { ...CFG, run });
  assert.deepEqual(first.processed, ["hashY"]);
  assert.deepEqual(second.skipped, ["hashY"]);

  const { events } = readKelEvents(f);
  const key = cursorKey({
    stage: CFG.stage,
    inputContentHash: "hashY",
    codeCommit: CFG.codeCommit,
    configHash: CFG.configHash
  });
  const forKey = events.filter((e) => e.type === "cursor_advanced" && e.subject.id === key);
  assert.equal(forKey.length, 1); // exactly one done cursor
  assert.deepEqual(foldCursors(events).get(key).outputs, ["out:hashY"]);
});

test("Scenario: an interrupted run resumes (only the not-yet-done inputs)", () => {
  const f = logfile();
  recordCursor(f, { ...CFG, inputContentHash: "hA", outputs: ["oA"] }); // hA done before the "interruption"
  const ran = [];
  const r = processDelta(f, [input("hA"), input("hB")], {
    ...CFG,
    run: (i) => {
      ran.push(i.content_hash);
      return [`o:${i.content_hash}`];
    }
  });
  assert.deepEqual(r.skipped, ["hA"]);
  assert.deepEqual(r.processed, ["hB"]);
  assert.deepEqual(ran, ["hB"]); // only hB was processed on resume
});

test("Scenario: out-of-order arrival resolves by valid-time (HLC), not arrival order", () => {
  // arrival order is [later, earlier]; valid-time order is [earlier, later]
  const later = input("hLate", {
    valid_time: "2026-03-01T00:00:00Z",
    hlc: "2026-03-01T00:00:00.000Z-0000-t480"
  });
  const earlier = input("hEarly", {
    valid_time: "2026-02-01T00:00:00Z",
    hlc: "2026-02-01T00:00:00.000Z-0000-t480"
  });
  const ordered = applyInValidTimeOrder([later, earlier]);
  assert.deepEqual(
    ordered.map((x) => x.content_hash),
    ["hEarly", "hLate"]
  );
});

test("a config or commit change invalidates the cursor (input reprocessed)", () => {
  const f = logfile();
  processDelta(f, [input("hZ")], { ...CFG, run: () => ["o"] }); // done at cfg1/abc123
  const r = processDelta(f, [input("hZ")], { ...CFG, configHash: "cfg2", run: () => ["o"] }); // different config
  assert.deepEqual(r.processed, ["hZ"]); // reprocessed — the cursor key changed
});
