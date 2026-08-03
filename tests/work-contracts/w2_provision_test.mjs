// W2 acceptance — contracts are enforced by machinery, not discipline.
// Scenarios ↔ delivery/tasks/W2.md gherkin. The three checks are pure, so these need no git repo;
// provisioning is tested with an injected `run` so no worktree is actually created.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAllowlist,
  checkBudget,
  preflightTools,
  provisionSandbox,
  releaseSandbox
} from "../../server/coordination/lib/sandbox_provision.mjs";

const ALLOW = ["server/coordination/", "runtime/benny/agentamp/", "scripts/gates/w2.mjs"];

// --- Scenario 1 -------------------------------------------------------------
test("Scenario: allowlist violations cannot pass verify", () => {
  const r = checkAllowlist(
    ["server/coordination/lib/x.mjs", "app/L0/secret.js", "scripts/gates/w2.mjs"],
    ALLOW
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["app/L0/secret.js"]);
  assert.match(r.reason, /app\/L0\/secret\.js/, "the refusal must NAME the offending file");
});

test("a clean change set passes, and a directory entry covers files beneath it", () => {
  const r = checkAllowlist(
    ["server/coordination/lib/a.mjs", "server/coordination/schema/b.json", "scripts/gates/w2.mjs"],
    ALLOW
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test("a prefix that is not a path boundary is NOT covered", () => {
  // 'server/coordination/' must not cover 'server/coordination-notes/x'
  const r = checkAllowlist(["server/coordination-notes/x.mjs"], ALLOW);
  assert.equal(r.ok, false, "a substring match is not a path match");
});

// --- Scenario 2 -------------------------------------------------------------
test("Scenario: missing tools block before work starts", async () => {
  const r = preflightTools(["node", "definitely-not-installed"], (t) => t === "node");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["definitely-not-installed"]);

  // and provisioning refuses outright rather than creating a sandbox it cannot use
  const p = await provisionSandbox("X1", { sandbox: "worktree", tools: ["ghost"] }, {
    probe: () => false,
    run: () => assert.fail("git must not be touched when a declared tool is missing")
  });
  assert.equal(p.ok, false);
  assert.equal(p.reason, "tool-unavailable");
  assert.match(p.reason + p.missing.join(), /ghost|tool-unavailable/);
});

// --- budget ----------------------------------------------------------------
test("an over-budget diff is refused WITH its line count", () => {
  const numstat = [
    { file: "server/coordination/lib/a.mjs", added: 300, deleted: 20 },
    { file: "runtime/benny/agentamp/b.py", added: 200, deleted: 0 }
  ];
  const r = checkBudget(numstat, 400);
  assert.equal(r.ok, false);
  assert.equal(r.lines, 520);
  assert.match(r.reason, /520/, "the refusal must state the count, not just refuse");
});

test("tests and lockfiles are excluded from the budget", () => {
  const numstat = [
    { file: "server/coordination/lib/a.mjs", added: 100, deleted: 0 },
    { file: "tests/work-contracts/big_test.mjs", added: 900, deleted: 0 },
    { file: "package-lock.json", added: 5000, deleted: 0 }
  ];
  const r = checkBudget(numstat, 400);
  assert.equal(r.ok, true);
  assert.equal(r.lines, 100, "only authored non-test, non-lockfile lines count");
});

// --- provisioning ----------------------------------------------------------
test("worktree provisioning issues the declared git command and reports path + branch", async () => {
  const calls = [];
  const r = await provisionSandbox("W9", { sandbox: "worktree", tools: [] }, {
    repoRoot: "/repo",
    worktreeRoot: "/wt",
    probe: () => true,
    run: (args, cwd) => {
      calls.push({ args, cwd });
      return { status: 0, stderr: "" };
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.branch, "task/W9");
  assert.deepEqual(calls[0].args.slice(0, 2), ["worktree", "add"]);
  assert.ok(calls[0].args.includes("-b"));
});

test("the spec's .worktrees/feat layout is reachable without being hard-coded", async () => {
  const r = await provisionSandbox("W9", { sandbox: "worktree", tools: [] }, {
    repoRoot: "/repo",
    worktreeRoot: "/repo/.worktrees",
    branchPrefix: "feat/",
    probe: () => true,
    run: () => ({ status: 0, stderr: "" })
  });
  assert.equal(r.branch, "feat/W9");
});

test("in-place provisions nothing, by design", async () => {
  const r = await provisionSandbox("W9", { sandbox: "in-place", tools: [] }, {
    repoRoot: "/repo",
    probe: () => true,
    run: () => assert.fail("in-place must not create a worktree")
  });
  assert.equal(r.ok, true);
  assert.equal(r.branch, null);
});

test("a failed worktree add is reported honestly, not swallowed", async () => {
  const r = await provisionSandbox("W9", { sandbox: "worktree", tools: [] }, {
    repoRoot: "/repo",
    worktreeRoot: "/wt",
    probe: () => true,
    run: () => ({ status: 128, stderr: "fatal: branch already exists" })
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "worktree-failed");
  assert.match(r.detail, /already exists/);
});

// --- wired into the loop: the positive coverage W1's concurrency test gives up -----------------
test("workNext provisions the sandbox on a successful claim", async () => {
  const { workNext } = await import("../../server/coordination/lib/work_loop.mjs");
  const coord = await import("../../runtime/benny/agentamp/coord_client.mjs");
  const { initCoordination } = await import("../../server/coordination/lib/ledger.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "w2-repo-"));
  fs.mkdirSync(path.join(repoRoot, "delivery", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "delivery", "board"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "delivery", "tasks", "Z0.md"),
    "---\nid: Z0\ndeps: []\nauthority: agent-ok\ntools: [node]\nsandbox: worktree\nverify: node scripts/gates/z0.mjs\nbudget: 100\n---\n"
  );
  fs.writeFileSync(path.join(repoRoot, "delivery", "board", "BOARD.md"), "## READY\n\n- Z0 — z\n\n## DONE\n");
  const coordDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "w2-c-")), "coordination");
  initCoordination(coordDir);
  const ctx = await coord.connect({ coordDir, baseUrl: "http://127.0.0.1:1" });

  const calls = [];
  const r = await workNext(ctx, "claude", repoRoot, {
    sandboxOpts: {
      worktreeRoot: path.join(repoRoot, "wt"),
      probe: () => true,
      run: (args) => {
        calls.push(args);
        return { status: 0, stderr: "" };
      }
    }
  });
  assert.equal(r.item, "Z0");
  assert.equal(r.sandbox.ok, true);
  assert.equal(r.sandbox.branch, "task/Z0");
  assert.deepEqual(calls[0].slice(0, 2), ["worktree", "add"], "a claim must provision, not just lease");
});

test("a missing declared tool blocks the claim AND releases the lease", async () => {
  const { workNext } = await import("../../server/coordination/lib/work_loop.mjs");
  const coord = await import("../../runtime/benny/agentamp/coord_client.mjs");
  const { initCoordination } = await import("../../server/coordination/lib/ledger.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "w2-repo2-"));
  fs.mkdirSync(path.join(repoRoot, "delivery", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "delivery", "board"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "delivery", "tasks", "Z1.md"),
    "---\nid: Z1\ndeps: []\nauthority: agent-ok\ntools: [ghosttool]\nsandbox: worktree\nverify: node x.mjs\nbudget: 100\n---\n"
  );
  fs.writeFileSync(path.join(repoRoot, "delivery", "board", "BOARD.md"), "## READY\n\n- Z1 — z\n\n## DONE\n");
  const coordDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "w2-c2-")), "coordination");
  initCoordination(coordDir);
  const ctx = await coord.connect({ coordDir, baseUrl: "http://127.0.0.1:1" });

  const r = await workNext(ctx, "claude", repoRoot, {
    sandboxOpts: { probe: () => false, run: () => assert.fail("must not touch git") }
  });
  assert.equal(r.claimed, false);
  assert.equal(r.reason, "tool-unavailable");
  assert.equal(r.blocked, "Z1");
  assert.equal(
    fs.existsSync(path.join(coordDir, "leases", "Z1.json")),
    false,
    "a blocked claim must not leave the item leased and stranded"
  );
});

test("release removes the worktree it provisioned", () => {
  const calls = [];
  const r = releaseSandbox("W9", {
    repoRoot: "/repo",
    worktreeRoot: "/wt",
    run: (args) => {
      calls.push(args);
      return { status: 0, stderr: "" };
    }
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].slice(0, 2), ["worktree", "remove"]);
});
