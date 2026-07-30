// N3 acceptance — drill-down + board & LONGVIEW tie-in. Each Scenario in delivery/tasks/N3.md
// maps to a named test. Pure functions + a static page check; hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  boardLanes,
  drillMachine,
  longviewProgress
} from "../../server/coordination/lib/estate_api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Scenario: board lane in the console", () => {
  const board = [
    "## READY  (take from the top)",
    "- N9 — first ready thing · claude · 2026-07-27",
    "- X1 — second ready · a · b",
    "## CLAIMED (agent · date)",
    "- Y1 — a claimed task · c · d",
    "## VERIFY (awaiting non-author verification)",
    "- Z1 — in verify · e · f",
    "## DONE (id · verified-by · date)",
    "- D1 — done thing · g · h",
    "## BLOCKED",
    "- Q9 — should NOT count · x · y"
  ].join("\n");
  const lanes = boardLanes(board);
  assert.equal(lanes.ready.count, 2, "two READY items");
  assert.equal(lanes.ready.top[0].id, "N9", "topmost READY surfaced first");
  assert.equal(lanes.claimed.count, 1);
  assert.equal(lanes.verify.count, 1);
  assert.equal(lanes.done.count, 1);
  // BLOCKED is outside the tracked columns → not counted anywhere
  const all = JSON.stringify(lanes);
  assert.ok(!all.includes("Q9"), "BLOCKED items are not folded into the lanes");
});

test("Scenario: drill-down never leaks quarantine", () => {
  const estate = {
    sessions: {
      "sha256:ok": { sid: "s1", project: "prime-silo", quarantined: false, drives: ["t480:D"] },
      "sha256:cv": {
        sid: "applied-jpmc",
        project: "job-application",
        quarantined: true,
        drives: ["t480:D"]
      }
    }
  };
  const payload = drillMachine(estate, "t480");
  assert.equal(payload.quarantined, 1, "the quarantined session is counted");
  assert.equal(payload.sessions.length, 1, "only the non-quarantined session carries details");
  const asText = JSON.stringify(payload);
  assert.ok(!asText.includes("applied-jpmc"), "quarantined sid never appears");
  assert.ok(!asText.includes("job-application"), "quarantined project/content never appears");
});

test("Scenario: LONGVIEW dial reads real progress", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n3-"));
  const f = path.join(dir, "progress.json");
  fs.writeFileSync(f, JSON.stringify({ phase: "map", fraction: 0.5, done: 94, total: 188 }));
  const present = longviewProgress(f);
  assert.equal(present.present, true);
  assert.equal(present.fraction, 0.5, "the REAL fraction is returned, not fabricated");
  assert.equal(present.phase, "map");
  // absent → a null shape, never a made-up number
  const absent = longviewProgress(path.join(dir, "nope.json"));
  assert.equal(absent.present, false);
  assert.equal(absent.stages, null);
});

test("page wires drill-down + tie-ins", () => {
  const html = fs.readFileSync(path.join(ROOT, "server/pages/estate.html"), "utf8");
  assert.match(html, /class="drill"/, "cards expose a drill affordance");
  assert.match(html, /lineage-timeline/, "drill targets a lineage-timeline element");
  for (const ep of ["/api/estate/board", "/api/estate/longview", "/api/estate/drill/"])
    assert.ok(html.includes(ep), `page reads ${ep}`);
});
