#!/usr/bin/env node
//
// Phase M1 — memory page (#/_prime_silo/memory) factory tests.
//
// Drives window.memoryPage() with a stubbed global fetch and a minimal
// Alpine harness ($refs, $nextTick). Verifies the offline state on a 502,
// the ready state on success, and that selecting a session mounts the
// lineage graph into the graph ref.
//
// The page entry assigns `window.memoryPage = ...` at module load, so we set
// globalThis.window first and dynamic-import the module (same approach as
// manifest_explorer_test.mjs).

import assert from "node:assert/strict";

globalThis.window = { location: { hash: "" } };
globalThis.document = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {}
};

const mod = await import("../app/L0/_all/mod/_prime_silo/memory/memory.js");
const page = mod.__testing;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installFetch(router) {
  globalThis.fetch = async (url) => router(String(url));
}

function fakeHost() {
  return {
    classList: { add() {}, remove() {} },
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

function harness(component) {
  component.$nextTick = (fn) => fn();
  component.$refs = { cards: fakeHost(), graph: fakeHost() };
  return component;
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function main() {
  testReadSessionIdFromQuery();
  await testOfflineState();
  await testReadyAndSelectMountsGraph();
  console.log("memory_page_test: ok");
}

function testReadSessionIdFromQuery() {
  globalThis.window.location.hash = "#/_prime_silo/memory?session_id=abc123";
  assert.equal(page.readSessionIdFromQuery(), "abc123");
  globalThis.window.location.hash = "#/_prime_silo/memory";
  assert.equal(page.readSessionIdFromQuery(), "");
}

async function testOfflineState() {
  globalThis.window.location.hash = "";
  installFetch((url) => {
    if (url.includes("/api/memoray/sessions")) {
      return jsonResponse({ error: "memoray_unreachable", hint: "boot scripts/memoray.ps1" }, 502);
    }
    return jsonResponse({}, 200);
  });
  const component = harness(window.memoryPage());
  await component.init();
  await settle();
  assert.equal(component.state, "offline", "502 unreachable → offline screen");
}

async function testReadyAndSelectMountsGraph() {
  globalThis.window.location.hash = "";
  const sessions = [
    { id: "s1", agent: "Claude", content: "Session one", metadata: { project: "P" } }
  ];
  installFetch((url) => {
    if (url.includes("/api/memoray/sessions")) return jsonResponse(sessions);
    if (url.includes("/api/integration_audit"))
      return jsonResponse({
        integrations: [{ id: "memoray", status: "pass", summary: { drift: 0 } }]
      });
    if (url.includes("/api/memoray/beta/overview"))
      return jsonResponse({
        projects: [],
        worktrees: [],
        totalSessions: 1,
        totalTokens: 0,
        hotFiles: []
      });
    if (url.includes("/api/memoray/system/capabilities"))
      return jsonResponse({ claude: { mcpServers: [] }, antigravity: { plugins: [] } });
    if (url.includes("/api/memoray/system/metrics"))
      return jsonResponse({
        cpu: "1",
        ram: { used: 1, total: 2, percent: "50" },
        network: {},
        processes: []
      });
    if (url.includes("/api/memoray/graph/"))
      return jsonResponse({ nodes: [{ id: "s1", type: "Session", label: "S" }], links: [] });
    return jsonResponse({});
  });

  const component = harness(window.memoryPage());
  await component.init();
  await settle();
  assert.equal(component.state, "ready");
  assert.equal(component.sessions.length, 1);
  assert.equal(component.conformance.status, "pass", "conformance strip reflects the audit");

  component.selectSession("s1");
  await settle();
  assert.equal(component.activeSessionId, "s1");
  assert.ok(component._graphWidget, "selecting a session mounts the lineage graph widget");

  component.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
