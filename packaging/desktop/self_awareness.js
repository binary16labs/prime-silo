// First-run self-awareness seeding for the packaged desktop shell.
//
// "Our framework is the demo." Instead of a separate seed-demo step, the build
// ships a self-awareness bundle (packaging/self-awareness/, produced by
// packaging/scripts/build-self-awareness.js): a snapshot of Prime-Silo's own
// source, a static code-graph, the app manifests, and the navigable skills.
//
// On first launch this module loads that bundle into the `prime_silo_self`
// workspace and kicks off a code-graph scan + doc ingest, so Benny boots
// already able to answer questions about the very thing the operator is running.
//
// Everything here is best-effort and guarded:
//   • A marker file in userData makes it run exactly once on success.
//   • If the Benny runtime isn't reachable yet, it skips WITHOUT writing the
//     marker, so the next launch retries once services are up.
//   • Any failure is logged and swallowed — seeding must never block or crash
//     desktop startup.
//
// All runtime calls go through the shell's own server proxy (/api/runtime/*),
// which injects the Benny API key — so we never embed credentials here.

const fs = require("node:fs");
const path = require("node:path");

const MARKER_NAME = "self-awareness-seeded.json";
const SELF_WORKSPACE = "prime_silo_self";

// Locate the shipped bundle. Packaged builds copy it under resources/; a dev
// run finds it next to this file via the packaging/ tree.
function resolveBundleDir() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "packaging", "self-awareness") : "",
    path.join(__dirname, "..", "self-awareness")
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(path.join(candidate, "bundle.json"))) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  return "";
}

async function fetchJson(url, init = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

function copyDirInto(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
}

/**
 * Seed the prime_silo_self workspace from the bundled self-awareness artifacts.
 *
 * @param {{ browserUrl: string, userDataPath: string, logger?: Console }} options
 * @returns {Promise<{ ok: boolean, workspace?: string, reason?: string, error?: string }>}
 */
async function seedSelfAwareness(options = {}) {
  const logger = options.logger || console;
  const browserUrl = String(options.browserUrl || "").trim();
  const userDataPath = String(options.userDataPath || "").trim();

  try {
    if (!browserUrl) {
      return { ok: false, reason: "no-server" };
    }
    if (!userDataPath) {
      return { ok: false, reason: "no-userdata" };
    }

    const bundleDir = resolveBundleDir();
    if (!bundleDir) {
      return { ok: false, reason: "no-bundle" };
    }

    const markerPath = path.join(userDataPath, MARKER_NAME);
    if (fs.existsSync(markerPath)) {
      return { ok: false, reason: "already-seeded" };
    }

    const base = browserUrl.replace(/\/$/, "");

    // Probe the runtime first. If it isn't up yet we bail without a marker so
    // the next launch retries once Benny's services are ready.
    try {
      await fetchJson(`${base}/api/runtime/workspaces`, { method: "GET" }, 3000);
    } catch {
      return { ok: false, reason: "runtime-unreachable" };
    }

    // Create (or retrieve) the self workspace; the runtime returns its path.
    const wsInfo = await fetchJson(
      `${base}/api/runtime/workspaces/${encodeURIComponent(SELF_WORKSPACE)}`,
      { method: "POST" },
      8000
    );
    const wsPath = wsInfo && typeof wsInfo.path === "string" ? wsInfo.path : "";

    // Copy the bundled source snapshot + manifests into the workspace so the
    // code-graph scan and doc ingest have something to work on.
    if (wsPath && fs.existsSync(wsPath)) {
      copyDirInto(path.join(bundleDir, "source"), path.join(wsPath, "src"));
      copyDirInto(path.join(bundleDir, "manifests"), path.join(wsPath, "data_in", "manifests"));
    }

    // Build the code graph (background scan on the runtime). Best-effort.
    try {
      await fetchJson(`${base}/api/runtime/graph/code/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: SELF_WORKSPACE, root_dir: "src", name: "prime-silo" })
      }, 10000);
    } catch (error) {
      logger.warn?.(`[self-awareness] code-graph scan skipped: ${error.message || error}`);
    }

    // Ingest the bundled docs/manifests into the knowledge graph. Best-effort.
    try {
      await fetchJson(`${base}/api/runtime/rag/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: SELF_WORKSPACE })
      }, 10000);
    } catch (error) {
      logger.warn?.(`[self-awareness] doc ingest skipped: ${error.message || error}`);
    }

    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ seeded_at: new Date().toISOString(), workspace: SELF_WORKSPACE, bundle_dir: bundleDir }, null, 2)
    );

    return { ok: true, workspace: SELF_WORKSPACE };
  } catch (error) {
    logger.warn?.(`[self-awareness] seeding failed: ${error.message || error}`);
    return { ok: false, reason: "error", error: String(error.message || error) };
  }
}

module.exports = {
  seedSelfAwareness,
  resolveBundleDir,
  __testing: { MARKER_NAME, SELF_WORKSPACE }
};
