// B0 acceptance tests — one test block per contract scenario (delivery/tasks/B0.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ulid,
  initCoordination,
  validateEvent,
  appendEvent,
  readEvents,
  foldState,
  claimTask,
  renewLease,
} from "../../server/coordination/lib/ledger.mjs";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-"));
  initCoordination(dir);
  return dir;
}

function validEvent(overrides = {}) {
  return {
    id: ulid(),
    ts: new Date().toISOString(),
    type: "task_created",
    agent: "claude",
    task_id: "T1",
    payload: {},
    ...overrides,
  };
}

test("Scenario: malformed events never enter the ledger", (t) => {
  const dir = freshDir();
  const agents = ["claude", "antigravity", "opencode", "benny", "human"];

  const bad = [
    ["missing task_id", (() => { const e = validEvent(); delete e.task_id; return e; })()],
    ["unregistered agent", validEvent({ agent: "gpt-9" })],
    ["bad ts", validEvent({ ts: "yesterday" })],
    ["unknown event type", validEvent({ type: "task_exploded" })],
    ["bad ulid", validEvent({ id: "not-a-ulid" })],
    ["payload not an object", validEvent({ payload: "hi" })],
    ["extra field", validEvent({ sneaky: true })],
  ];
  for (const [label, evt] of bad) {
    const v = validateEvent(evt, agents);
    assert.equal(v.ok, false, `${label} should be rejected`);
    assert.ok(v.reason, `${label} rejection carries a reason`);
    assert.throws(() => appendEvent(dir, evt), `${label} must not append`);
  }
  // nothing was appended
  assert.equal(readEvents(dir).events.length, 0);

  // a valid fixture is accepted and appended
  const good = validEvent({ run_id: "run_123" });
  assert.equal(validateEvent(good, agents).ok, true);
  appendEvent(dir, good);
  const { ok, events } = readEvents(dir);
  assert.equal(ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].task_id, "T1");
});

test("Scenario: concurrent claims yield exactly one winner", { timeout: 120_000 }, async () => {
  const dir = freshDir();
  const worker = path.join(here, "race-worker.mjs");
  const agents = ["claude", "antigravity", "opencode"];
  for (let round = 1; round <= 20; round++) {
    const taskId = `T-race-${round}`;
    const results = await Promise.all(
      agents.map((agent) =>
        execFileP(process.execPath, [worker, dir, taskId, agent]).then((r) => r.stdout.trim())
      )
    );
    const winners = results.filter((r) => r === "CLAIMED");
    const losers = results.filter((r) => r === "already-claimed");
    assert.equal(winners.length, 1, `round ${round}: exactly one winner (got ${results})`);
    assert.equal(losers.length, 2, `round ${round}: two already-claimed (got ${results})`);
  }
});

test("Scenario: expired leases are claimable", (t) => {
  const dir = freshDir();
  const first = claimTask(dir, "T2", "opencode");
  assert.equal(first.ok, true);

  // live lease refuses a second claimant
  assert.equal(claimTask(dir, "T2", "claude").ok, false);

  // expire it: rewrite expires_at into the past
  const leasePath = path.join(dir, "leases", "T2.json");
  const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  lease.expires_at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(leasePath, JSON.stringify(lease));

  const takeover = claimTask(dir, "T2", "claude");
  assert.equal(takeover.ok, true);
  const { events } = readEvents(dir);
  const last = events.at(-1);
  assert.equal(last.type, "task_claimed");
  assert.equal(last.agent, "claude");
  assert.equal(last.payload.takeover, true, "takeover is recorded on the claim event");
});

test("Scenario: expired leases — heartbeat renewal keeps a lease alive (owner only)", () => {
  const dir = freshDir();
  claimTask(dir, "T3", "benny");
  const leasePath = path.join(dir, "leases", "T3.json");
  const before = JSON.parse(fs.readFileSync(leasePath, "utf8")).expires_at;
  assert.equal(renewLease(dir, "T3", "claude").ok, false, "non-owner cannot renew");
  const renewed = renewLease(dir, "T3", "benny");
  assert.equal(renewed.ok, true);
  const after = JSON.parse(fs.readFileSync(leasePath, "utf8")).expires_at;
  assert.ok(new Date(after) >= new Date(before), "renewal never shortens the lease");
});

test("Scenario: ledger is append-only truth", () => {
  const dir = freshDir();
  const seq = [
    ["task_created", "human", "T4", {}],
    ["task_claimed", "opencode", "T4", {}],
    ["task_progress", "opencode", "T4", { note: "halfway" }],
    ["task_done", "opencode", "T4", {}],
    ["task_created", "human", "T5", {}],
    ["task_claimed", "claude", "T5", {}],
    ["task_blocked", "claude", "T5", { reason: "contract insufficient" }],
    ["task_created", "human", "T6", {}],
    ["task_claimed", "benny", "T6", {}],
    ["task_released", "benny", "T6", {}],
    ["knowledge_added", "antigravity", "-", { file: "knowledge/lemonade-wedge.md" }],
  ];
  for (const [type, agent, task_id, payload] of seq) {
    appendEvent(dir, validEvent({ type, agent, task_id, payload }));
  }

  // states derive solely from folding events
  const state = foldState(readEvents(dir).events);
  assert.equal(state.get("T4").state, "done");
  assert.equal(state.get("T5").state, "blocked");
  assert.equal(state.get("T5").agent, "claude");
  assert.equal(state.get("T6").state, "todo", "released tasks return to todo");
  assert.equal(state.has("-"), false, "knowledge events do not create tasks");

  // an edited historical line is detected
  const ledgerPath = path.join(dir, "tasks.jsonl");
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.agent = "human"; // rewrite history: claim now looks human-made
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(ledgerPath, lines.join("\n"));
  const check = readEvents(dir);
  assert.equal(check.ok, false, "tampered ledger is detected");
  assert.equal(check.badLine, 2, "the edited line is identified");
});

test("Scenario: malformed events — registry is extensible via agents.json", () => {
  const dir = freshDir();
  const agentsPath = path.join(dir, "agents.json");
  const reg = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
  assert.deepEqual(reg.agents, ["claude", "antigravity", "opencode", "benny", "human"]);
  reg.agents.push("gemini-cli");
  fs.writeFileSync(agentsPath, JSON.stringify(reg));
  appendEvent(dir, validEvent({ agent: "gemini-cli" })); // now accepted
  assert.equal(readEvents(dir).events.at(-1).agent, "gemini-cli");
});
