// L7 acceptance — single-winner loop claim + compaction budget. Scenarios ↔ delivery/tasks/L7.md.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimLoopTurn,
  releaseLoopTurn,
  FLYWHEEL_TURN
} from "../../server/coordination/lib/loop_claim.mjs";
import {
  compactLog,
  reconstruct,
  checkStorageBudget
} from "../../server/coordination/lib/compaction.mjs";
import { initCoordination } from "../../server/coordination/lib/ledger.mjs";

const coord = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  initCoordination(d); // seeds agents claude/antigravity/opencode/benny/human + leases/ dir
  return d;
};

test("Scenario: only one machine wins the turn", () => {
  const dir = coord();
  const machines = ["claude", "antigravity", "opencode", "benny"];
  const results = machines.map((m) => claimLoopTurn(dir, m));
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1); // exactly one acquires the flywheel-turn lease
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === "already-claimed"));
});

test("Scenario: a stale lease is reclaimable, still single-winner", () => {
  const dir = coord();
  assert.equal(claimLoopTurn(dir, "claude").ok, true);
  // force the lease stale
  const leasePath = path.join(dir, "leases", `${FLYWHEEL_TURN}.json`);
  const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  lease.expires_at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(leasePath, JSON.stringify(lease));
  // now several race to reclaim the stale lease
  const reclaim = ["benny", "antigravity", "opencode"].map((m) => claimLoopTurn(dir, m));
  assert.equal(reclaim.filter((r) => r.ok).length, 1); // still exactly one winner
});

test("Scenario: compaction loses nothing (journalled, reconstructable)", () => {
  const dir = coord();
  const logFile = path.join(dir, "eventlog", "events.jsonl");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const original = Array.from({ length: 6 }, (_, i) => JSON.stringify({ id: i, v: `line${i}` }));
  fs.writeFileSync(logFile, original.join("\n") + "\n");
  const journal = path.join(dir, "eventlog", "journal.jsonl");

  const res = compactLog(logFile, journal, { keep: 2 });
  assert.equal(res.moved, 4);
  assert.equal(res.kept, 2);
  // active log now holds only the newest 2 lines
  assert.equal(
    fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length,
    2
  );
  // replay journal + active reconstructs the full pre-compaction state, in order
  assert.deepEqual(reconstruct(journal, logFile), original);
});

test("Scenario: growth past budget is flagged, not silent", () => {
  const dir = coord();
  const f = path.join(dir, "blob.bin");
  fs.writeFileSync(f, Buffer.alloc(4096, 1));
  const under = checkStorageBudget(dir, 1024 * 1024);
  assert.equal(under.ok, true);
  const over = checkStorageBudget(dir, 1024); // 4KB file exceeds a 1KB budget
  assert.equal(over.ok, false);
  assert.ok(over.overage > 0);
  assert.ok(over.size >= 4096);
});

test("release frees the turn for the next winner", () => {
  const dir = coord();
  assert.equal(claimLoopTurn(dir, "claude").ok, true);
  assert.equal(claimLoopTurn(dir, "benny").ok, false); // held
  releaseLoopTurn(dir, "claude");
  assert.equal(claimLoopTurn(dir, "benny").ok, true); // now free
});
