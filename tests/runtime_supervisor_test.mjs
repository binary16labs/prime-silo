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
  const initFn = async (args) => { initCalls.push(args); };
  return {
    spawned, ready, initCalls,
    opts: {
      bundleDir: "/fake/bundle",
      bennyHome: "/fake/home",
      env: {},
      platform: "win32",
      spawnFn, probeFn, initFn,
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
  testSpawnBuilders();
  await testOrderedStart();
  await testRemoteOverrideNoOps();
  await testRestartOnExit();
  await testStopKillsAndPreventsRestart();
  console.log("runtime_supervisor_test: ok");
  process.exit(0);
}

function testGate() {
  assert.equal(sup.shouldUseBundledRuntime({ bundleDir: "" }).reason, "no-bundle");
  assert.equal(
    sup.shouldUseBundledRuntime({ bundleDir: "/b", env: { RUNTIME_BASE_URL: "http://t480:8005" } }).reason,
    "remote-runtime"
  );
  assert.equal(
    sup.shouldUseBundledRuntime({ bundleDir: "/b", config: { useBundledRuntime: false } }).reason,
    "disabled-by-config"
  );
  assert.equal(sup.shouldUseBundledRuntime({ bundleDir: "/b", env: {} }).use, true);
  // Default localhost RUNTIME_BASE_URL still counts as "use bundled".
  assert.equal(
    sup.shouldUseBundledRuntime({ bundleDir: "/b", env: { RUNTIME_BASE_URL: "http://127.0.0.1:8005" } }).use,
    true
  );
}

function testSpawnBuilders() {
  const api = sup.buildApiSpawn({ bundleDir: "/b", bennyHome: "/h", platform: "win32", env: {}, hmacKey: "deadbeef" });
  assert.match(api.command, /python\.exe$/);
  assert.deepEqual(api.args, ["-m", "uvicorn", "benny.api.server:app", "--host", "127.0.0.1", "--port", "8005"]);
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
  assert.deepEqual(h.spawned.map((x) => x.name), ["neo4j", "api"]);
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
  assert.ok(neoChild.killed.includes("SIGTERM"), "neo4j received SIGTERM");
  assert.ok(apiChild.killed.includes("SIGTERM"), "api received SIGTERM");
  const countAfterStop = h.spawned.length;
  // A late exit after stop must NOT trigger a restart.
  apiChild.emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.spawned.length, countAfterStop, "no restart after stop");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
