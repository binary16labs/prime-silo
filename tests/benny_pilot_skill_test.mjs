#!/usr/bin/env node
//
// Phase B-Bridge — benny-pilot agent skill contract tests.
//
// Mirrors memory_recall_skill_test: the skill sits where onscreen discovery
// looks, has valid frontmatter, is catalog-loaded (not auto-loaded), cites the
// Bridge deep-link convention, and the helper exports the documented grounded
// query functions. bridgeLink is pure and tested directly.

import assert from "node:assert/strict";
import fs from "node:fs";

import * as pilot from "../app/L0/_all/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js";

const SKILL_PATH = "app/L0/_all/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/SKILL.md";

function globToRegExp(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$");
}

async function main() {
  testSkillFileDiscoverableByPattern();
  testFrontmatter();
  testCatalogLoadedNotAutoLoaded();
  testHelperExports();
  testBridgeLinkDeepLink();
  testReadContextReadsGlobal();
  console.log("benny_pilot_skill_test: ok");
}

function testSkillFileDiscoverableByPattern() {
  const pattern = "mod/*/*/ext/skills/*/SKILL.md";
  const relToMod = SKILL_PATH.slice(SKILL_PATH.indexOf("mod/"));
  assert.match(relToMod, globToRegExp(pattern), "skill must sit where onscreen discovery looks");
}

function testFrontmatter() {
  const md = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(md, /^---/u, "has frontmatter");
  assert.match(md, /name: Benny pilot/u);
  assert.match(md, /description: .*Bridge/iu, "description mentions the Bridge for catalog matching");
  assert.match(md, /#\/_prime_silo\/bridge/u, "cites the Bridge deep-link route");
  assert.match(md, /benny-pilot\.js/u, "tells the agent how to load the helper");
}

function testCatalogLoadedNotAutoLoaded() {
  const md = fs.readFileSync(SKILL_PATH, "utf8");
  assert.doesNotMatch(md, /metadata:\s*\n\s*loaded:/u, "benny-pilot must be catalog-loaded, not auto-loaded");
}

function testHelperExports() {
  for (const fn of ["bridgeLink", "readContext", "lifelog", "recentSessions", "search", "runs", "codeGraph"]) {
    assert.equal(typeof pilot[fn], "function", `helper exports ${fn}()`);
  }
}

function testBridgeLinkDeepLink() {
  // URLSearchParams encodes spaces as '+' (readQuery decodes both '+' and %20).
  assert.equal(pilot.bridgeLink("memory", "s 1/2"), "#/_prime_silo/bridge?mode=memory&id=s+1%2F2");
  assert.equal(pilot.bridgeLink("pulse"), "#/_prime_silo/bridge?mode=pulse");
}

function testReadContextReadsGlobal() {
  const prev = globalThis.window;
  globalThis.window = { __bennyBridgeContext: { mode: "code", workspace: "ws" } };
  try {
    assert.deepEqual(pilot.readContext(), { mode: "code", workspace: "ws" });
  } finally {
    globalThis.window = prev;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
