// Estate satellite runtime launcher — starts the bundled Neo4j + the REPO benny
// on a satellite (e.g. the ASUS), driven by the estate host profile
// (config/estate-hosts.json, selected by ESTATE_HOST). Reuses the desktop runtime
// supervisor (Neo4j spawn, health-gating, restart supervision) with three
// profile-driven overrides via a custom spawnFn:
//   1. benny resolves from the REPO runtime (repo/runtime FIRST on PYTHONPATH) so
//      it has the v1.15 /rag/graph-upsert route the bundled benny lacks.
//   2. benny + Neo4j bind to the profile's bind_host (0.0.0.0 = remote control:
//      the hub can reach benny :8005 / Neo4j :7687 across the LAN).
//   3. Neo4j DATA is redirected to the profile's neo4j_data_dir — a LOCAL path —
//      even though BENNY_HOME (the workspace) is on OneDrive. A live graph DB on
//      OneDrive corrupts; the graph rebuilds from the shared cards, so local is safe.
//
// Usage (on the satellite):  ESTATE_HOST=asus node scripts/estate/boot-satellite.cjs
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const REPO_RUNTIME = path.join(REPO, "runtime");
const { createRuntimeSupervisor, resolveSpawnInvocation } = require(
  path.join(REPO, "packaging", "desktop", "runtime_supervisor.js")
);

// ---- load .env (fallback) + the estate host profile (authoritative) ----------
const dotenv = {};
try {
  for (const line of fs.readFileSync(path.join(REPO, ".env"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0)
      dotenv[t.slice(0, i).trim()] = t
        .slice(i + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
  }
} catch (e) {
  console.warn("[satellite] .env load failed:", e.message);
}
const expand = (v) =>
  typeof v === "string" ? v.replace(/%([^%]+)%/g, (_, n) => process.env[n] || `%${n}%`) : v;
let profile = {};
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config", "estate-hosts.json"), "utf8"));
  const name = process.env.ESTATE_HOST || dotenv.ESTATE_HOST || cfg.active;
  profile = (cfg.hosts && cfg.hosts[name]) || {};
  console.log(`[satellite] estate host = ${name}`);
} catch (e) {
  console.warn("[satellite] estate-hosts.json load failed:", e.message);
}

const bundleDir = path.join(process.env.APPDATA, "space-agent", "runtime-bundle");
const bennyHome = expand(process.env.BENNY_HOME || profile.workspace_root || "D:/benny-home/benny");
const LOCAL_NEO4J = path
  .join(process.env.LOCALAPPDATA || process.env.TEMP || ".", "prime-silo", "neo4j-data")
  .replace(/\\/g, "/");
let neo4jDataDir = expand(
  process.env.NEO4J_DATA_DIR || profile.neo4j_data_dir || LOCAL_NEO4J
).replace(/\\/g, "/");
try {
  fs.mkdirSync(neo4jDataDir, { recursive: true }); // configured path must be a real LOCAL disk
} catch {
  console.warn(`[satellite] neo4j_data_dir '${neo4jDataDir}' unusable — falling back to ${LOCAL_NEO4J}`);
  neo4jDataDir = LOCAL_NEO4J;
  fs.mkdirSync(neo4jDataDir, { recursive: true });
}
const bind = process.env.BENNY_BIND || profile.bind_host || "127.0.0.1";

// benny (the SERVER) needs the LM/embedder endpoints — take the profile's, so the
// satellite's benny calls the T480's LM Studio, not a local one.
process.env.BENNY_HOME = bennyHome;
process.env.RUNTIME_BASE_URL = "";
if (profile.lm_endpoint) process.env.BENNY_LMSTUDIO_ENDPOINTS = profile.lm_endpoint;
if (profile.embed_model) process.env.BENNY_EMBED_MODEL = profile.embed_model;
for (const k of ["NEO4J_PASSWORD", "BENNY_HMAC_KEY", "BENNY_API_KEY", "BENNY_EMBED_MODEL"])
  if (!process.env[k] && dotenv[k]) process.env[k] = dotenv[k];
console.log(
  `[satellite] bennyHome=${bennyHome}\n[satellite] neo4jData=${neo4jDataDir} (LOCAL) · bind=${bind} · LM=${process.env.BENNY_LMSTUDIO_ENDPOINTS}`
);

function spawnFn(name, spec) {
  let s = spec;
  if (name === "api") {
    const pp = REPO_RUNTIME + path.delimiter + (spec.env.PYTHONPATH || "");
    const args = spec.args.map((a) => (a === "127.0.0.1" ? bind : a));
    s = { ...spec, args, env: { ...spec.env, PYTHONPATH: pp } };
  } else if (name === "neo4j") {
    // Rewrite the just-written neo4j.conf: bind to the LAN + redirect DATA/LOGS to
    // the LOCAL neo4jDataDir (BENNY_HOME may be on OneDrive; the DB must not be).
    try {
      const conf = path.join(spec.confDir, "neo4j.conf");
      const txt = fs
        .readFileSync(conf, "utf8")
        .replace(/server\.default_listen_address=.*/g, `server.default_listen_address=${bind}`)
        .replace(/server\.directories\.data=.*/g, `server.directories.data=${neo4jDataDir}/data`)
        .replace(/server\.directories\.logs=.*/g, `server.directories.logs=${neo4jDataDir}/logs`);
      fs.mkdirSync(neo4jDataDir, { recursive: true });
      fs.writeFileSync(conf, txt, "utf8");
    } catch (e) {
      console.warn("[satellite] neo4j.conf rewrite failed:", e.message);
    }
  }
  const inv = resolveSpawnInvocation(s);
  if (s.logFile) {
    try {
      fs.mkdirSync(path.dirname(s.logFile), { recursive: true });
      const fd = fs.openSync(s.logFile, "a");
      inv.options.stdio = ["ignore", fd, fd];
    } catch {
      /* keep default stdio */
    }
  }
  return spawn(inv.command, inv.args, inv.options);
}

const sup = createRuntimeSupervisor({
  bundleDir,
  bennyHome,
  env: process.env,
  spawnFn,
  readyTimeoutMs: 150000,
  logger: console,
  onStatus: (s) => console.log("[status]", JSON.stringify(s))
});

sup
  .start()
  .then((r) => {
    console.log("[satellite] start ->", JSON.stringify(r));
    if (!r.managed) process.exit(1);
    console.log(
      `[satellite] neo4jReady=${r.neo4jReady} apiReady=${r.apiReady} — benny :8005${bind === "0.0.0.0" ? " (LAN — remote control on)" : " (localhost)"}`
    );
  })
  .catch((e) => {
    console.error("[satellite] fatal:", e);
    process.exit(1);
  });

setInterval(() => {}, 1 << 30);
process.on("SIGINT", async () => {
  try {
    await sup.stop();
  } catch {}
  process.exit(0);
});
