// W0 acceptance tests — one block per contract scenario (delivery/tasks/W0.md).
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  BUDGET_BANDS,
  readBudget,
  gatherBudgetRows,
  generatedOutputs
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

// --- S27: the budget as a reading, not a prediction --------------------------------------------
// Three contracts in a row overran by 30 to 40 per cent. A ceiling does not fix a bad estimator, so
// the figure becomes something an author reads while there is still work left to split. These pin
// what it counts — and, more importantly, what it must refuse to count, because every one of those
// exclusions was found by hand after the fact and then written down in prose that was forgotten.

const rows = (pairs) => pairs.map(([path, added]) => ({ path, added }));

test("Scenario: the reading counts what the convention says and nothing else", () => {
  const r = readBudget({
    id: "X1",
    band: "M",
    budget: 500,
    rows: rows([
      ["server/coordination/lib/library.mjs", 120],
      ["app/L0/_all/mod/_prime_silo/drives/drives.js", 80],
      ["delivery/tasks/X1.md", 40], // the contract itself
      ["tests/library_test.mjs", 200], // tests
      ["delivery/board/LOG.md", 60], // the board, which the DoD makes every task write
      ["manual/SITEMAP.md", 19], // regenerated, not written
      ["manual/usecases.coverage.json", 19],
      ["manual/usecases.json", 48] // hand-edited: this one DOES count
    ]),
    generated: generatedOutputs(ROOT)
  });

  assert.equal(r.counted, 120 + 80 + 48, `only authored source: ${JSON.stringify(r.counted)}`);
  assert.equal(r.band, "M");
  assert.equal(r.budget, 500);
  assert.equal(r.left, 500 - 248);
  assert.equal(r.over, false);

  // the exclusions are NAMED, so the reading can be argued with rather than trusted
  const why = Object.fromEntries(r.excluded.map((e) => [e.path, e.why]));
  assert.equal(why["delivery/tasks/X1.md"], "the contract itself");
  assert.equal(why["tests/library_test.mjs"], "tests");
  assert.equal(why["delivery/board/LOG.md"], "the board");
  assert.equal(why["manual/SITEMAP.md"], "generated");
  assert.equal(why["manual/usecases.coverage.json"], "generated");
  assert.equal(why["manual/usecases.json"], undefined, "a hand-edited registry is not generated");

  // the paired negative: a reading that counted everything would report 586
  assert.notEqual(r.counted, 586);
});

test("Scenario: crossing the band is said while there is still work to do", () => {
  const r = readBudget({
    id: "X1",
    band: "S",
    budget: 300,
    rows: rows([["server/app.js", 310]])
  });
  assert.equal(r.counted, 310);
  assert.equal(r.over, true);
  assert.equal(r.left, -10);
  assert.match(r.verdict, /over band S/iu);
  // it reports; it does not refuse. The band is a trigger for a conversation, and w0 already
  // enforces band equals budget — a second refusal here would be ceremony.
  assert.equal(r.refused, undefined);
  assert.equal(typeof r.verdict, "string");

  const under = readBudget({
    id: "X1",
    band: "S",
    budget: 300,
    rows: rows([["server/app.js", 290]])
  });
  assert.equal(under.over, false);
  assert.match(under.verdict, /10 left/u);
});

test("Scenario: an unformatted file is named rather than silently counted", () => {
  // 180 of S26's lines were a JSON round-trip reformatting a file nobody had edited. A figure the
  // formatter would change is not a figure to argue about.
  const r = readBudget({
    id: "X1",
    band: "M",
    budget: 500,
    rows: rows([["manual/usecases.json", 228]]),
    unformatted: ["manual/usecases.json"]
  });
  assert.match(r.verdict, /format/iu, `it says to format first: ${r.verdict}`);
  assert.deepEqual(r.unformatted, ["manual/usecases.json"]);

  // and when everything is formatted it says nothing about formatting
  const clean = readBudget({
    id: "X1",
    band: "M",
    budget: 500,
    rows: rows([["manual/usecases.json", 48]])
  });
  assert.equal(/format/iu.test(clean.verdict), false);
});

// --- S27 round 2: what a verifier's mutations proved was undefended ---------------------------
// Three mutations survived round one, all on the half of this contract that is not the pure
// function: delete the whole command and the gate still printed GATE GREEN; count added+deleted and
// every test stayed green; revert the working-tree read to three-dot and nothing noticed. The
// deliverable IS the command, so the command is what these pin.

test("Scenario: the generated set is read off the build scripts, not transcribed", () => {
  const g = generatedOutputs(ROOT);
  // the six the first version listed by hand — and the six it had missed
  for (const f of [
    "manual/SITEMAP.md",
    "manual/USE-CASES.md",
    "manual/PROCESS-FLOWS.md",
    "manual/ROBUSTNESS.md",
    "manual/sitemap.json",
    "manual/usecases.coverage.json",
    "manual/OPERATING-MANUAL.md",
    "manual/manual.rag.md",
    "manual/manual.rag.jsonl",
    "manual/manual.pageindex.md",
    "manual/manual.triples.json",
    "manual/tour.html"
  ])
    assert.ok(g.has(f), `${f} is written by a build script and must not be charged to an author`);

  // and the two the first version wrongly held: nothing in the repo writes these, they are edited
  // by hand, and excluding them handed out 700 free lines of authored content
  for (const f of [
    "manual/flows.json",
    "manual/robustness.json",
    "manual/usecases.json",
    "manual/manual.json"
  ])
    assert.equal(g.has(f), false, `${f} is hand-edited source and must be counted`);
});

const fakeGit = (diff, others = "") => {
  const calls = [];
  const git = (...args) => {
    calls.push(args.join(" "));
    if (args[0] === "diff") return { status: 0, stdout: diff, stderr: "" };
    if (args[0] === "ls-files") return { status: 0, stdout: others, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
};

const TAB = String.fromCharCode(9);

test("Scenario: only added lines count, and against the working tree", () => {
  const { git, calls } = fakeGit(
    [
      "40" + TAB + "35" + TAB + "server/a.mjs",
      "10" + TAB + "0" + TAB + "server/b.mjs",
      "-" + TAB + "-" + TAB + "res/logo.png"
    ].join(String.fromCharCode(10))
  );
  const rows = gatherBudgetRows({ git, ref: "abc123", repoRoot: ROOT });

  // added-only. added+deleted reads 85, which is how one branch managed to be 923 or 990 or 856
  const r = readBudget({
    id: "X1",
    band: "S",
    budget: 300,
    rows,
    generated: generatedOutputs(ROOT)
  });
  assert.equal(r.counted, 50, `added lines only: ${JSON.stringify(rows)}`);
  assert.notEqual(r.counted, 85, "added+deleted is a different rule and makes bands unarguable");

  // the working tree, not HEAD: a three-dot diff reads 0 for everything uncommitted, which is the
  // one moment the figure is worth having
  assert.ok(
    calls.includes("diff --numstat abc123"),
    `the diff must be against the working tree: ${JSON.stringify(calls)}`
  );
  assert.equal(
    calls.some((c) => c.includes("...")),
    false,
    "a three-dot range here would silence every uncommitted line"
  );

  // a binary file has no lines to count — but it is named rather than silently dropped
  const png = r.excluded.find((e) => e.path === "res/logo.png");
  assert.match(png?.why ?? "", /binary/u);
});

test("Scenario: a file that is not committed yet still counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s27-"));
  fs.writeFileSync(path.join(dir, "new.mjs"), ["a", "b", "c", ""].join(String.fromCharCode(10)));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "more.mjs"), ["x", "y"].join(String.fromCharCode(10)));
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 0, 2]));
  const { git } = fakeGit(
    "",
    ["new.mjs", "sub/more.mjs", "blob.bin", ""].join(String.fromCharCode(10))
  );

  const rows = gatherBudgetRows({ git, ref: "abc123", repoRoot: dir });
  const r = readBudget({ id: "X1", band: "S", budget: 300, rows, generated: new Set() });
  // 3 + 2: new files are most of what a contract writes, and git diff cannot see any of them. The
  // shipped version told an author holding 657 uncommitted lines that they had 143 left.
  assert.equal(r.counted, 5, `untracked lines are counted: ${JSON.stringify(rows)}`);
  assert.match(r.excluded.find((e) => e.path === "blob.bin")?.why ?? "", /binary/u);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scenario: a reading it cannot derive is an error, never zero", () => {
  // every fail-open pointed the same way — "you have room". A typo'd --base printed "300 left".
  const git = (...args) =>
    args[0] === "diff"
      ? { status: 128, stdout: "", stderr: "fatal: bad revision 'mian'" }
      : { status: 0, stdout: "", stderr: "" };
  assert.throws(() => gatherBudgetRows({ git, ref: "mian", repoRoot: ROOT }), /bad revision/u);

  // and a formatter that could not run says so rather than reading clean — the checkout a verifier
  // is told to use has no node_modules
  const quiet = readBudget({ id: "X1", band: "S", budget: 300, rows: [], formatterRan: false });
  assert.match(quiet.verdict, /formatter could not run/u);
  assert.equal(
    /could not run/u.test(readBudget({ id: "X1", band: "S", budget: 300 }).verdict),
    false
  );

  // a file that was not counted cannot be inflating the figure
  const both = readBudget({
    id: "X1",
    band: "S",
    budget: 300,
    rows: [{ path: "tests/t.mjs", added: 90 }],
    unformatted: ["tests/t.mjs"]
  });
  assert.equal(
    /format/iu.test(both.verdict),
    false,
    `not counted and inflating at once: ${both.verdict}`
  );

  // no band declared: "OVER band undefined" is not a sentence
  const nb = readBudget({ id: "X1", budget: 100, rows: [{ path: "a.mjs", added: 150 }] });
  assert.match(nb.verdict, /OVER budget by 50/u);
});

test("Scenario: the command itself runs and prints a reading", () => {
  // the mutation that mattered: delete the whole --budget entry point and every other test here
  // stays green while `w0.mjs --budget S27` prints GATE GREEN and no figure at all.
  const r = spawnSync(process.execPath, ["scripts/gates/w0.mjs", "--budget", "S27"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[budget\] S27 \(band S\) vs /u, `no reading printed: ${r.stdout}`);
  assert.match(
    r.stdout,
    /\[budget\] \d+ non-test lines of 300 . /u,
    `no figure printed: ${r.stdout}`
  );
  assert.match(
    r.stdout,
    /not counted: \d+ in tests\//u,
    "the exclusions are shown, not just applied"
  );

  // a ref it cannot resolve refuses rather than reporting a budget nobody spent
  const bad = spawnSync(
    process.execPath,
    ["scripts/gates/w0.mjs", "--budget", "S27", "--base", "mian-not-a-ref"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(bad.status, 1, `a bad --base must not read clean: ${bad.stdout}`);
  assert.equal(/non-test lines/u.test(bad.stdout), false, bad.stdout);
});
