// The run inventory, and the control's effective date.
//
// "Unauthorised runs: 0" means nothing without a list of runs to check. But the moment you
// build that list you meet the honest problem: every run in this estate predates the
// governance layer, because signing did not exist until it was built. Failing a July run for
// lacking a September mechanism produces a wall of red, and a wall of red is a gauge nobody
// reads.
//
// Controls have effective dates for exactly this reason. These tests pin the two ways that
// idea can be got wrong:
//
//   Too lenient — a run sneaks out of scope and escapes the check (notably by having no
//   timestamp at all, which must NOT be a free pass).
//   Too harsh — pre-control runs counted as defects, drowning the real signal.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fromRunRecords,
  fromOpenLineage,
  governanceEpochFrom,
  partitionRuns
} from "../server/coordination/lib/runs.mjs";
import { buildEvidencePack } from "../server/coordination/lib/evidence.mjs";
import {
  proposalRaisedEvent,
  proposalSignedEvent
} from "../server/coordination/lib/governance.mjs";

const EPOCH = "2026-09-05T12:00:00.000Z";
const run = (id, at, proposal_id = null) => ({ run_id: id, at, proposal_id, kind: "test" });

test("the epoch is when signing first became possible", () => {
  const events = [
    { type: "service_transitioned", valid_time: "2026-01-01T00:00:00.000Z" },
    proposalRaisedEvent({ proposalId: "p1", machine: "t480", title: "first", valid_time: EPOCH }),
    proposalRaisedEvent({
      proposalId: "p2",
      machine: "t480",
      title: "later",
      valid_time: "2026-10-01T00:00:00.000Z"
    })
  ];
  assert.equal(governanceEpochFrom(events), EPOCH, "the EARLIEST proposal sets the date");
  assert.equal(governanceEpochFrom(events, "2026-06-01T00:00:00.000Z"), "2026-06-01T00:00:00.000Z");
  assert.equal(governanceEpochFrom([]), null, "no proposals means no control in force yet");
});

test("pre-control runs are excluded but still counted", () => {
  const { inScope, preControl } = partitionRuns(
    [run("old", "2026-07-01T00:00:00.000Z"), run("new", "2026-09-06T00:00:00.000Z")],
    EPOCH
  );
  assert.deepEqual(
    inScope.map((r) => r.run_id),
    ["new"]
  );
  assert.deepEqual(
    preControl.map((r) => r.run_id),
    ["old"],
    "excluded, but visible"
  );
});

test("an undated run cannot escape by having lost its date", () => {
  // The lenient failure: default an unknown timestamp to "pre-control" and anything can slip
  // the check simply by not recording when it ran.
  const { inScope, undated } = partitionRuns([run("nodate", null)], EPOCH);
  assert.deepEqual(
    undated.map((r) => r.run_id),
    ["nodate"]
  );
  assert.deepEqual(
    inScope.map((r) => r.run_id),
    ["nodate"],
    "undated is IN scope, not out of it"
  );
});

test("an in-scope run without a signature is a defect; with one it is not", () => {
  const events = [
    proposalRaisedEvent({
      proposalId: "ok",
      machine: "t480",
      title: "approved",
      valid_time: EPOCH
    }),
    proposalSignedEvent({ proposalId: "ok", machine: "t480", signer: "nsdha", valid_time: EPOCH })
  ];
  const runs = [
    run("signed", "2026-09-06T00:00:00.000Z", "ok"),
    run("unsigned", "2026-09-06T00:00:00.000Z"),
    run("ancient", "2026-07-01T00:00:00.000Z")
  ];
  const pack = buildEvidencePack([{ file: "f", ok: true, events }], { runs });
  const d = pack.defects.find((x) => x.id === "unauthorised-run");

  assert.equal(d.state, "measured");
  assert.equal(d.count, 1, "only the in-scope unsigned run counts");
  assert.match(d.note, /unsigned/);
  assert.doesNotMatch(d.note, /ancient/, "a pre-control run is never named as a defect");
  assert.equal(pack.control.runs_pre_control, 1);
  assert.equal(pack.control.runs_in_scope, 2);
});

test("supplying runs moves the defect from unmeasured to measured", () => {
  const events = [
    proposalRaisedEvent({ proposalId: "p", machine: "t480", title: "t", valid_time: EPOCH })
  ];
  const without = buildEvidencePack([{ file: "f", ok: true, events }]);
  const with_ = buildEvidencePack([{ file: "f", ok: true, events }], { runs: [] });
  assert.equal(without.defects.find((d) => d.id === "unauthorised-run").state, "not measurable");
  assert.equal(without.verdict.unmeasured, 3);
  assert.equal(with_.defects.find((d) => d.id === "unauthorised-run").state, "measured");
  assert.equal(with_.verdict.unmeasured, 2);
});

test("run records and lineage events both yield a usable inventory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  try {
    fs.writeFileSync(
      path.join(dir, "run-abc.json"),
      JSON.stringify({
        run_id: "run-abc",
        started_at: "2026-07-17T09:07:45.056084",
        workspace: "sessions_v1",
        status: "completed"
      })
    );
    fs.writeFileSync(path.join(dir, "not-a-run.json"), JSON.stringify({ nope: true }));
    const records = fromRunRecords(dir);
    assert.equal(records.length, 1, "a record with no run_id is not a run we can vouch for");
    assert.equal(records[0].kind, "swarm");

    const ol = path.join(dir, "openlineage.json");
    fs.writeFileSync(
      ol,
      JSON.stringify([
        { run: { runId: "x-1-map" }, eventTime: "2026-08-14T23:28:24.326Z" },
        { run: { runId: "x-1-map" }, eventTime: "2026-08-14T23:40:00.000Z" } // START + COMPLETE
      ])
    );
    const fromOl = fromOpenLineage(ol);
    assert.equal(fromOl.length, 1, "one run id, not one per event");
    assert.equal(fromOl[0].kind, "pipeline");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
