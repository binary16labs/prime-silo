// W1 acceptance — deterministic next-item delivery.
// Scenarios ↔ delivery/tasks/W1.md gherkin, plus the D1-D4 decisions from
// architecture/SOLUTION-W1-work-next.md section 9. Hermetic: fixtures + a temp coordDir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initCoordination, readEvents } from "../../server/coordination/lib/ledger.mjs";
import { NO_ITEM, authorOf, selectNext } from "../../server/coordination/lib/work_select.mjs";
import { recordVerified, workNext } from "../../server/coordination/lib/work_loop.mjs";
import * as coord from "../../runtime/benny/agentamp/coord_client.mjs";

const NOW = 1_800_000_000_000; // pinned: the selector must never read the clock itself
const DEAD_URL = "http://127.0.0.1:1";

// A → B → C chain plus two independent leaves, one of them human-signed.
const CONTRACTS = [
  { id: "A0", deps: [], authority: "agent-ok" },
  { id: "A1", deps: ["A0"], authority: "agent-ok" },
  { id: "A2", deps: ["A1"], authority: "agent-ok" },
  { id: "B0", deps: [], authority: "agent-ok" },
  { id: "H0", deps: [], authority: "human-signed" }
];
const base = (over = {}) => ({
  ledger: { A0: { state: "done" } },
  board: {},
  priority: [],
  leases: {},
  agent: "claude",
  now: NOW,
  ...over
});

// --- Scenario 1 -------------------------------------------------------------
test("Scenario: the selector is a function", () => {
  const first = selectNext(CONTRACTS, base());
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(selectNext(CONTRACTS, base()), first, `run ${i} diverged`);
  }
  assert.ok(first.item, "fixture should yield an item at all");
});

test("priority from the board reorders candidates; id breaks the remaining tie", () => {
  // B0 and A1 are both ready and both at different depths — depth wins first.
  assert.equal(selectNext(CONTRACTS, base()).item, "B0", "depth 0 outranks depth 1");
  // With B0 done, A1 (depth 1) is the only agent-ok candidate left.
  const done = base({ ledger: { A0: { state: "done" }, B0: { state: "done" } } });
  assert.equal(selectNext(CONTRACTS, done).item, "A1");
});

// --- Scenario 2 -------------------------------------------------------------
/** A throwaway repo with three independent ready contracts, so arbitration is what is tested —
 *  not whatever the live board happens to contain today. */
function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "w1-repo-"));
  fs.mkdirSync(path.join(root, "delivery", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, "delivery", "board"), { recursive: true });
  for (const id of ["A0", "B0", "C0"]) {
    fs.writeFileSync(
      path.join(root, "delivery", "tasks", `${id}.md`),
      `---\nid: ${id}\ndeps: []\nauthority: agent-ok\nverify: node scripts/gates/x.mjs\n---\n`
    );
  }
  fs.writeFileSync(
    path.join(root, "delivery", "board", "BOARD.md"),
    "## READY\n\n- A0 — a\n- B0 — b\n- C0 — c\n\n## DONE\n"
  );
  return root;
}

test("Scenario: concurrent pulls never collide", async () => {
  const repoRoot = fixtureRepo();
  const rounds = 20;
  for (let round = 0; round < rounds; round++) {
    const coordDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "w1-")), "coordination");
    initCoordination(coordDir);
    const a = await coord.connect({ coordDir, baseUrl: DEAD_URL });
    const b = await coord.connect({ coordDir, baseUrl: DEAD_URL });
    // W2 amendment: workNext now provisions a git worktree on a successful claim. This scenario
    // tests LEASE ARBITRATION, which is orthogonal — and the fixture repo is deliberately not a git
    // repo. Provisioning is disabled here and covered positively in w2_provision_test.mjs instead,
    // so the assertion below is unchanged and total coverage goes up, not down.
    const [ra, rb] = await Promise.all([
      workNext(a, "claude", repoRoot, { provision: false }),
      workNext(b, "antigravity", repoRoot, { provision: false })
    ]);
    assert.notEqual(
      ra.item,
      rb.item,
      `round ${round}: both agents received ${ra.item} — the lease did not arbitrate`
    );
  }
});

// --- Scenario 3 -------------------------------------------------------------
test("Scenario: author is never verifier", async () => {
  const coordDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "w1-av-")), "coordination");
  initCoordination(coordDir);
  const ctx = await coord.connect({ coordDir, baseUrl: DEAD_URL });
  await coord.claim(ctx, "T", "claude");

  const self = await recordVerified(ctx, "T", "claude");
  assert.equal(self.ok, false);
  assert.equal(self.reason, "author-is-verifier");

  const other = await recordVerified(ctx, "T", "antigravity");
  assert.equal(other.ok, true);
  assert.equal(other.author, "claude");

  const { events } = readEvents(coordDir);
  assert.equal(events.filter((e) => e.type === "task_verified").length, 1, "no phantom write");
  assert.equal(readEvents(coordDir).ok, true, "chain intact after task_verified");
});

test("verifying a task nobody claimed is refused, not silently accepted", async () => {
  const coordDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "w1-nc-")), "coordination");
  initCoordination(coordDir);
  const ctx = await coord.connect({ coordDir, baseUrl: DEAD_URL });
  assert.equal((await recordVerified(ctx, "GHOST", "antigravity")).reason, "never-claimed");
});

// --- D1: human-signed is reported, never selected ---------------------------
test("D1: a human-signed item is never auto-claimed", () => {
  const onlyHuman = selectNext([{ id: "H0", deps: [], authority: "human-signed" }], base({ ledger: {} }));
  assert.equal(onlyHuman.item, null);
  assert.equal(onlyHuman.reason, NO_ITEM.NONE_READY);
  assert.deepEqual(onlyHuman.awaitingSignature, ["H0"]);
  // and it is never smuggled in among the candidates of a normal run
  assert.ok(!selectNext(CONTRACTS, base()).candidates.includes("H0"));
});

// --- D2: board/ledger disagreement is surfaced, not resolved ----------------
test("D2: a board/ledger conflict is surfaced and the item skipped", () => {
  const r = selectNext(CONTRACTS, base({ board: { B0: "DONE" } })); // ledger says otherwise
  assert.deepEqual(r.conflicts, [{ id: "B0", board: "DONE", ledger: "absent" }]);
  assert.ok(!r.candidates.includes("B0"), "a conflicted item must not be handed out");
});

// --- D4: WIP limit ----------------------------------------------------------
test("D4: an agent already holding a live lease is refused a second item", () => {
  const held = { B0: { agent: "claude", expires_at: new Date(NOW + 60_000).toISOString() } };
  const r = selectNext(CONTRACTS, base({ leases: held }));
  assert.equal(r.item, null);
  assert.equal(r.reason, NO_ITEM.WIP_LIMIT);
  assert.equal(r.holding, "B0");
  // an EXPIRED lease must not trigger the limit
  const stale = { B0: { agent: "claude", expires_at: new Date(NOW - 1).toISOString() } };
  assert.notEqual(selectNext(CONTRACTS, base({ leases: stale })).reason, NO_ITEM.WIP_LIMIT);
});

// --- the contract's TDD step 3 ---------------------------------------------
test("completing an item makes exactly its dependents ready", () => {
  const before = selectNext(CONTRACTS, base()).candidates;
  assert.ok(!before.includes("A2"), "A2 must wait for A1");
  const after = selectNext(
    CONTRACTS,
    base({ ledger: { A0: { state: "done" }, A1: { state: "done" }, B0: { state: "done" } } })
  ).candidates;
  assert.deepEqual(after, ["A2"], "exactly the dependent, nothing else");
});

test("a verified dep counts as satisfied (task_verified folds to a terminal state)", () => {
  const r = selectNext(CONTRACTS, base({ ledger: { A0: { state: "verified" }, B0: { state: "done" } } }));
  assert.ok(r.candidates.includes("A1"));
});

test("authorOf returns the most recent claimer", () => {
  const events = [
    { task_id: "T", type: "task_claimed", agent: "claude" },
    { task_id: "T", type: "task_released", agent: "claude" },
    { task_id: "T", type: "task_claimed", agent: "benny" },
    { task_id: "OTHER", type: "task_claimed", agent: "opencode" }
  ];
  assert.equal(authorOf(events, "T"), "benny");
});
