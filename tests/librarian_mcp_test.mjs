// S22 — the three MCP tools, for agents outside the app.
//
// HOW THIS FILE TESTS, AND WHY. `mcp/server.js` imports @modelcontextprotocol/sdk, which this repo
// does not install, and it connects a stdio transport at import time — so it can be neither imported
// nor booted here. Gate b2 already meets the same wall and answers it the same way: assert against
// the shipped SOURCE. Two of the three claims are stronger that way than a spy would make them.
// A spy proves a particular run opened no catalogue; the structural assertion below proves the file
// cannot, because it names no database, no sqlite and no path to one.
//
// The one claim that needs real execution is how the hub's address is worked out, so `resolveHub` is
// lifted out of the shipped text and run for real against stubbed config, rather than described.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "mcp", "server.js"), "utf8");
const TOOLS = ["library_find", "library_duplicates", "library_check"];

test("Scenario: the three tools are listed, each with an input schema", () => {
  for (const name of TOOLS) {
    const at = SRC.indexOf(`name: "${name}"`);
    assert.notEqual(at, -1, `${name} is not declared`);
    const block = SRC.slice(at, at + 1600);
    assert.match(block, /description:/u, `${name} has a description`);
    assert.match(block, /inputSchema: \{/u, `${name} has an input schema`);
    assert.match(block, /required: \[/u, `${name} says which arguments are required`);
    // the handler must actually dispatch it, or a listed tool answers "Unknown tool"
    assert.ok(SRC.includes(`case "${name}":`), `${name} is listed but not handled`);
  }
  // the paired negative: this check can fail. A tool that does not exist is not found.
  assert.equal(SRC.includes('name: "library_delete"'), false);
});

test("Scenario: an outside agent reaches the catalogue only through the hub", () => {
  // The hub is where the owner's quarantine rules are applied and counted. A direct read here
  // would be a second judge of those rules, and the first one to drift would hand an outside agent
  // a name the app itself refuses to show. So the library handler owns no route to the data.
  const at = SRC.indexOf('case "library_find":');
  const handler = SRC.slice(at, SRC.indexOf("default:", at));
  assert.ok(handler.length > 400, "the library handler was found");
  for (const forbidden of ["DatabaseSync", "node:sqlite", ".db", "library.mjs", "readFileSync"])
    assert.equal(handler.includes(forbidden), false, `the handler must not reference ${forbidden}`);
  assert.match(handler, /fetch\(/u, "it asks the hub over HTTP");
  assert.match(handler, /api\/estate\/library/u, "at the library routes");
  // every query declares which surface asked, so the hub's audit event can record it
  assert.equal(
    (handler.match(/surface: "mcp"/gu) ?? []).length,
    2,
    "the GETs and the POST declare it"
  );
  assert.match(handler, /surface=mcp|surface": "mcp"|URLSearchParams\(\{ surface: "mcp" \}\)/u);
});

test("Scenario: with the hub stopped the tools say so, and never read the file instead", () => {
  const at = SRC.indexOf('case "library_find":');
  const handler = SRC.slice(at, SRC.indexOf("default:", at));
  const rescue = handler.slice(handler.indexOf("catch"));
  assert.match(rescue, /hub is not running/u, "it says the hub is not running");
  assert.match(rescue, /PRIME_SILO_API/u, "and how to point it somewhere else");
  // the failure path returns an answer; it does not fall through to another source of truth
  assert.match(rescue, /libraryAnswer\(/u);
  for (const forbidden of ["DatabaseSync", "sqlite", "readFileSync", ".db"])
    assert.equal(rescue.includes(forbidden), false, `no fallback via ${forbidden}`);
});

// --- the hub's address, executed for real ------------------------------------------------------
// resolveHub is lifted out of the shipped source and evaluated with stubbed config, so these are
// the real rules running, not a copy of them. If the function is renamed or removed, this throws.
const loadResolveHub = async () => {
  const start = SRC.indexOf("export function resolveHub");
  assert.notEqual(start, -1, "resolveHub is exported from mcp/server.js");
  const end = SRC.indexOf("\n}\n", start) + 3;
  const body = SRC.slice(start, end).replace("export function", "function");
  const factory = new Function(
    "readDotEnvFile",
    "getProjectEnvFilePath",
    "PROJECT_ROOT",
    `${body}; return resolveHub;`
  );
  return (stored, env) =>
    factory(
      () => stored,
      () => "/stub/.env",
      "/stub"
    )({ env, projectRoot: "/stub" });
};

test("Scenario: the hub address comes from the local config, and the answer says where from", async () => {
  const resolveHub = await loadResolveHub();

  // PRIME_SILO_API wins over anything stored
  assert.deepEqual(
    resolveHub({ HOST: "10.0.0.9", PORT: "4000" }, { PRIME_SILO_API: "http://example:9/" }),
    {
      url: "http://example:9",
      from: "PRIME_SILO_API"
    }
  );

  // otherwise .env, and 0.0.0.0 is a BIND address, not somewhere to connect
  assert.deepEqual(resolveHub({ HOST: "0.0.0.0", PORT: "3000" }, {}), {
    url: "http://127.0.0.1:3000",
    from: ".env"
  });
  assert.deepEqual(resolveHub({ HOST: "127.0.0.1", PORT: "8080" }, {}), {
    url: "http://127.0.0.1:8080",
    from: ".env"
  });
  // a foreign .env is VISIBLE in the answer rather than silently queried — the ASUS lesson
  assert.deepEqual(resolveHub({ HOST: "192.168.1.50", PORT: "3000" }, {}), {
    url: "http://192.168.1.50:3000",
    from: ".env"
  });

  // PORT=0 cannot be resolved from config at all, and saying so beats guessing 3000
  const zero = resolveHub({ HOST: "0.0.0.0", PORT: "0" }, {});
  assert.equal(zero.url, undefined, "no address is invented");
  assert.match(zero.error, /PORT=0/u);
  assert.match(zero.error, /PRIME_SILO_API/u, "it says how to fix it");

  // an unreadable or absent .env falls back to the documented default, still labelled
  assert.deepEqual(resolveHub({}, {}), { url: "http://127.0.0.1:3000", from: ".env" });
});
