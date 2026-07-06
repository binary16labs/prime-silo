// A8 — ingest resilience helpers: stall detection + wiki reconcile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskStalled, reconcileIngested } from "../scripts/longview/lib/ingest_state.mjs";

const NOW = Date.parse("2026-07-06T08:00:00Z");
const MIN = 60_000;

// --- taskStalled -------------------------------------------------------------

// a task that advanced recently is not stalled
assert.equal(
  taskStalled({ updated_at: "2026-07-06T07:55:00Z" }, NOW, 30 * MIN),
  false,
  "recent progress must not be stalled"
);

// a task whose record stopped advancing past the threshold is stalled
assert.equal(
  taskStalled({ updated_at: "2026-07-06T07:00:00Z" }, NOW, 30 * MIN),
  true,
  "60 min without progress at a 30 min threshold is stalled"
);

// never misclassify for lack of evidence
assert.equal(taskStalled(null, NOW, 30 * MIN), false, "no task -> not stalled");
assert.equal(taskStalled({}, NOW, 30 * MIN), false, "no timestamp -> not stalled");
assert.equal(
  taskStalled({ updated_at: "not-a-date" }, NOW, 30 * MIN),
  false,
  "unparseable timestamp -> not stalled"
);
assert.equal(
  taskStalled({ updated_at: "2026-07-06T07:00:00Z" }, NOW, 0),
  false,
  "stallMs=0 disables"
);

// --- reconcileIngested ---------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lv-wiki-"));
const batch = ["card_a.md", "card_b.md", "card_c.md", "card_d.md"];
// server completed a and c before the batch died
fs.writeFileSync(path.join(tmp, "card_a.md"), "# a");
fs.writeFileSync(path.join(tmp, "card_c.md"), "# c");

const ingested = new Set(["card_a.md"]); // a was already known-ingested
const recovered = reconcileIngested(batch, tmp, fs, ingested);

assert.deepEqual(recovered, ["card_c.md"], "only newly-evidenced files are recovered");
assert.ok(ingested.has("card_c.md"), "recovered file joins the ingested set");
assert.ok(!ingested.has("card_b.md"), "files without wiki evidence stay pending");
assert.ok(!ingested.has("card_d.md"), "files without wiki evidence stay pending");

// retry after reconcile would process exactly the remainder
const pending = batch.filter((n) => !ingested.has(n));
assert.deepEqual(
  pending,
  ["card_b.md", "card_d.md"],
  "retry processes exactly the unfinished files"
);

// --- A8.1 startup reconcile: a FRESH process (empty ingested.json — the old
// process died before marking anything) must recover ALL wiki-evidenced files
// before computing pending, or it re-ingests finished work (observed live
// 2026-07-06: relaunch saw 164 pending instead of 124 and re-ran batch 1).
const freshSet = new Set();
const startupRecovered = reconcileIngested(batch, tmp, fs, freshSet);
assert.deepEqual(
  startupRecovered.sort(),
  ["card_a.md", "card_c.md"],
  "startup reconcile recovers every wiki-evidenced card, not just in-run failures"
);
assert.deepEqual(
  batch.filter((n) => !freshSet.has(n)),
  ["card_b.md", "card_d.md"],
  "fresh process resumes at the first genuinely-unfinished card"
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("longview_ingest_state_test: all assertions passed");
