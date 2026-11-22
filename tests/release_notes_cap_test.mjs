// v1.24.6 publish failed: 459 commits since v1.24.5 made a 277k-char release body; GitHub refuses
// > 125,000 (422). The notes script now caps the body, keeps the downloads table, links the full list.
//   node tests/release_notes_cap_test.mjs   (uses the real local tags; no network: no OPENROUTER key)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const notes = (cur, prev) => {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [path.join(ROOT, "packaging", "scripts", "release-notes.js"), "--current-tag", cur, "--previous-tag", prev], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
let pass = 0;
const has = (t) => spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${t}`], { cwd: ROOT }).status === 0;

if (has("v1.24.6") && has("v1.24.5")) {
  const big = notes("v1.24.6", "v1.24.5");
  assert.ok(big.length <= 125000, `body ${big.length} > GitHub's 125,000 limit`);
  assert.match(big, /^## Downloads/);
  assert.match(big, /compare\/v1\.24\.5\.\.\.v1\.24\.6$/);
  pass++;
  console.log(`  ok  a 459-commit release is capped (${big.length} chars), downloads kept, full list linked`);
}
if (has("v1.24.5") && has("v1.24.4")) {
  const small = notes("v1.24.5", "v1.24.4");
  assert.doesNotMatch(small, /…and more/);
  pass++;
  console.log(`  ok  NEGATIVE: a normal release (${small.length} chars) is untouched`);
}
assert.ok(pass > 0, "no release tags present to test against (0 of 0 is not a pass)");
console.log(`PASS ${pass} checks`);
