// S26 — the Drives panel. Its judgements are pure functions, so these run without a DOM.
//
// The markup is checked for one thing: that it exists and links what it says it links. A view that
// cannot load its own stylesheet is a blank page, and a blank page and an empty drive look the same
// — which is the S4 panel test's lesson and applies here unchanged.
//
// The load-bearing assertion is the last one: every URL this panel builds must be a route the API
// actually serves, read out of the API rather than retyped here. A panel that reads a catalogue
// directly would be a second judge of the owner's quarantine rules, and the first to drift leaks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(ROOT, "app", "L0", "_all", "mod", "_prime_silo", "drives");
const read = (f) => fs.readFileSync(path.join(PANEL, f), "utf8");

test("S26: the panel is where the shell looks, and links what it needs", () => {
  const yaml = read(path.join("ext", "panels", "drives.yaml"));
  assert.match(yaml, /^path: _prime_silo\/drives$/mu, "it declares its route");
  assert.match(yaml, /^name: Drives$/mu);
  assert.ok(/^description: .{60,}$/mu.test(yaml), "with a description long enough to be useful");

  const view = read("view.html");
  for (const href of [
    "/mod/_core/framework/css/layout.css",
    "/mod/_core/framework/css/type.css",
    "/mod/_prime_silo/drives/drives.css",
    "/mod/_prime_silo/drives/drives.js"
  ])
    assert.ok(view.includes(href), `the view links ${href}`);
  // the paired negative: this check can fail
  assert.equal(view.includes("/mod/_prime_silo/nothing.css"), false);
});

test("S26: every URL the panel builds is a route the API serves", () => {
  const js = read("drives.js");
  const api = fs.readFileSync(
    path.join(ROOT, "server", "coordination", "lib", "estate_api.mjs"),
    "utf8"
  );
  const served = new Set(
    [...api.matchAll(/rest === "(\/library[^"]*)"/gu)]
      .map((m) => m[1])
      .filter((r) => !r.endsWith("/stop"))
  );
  assert.ok(served.size >= 6, `the API serves the library routes: ${[...served]}`);

  const base = (js.match(/const API = "([^"]+)"/u) ?? [])[1];
  assert.equal(base, "/api/estate/library");
  const used = new Set();
  for (const m of js.matchAll(/\$\{API\}(\/[A-Za-z]*)/gu)) used.add(m[1]);
  if (/read\(API\)/u.test(js)) used.add("");
  assert.ok(used.size >= 3, `it calls the folder, neighbours and library routes: ${[...used]}`);
  for (const u of used) assert.ok(served.has(`/library${u}`), `${base}${u} is not a route`);

  // IT READS NOTHING ITSELF. The hub is the one place the owner's rules are applied.
  for (const forbidden of ["node:fs", "DatabaseSync", ".db", "require(", "readFile"])
    assert.equal(js.includes(forbidden), false, `the panel must not reference ${forbidden}`);
  assert.match(js, /fetch\(/u, "it asks the hub");
});

test("S26: the panel keeps the two duplicate figures apart", async () => {
  // Merging them would send the owner at the wrong job: a tree duplicated against another tree can
  // be retired, a tree duplicated against itself cannot. The panel's own wording has to carry that.
  const mod = await import(pathToFileURL(path.join(PANEL, "drives.js")).href);
  void mod;
  const page = globalThis.drivesPage();

  assert.equal(
    page.dupLine({ all_elsewhere: true, dup_out_bytes: 5e9, dup_in_bytes: 0 }),
    "all of it exists elsewhere",
    "the one line that invites retiring a whole tree"
  );
  assert.equal(
    page.dupLine({ all_elsewhere: false, dup_out_bytes: 2e9, dup_in_bytes: 0 }),
    "2.0 GB elsewhere"
  );
  assert.equal(
    page.dupLine({ all_elsewhere: false, dup_out_bytes: 0, dup_in_bytes: 3e9 }),
    "3.0 GB inside",
    "duplicated inside itself reads differently, because it is a different job"
  );
  assert.equal(
    page.dupLine({ all_elsewhere: false, dup_out_bytes: 2e9, dup_in_bytes: 3e9 }),
    "2.0 GB elsewhere · 3.0 GB inside",
    "and both at once are both said"
  );
  assert.equal(page.dupLine({ all_elsewhere: false, dup_out_bytes: 0, dup_in_bytes: 0 }), "");
});

test("S26: sizes read as sizes, and a still-building rollup is said in words", async () => {
  await import(pathToFileURL(path.join(PANEL, "drives.js")).href);
  const page = globalThis.drivesPage();
  assert.equal(page.size(0), "0 bytes");
  assert.equal(page.size(1536), "1.5 kB");
  assert.equal(page.size(2.5e9), "2.5 GB");
  assert.equal(page.size(1.55e12), "1.6 TB");
  assert.equal(page.size(267.6e9), "268 GB", "past ten units, the decimal is noise");
  assert.equal(page.count(1117007), (1117007).toLocaleString());

  // 202 is not a failure and not an empty folder, and the page must not render it as either
  const js = read("drives.js");
  assert.match(js, /status === 202/u, "202 is handled on its own");
  assert.match(js, /Still being worked out/u, "and said in words");
});
