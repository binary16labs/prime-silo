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
  MAX_TOKENS
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
  assert.ok(r.errors.some((e) => /token/i.test(e)), `names the token rule: ${r.errors}`);
});

test("Scenario: bloated or vague contracts are rejected — missing acceptance scenario", () => {
  const vague = contract().replace(/```gherkin[\s\S]*```/, "");
  const r = validateContract(vague, { id: "X1", repoRoot: ROOT, knownIds: KNOWN });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /scenario/i.test(e)), `names the Scenario rule: ${r.errors}`);
});

test("Scenario: bloated or vague contracts are rejected — unresolved dep and bad allowlist root", () => {
  const badDep = validateContract(contract({ deps: "[ZZ99]" }), {
    id: "X1", repoRoot: ROOT, knownIds: KNOWN
  });
  assert.ok(badDep.errors.some((e) => /ZZ99/.test(e)), `names the dep: ${badDep.errors}`);

  const badPath = validateContract(contract({ allowlist: "[nonexistent-root/x.js]" }), {
    id: "X1", repoRoot: ROOT, knownIds: KNOWN
  });
  assert.ok(badPath.errors.some((e) => /nonexistent-root/.test(e)), `names the path: ${badPath.errors}`);

  const badVerify = validateContract(contract({ verify: "node scripts/gates/zz.mjs", allowlist: "[server/coordination/]" }), {
    id: "X1", repoRoot: ROOT, knownIds: KNOWN
  });
  assert.ok(badVerify.errors.some((e) => /verify/i.test(e)), `names the verify rule: ${badVerify.errors}`);
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
