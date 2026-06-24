#!/usr/bin/env node
//
// Phase M1 — memoray.overview_cards (Command Center) widget tests.
//
// Covers the pure render helpers (the hotFiles fileName/filePath regression
// guard lives here), recent-session derivation, and the factory lifecycle:
// loads via injected client, renders, wires session clicks, and — the bug
// class we fixed in the React original — clears the metrics interval and the
// visibilitychange listener on destroy.

import assert from "node:assert/strict";

import {
  createOverviewCardsWidget,
  __testing as oc
} from "../app/L0/_all/mod/_prime_silo/widgets/memoray/overview_cards/index.js";

async function main() {
  testFormatBytesAndBasename();
  testDeriveRecentSessionsSortsAndCaps();
  testHeatmapUsesFileNameFilePath();
  testCapabilitiesRendersMcpAndPlugins();
  await testFactoryLoadsRendersAndSelects();
  await testDestroyClearsTimerAndListener();
  await testOfflineState();
  console.log("widgets_memoray_overview_cards_test: ok");
}

function testFormatBytesAndBasename() {
  assert.equal(oc.formatBytes(0), "0 B");
  assert.equal(oc.formatBytes(1024), "1 KB");
  assert.equal(oc.basename("C:\\a\\b\\c.js"), "c.js");
  assert.equal(oc.basename("/x/y/z.txt"), "z.txt");
}

function testDeriveRecentSessionsSortsAndCaps() {
  const overview = {
    projects: [
      {
        name: "P1",
        agents: {
          claude: {
            sessions: [
              { id: "a", timestamp: 100 },
              { id: "b", timestamp: 300 }
            ]
          }
        }
      },
      { name: "P2", agents: { antigravity: { sessions: [{ id: "c", timestamp: 200 }] } } }
    ]
  };
  const recent = oc.deriveRecentSessions(overview);
  assert.deepEqual(
    recent.map((s) => s.id),
    ["b", "c", "a"],
    "newest first across projects"
  );
  assert.equal(recent[0].projectName, "P1");
  assert.equal(oc.deriveRecentSessions(null).length, 0);
}

function testHeatmapUsesFileNameFilePath() {
  // Regression guard: the widget must read fileName/filePath (NOT path).
  const html = oc.renderHeatmapCard({
    hotFiles: [
      {
        fileName: "memoray_proxy.js",
        filePath: "C:/x/memoray_proxy.js",
        agent: "Claude",
        count: 9
      },
      { fileName: "index.js", filePath: "C:/y/index.js", agent: "Antigravity", count: 3 }
    ]
  });
  assert.match(html, /memoray_proxy\.js/);
  assert.match(html, /9×/);
  assert.match(html, /index\.js/);
  // A row missing fileName must fall back to filePath, never "Unknown" if a path exists.
  const fallback = oc.renderHeatmapCard({
    hotFiles: [{ filePath: "C:/z/only_path.js", count: 1, agent: "Claude" }]
  });
  assert.match(fallback, /only_path\.js/);
}

function testCapabilitiesRendersMcpAndPlugins() {
  const html = oc.renderCapabilitiesCard({
    claude: { mcpServers: [{ name: "filesystem", command: "npx mcp-fs" }] },
    antigravity: { plugins: ["search"], permissions: ["command(git)"] }
  });
  assert.match(html, /filesystem/);
  assert.match(html, /search/);
  assert.match(html, /EXECUTE/, "command(...) permission renders as EXECUTE scope");
}

/* ── fakes ───────────────────────────────────────────────────────────── */

function createFakeHost() {
  const sessionEls = [];
  return {
    classList: { add() {}, remove() {} },
    innerHTML: "",
    _sessionEls: sessionEls,
    querySelector(sel) {
      // Pretend the grid is not yet present so pollMetrics takes the no-op path.
      return null;
    },
    querySelectorAll(sel) {
      return sel === "[data-session-id]" ? sessionEls : [];
    }
  };
}

function fakeSessionEl(id) {
  const listeners = [];
  return {
    _id: id,
    getAttribute: (n) => (n === "data-session-id" ? id : null),
    addEventListener: (_type, h) => listeners.push(h),
    click: () => listeners.forEach((h) => h())
  };
}

function clientStub(handlers) {
  return {
    memorayFetch: async (path) => ({ _path: path }),
    readMemorayJson: async (resp) => {
      const handler = handlers[resp._path];
      if (!handler) throw new Error("no handler for " + resp._path);
      const result = handler();
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const OVERVIEW = {
  projects: [
    { name: "P", agents: { claude: { sessions: [{ id: "s1", timestamp: 1, title: "T" }] } } }
  ],
  worktrees: [],
  totalSessions: 1,
  totalTokens: 5,
  hotFiles: []
};

async function testFactoryLoadsRendersAndSelects() {
  const host = createFakeHost();
  host._sessionEls.push(fakeSessionEl("clicked-session"));
  const selected = [];
  const client = clientStub({
    "/beta/overview": () => OVERVIEW,
    "/system/capabilities": () => ({ claude: { mcpServers: [] }, antigravity: { plugins: [] } }),
    "/system/metrics": () => ({
      cpu: "1.0",
      ram: { used: 1, total: 2, percent: "50" },
      network: {},
      processes: []
    })
  });
  const widget = createOverviewCardsWidget(
    host,
    { onSelectSession: (id) => selected.push(id) },
    { memorayClient: client }
  );
  await settle();
  assert.match(host.innerHTML, /mray-oc__grid/, "renders the card grid");
  // Session click wiring (querySelectorAll → addEventListener).
  host._sessionEls[0].click();
  assert.deepEqual(selected, ["clicked-session"]);
  widget.destroy();
}

async function testDestroyClearsTimerAndListener() {
  // Install a fake global document so the visibilitychange listener path runs.
  const docListeners = new Map();
  const fakeDoc = {
    visibilityState: "visible",
    addEventListener: (t, h) => {
      docListeners.set(t, (docListeners.get(t) || 0) + 1);
    },
    removeEventListener: (t, h) => {
      docListeners.set(t, (docListeners.get(t) || 0) - 1);
    }
  };
  const priorDoc = globalThis.document;
  globalThis.document = fakeDoc;

  const clearedIds = [];
  const realClear = globalThis.clearInterval;
  globalThis.clearInterval = (id) => {
    clearedIds.push(id);
    return realClear(id);
  };

  try {
    const host = createFakeHost();
    const client = clientStub({
      "/beta/overview": () => OVERVIEW,
      "/system/capabilities": () => ({ claude: { mcpServers: [] }, antigravity: { plugins: [] } }),
      "/system/metrics": () => ({
        cpu: "1",
        ram: { used: 1, total: 2, percent: "50" },
        network: {},
        processes: []
      })
    });
    const widget = createOverviewCardsWidget(host, {}, { memorayClient: client });
    await settle();
    assert.equal(docListeners.get("visibilitychange"), 1, "registered a visibilitychange listener");
    widget.destroy();
    assert.equal(
      docListeners.get("visibilitychange"),
      0,
      "destroy removes the visibilitychange listener"
    );
    assert.ok(clearedIds.length >= 1, "destroy clears the metrics interval");
  } finally {
    globalThis.clearInterval = realClear;
    globalThis.document = priorDoc;
  }
}

async function testOfflineState() {
  const host = createFakeHost();
  const offline = Object.assign(new Error("offline"), { state: "offline" });
  const client = clientStub({ "/beta/overview": () => offline });
  const widget = createOverviewCardsWidget(host, {}, { memorayClient: client });
  await settle();
  assert.match(host.innerHTML, /offline/i);
  assert.match(host.innerHTML, /memoray\.ps1/);
  widget.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
