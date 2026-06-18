// Bundled Benny runtime supervisor for the packaged desktop shell.
//
// When the app ships a self-contained runtime bundle (embeddable Python + baked
// deps + Neo4j + JRE under resources/runtime-bundle/, see
// packaging/scripts/assemble-runtime-bundle.js), this module starts and
// supervises it so the EXE is zero-install: ordered start of native Neo4j then
// the FastAPI server, health-gated, with crash-restart and graceful shutdown.
//
// It is ADDITIVE and conditional — it only takes over when:
//   (a) a runtime bundle is present in resources, AND
//   (b) RUNTIME_BASE_URL is unset / the default localhost:8005, AND
//   (c) config.useBundledRuntime is not false.
// Otherwise it no-ops, preserving server/dev mode (node space serve, standalone
// `benny up`) and the "point at a remote Benny" mode (RUNTIME_BASE_URL set).
//
// The spawn and probe layers are injectable so the ordering / restart / stop
// logic is unit-testable without real processes (see tests).

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const DEFAULT_API_PORT = 8005;
const DEFAULT_NEO4J_HTTP_PORT = 7474;
const DEFAULT_RUNTIME_BASE_URLS = new Set([
  "",
  "http://127.0.0.1:8005",
  "http://localhost:8005"
]);

/* ── pure helpers (unit-tested) ──────────────────────────────────────── */

// Find the shipped runtime bundle, if any.
function resolveBundleDir(resourcesPath, here = __dirname) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "runtime-bundle") : "",
    path.join(here, "..", "runtime-bundle")
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(path.join(candidate, "bundle.json"))) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return "";
}

// Decide whether the supervisor should manage a local runtime.
function shouldUseBundledRuntime({ bundleDir, env = {}, config = {} } = {}) {
  if (!bundleDir) {
    return { use: false, reason: "no-bundle" };
  }
  const runtimeBaseUrl = String(env.RUNTIME_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!DEFAULT_RUNTIME_BASE_URLS.has(runtimeBaseUrl)) {
    return { use: false, reason: "remote-runtime" };
  }
  if (config.useBundledRuntime === false) {
    return { use: false, reason: "disabled-by-config" };
  }
  return { use: true, reason: "ok" };
}

// A bundle is usable only when the real binaries are present (a manifest-only
// dev build ships just bundle.json + requirements → must NOT be spawned).
function isBundleComplete(bundleDir, platform = process.platform) {
  if (!bundleDir) return false;
  const p = bundlePaths(bundleDir, platform);
  return [p.python, p.neo4jBin, p.javaHome, p.benny].every((target) => {
    try { return fs.existsSync(target); } catch { return false; }
  });
}

// Platform-specific paths inside the bundle.
function bundlePaths(bundleDir, platform = process.platform) {
  const isWin = platform === "win32";
  return {
    python: path.join(bundleDir, "python", isWin ? "python.exe" : path.join("bin", "python3")),
    java: path.join(bundleDir, "jre", "bin", isWin ? "java.exe" : "java"),
    javaHome: path.join(bundleDir, "jre"),
    neo4jHome: path.join(bundleDir, "neo4j"),
    neo4jBin: path.join(bundleDir, "neo4j", "bin", isWin ? "neo4j.bat" : "neo4j"),
    site: path.join(bundleDir, "site"),
    benny: path.join(bundleDir, "benny")
  };
}

// Render a Neo4j 5 config that points data/logs into the writable BENNY_HOME and
// disables auth (single-user local DB → the API connects with its defaults).
function renderNeo4jConf(bennyHome) {
  const graph = path.join(bennyHome, "data", "graph").replace(/\\/g, "/");
  return [
    `server.directories.data=${graph}/data`,
    `server.directories.logs=${graph}/logs`,
    "server.default_listen_address=127.0.0.1",
    "server.bolt.listen_address=:7687",
    "server.http.listen_address=:7474",
    "dbms.security.auth_enabled=false",
    ""
  ].join("\n");
}

// Build the spawn spec for native Neo4j (JRE + conf under BENNY_HOME).
function buildNeo4jSpawn({ bundleDir, bennyHome, platform = process.platform, env = {} }) {
  const p = bundlePaths(bundleDir, platform);
  const confDir = path.join(bennyHome, "neo4j-conf");
  return {
    command: p.neo4jBin,
    args: ["console"],
    env: {
      ...env,
      JAVA_HOME: p.javaHome,
      NEO4J_HOME: p.neo4jHome,
      NEO4J_CONF: confDir
    },
    confDir
  };
}

// Build the spawn spec for the FastAPI server via the bundled Python.
function buildApiSpawn({ bundleDir, bennyHome, platform = process.platform, env = {}, hmacKey = "" }) {
  const p = bundlePaths(bundleDir, platform);
  const pythonPath = [p.site, p.benny].join(path.delimiter);
  const childEnv = {
    ...env,
    BENNY_HOME: bennyHome,
    PYTHONPATH: pythonPath,
    NEO4J_URI: env.NEO4J_URI || "bolt://localhost:7687"
  };
  if (hmacKey) {
    childEnv.BENNY_HMAC_KEY = hmacKey;
  }
  return {
    command: p.python,
    args: ["-m", "uvicorn", "benny.api.server:app", "--host", "127.0.0.1", "--port", String(DEFAULT_API_PORT)],
    env: childEnv
  };
}

// Read the per-install HMAC key written by `benny init` (home.py), if present.
function readInstallHmacKey(bennyHome) {
  try {
    const value = fs.readFileSync(path.join(bennyHome, "state", "hmac-key"), "utf8").trim();
    return value || "";
  } catch {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── default real spawn / probe / init implementations ───────────────── */

function defaultSpawn(_name, spec) {
  return spawn(spec.command, spec.args, {
    env: spec.env,
    stdio: "ignore",
    detached: false,
    windowsHide: true
  });
}

async function defaultProbe(service) {
  const url = service === "neo4j"
    ? `http://127.0.0.1:${DEFAULT_NEO4J_HTTP_PORT}`
    : `http://127.0.0.1:${DEFAULT_API_PORT}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok || response.status === 401; // neo4j http answers even pre-auth
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ── supervisor ──────────────────────────────────────────────────────── */

/**
 * Create a runtime supervisor. Most collaborators are injectable for testing:
 *   spawnFn(name, spec) -> child (EventEmitter w/ .kill(signal), .pid)
 *   probeFn(service) -> Promise<boolean>     ("neo4j" | "api")
 *   initFn({ bundleDir, bennyHome }) -> Promise<void>   (first-run benny init)
 */
function createRuntimeSupervisor(options = {}) {
  const {
    resourcesPath = "",
    bennyHome,
    config = {},
    env = process.env,
    platform = process.platform,
    spawnFn = defaultSpawn,
    probeFn = defaultProbe,
    initFn = defaultInit,
    logger = console,
    readyTimeoutMs = 60000,
    probeIntervalMs = 1000,
    maxRestarts = 5,
    backoffMsFn = (attempt) => Math.min(15000, 1000 * 2 ** (attempt - 1)),
    isBundleCompleteFn = isBundleComplete
  } = options;

  const bundleDir = options.bundleDir || resolveBundleDir(resourcesPath);
  const children = new Map(); // service -> { child, spec, restarts }
  let stopping = false;
  let started = false;

  function gate() {
    const decision = shouldUseBundledRuntime({ bundleDir, env, config });
    if (decision.use && !isBundleCompleteFn(bundleDir, platform)) {
      return { use: false, reason: "incomplete-bundle" };
    }
    return decision;
  }

  async function waitReady(service) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (stopping) return false;
      if (await probeFn(service)) return true;
      await delay(probeIntervalMs);
    }
    return false;
  }

  function attachRestart(service, spec) {
    const entry = children.get(service);
    if (!entry || !entry.child || typeof entry.child.once !== "function") return;
    entry.child.once("exit", (code, signal) => {
      if (stopping) return;
      entry.restarts = (entry.restarts || 0) + 1;
      if (entry.restarts > maxRestarts) {
        logger.error?.(`[runtime] ${service} exited (${signal || code}) and exceeded ${maxRestarts} restarts; giving up.`);
        return;
      }
      const backoff = backoffMsFn(entry.restarts);
      logger.warn?.(`[runtime] ${service} exited (${signal || code}); restarting in ${backoff}ms (attempt ${entry.restarts}).`);
      setTimeout(() => {
        if (stopping) return;
        void launch(service, spec);
      }, backoff);
    });
  }

  function launch(service, spec) {
    const child = spawnFn(service, spec);
    const prev = children.get(service);
    children.set(service, { child, spec, restarts: prev ? prev.restarts : 0 });
    attachRestart(service, spec);
    return child;
  }

  async function start() {
    const decision = gate();
    if (!decision.use) {
      logger.log?.(`[runtime] Not managing a bundled runtime (${decision.reason}).`);
      return { managed: false, reason: decision.reason };
    }
    if (started) {
      return { managed: true, reason: "already-started" };
    }
    started = true;
    stopping = false;

    // First-run: initialise the writable BENNY_HOME (dirs, config, hmac-key).
    try {
      fs.mkdirSync(bennyHome, { recursive: true });
      if (!fs.existsSync(path.join(bennyHome, "state", "hmac-key"))) {
        await initFn({ bundleDir, bennyHome, platform, env });
      }
    } catch (error) {
      logger.warn?.(`[runtime] benny init skipped: ${error.message || error}`);
    }

    // Neo4j first (the API connects to it lazily, but graphs need it up).
    const neo4jSpec = buildNeo4jSpawn({ bundleDir, bennyHome, platform, env });
    try {
      fs.mkdirSync(neo4jSpec.confDir, { recursive: true });
      fs.writeFileSync(path.join(neo4jSpec.confDir, "neo4j.conf"), renderNeo4jConf(bennyHome), "utf8");
    } catch (error) {
      logger.warn?.(`[runtime] could not write neo4j.conf: ${error.message || error}`);
    }
    launch("neo4j", neo4jSpec);
    const neo4jReady = await waitReady("neo4j");
    if (!neo4jReady) {
      logger.warn?.("[runtime] Neo4j did not report healthy in time; graphs may be unavailable until it does.");
    }

    // Then the API.
    const apiSpec = buildApiSpawn({
      bundleDir, bennyHome, platform, env, hmacKey: readInstallHmacKey(bennyHome)
    });
    launch("api", apiSpec);
    const apiReady = await waitReady("api");

    return {
      managed: true,
      reason: "started",
      neo4jReady,
      apiReady,
      services: [...children.keys()]
    };
  }

  async function stop({ graceMs = 6000 } = {}) {
    stopping = true;
    const entries = [...children.values()];
    children.clear();
    started = false;
    await Promise.all(entries.map(({ child }) => stopChild(child, graceMs, logger)));
  }

  async function restart() {
    await stop();
    return start();
  }

  return {
    bundleDir,
    get managed() { return gate().use; },
    gate,
    start,
    stop,
    restart,
    status() {
      return { managed: gate().use, started, services: [...children.keys()] };
    }
  };
}

function stopChild(child, graceMs, logger = console) {
  return new Promise((resolve) => {
    if (!child || typeof child.kill !== "function") {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish();
    }, graceMs);
    if (typeof child.once === "function") {
      child.once("exit", finish);
    }
    try {
      child.kill("SIGTERM");
    } catch (error) {
      logger.warn?.(`[runtime] error stopping child: ${error.message || error}`);
      finish();
    }
  });
}

// Default first-run init: run the bundled python's `benny_cli init` so the
// writable BENNY_HOME gets dirs, config, and the per-install hmac-key.
async function defaultInit({ bundleDir, bennyHome, platform = process.platform, env = process.env }) {
  const p = bundlePaths(bundleDir, platform);
  await new Promise((resolve, reject) => {
    const child = spawn(p.python, ["-m", "benny_cli", "init"], {
      env: { ...env, BENNY_HOME: bennyHome, PYTHONPATH: [p.site, p.benny].join(path.delimiter) },
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

module.exports = {
  createRuntimeSupervisor,
  resolveBundleDir,
  shouldUseBundledRuntime,
  isBundleComplete,
  bundlePaths,
  renderNeo4jConf,
  buildNeo4jSpawn,
  buildApiSpawn,
  readInstallHmacKey,
  __testing: { stopChild, DEFAULT_RUNTIME_BASE_URLS }
};
