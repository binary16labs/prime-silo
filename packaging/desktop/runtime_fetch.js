// First-run runtime fetch for the zero-install desktop app.
//
// The self-contained Benny runtime (embeddable Python + deps + Neo4j + JRE) is
// NOT shipped inside the installer — packing ~600MB of executables/DLLs through
// electron-builder/NSIS is unreliable on Windows (Defender locks freshly-written
// PE files mid-copy; that broke v1.2.8). Instead the bundle is published as a
// per-platform GitHub *release asset* (see packaging/scripts/pack-runtime-bundle.js)
// and downloaded + extracted into the per-user data dir on first launch.
//
// `ensureRuntimeBundle()` is the entry point the supervisor calls before it
// starts Neo4j/the API. It is idempotent (a version marker short-circuits once
// installed) and fully injectable so the download/extract/verify flow is unit
// tested without the network or a real ~hundreds-of-MB archive.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFileSync } = require("node:child_process");

const DEFAULT_OWNER = "binary16labs";
const DEFAULT_REPO = "prime-silo";
const MARKER_FILE = ".runtime-bundle.json";

/* ── pure helpers (unit-tested) ──────────────────────────────────────── */

// The release-asset names produced by pack-runtime-bundle.js for this target.
function runtimeBundleAssetNames(platform = process.platform, arch = process.arch) {
  const base = `runtime-bundle-${platform}-${arch}`;
  return {
    base,
    archive: `${base}.tar.gz`,
    sha256: `${base}.tar.gz.sha256`,
    manifest: `${base}.json`
  };
}

// https://github.com/<owner>/<repo>/releases/download/v<version>/<asset>
function resolveAssetUrl({ owner = DEFAULT_OWNER, repo = DEFAULT_REPO, version, asset }) {
  const tag = String(version || "").startsWith("v") ? String(version) : `v${version}`;
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${asset}`;
}

function markerPath(destDir) {
  return path.join(destDir, MARKER_FILE);
}

function readMarker(destDir) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(destDir), "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(destDir, data) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(
    markerPath(destDir),
    JSON.stringify({ ...data, installed_at: new Date().toISOString() }, null, 2)
  );
}

// A correctly-installed bundle for `version` is present iff the marker matches
// the wanted version AND the runtime entry points still exist on disk.
function isBundleInstalled(
  destDir,
  version,
  existsFn = fs.existsSync,
  platform = process.platform
) {
  const marker = readMarker(destDir);
  if (!marker || String(marker.app_version) !== String(version)) {
    return false;
  }
  const py = platform === "win32" ? "python/python.exe" : "python/bin/python3";
  return [py, "benny", "neo4j", "jre"].every((rel) => existsFn(path.join(destDir, rel)));
}

/* ── default I/O collaborators (overridable for tests) ───────────────── */

async function defaultDownload(url, destPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${url} (${response.status})`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const hash = createHash("sha256");
  const tmp = `${destPath}.part`;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(tmp)
  );
  fs.renameSync(tmp, destPath);
  return hash.digest("hex");
}

async function defaultFetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Fetch failed ${url} (${response.status})`);
  }
  return response.text();
}

function defaultExtract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // tar handles .tar.gz on Windows 10+, macOS and Linux.
  execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "ignore" });
}

// "<sha256>  <filename>" → "<sha256>"
function parseSha256Sidecar(text) {
  const token = String(text || "")
    .trim()
    .split(/\s+/)[0];
  return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : "";
}

function killLingeringProcesses(targetDir, platform = process.platform, logger = console) {
  if (platform !== "win32") return;
  try {
    const psCmd = `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${targetDir}\\', 'CurrentCultureIgnoreCase') } | Stop-Process -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { stdio: "ignore", windowsHide: true });
  } catch (error) {
    logger.warn && logger.warn(`[runtime-fetch] failed to kill lingering processes in ${targetDir}: ${error.message || error}`);
  }
}

/* ── main ────────────────────────────────────────────────────────────── */

/**
 * Ensure the runtime bundle for `version` is installed under `destDir`,
 * downloading + extracting the matching release asset on first run.
 *
 * Returns { ok, reason, destDir }. Never throws: a network/extract failure
 * resolves to ok:false so the supervisor can degrade gracefully (the app still
 * runs in proxy/remote mode) and retry on the next launch.
 *
 * Injectables (all optional): downloadFn, fetchTextFn, extractFn, existsFn,
 * logger, owner, repo, expectedSha256, cacheDir.
 */
async function ensureRuntimeBundle(opts = {}) {
  const {
    destDir,
    version,
    platform = process.platform,
    arch = process.arch,
    owner = DEFAULT_OWNER,
    repo = DEFAULT_REPO,
    downloadFn = defaultDownload,
    fetchTextFn = defaultFetchText,
    extractFn = defaultExtract,
    existsFn = fs.existsSync,
    logger = console,
    cacheDir = path.join(os.tmpdir(), "ps-runtime-fetch")
  } = opts;

  if (!destDir || !version) {
    return { ok: false, reason: "bad-args", destDir };
  }

  if (isBundleInstalled(destDir, version, existsFn, platform)) {
    return { ok: true, reason: "already-present", destDir };
  }

  // Best-effort: prune leftovers from a previous interrupted/locked install
  // (.old-* retired bundles, .staging-* partial extracts). A copy still locked
  // by a lingering process is skipped and removed on a later launch.
  try {
    const parent = path.dirname(destDir);
    const base = path.basename(destDir);
    for (const entry of fs.readdirSync(parent)) {
      if (entry.startsWith(`${base}.old-`) || entry.startsWith(`${base}.staging-`)) {
        const fullPath = path.join(parent, entry);
        killLingeringProcesses(fullPath, platform, logger);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch {
          /* still locked — leave for next launch */
        }
      }
    }
  } catch {
    /* best-effort */
  }

  const names = runtimeBundleAssetNames(platform, arch);

  // Resolve the expected checksum: caller override, else the .sha256 sidecar.
  let expectedSha = String(opts.expectedSha256 || "").toLowerCase();
  if (!expectedSha) {
    try {
      expectedSha = parseSha256Sidecar(
        await fetchTextFn(resolveAssetUrl({ owner, repo, version, asset: names.sha256 }))
      );
    } catch (error) {
      logger.warn &&
        logger.warn(`[runtime-fetch] checksum sidecar unavailable: ${error.message || error}`);
    }
  }

  const archiveUrl = resolveAssetUrl({ owner, repo, version, asset: names.archive });
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, names.archive);

  let gotSha;
  try {
    logger.log && logger.log(`[runtime-fetch] downloading ${names.archive} …`);
    gotSha = await downloadFn(archiveUrl, archivePath);
  } catch (error) {
    logger.error && logger.error(`[runtime-fetch] download failed: ${error.message || error}`);
    return { ok: false, reason: "download-failed", destDir };
  }

  if (expectedSha && gotSha && gotSha.toLowerCase() !== expectedSha) {
    fs.rmSync(archivePath, { force: true });
    logger.error &&
      logger.error(`[runtime-fetch] checksum mismatch (got ${gotSha}, want ${expectedSha})`);
    return { ok: false, reason: "checksum-mismatch", destDir };
  }

  // Extract to a sibling staging dir first, then swap it into place. Extracting
  // straight into destDir (after rmSync) used to leave a half-deleted, corrupt
  // bundle when a lingering java/neo4j held a lock under destDir on Windows —
  // the recursive delete throws *after* removing the unlocked files.
  const staging = `${destDir}.staging-${process.pid}-${Date.now()}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    extractFn(archivePath, staging);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    logger.error && logger.error(`[runtime-fetch] extract failed: ${error.message || error}`);
    return { ok: false, reason: "extract-failed", destDir };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  // Swap without an in-place delete of a possibly-locked dir. Renaming a
  // directory succeeds even when files inside are open (same volume), so we move
  // the old bundle aside, move staging in, then prune the old copy best-effort
  // (a locked leftover is harmless and cleaned on a later launch). If the swap
  // fails the existing bundle is left intact and usable.
  try {
    if (fs.existsSync(destDir)) {
      killLingeringProcesses(destDir, platform, logger);
      const retired = `${destDir}.old-${Date.now()}`;
      fs.renameSync(destDir, retired);
      try {
        fs.rmSync(retired, { recursive: true, force: true });
      } catch {
        /* locked — pruned on a later launch */
      }
    }
    fs.renameSync(staging, destDir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    logger.error && logger.error(`[runtime-fetch] install swap failed: ${error.message || error}`);
    return { ok: false, reason: "replace-busy", destDir };
  }

  if (
    !isBundleInstalled(destDir, version, existsFn, platform) &&
    !existsFn(path.join(destDir, platform === "win32" ? "python/python.exe" : "python/bin/python3"))
  ) {
    return { ok: false, reason: "incomplete-after-extract", destDir };
  }

  writeMarker(destDir, { app_version: String(version), sha256: gotSha || expectedSha || "" });
  logger.log && logger.log(`[runtime-fetch] runtime ready at ${destDir}`);
  return { ok: true, reason: "downloaded", destDir };
}

module.exports = {
  ensureRuntimeBundle,
  runtimeBundleAssetNames,
  resolveAssetUrl,
  isBundleInstalled,
  readMarker,
  writeMarker,
  parseSha256Sidecar,
  MARKER_FILE
};
