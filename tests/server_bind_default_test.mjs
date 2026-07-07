#!/usr/bin/env node
//
// Q0 — server is loopback by default. Scenario names map to delivery/tasks/Q0.md:
//   • no HOST env → 127.0.0.1, not LAN-exposed
//   • HOST=0.0.0.0 → honoured, flagged lanExposed so startup logs the warning
//
// Hermetic: exercises the exported resolveBindHost helper; no sockets opened.

import assert from "node:assert/strict";

// Q0: the proxy config asserts at import-time consumers... app.js imports
// runtime_proxy which fails fast without keys — pin fixtures first.
process.env.BENNY_API_KEY = "q0-test-fixture-human-key";
process.env.BENNY_AGENT_API_KEY = "q0-test-fixture-agent-key";

const { resolveBindHost } = await import("../server/app.js");

// Scenario: server is loopback by default (no HOST env)
{
  const { host, lanExposed } = resolveBindHost(undefined);
  assert.equal(host, "127.0.0.1", "no HOST must default to loopback");
  assert.equal(lanExposed, false);
}
{
  const { host, lanExposed } = resolveBindHost("");
  assert.equal(host, "127.0.0.1", "blank HOST must default to loopback");
  assert.equal(lanExposed, false);
}

// Scenario: HOST=0.0.0.0 set explicitly → honoured + flagged for the warning
for (const wildcard of ["0.0.0.0", "::", "[::]"]) {
  const { host, lanExposed } = resolveBindHost(wildcard);
  assert.equal(host, wildcard, "explicit wildcard HOST must be honoured");
  assert.equal(lanExposed, true, `${wildcard} must be flagged as LAN exposure`);
}

// A specific interface is honoured without the LAN warning flag.
{
  const { host, lanExposed } = resolveBindHost("192.168.1.50");
  assert.equal(host, "192.168.1.50");
  assert.equal(lanExposed, false, "a named interface is a deliberate choice, not the wildcard");
}

console.log("server_bind_default_test: ok");
