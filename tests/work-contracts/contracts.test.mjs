// W0 acceptance tests — one block per contract scenario (delivery/tasks/W0.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFrontmatter,
  estimateTokens,
  validateContract,
  validateBacklog,
  detectCycle,
  milestoneIds,
  MAX_TOKENS,
  OVERSIZE_GRANTED,
  BUDGET_BANDS
} from "../../server/coordination/work-schema/validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWN = ["B0", "Q0", "X1"];

function contract(overrides = {}) {
  const fm = {
    id: "X1",
    epic: "EP-B",
    milestone: "M1",
    okr: "O2.KR2.1",
    deps: "[B0]",
    authority: "agent-ok",
    allowlist: "[server/coordination/, tests/x1/, scripts/gates/x1.mjs]",
    tools: "[node]",
    sandbox: "worktree",
    verify: "node scripts/gates/x1.mjs",
    budget: "400",
    ...overrides
  };
  const head = Object.entries(fm)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${head}\n---\n\n# X1 — fixture\n\n## Goal\nA fixture.\n\n## Acceptance\n\`\`\`gherkin\nFeature: f\n  Scenario: s\n    Given g\n    When w\n    Then t\n\`\`\`\n`;
}

test("Scenario: every contract validates (frontmatter parses incl. inline comments)", () => {
  const fm = parseFrontmatter(
    "---\nid: W0\nauthority: agent-ok   # comment\nallowlist: [a/, b.mjs]\ndeps: []\n---\nbody"
  );
  assert.equal(fm.id, "W0");
  assert.equal(fm.authority, "agent-ok");
  assert.deepEqual(fm.allowlist, ["a/", "b.mjs"]);
  assert.deepEqual(fm.deps, []);

  const r = validateContract(contract(), { id: "X1", repoRoot: ROOT, knownIds: KNOWN });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test("Scenario: bloated or vague contracts are rejected — over token budget", () => {
  const fat = contract() + "\npadding word ".repeat(MAX_TOKENS);
  assert.ok(estimateTokens(fat) > MAX_TOKENS);
  const r = validateContract(fat, { id: "X1", repoRoot: ROOT, knownIds: KNOWN });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /token/i.test(e)),
    `names the token rule: ${r.errors}`
  );
});

test("Scenario: bloated or vague contracts are rejected — missing acceptance scenario", () => {
  const vague = contract().replace(/```gherkin[\s\S]*```/, "");
  const r = validateContract(vague, { id: "X1", repoRoot: ROOT, knownIds: KNOWN });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /scenario/i.test(e)),
    `names the Scenario rule: ${r.errors}`
  );
});

test("Scenario: bloated or vague contracts are rejected — unresolved dep and bad allowlist root", () => {
  const badDep = validateContract(contract({ deps: "[ZZ99]" }), {
    id: "X1",
    repoRoot: ROOT,
    knownIds: KNOWN
  });
  assert.ok(
    badDep.errors.some((e) => /ZZ99/.test(e)),
    `names the dep: ${badDep.errors}`
  );

  const badPath = validateContract(contract({ allowlist: "[nonexistent-root/x.js]" }), {
    id: "X1",
    repoRoot: ROOT,
    knownIds: KNOWN
  });
  assert.ok(
    badPath.errors.some((e) => /nonexistent-root/.test(e)),
    `names the path: ${badPath.errors}`
  );

  const badVerify = validateContract(
    contract({ verify: "node scripts/gates/zz.mjs", allowlist: "[server/coordination/]" }),
    {
      id: "X1",
      repoRoot: ROOT,
      knownIds: KNOWN
    }
  );
  assert.ok(
    badVerify.errors.some((e) => /verify/i.test(e)),
    `names the verify rule: ${badVerify.errors}`
  );
});

test("Scenario: nothing is lost between plan and backlog — cycle detection works", () => {
  assert.equal(detectCycle({ A: ["B"], B: ["C"], C: [] }), null);
  const cyc = detectCycle({ A: ["B"], B: ["A"] });
  assert.ok(cyc, "cycle reported");
});

test("Scenario: nothing is lost + traceability complete — full-tree validation is green", () => {
  const r = validateBacklog(ROOT);
  assert.deepEqual(r.errors, [], "full backlog, board, plan-deps and traceability agree");
  assert.equal(r.ok, true);
  assert.ok(r.count >= 60, `all plan phases authored (got ${r.count})`);
});

// --- the ceiling and the milestone list (added 2026-10-17 with the W0 repair) ------------------
// Two rules got looser by accident and are pinned here. Each pairs a pass with a fail on the same
// shape, because "no error" is also what a dead check reports.

test("Scenario: a granted oversize is a pin, not a licence — growth past it fails again", () => {
  // Seven owner-signed contracts are listed in OVERSIZE_GRANTED at the size they were measured at.
  // The point of recording the size is that creep beyond it is caught; a bare exemption would let
  // a listed contract grow without limit, which is the ceiling removed for exactly those files.
  const ids = Object.keys(OVERSIZE_GRANTED);
  assert.ok(ids.length > 0, "the grant list is not empty");

  for (const id of ids) {
    const granted = OVERSIZE_GRANTED[id];
    assert.ok(granted > MAX_TOKENS, `${id}'s grant should exceed the ceiling it replaces`);

    const body = "x".repeat(granted * 4 - estimateTokens(contract()) * 4);
    const atLimit = contract({ id }) + body;
    const errsAt = validateContract(atLimit, { id, repoRoot: ROOT, knownIds: [...KNOWN, id] });
    assert.equal(
      errsAt.errors.some((e) => /oversize|ceiling/.test(e)),
      false,
      `${id} within its grant must not be reported: ${errsAt.errors}`
    );

    const over = atLimit + "y".repeat(4 * 20);
    const errsOver = validateContract(over, { id, repoRoot: ROOT, knownIds: [...KNOWN, id] });
    assert.ok(
      errsOver.errors.some((e) => /exceeds its granted oversize/.test(e)),
      `${id} grown past its grant must be reported: ${errsOver.errors}`
    );
  }
});

test("Scenario: an unlisted contract still meets the 1500 ceiling", () => {
  const big = contract() + "x".repeat(MAX_TOKENS * 4);
  const r = validateContract(big, { id: "X1", repoRoot: ROOT, knownIds: KNOWN });
  assert.ok(
    r.errors.some((e) => new RegExp(`exceeds the ${MAX_TOKENS} token ceiling`).test(e)),
    `the ceiling still applies off the grant list: ${r.errors}`
  );
});

test("Scenario: the valid milestones are the ones with a file on disk", () => {
  // The old literal list froze at M10 while M11-M13 were authored, so three contracts the owner had
  // signed were reported as naming an unknown milestone. Reading the directory is what fixed it —
  // and an invented milestone must still fail, or the check is just gone.
  const onDisk = milestoneIds(ROOT);
  assert.ok(onDisk.has("M1"), "M1 is on disk");
  assert.ok(onDisk.has("M13"), "a milestone authored after the literal list is accepted");
  assert.equal(onDisk.has("M99"), false, "a milestone with no file is not valid");

  const ok = validateContract(contract({ milestone: "M13" }), {
    id: "X1",
    repoRoot: ROOT,
    knownIds: KNOWN
  });
  assert.equal(
    ok.errors.some((e) => /milestone/.test(e)),
    false,
    `M13 has a file and must pass: ${ok.errors}`
  );

  const bad = validateContract(contract({ milestone: "M99" }), {
    id: "X1",
    repoRoot: ROOT,
    knownIds: KNOWN
  });
  assert.ok(
    bad.errors.some((e) => /milestone 'M99' has no delivery\/milestones file/.test(e)),
    `an unknown milestone is still named: ${bad.errors}`
  );
});

test("Scenario: a declared band IS the budget, and XL is the ceiling", () => {
  // The rule exists because four budgets were raised mid-flight (S21 600->680->800, S22
  // 600->800->900, C3 300->1100). Declaring the band up front only helps if a contract whose budget
  // drifts from it fails, so each case below pairs a pass with a fail on the same shape.
  assert.deepEqual(BUDGET_BANDS, { S: 300, M: 500, L: 800, XL: 1000 });

  const check = (over) =>
    validateContract(contract(over), { id: "X1", repoRoot: ROOT, knownIds: KNOWN }).errors;

  for (const [band, budget] of Object.entries(BUDGET_BANDS)) {
    assert.deepEqual(
      check({ band, budget: String(budget) }).filter((e) => /band|budget/u.test(e)),
      [],
      `band ${band} at ${budget} is the declared pair`
    );
    // raising the budget above its own band is the move this rule exists to stop
    const raised = check({ band, budget: String(budget + 100) });
    assert.ok(
      raised.some((e) => /split, do not raise/u.test(e)),
      `band ${band} with a raised budget must fail: ${raised}`
    );
  }

  // a band nobody declared, and the ceiling: there is nothing above XL to climb to
  assert.ok(check({ band: "XXL", budget: "1500" }).some((e) => /is not one of/u.test(e)));
  assert.equal("XXL" in BUDGET_BANDS, false, "XL is the ceiling");

  // a contract authored before the rule carries no band and is left alone, not retro-fitted
  assert.deepEqual(
    check({ budget: "450" }).filter((e) => /band/u.test(e)),
    []
  );
});
