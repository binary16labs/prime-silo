// L10 acceptance — flywheel daemon (trigger + liveness). Scenarios ↔ delivery/tasks/L10.md gherkin.
// Hermetic: temp coord dir + temp run-event logs; no real fs-watch/cron/subprocess (injected callbacks).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initCoordination, readEvents } from "../../server/coordination/lib/ledger.mjs";
import {
  claimLoopTurn,
  releaseLoopTurn,
  FLYWHEEL_TURN
} from "../../server/coordination/lib/loop_claim.mjs";
import { liveness } from "../../server/coordination/lib/liveness.mjs";
import {
  advanceTurn,
  superviseTurn,
  deadManAbort,
  emitRunEvent,
  readRunEvents
} from "../../server/coordination/lib/flywheel_daemon.mjs";

const coord = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fly-"));
  // the daemon runs as a registered coordination agent (per machine).
  initCoordination(d, { agents: ["house-daemon-a", "house-daemon-b", "human"] });
  return d;
};
const leasePath = (d) => path.join(d, "leases", `${FLYWHEEL_TURN}.json`);
const runlog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "run-")), "events.jsonl");

// ---------------------------------------------------------------------------
test("Scenario: reactive and cron triggers both advance a turn, each taking the claim", () => {
  const d = coord();
  const ran = [];
  const reactive = advanceTurn(d, "house-daemon-a", {
    source: "fs-watch",
    runStage: () => ran.push("fs-watch")
  });
  const cron = advanceTurn(d, "house-daemon-a", {
    source: "cron",
    runStage: () => ran.push("cron")
  });

  assert.equal(reactive.ran, true);
  assert.equal(reactive.source, "fs-watch");
  assert.equal(cron.ran, true);
  assert.equal(cron.source, "cron");
  assert.deepEqual(ran, ["fs-watch", "cron"]);
  // each turn took (and released) the flywheel-turn claim — two claims recorded in the L7 ledger.
  const claims = readEvents(d).events.filter(
    (e) => e.type === "task_claimed" && e.task_id === FLYWHEEL_TURN
  );
  assert.equal(claims.length, 2);
  assert.ok(!fs.existsSync(leasePath(d)), "lease released after each turn");
});

test("Scenario: only one machine runs a turn (single-winner, reuses L7)", () => {
  const d = coord();
  let inner = null;
  // while machine A is mid-turn (has NOT released), machine B tries to trigger concurrently.
  const a = advanceTurn(d, "house-daemon-a", {
    source: "fs-watch",
    runStage: () => {
      inner = advanceTurn(d, "house-daemon-b", { source: "cron", runStage: () => {} });
    }
  });
  assert.equal(a.ran, true);
  assert.equal(inner.ran, false);
  assert.equal(inner.reason, "already-claimed"); // exactly one advanced the turn
});

test("Scenario: a wedged job is detected by resource, not by logs", () => {
  // CPU-time flat, artifacts/mtime stale, external heartbeat stale — but the LOG mtime is FRESH.
  // A fresh log line must NOT rescue a wedged job (the verify-gpu-job-liveness lesson).
  const t0 = 1_000_000;
  const prev = {
    now: t0,
    cpuTimeMs: 5000,
    artifactCount: 3,
    artifactMtimeMs: t0 - 10_000,
    heartbeatMs: t0 - 10_000
  };
  const cur = {
    now: t0 + 120_000,
    cpuTimeMs: 5000, // flat — no compute
    artifactCount: 3, // no new checkpoints
    artifactMtimeMs: t0 - 10_000, // stale
    heartbeatMs: t0 - 200_000, // supervisor heartbeat stale
    logMtimeMs: t0 + 119_000 // log looks fresh — must be ignored
  };
  const v = liveness(prev, cur, { stallMs: 60_000 });
  assert.equal(v.stalled, true);
  assert.equal(v.alive, false);

  // control: a job burning CPU is alive even if artifacts haven't landed yet.
  const alive = liveness(prev, { ...cur, cpuTimeMs: 8000 }, { stallMs: 60_000 });
  assert.equal(alive.alive, true);
  assert.equal(alive.stalled, false);
});

test("Scenario: a wedge aborts clean (dead-man switch)", () => {
  const d = coord();
  const rl = runlog();
  // machine A holds the turn; a supervisor observes a wedge and fires the dead-man switch.
  const claim = claimLoopTurn(d, "house-daemon-a");
  assert.equal(claim.ok, true);
  emitRunEvent(rl, { type: "run_started", run_id: "turn-1", agent: "house-daemon-a" });

  let stopped = false;
  let alerted = null;
  const wedge = [
    { now: 0, cpuTimeMs: 100, artifactCount: 1, artifactMtimeMs: 0, heartbeatMs: 0 },
    {
      now: 120_000,
      cpuTimeMs: 100,
      artifactCount: 1,
      artifactMtimeMs: 0,
      heartbeatMs: -200_000,
      logMtimeMs: 119_000
    }
  ];
  const result = superviseTurn(d, "house-daemon-a", {
    samples: wedge,
    stallMs: 60_000,
    runEventsLog: rl,
    runId: "turn-1",
    stopJob: () => {
      stopped = true;
      return true;
    },
    alert: (a) => {
      alerted = a;
      return true;
    }
  });

  assert.equal(result.stalled, true);
  assert.equal(result.aborted, true);
  assert.equal(stopped, true, "the wedged job was stopped");
  assert.ok(!fs.existsSync(leasePath(d)), "the lease was released — the box is not left wedged");
  assert.ok(alerted && alerted.reason, "an alert was raised");
  const failed = readRunEvents(rl).filter((e) => e.type === "run_failed" && e.run_id === "turn-1");
  assert.equal(failed.length, 1, "run_failed emitted (honest G0 record)");
});

test("supervise leaves a healthy turn alone (dead-man is not trigger-happy)", () => {
  const d = coord();
  const rl = runlog();
  claimLoopTurn(d, "house-daemon-a");
  const healthy = [
    { now: 0, cpuTimeMs: 100, artifactCount: 1, artifactMtimeMs: 0, heartbeatMs: 0 },
    {
      now: 120_000,
      cpuTimeMs: 9000,
      artifactCount: 2,
      artifactMtimeMs: 119_000,
      heartbeatMs: 118_000
    }
  ];
  const result = superviseTurn(d, "house-daemon-a", {
    samples: healthy,
    stallMs: 60_000,
    runEventsLog: rl,
    runId: "t",
    stopJob: () => true,
    alert: () => true
  });
  assert.equal(result.stalled, false);
  assert.equal(result.aborted, false);
  assert.ok(fs.existsSync(leasePath(d)), "healthy turn keeps its lease");
  releaseLoopTurn(d, "house-daemon-a");
});
