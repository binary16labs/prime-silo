#!/usr/bin/env node
//
// Runtime supervisor — the bundled-Benny lifecycle for the zero-install EXE.
//
// Drives the supervisor with injected spawn/probe/init/backoff so the gating,
// ordered start (Neo4j → API), crash-restart, and graceful stop are verified
// without real processes. Also checks the pure spawn-spec builders and the
// mode-coexistence gate (server mode / remote-Benny override).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sup = require("../packaging/desktop/runtime_supervisor.js");

class FakeChild extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.pid = Math.floor(Math.random() * 100000);
    this.killed = [];
  }
  kill(signal) {
    this.killed.push(signal);
    // Resolve graceful stop quickly.
    setImmediate(() => this.emit("exit", null, signal));
  }
}

function makeHarness(overrides = {}) {
  const spawned = [];
  const ready = { neo4j: true, api: true };
  const spawnFn = (name) => {
    const child = new FakeChild(name);
    spawned.push({ name, child });
    return child;
  };
  const probeFn = async (service) => ready[service];
  const initCalls = [];
  const initFn = async (args) => {
    initCalls.push(args);
  };
  // On Windows the supervisor tree-kills via taskkill rather than child.kill;
  // inject a fake that records the target and emits exit so stop() resolves.
  const killedTree = [];
  const killTreeFn = (child) => {
    killedTree.push(child);
    if (typeof child.emit === "function") setImmediate(() => child.emit("exit", null, "tree-kill"));
  };
  return {
    spawned,
    ready,
    initCalls,
    killedTree,
    opts: {
      bundleDir: "/fake/bundle",
      bennyHome: "/fake/home",
      env: {},
      platform: "win32",
      spawnFn,
      probeFn,
      initFn,
      killTreeFn,
      isBundleCompleteFn: () => true,
      readyTimeoutMs: 200,
      probeIntervalMs: 5,
      backoffMsFn: () => 5,
      logger: { log() {}, warn() {}, error() {} },
      ...overrides
    }
  };
}

async function main() {
  testGate();
  testManagedHomeAndCliContext();
  testSpawnInvocation();
  testSpawnBuilders();
  await testOrderedStart();
  await testRemoteOverrideNoOps();
  await testRestartOnExit();
  await testStopKillsAndPreventsRestart();
  await testFetchOnFirstRun();
  await testFetchUnavailableNoOps();
  console.log("runtime_supervisor_test: ok");
  process.exit(0);
}

function testGate() {
  assert.equal(sup.shouldUseBundledRuntime({ bundleDir: "" }).reason, "no-bundle");
  assert.equal(
    sup.shouldUseBundledRuntime({ bundleDir: "/b", env: { RUNTIME_BASE_URL: "http://t480:8005" } })
      .reason,
    "remote-runtime"
  );
  assert.equal(
    sup.shouldUseBundledRuntime({ bundleDir: "/b", config: { useBundledRuntime: false } }).reason,
    "disabled-by-config"
  );
  assert.equal(sup.shouldUseBundledRuntime({ bundleDir: "/b", env: {} }).use, true);
  // Default localhost RUNTIME_BASE_URL still counts as "use bundled".
  assert.equal(
    sup.shouldUseBundledRuntime({
      bundleDir: "/b",
      env: { RUNTIME_BASE_URL: "http://127.0.0.1:8005" }
    }).use,
    true
  );
}

function testManagedHomeAndCliContext() {
  // config.bennyHome overrides the default the shell passes in.
  assert.equal(sup.resolveManagedBennyHome("/default", {}), "/default");
  assert.equal(sup.resolveManagedBennyHome("/default", { bennyHome: "  /custom  " }), "/custom");
  assert.equal(sup.resolveManagedBennyHome("/default", { bennyHome: "" }), "/default");

  // The supervisor exposes the resolved home + a CLI context pointing at the
  // bundled Python (what the tray uses for "Open Benny CLI").
  const h = makeHarness();
  const s = sup.createRuntimeSupervisor({ ...h.opts, config: { bennyHome: "/custom-home" } });
  assert.equal(s.bennyHome, "/custom-home");
  const ctx = s.cliContext();
  assert.match(ctx.python, /python\.exe$/);
  assert.equal(ctx.bennyHome, "/custom-home");
  assert.match(ctx.site, /site/);
  assert.match(ctx.benny, /benny/);
  assert.equal(ctx.complete, true);
}

function testSpawnInvocation() {
  // Windows .bat MUST go through cmd.exe (Node EINVAL on direct .bat spawn),
  // with the command quoted so a space-containing install path survives.
  const win = sup.resolveSpawnInvocation(
    {
      command: "C:\\Program Files\\Space Agent\\neo4j\\bin\\neo4j.bat",
      args: ["console"],
      env: {}
    },
    "win32"
  );
  assert.equal(win.command, "cmd.exe");
  assert.deepEqual(win.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(win.args[3], '"C:\\Program Files\\Space Agent\\neo4j\\bin\\neo4j.bat" console');
  assert.equal(win.options.windowsVerbatimArguments, true);

  // A plain .exe (python) is spawned directly, no cmd wrapper.
  const exe = sup.resolveSpawnInvocation(
    { command: "C:\\x\\python\\python.exe", args: ["-m", "uvicorn"], env: {} },
    "win32"
  );
  assert.equal(exe.command, "C:\\x\\python\\python.exe");
  assert.deepEqual(exe.args, ["-m", "uvicorn"]);
  assert.equal(exe.options.windowsVerbatimArguments, undefined);

  // POSIX neo4j is a plain executable — no cmd wrapper there either.
  const nix = sup.resolveSpawnInvocation(
    { command: "/b/neo4j/bin/neo4j", args: ["console"], env: {} },
    "linux"
  );
  assert.equal(nix.command, "/b/neo4j/bin/neo4j");
}

function testSpawnBuilders() {
  const api = sup.buildApiSpawn({
    bundleDir: "/b",
    bennyHome: "/h",
    platform: "win32",
    env: {},
    hmacKey: "deadbeef"
  });
  assert.match(api.command, /python\.exe$/);
  assert.deepEqual(api.args, [
    "-m",
    "uvicorn",
    "benny.api.server:app",
    "--host",
    "127.0.0.1",
    "--port",
    "8005"
  ]);
  assert.equal(api.env.BENNY_HOME, "/h");
  assert.equal(api.env.BENNY_HMAC_KEY, "deadbeef");
  assert.match(api.env.PYTHONPATH, /site/);
  assert.match(api.env.PYTHONPATH, /benny/);

  const neo = sup.buildNeo4jSpawn({ bundleDir: "/b", bennyHome: "/h", platform: "win32", env: {} });
  assert.match(neo.command, /neo4j\.bat$/);
  assert.deepEqual(neo.args, ["console"]);
  assert.match(neo.env.JAVA_HOME, /jre$/);

  const conf = sup.renderNeo4jConf("/h");
  assert.match(conf, /dbms\.security\.auth_enabled=false/);
  assert.match(conf, /server\.bolt\.listen_address=:7687/);
}

async function testOrderedStart() {
  const h = makeHarness();
  const s = sup.createRuntimeSupervisor(h.opts);
  const result = await s.start();
  assert.equal(result.managed, true);
  assert.equal(result.neo4jReady, true);
  assert.equal(result.apiReady, true);
  // Neo4j spawned before the API.
  assert.deepEqual(
    h.spawned.map((x) => x.name),
    ["neo4j", "api"]
  );
  assert.equal(h.initCalls.length, 1, "first-run init runs once");
  await s.stop();
}

async function testRemoteOverrideNoOps() {
  const h = makeHarness({ env: { RUNTIME_BASE_URL: "http://t480.local:8005" } });
  const s = sup.createRuntimeSupervisor(h.opts);
  const result = await s.start();
  assert.equal(result.managed, false);
  assert.equal(result.reason, "remote-runtime");
  assert.equal(h.spawned.length, 0, "nothing spawned when pointed at a remote Benny");
}

async function testRestartOnExit() {
  const h = makeHarness();
  const s = sup.createRuntimeSupervisor(h.opts);
  await s.start();
  const apiChild = h.spawned.find((x) => x.name === "api").child;
  const before = h.spawned.filter((x) => x.name === "api").length;
  // Simulate an unexpected API crash.
  apiChild.emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 40)); // > backoff (5ms)
  const after = h.spawned.filter((x) => x.name === "api").length;
  assert.equal(after, before + 1, "API is respawned after an unexpected exit");
  await s.stop();
}

async function testStopKillsAndPreventsRestart() {
  const h = makeHarness();
  const s = sup.createRuntimeSupervisor(h.opts);
  await s.start();
  const neoChild = h.spawned.find((x) => x.name === "neo4j").child;
  const apiChild = h.spawned.find((x) => x.name === "api").child;
  await s.stop();
  // Windows platform → tree-kill (taskkill) both children, not SIGTERM.
  assert.ok(h.killedTree.includes(neoChild), "neo4j process tree was killed");
  assert.ok(h.killedTree.includes(apiChild), "api process tree was killed");
  const countAfterStop = h.spawned.length;
  // A late exit after stop must NOT trigger a restart.
  apiChild.emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.spawned.length, countAfterStop, "no restart after stop");
}

// First launch: the bundle isn't present, so start() must fetch it (download +
// extract into the per-user dir) and then proceed to spawn Neo4j + the API.
async function testFetchOnFirstRun() {
  const h = makeHarness();
  let complete = false;
  let fetchCalls = 0;
  const s = sup.createRuntimeSupervisor({
    ...h.opts,
    appVersion: "1.2.9",
    isBundleCompleteFn: () => complete,
    fetchFn: async ({ version, destDir }) => {
      fetchCalls += 1;
      assert.equal(version, "1.2.9");
      complete = true; // the download+extract makes the bundle complete
      return { ok: true, reason: "downloaded", destDir };
    }
  });
  const result = await s.start();
  assert.equal(fetchCalls, 1, "fetch runs once on first launch when the bundle is missing");
  assert.equal(result.managed, true);
  assert.deepEqual(
    h.spawned.map((x) => x.name),
    ["neo4j", "api"],
    "spawns after the runtime is fetched"
  );
  await s.stop();
}

// Offline first run: the fetch can't complete, so the supervisor no-ops cleanly
// (the shell still runs in proxy mode) and spawns nothing.
async function testFetchUnavailableNoOps() {
  const h = makeHarness();
  const s = sup.createRuntimeSupervisor({
    ...h.opts,
    appVersion: "1.2.9",
    isBundleCompleteFn: () => false, // never becomes complete
    fetchFn: async () => ({ ok: false, reason: "download-failed" })
  });
  const result = await s.start();
  assert.equal(result.managed, false);
  assert.equal(result.reason, "bundle-unavailable");
  assert.equal(h.spawned.length, 0, "nothing spawned when the runtime can't be fetched");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
