// N0 acceptance — content-addressed estate sync. Every Scenario in delivery/tasks/N0.md
// maps to a test named after it. Hermetic: OS temp dirs, no network, no hardware.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readKelEvents } from "../../server/coordination/lib/kel.mjs";
import {
  buildEstate,
  rebuildEstateFile,
  serializeEstate,
  isEstateSubjectId
} from "../../server/coordination/lib/estate.mjs";
import { syncSource } from "../../server/coordination/lib/estate_sync.mjs";

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "n0-"));
  return {
    dir: d,
    kel: path.join(d, "kel.jsonl"),
    staging: path.join(d, "staging"),
    out: path.join(d, "estate.jsonl")
  };
}
const estateEventCount = (kel) =>
  readKelEvents(kel).events.filter((e) => isEstateSubjectId(e.subject?.id)).length;
const lineCount = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim()).length
    : 0;

test("Scenario: overlap dedupes by content", () => {
  const t = tmp();
  // same content "REPORT-BODY" present on the D: portable copy (sid s1) and the F: backup (sid s2)
  syncSource(t.kel, t.staging, {
    machine: "t480",
    driveLabel: "D",
    driveRole: "replica",
    machineRole: "hub",
    sessions: [{ sid: "s1", content: "REPORT-BODY", project: "p" }]
  });
  syncSource(t.kel, t.staging, {
    machine: "t480",
    driveLabel: "F",
    driveRole: "source",
    machineRole: "hub",
    sessions: [{ sid: "s2", content: "REPORT-BODY", project: "p" }]
  });

  const est = buildEstate(readKelEvents(t.kel).events);
  const sessions = Object.keys(est.sessions);
  assert.equal(sessions.length, 1, "identical content from two sids must be ONE session entry");
  assert.deepEqual(
    est.sessions[sessions[0]].drives,
    ["t480:D", "t480:F"],
    "the one session is referenced by BOTH drives"
  );
});

test("Scenario: delta-only re-sync", () => {
  const t = tmp();
  const src = {
    machine: "asus",
    driveLabel: "local",
    machineRole: "satellite",
    sessions: [{ sid: "a1", content: "SESSION-A" }]
  };
  const first = syncSource(t.kel, t.staging, src);
  const linesAfterFirst = lineCount(t.kel);
  const eventsAfterFirst = estateEventCount(t.kel);

  const second = syncSource(t.kel, t.staging, src); // nothing changed

  assert.equal(first.stored, 1, "first sync stores the blob");
  assert.equal(second.stored, 0, "re-sync stores no new blob");
  assert.equal(second.deduped, 1, "re-sync sees the content already stored (deduped)");
  assert.equal(second.sessionsNew, 0, "re-sync emits no new session event");
  assert.equal(
    estateEventCount(t.kel),
    eventsAfterFirst,
    "no new estate KEL event on an unchanged re-sync"
  );
  assert.equal(
    lineCount(t.kel),
    linesAfterFirst,
    "an unchanged re-sync appends nothing to the log"
  );
});

test("Scenario: changed content reprocesses", () => {
  const t = tmp();
  syncSource(t.kel, t.staging, {
    machine: "t480",
    driveLabel: "D",
    sessions: [
      { sid: "s1", content: "V1" },
      { sid: "keep", content: "KEEP" }
    ]
  });
  const r = syncSource(t.kel, t.staging, {
    machine: "t480",
    driveLabel: "D",
    sessions: [
      { sid: "s1", content: "V2" },
      { sid: "keep", content: "KEEP" }
    ]
  });

  assert.equal(r.sessionsNew, 1, "exactly the changed session is reprocessed");
  assert.equal(r.sessionsSkipped, 1, "the unchanged session is skipped");
  const est = buildEstate(readKelEvents(t.kel).events);
  // V1 (superseded, still logged), V2 (new), KEEP (unchanged) = 3 distinct content entries
  assert.equal(
    Object.keys(est.sessions).length,
    3,
    "changed content is a new entry; nothing is lost"
  );
});

test("Scenario: the projection rebuilds from the log", () => {
  const t = tmp();
  syncSource(t.kel, t.staging, {
    machine: "t480",
    driveLabel: "F",
    driveRole: "source",
    machineRole: "hub",
    sessions: [
      { sid: "s1", content: "A" },
      { sid: "s2", content: "B" }
    ]
  });
  syncSource(t.kel, t.staging, {
    machine: "asus",
    driveLabel: "local",
    machineRole: "satellite",
    sessions: [
      { sid: "a1", content: "A" },
      { sid: "q", content: "CV", quarantined: true }
    ]
  });

  const r1 = rebuildEstateFile(t.kel, t.out);
  assert.ok(r1.ok);
  const bytes1 = fs.readFileSync(t.out, "utf8");
  fs.rmSync(t.out);
  const r2 = rebuildEstateFile(t.kel, t.out);
  assert.ok(r2.ok);
  const bytes2 = fs.readFileSync(t.out, "utf8");
  assert.equal(bytes2, bytes1, "rebuilding from the same log is byte-identical");
  assert.equal(serializeEstate(r1.estate), bytes1, "serialize is deterministic");

  // and the quarantine flag rides through the projection (privacy: flag, not content)
  const est = r2.estate;
  const cv = Object.values(est.sessions).find((s) => s.quarantined);
  assert.ok(cv, "quarantined session is flagged in the estate");
  assert.equal(cv.sid, "q");
});
