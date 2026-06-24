#!/usr/bin/env node
//
// Phase M1 — memory-recall agent skill contract tests.
//
// Verifies the SKILL.md frontmatter, that the file sits at a path the
// onscreen skill discovery glob (mod/*/*/ext/skills/*/SKILL.md) matches, and
// that the helper module exports the documented functions (sessionLink is
// pure and testable directly).

import assert from "node:assert/strict";
import fs from "node:fs";

import * as memoryRecall from "../app/L0/_all/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js";

const SKILL_PATH = "app/L0/_all/mod/_prime_silo/memoray_client/ext/skills/memory-recall/SKILL.md";

function globToRegExp(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$");
}

async function main() {
  testSkillFileDiscoverableByPattern();
  testFrontmatter();
  testCatalogLoadedNotAutoLoaded();
  testHelperExports();
  testSessionLinkDeepLink();
  console.log("memory_recall_skill_test: ok");
}

function testSkillFileDiscoverableByPattern() {
  // The shared discovery pattern from skillset/skills.js.
  const pattern = "mod/*/*/ext/skills/*/SKILL.md";
  const relToMod = SKILL_PATH.slice(SKILL_PATH.indexOf("mod/"));
  assert.match(relToMod, globToRegExp(pattern), "skill must sit where onscreen discovery looks");
}

function testFrontmatter() {
  const md = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(md, /^---/u, "has frontmatter");
  assert.match(md, /name: Memory recall/u);
  assert.match(
    md,
    /description: .*memory graph/iu,
    "description mentions the memory graph for catalog matching"
  );
  // Cites the deep-link convention and the proxy path.
  assert.match(md, /#\/_prime_silo\/memory/u);
  assert.match(md, /\/api\/memoray/u);
}

function testCatalogLoadedNotAutoLoaded() {
  const md = fs.readFileSync(SKILL_PATH, "utf8");
  // It must NOT declare metadata.loaded — that would auto-load it into every
  // prompt and tax small local models. Catalog-only = loaded on demand.
  assert.doesNotMatch(
    md,
    /metadata:\s*\n\s*loaded:/u,
    "memory-recall must be catalog-loaded, not auto-loaded"
  );
}

function testHelperExports() {
  for (const fn of [
    "recentSessions",
    "search",
    "overview",
    "sessionGraph",
    "filesTouched",
    "sessionLink"
  ]) {
    assert.equal(typeof memoryRecall[fn], "function", `helper exports ${fn}()`);
  }
}

function testSessionLinkDeepLink() {
  assert.equal(memoryRecall.sessionLink("s 1/2"), "#/_prime_silo/memory?session_id=s%201%2F2");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
