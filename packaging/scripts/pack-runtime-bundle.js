#!/usr/bin/env node

// Assemble the self-contained Benny runtime bundle and pack it into a single
// compressed archive that ships as a GitHub *release asset* (NOT inside the
// installer). The desktop app downloads + extracts this on first launch
// (see packaging/desktop/runtime_fetch.js) so the installer stays small and
// electron-builder never has to copy ~600MB of executables/DLLs through NSIS
// (which Windows Defender locks mid-copy — that broke v1.2.8).
//
// Output (into <outDir>, default dist/runtime-bundle/):
//   runtime-bundle-<platform>-<arch>.tar.gz        the bundle (python+site+benny+neo4j+jre)
//   runtime-bundle-<platform>-<arch>.tar.gz.sha256 "<sha256>  <filename>"
//   runtime-bundle-<platform>-<arch>.json          { archive, sha256, bytes, app_version, components }
//
// tar.gz (not zip) is used so every target — Windows 10+, macOS, Linux — can
// extract it with the always-present `tar` (the client extractor in
// runtime_fetch.js runs `tar -xzf`).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { buildRuntimeBundle } = require("./assemble-runtime-bundle");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

function archiveBaseName(platform, arch) {
  return `runtime-bundle-${platform}-${arch}`;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// Create a .tar.gz of the *contents* of bundleDir (so the archive holds
// python/, site/, … at its root — not a wrapping bundle/ dir). Uses the system
// `tar`, which is present on all CI runners and end-user platforms we target.
function createTarGz(bundleDir, archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.rmSync(archivePath, { force: true });
  // -C bundleDir . => archive every entry relative to the bundle root.
  execFileSync("tar", ["-czf", archivePath, "-C", bundleDir, "."], { stdio: "inherit" });
}

async function packRuntimeBundle(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const projectRoot = opts.projectRoot || PROJECT_ROOT;
  const outDir = opts.outDir || path.join(projectRoot, "dist", "runtime-bundle");
  const bundleDir = path.join(projectRoot, "packaging", "runtime-bundle");

  // 1. Assemble the full bundle (downloads python/neo4j/jre, pip-installs the
  //    curated runtime deps into site/, copies the benny source).
  const assembled = await buildRuntimeBundle({ platform, arch, projectRoot, manifestOnly: false });

  // 2. Pack it.
  fs.mkdirSync(outDir, { recursive: true });
  const base = archiveBaseName(platform, arch);
  const archivePath = path.join(outDir, `${base}.tar.gz`);
  createTarGz(bundleDir, archivePath);

  // 3. Checksums + a small JSON manifest the app reads to know what/where to fetch.
  const sha256 = sha256File(archivePath);
  const bytes = fs.statSync(archivePath).size;
  fs.writeFileSync(`${archivePath}.sha256`, `${sha256}  ${base}.tar.gz\n`, "utf8");
  const manifest = {
    schema: "prime-silo.runtime-bundle-archive/1",
    archive: `${base}.tar.gz`,
    sha256,
    bytes,
    platform,
    arch,
    app_version: assembled.manifest.app_version,
    components: assembled.manifest.components
  };
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(manifest, null, 2));

  return { outDir, archivePath, sha256, bytes, manifest };
}

module.exports = { packRuntimeBundle, archiveBaseName };

function parseArchArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--arch" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--arch=")) return argv[i].slice("--arch=".length);
  }
  return process.arch;
}

if (require.main === module) {
  packRuntimeBundle({ arch: parseArchArg(process.argv.slice(2)) })
    .then((r) => {
      console.log(`Runtime bundle archive: ${path.relative(PROJECT_ROOT, r.archivePath)}`);
      console.log(`  ${(r.bytes / (1024 * 1024)).toFixed(1)} MB · sha256 ${r.sha256}`);
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
