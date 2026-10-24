// S22 — the in-app librarian skill. The skill is only useful if the shell can FIND it, and only
// safe if every call it makes goes through the hub, where the owner's privacy rules are applied.
// Both are asserted from the files themselves rather than from a description of them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TOP_LEVEL_SKILL_FILE_PATTERN } from "../app/L0/_all/mod/_core/skillset/skills.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app", "L0", "_all");
const DIR = path.join(APP, "mod", "_prime_silo", "estate_map", "ext", "skills", "librarian");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

// the glob the shell discovers skills with, as a regex over the app-relative path
const discoveryRe = new RegExp(
  `^${TOP_LEVEL_SKILL_FILE_PATTERN.replaceAll(".", "[.]").replaceAll("*", "[^/]+")}$`,
  "u"
);

test("Scenario: the skill is where the shell looks for skills", () => {
  const rel = path.relative(APP, path.join(DIR, "SKILL.md")).replaceAll(path.sep, "/");
  assert.match(rel, discoveryRe, `${rel} does not match ${TOP_LEVEL_SKILL_FILE_PATTERN}`);
  // the paired negative: the pattern is a real constraint, not one anything satisfies
  assert.equal(discoveryRe.test("mod/_prime_silo/estate_map/skills/librarian/SKILL.md"), false);
  assert.ok(fs.existsSync(path.join(DIR, "librarian.js")), "the helper sits beside it");
});

test("Scenario: the skill is catalogue-loaded, with a description that says when to load it", () => {
  const md = read("SKILL.md");
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  assert.ok(fm, "frontmatter present");
  const keys = Object.fromEntries(
    fm[1]
      .split(/\r?\n/u)
      .map((l) => l.match(/^(\w+):\s*(.*)$/u))
      .filter(Boolean)
      .map((m) => [m[1], m[2]])
  );
  assert.ok(keys.name, "a name");
  assert.ok((keys.description || "").length > 80, "a description long enough to route on");
  // skills.js auto-loads only a skill whose frontmatter carries `loaded`. Absent means the
  // catalogue offers it and the agent loads it when the question calls for it — benny-pilot's
  // shape. A `loaded:` here would put this skill in every prompt on every page.
  assert.equal("loaded" in keys, false, "must not be auto-loaded");
  // the rules the answer has to obey are IN the skill, or an agent will invent its own
  assert.match(md, /withheld/u, "it says what to do about withheld results");
  assert.match(md, /finishedAt|catalogue's age/u, "it says to state the catalogue's age");
});

test("Scenario: every call the helper makes is a hub library route", () => {
  const src = read("librarian.js");
  // the routes the API actually serves, read from the API rather than retyped here
  const api = fs.readFileSync(
    path.join(ROOT, "server", "coordination", "lib", "estate_api.mjs"),
    "utf8"
  );
  const served = new Set(
    [...api.matchAll(/rest === "(\/library[^"]*)"/gu)]
      .map((m) => m[1])
      .filter((r) => !r.endsWith("/stop"))
  );
  assert.ok(served.size >= 4, `the API serves the library routes: ${[...served]}`);

  // every path the helper builds, taken out of its source
  const base = (src.match(/const API = "([^"]+)"/u) ?? [])[1];
  assert.equal(base, "/api/estate/library");
  const used = new Set();
  for (const m of src.matchAll(/\$\{API\}(\/[A-Za-z]*)/gu)) used.add(m[1]);
  if (/read\(API\)/u.test(src)) used.add("");
  assert.ok(used.size >= 4, `the helper calls four routes, found: ${[...used]}`);
  for (const u of used)
    assert.ok(served.has(`/library${u}`), `${base}${u} is not a route the API serves`);

  // IT NEVER READS A CATALOGUE ITSELF: the hub is the only judge of the owner's privacy rules
  for (const forbidden of ["node:fs", "DatabaseSync", "require(", ".db"])
    assert.equal(src.includes(forbidden), false, `the helper must not reference ${forbidden}`);
  assert.equal(/\bfetch\(/u.test(src), true, "it asks the hub");
});

test("Scenario: the helper exports the four questions and declares its surface", async () => {
  const mod = await import(pathToFileURL(path.join(DIR, "librarian.js")).href);
  for (const fn of ["find", "duplicates", "check", "status"])
    assert.equal(typeof mod[fn], "function", `exports ${fn}`);
  // every query says which surface asked, so the audit event can record it
  const src = read("librarian.js");
  assert.equal(
    (src.match(/surface: "skill"/gu) ?? []).length,
    3,
    "find, duplicates and check each declare it"
  );
});

test("Scenario: the docs name every library route the API serves, and list the skill and tools", () => {
  const api = fs.readFileSync(
    path.join(ROOT, "server", "coordination", "lib", "estate_api.mjs"),
    "utf8"
  );
  const served = [...api.matchAll(/rest === "(\/library[^"]*)"/gu)].map((m) => m[1]);
  assert.ok(served.length >= 6, `routes found: ${served}`);

  // server/AGENTS.md requires the supplemental doc after any change under server/. A doc that
  // misses a route is worse than none: it reads as the whole surface.
  const doc = fs.readFileSync(
    path.join(ROOT, "app/L0/_all/mod/_core/documentation/docs/server/estate-library.md"),
    "utf8"
  );
  for (const r of new Set(served))
    assert.ok(doc.includes(r), `estate-library.md does not name ${r}`);
  // the paired negative: the check can fail
  assert.equal(doc.includes("/library/delete"), false);

  const aware = fs.readFileSync(path.join(ROOT, "AGENT-AWARENESS.md"), "utf8");
  assert.match(aware, /librarian/u, "it lists the skill");
  for (const t of ["library_find", "library_duplicates", "library_check"])
    assert.ok(aware.includes(t), `AGENT-AWARENESS.md does not list ${t}`);
  assert.match(aware, /counted, never named/u, "and what they refuse");

  const skills = fs.readFileSync(
    path.join(ROOT, "app/L0/_all/mod/_core/documentation/docs/agent/skills-and-documentation.md"),
    "utf8"
  );
  assert.match(skills, /librarian/u, "the skills doc lists it");
});
