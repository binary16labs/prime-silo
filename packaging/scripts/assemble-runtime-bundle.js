#!/usr/bin/env node

// Assemble the self-contained Benny runtime bundle shipped inside the desktop
// package so the EXE is zero-install. The bundle (see
// packaging/desktop/runtime_supervisor.js, which spawns it) contains:
//
//   python/   embeddable standalone Python (python-build-standalone), arch-matched
//   site/     baked site-packages: runtime deps (native wheels for THIS OS/arch)
//   benny/    the runtime source (runtime/benny + benny_cli.py)
//   neo4j/    Neo4j Community, unpacked
//   jre/      Temurin JRE 17 (runs Neo4j), arch-matched
//   bundle.json   manifest (versions, platform/arch, entry points)
//
// Native wheels (chromadb/hnswlib/tree-sitter/…) must be built on the target
// runner, so this runs inside each platform's CI build step (and locally on a
// matching host). Windows-x64 is wired first; other targets are Phase 2.
//
// Heavy network/extraction steps run only on a real build. `--manifest-only`
// writes just the filtered requirements + bundle.json (for dry runs / tests /
// non-target platforms) so the rest of the desktop build never breaks.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFileSync } = require("node:child_process");

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "../..");

// Pinned component versions. NOTE: sha256 values must be pinned per asset before
// production (left "" here = verify-if-present). The Windows-x64 download URLs
// are real; other platform rows are filled in Phase 2.
const PYTHON_RELEASE = "20240814";
const PYTHON_VERSION = "3.11.9";
const NEO4J_VERSION = "5.23.0";
const JRE_MAJOR = "17";

const PYTHON_BUILDS = {
  "win32:x64": {
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    // Pinned from the verified local zero-install build (version-stable URL).
    sha256: "4c71d25731214b8a960d1d87510f24179d819249c5b434aaf7135818421b6215"
  }
  // Phase 2: darwin:arm64, darwin:x64, linux:x64, linux:arm64, win32:arm64
};

const NEO4J_BUILDS = {
  // Pinned from the verified local zero-install build (version-stable URL).
  win32: {
    url: `https://dist.neo4j.org/neo4j-community-${NEO4J_VERSION}-windows.zip`,
    sha256: "d43151ba7104aa38da57426151468b602c32a6119a5089576a02781cd6f8250d"
  }
  // Phase 2: darwin/linux → neo4j-community-<v>-unix.tar.gz
};

// Adoptium "latest GA" binary endpoints (redirect to the asset). NOTE: this URL
// is a MOVING target — it resolves to whatever 17.x GA is current, so we cannot
// pin a sha256 here (it would hard-fail the next time Adoptium bumps the patch).
// Left verify-if-present; to pin, switch to a fixed-asset/version URL first.
// (Reference: the 2026-06 local build resolved to
//  sha256 79a598e1fbb4e16582d92c4ee22280a3c4d72fd52606e1e46b1223c0fe53b0da.)
const JRE_BUILDS = {
  "win32:x64": {
    url: `https://api.adoptium.net/v3/binary/latest/${JRE_MAJOR}/ga/windows/x64/jre/hotspot/normal/eclipse`,
    sha256: ""
  }
  // Phase 2: mac/linux x64+arm64
};

/* ── pure helpers (unit-tested) ──────────────────────────────────────── */

function platformArchKey(platform, arch) {
  return `${platform}:${arch}`;
}

function resolvePythonBuild(platform, arch) {
  const build = PYTHON_BUILDS[platformArchKey(platform, arch)];
  if (!build) {
    throw new Error(`No pinned Python build for ${platform}/${arch} (Phase 2).`);
  }
  return build;
}

function resolveNeo4jBuild(platform) {
  const build =
    NEO4J_BUILDS[platform] ||
    (platform === "darwin" || platform === "linux"
      ? { url: `https://dist.neo4j.org/neo4j-community-${NEO4J_VERSION}-unix.tar.gz`, sha256: "" }
      : null);
  if (!build) {
    throw new Error(`No Neo4j build for ${platform} (Phase 2).`);
  }
  return build;
}

function resolveJreBuild(platform, arch) {
  const build = JRE_BUILDS[platformArchKey(platform, arch)];
  if (!build) {
    throw new Error(`No pinned JRE build for ${platform}/${arch} (Phase 2).`);
  }
  return build;
}

// The runtime dependency set the *downloaded* runtime bundle installs.
//
// Since v1.2.9 the bundle is NOT packed into the installer — it ships as a
// separate release asset the app fetches on first launch (see
// packaging/scripts/pack-runtime-bundle.js + packaging/desktop/runtime_fetch.js).
// That removed the NSIS payload ceiling that briefly forced a slim set, so we
// ship the FULL runtime here (parity with runtime/requirements.txt minus
// dev/test) — including the heavy observability + columnar stacks:
//   - arize-phoenix    Phoenix tracing/observability (governance/tracing.py).
//                      Pulls scipy, scikit-learn, the pydantic-ai + opentelemetry
//                      + boto3 + kubernetes + grpcio + google-genai stack.
//   - polars, pyarrow  Pypes' columnar engine (pypes/engines/polars_impl.py).
// This list is the source of truth for what pip installs into site/; it is kept
// explicit (rather than parsing runtime/requirements.txt) so the bundle contents
// are reviewable and decoupled from server/dev/test churn.
const BUNDLE_RUNTIME_REQUIREMENTS = [
  // API surface
  "fastapi>=0.115.0",
  "uvicorn>=0.34.0",
  "httpx>=0.28.0",
  "pydantic>=2.10.0",
  "python-multipart>=0.0.20",
  // Model calls (router/offline guard goes through litellm)
  "litellm>=1.60.0",
  "tiktoken>=0.7.0",
  // Swarm / Flows / Deep-produce
  "langchain>=0.3.0",
  "langgraph>=0.2.0",
  // RAG vector store + ANN index
  "chromadb>=0.5.0",
  "hnswlib>=0.8.0",
  // Graphs
  "neo4j>=5.25.0",
  "networkx>=3.4.0",
  // Lineage facets are imported at module load in governance/lineage.py (HTTP
  // emission itself stays gated off via BENNY_LINEAGE_ENABLED).
  "openlineage-python>=1.27.0",
  // Observability / tracing (governance/tracing.py). Pulls scipy, scikit-learn,
  // boto3, kubernetes, grpcio, the pydantic-ai + opentelemetry stack.
  "arize-phoenix>=5.0.0",
  // Tabular data — Pypes engines (pandas is the always-on default; polars/pyarrow
  // are the columnar fast path).
  "pandas>=2.0.0",
  "polars>=1.0.0",
  "pyarrow>=15.0.0",
  // Documents ingest (PDF + HTML cleanup). fitz == PyMuPDF.
  // PyMuPDF is also the DEFAULT DocModel backend for vision-augmented ingestion
  // (VIS-001 / ADR-003): it supplies figure crops (extract_image), tables
  // (find_tables) and text-in-reading-order with NO torch and NO model download,
  // keeping the bundle lean and fully offline. Docling is an OPTIONAL higher-
  // accuracy backend (torch/transformers, +~1.5GB, fetches HF weights on first
  // use) — deliberately NOT bundled; install it separately to opt in.
  "pypdf>=5.0.0",
  "beautifulsoup4>=4.12.0",
  "markdownify>=0.13.0",
  "PyMuPDF>=1.24.0",
  // Code graph (Tree-Sitter AST + grammars)
  "tree-sitter>=0.21.0",
  "tree-sitter-python>=0.21.0",
  "tree-sitter-javascript>=0.21.0",
  "tree-sitter-typescript>=0.23.0",
  // Misc core
  "jsonschema>=4.20.0",
  "pathspec>=0.12.0",
  "rich>=13.0.0",
  "mcp>=1.0"
];

// No packages are excluded any more (the bundle is a download, not an installer
// payload). Kept as an explicit, empty allow-everything marker so the intent is
// obvious and the assembler test can assert nothing is silently dropped.
const BUNDLE_EXCLUDED_PACKAGES = new Set([]);

// Return the curated bundle requirement set (the source of truth for what pip
// installs into site/). Kept as a function so callers read intent, not an array.
function bundleRuntimeRequirements() {
  return [...BUNDLE_RUNTIME_REQUIREMENTS];
}

// Strip comments and the dev/test block — retained for the assembler test and as
// a reference filter; the bundle itself installs bundleRuntimeRequirements().
function filterRuntimeRequirements(text) {
  const out = [];
  let inDevBlock = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#\s*Dev\/Test/i.test(line)) {
      inDevBlock = true;
      continue;
    }
    if (inDevBlock) {
      continue;
    }
    if (!line || line.startsWith("#")) {
      continue;
    }
    out.push(line);
  }
  return out;
}

function buildBundleManifest({ platform, arch, projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  let appVersion = "";
  try {
    appVersion =
      JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version || "";
  } catch {
    // ignore
  }
  const isWin = platform === "win32";
  return {
    schema: "prime-silo.runtime-bundle/1",
    app_version: appVersion,
    platform,
    arch,
    generated_at: new Date().toISOString(),
    components: {
      python: PYTHON_VERSION,
      python_release: PYTHON_RELEASE,
      neo4j: NEO4J_VERSION,
      jre: `temurin-${JRE_MAJOR}`
    },
    entry: {
      python: isWin ? "python/python.exe" : "python/bin/python3",
      java: isWin ? "jre/bin/java.exe" : "jre/bin/java",
      neo4j: isWin ? "neo4j/bin/neo4j.bat" : "neo4j/bin/neo4j",
      api: "-m uvicorn benny.api.server:app --host 127.0.0.1 --port 8005"
    }
  };
}

/* ── heavy I/O (CI / local build only) ───────────────────────────────── */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileSha256(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// Download to cache if missing (verifying any pinned hash), else reuse; always
// return the file's sha256 so a local build surfaces the hashes to pin.
async function ensureArchive(url, destPath, expectedSha256 = "") {
  if (fs.existsSync(destPath)) {
    const digest = fileSha256(destPath);
    if (expectedSha256 && digest.toLowerCase() !== expectedSha256.toLowerCase()) {
      fs.rmSync(destPath, { force: true });
    } else {
      return digest;
    }
  }
  return downloadFile(url, destPath, expectedSha256);
}

async function downloadFile(url, destPath, expectedSha256 = "") {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${url} (${response.status})`);
  }
  ensureDir(path.dirname(destPath));
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
  const digest = hash.digest("hex");
  if (expectedSha256 && digest.toLowerCase() !== expectedSha256.toLowerCase()) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Checksum mismatch for ${url}: got ${digest}`);
  }
  fs.renameSync(tmp, destPath);
  return digest;
}

// Extract a .tar.gz or .zip into a temp dir, then move the single top-level
// directory's contents to `targetDir` (flatten the version-named wrapper dir).
// Resolve the tar binary. On Windows we MUST use the bundled bsdtar
// (System32\tar.exe): if Git for Windows is installed, its GNU tar shadows
// bsdtar on PATH, and GNU tar misreads a Windows archive path like
// "C:\Users\..." as a remote host spec ("C:" → host) and fails with
// "Cannot connect to C: resolve failed". bsdtar handles drive-letter paths
// (and both .tar.gz and .zip) correctly.
function tarBin(platform = process.platform) {
  if (platform === "win32") {
    return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

function extractAndFlatten(archivePath, targetDir, platform = process.platform) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-extract-"));
  const isZip = /\.zip$/i.test(archivePath);
  try {
    if (isZip && platform !== "win32" && platform !== "darwin") {
      execFileSync("unzip", ["-q", archivePath, "-d", tmp], { stdio: "ignore" });
    } else {
      // bsdtar (Windows 10+/macOS) handles both .tar.gz and .zip; GNU tar handles .tar.gz.
      execFileSync(tarBin(platform), ["-xf", archivePath, "-C", tmp], { stdio: "ignore" });
    }
    const entries = fs.readdirSync(tmp);
    const roots = entries.filter((e) => fs.statSync(path.join(tmp, e)).isDirectory());
    const sourceDir = roots.length === 1 ? path.join(tmp, roots[0]) : tmp;
    ensureDir(path.dirname(targetDir));
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function pipInstall(pythonExe, requirements, siteDir) {
  // Start from a clean site/ — `pip install --target` does NOT replace existing
  // packages (it warns "already exists, specify --upgrade" and skips them), so a
  // re-run over a previous (e.g. un-slimmed) bundle would silently keep stale
  // deps. Fresh CI checkouts are empty, but local rebuilds and any cached site/
  // must be wiped so the bundle contains exactly `requirements`.
  fs.rmSync(siteDir, { recursive: true, force: true });
  ensureDir(siteDir);
  const reqFile = path.join(siteDir, "..", "requirements.runtime.txt");
  fs.writeFileSync(reqFile, requirements.join("\n") + "\n", "utf8");
  execFileSync(pythonExe, ["-m", "pip", "install", "--upgrade", "pip"], { stdio: "inherit" });
  execFileSync(
    pythonExe,
    ["-m", "pip", "install", "--no-input", "--target", siteDir, "-r", reqFile],
    { stdio: "inherit" }
  );
}

function copyBennySource(projectRoot, bennyDir) {
  ensureDir(bennyDir);
  fs.cpSync(path.join(projectRoot, "runtime", "benny"), path.join(bennyDir, "benny"), {
    recursive: true,
    filter: (src) => !/[\\/](__pycache__|\.pytest_cache|\.mypy_cache)$/.test(src)
  });
  fs.copyFileSync(
    path.join(projectRoot, "runtime", "benny_cli.py"),
    path.join(bennyDir, "benny_cli.py")
  );
  // Ship runtime/configs alongside (model_profiles.json resolves to
  // <bundle>/benny/configs/ via model_profiles.py parents[2]/configs). Optional
  // overrides — built-in defaults still apply when a file is absent.
  const configsSrc = path.join(projectRoot, "runtime", "configs");
  if (fs.existsSync(configsSrc)) {
    fs.cpSync(configsSrc, path.join(bennyDir, "configs"), {
      recursive: true,
      filter: (src) => !/[\\/](__pycache__)$/.test(src)
    });
  }
}

/**
 * Assemble the runtime bundle for one platform/arch.
 * @param {{platformKey?:string, platform?:string, arch?:string, projectRoot?:string, outDir?:string, manifestOnly?:boolean}} opts
 */
async function buildRuntimeBundle(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const projectRoot = opts.projectRoot || DEFAULT_PROJECT_ROOT;
  const outDir = opts.outDir || path.join(projectRoot, "packaging", "runtime-bundle");
  const manifestOnly = Boolean(opts.manifestOnly);

  ensureDir(outDir);
  const manifest = buildBundleManifest({ platform, arch, projectRoot });
  // The bundle installs the curated minimal set (see BUNDLE_RUNTIME_REQUIREMENTS),
  // NOT the full server requirements — the full set overflows NSIS's payload.
  const requirements = bundleRuntimeRequirements();

  if (manifestOnly) {
    fs.writeFileSync(
      path.join(outDir, "requirements.runtime.txt"),
      requirements.join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(manifest, null, 2));
    return { outDir, manifest, requirements, manifestOnly: true };
  }

  const cacheDir = path.join(os.tmpdir(), "ps-runtime-cache");
  ensureDir(cacheDir);
  const sha256 = {};

  // 1. Python.
  const python = resolvePythonBuild(platform, arch);
  const pyArchive = path.join(
    cacheDir,
    path.basename(new URL(python.url).pathname) || "python.tar.gz"
  );
  sha256.python = await ensureArchive(python.url, pyArchive, python.sha256);
  extractAndFlatten(pyArchive, path.join(outDir, "python"), platform);

  // 2. Deps into site/, benny source.
  const pythonExe = path.join(
    outDir,
    "python",
    platform === "win32" ? "python.exe" : path.join("bin", "python3")
  );
  pipInstall(pythonExe, requirements, path.join(outDir, "site"));
  copyBennySource(projectRoot, path.join(outDir, "benny"));

  // 3. Neo4j + JRE.
  const neo4j = resolveNeo4jBuild(platform);
  const neoArchive = path.join(cacheDir, path.basename(new URL(neo4j.url).pathname));
  sha256.neo4j = await ensureArchive(neo4j.url, neoArchive, neo4j.sha256);
  extractAndFlatten(neoArchive, path.join(outDir, "neo4j"), platform);

  const jre = resolveJreBuild(platform, arch);
  const jreArchive = path.join(
    cacheDir,
    `temurin-${JRE_MAJOR}-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`
  );
  sha256.jre = await ensureArchive(jre.url, jreArchive, jre.sha256);
  extractAndFlatten(jreArchive, path.join(outDir, "jre"), platform);

  // Record the downloaded archive hashes — pin these into the *_BUILDS tables
  // before production. A local build surfaces them here.
  manifest.sha256 = sha256;
  fs.writeFileSync(path.join(outDir, "bundle.json"), JSON.stringify(manifest, null, 2));
  console.log("Runtime bundle component sha256 (pin these before deploy):");
  for (const [name, digest] of Object.entries(sha256)) {
    console.log(`  ${name}: ${digest}`);
  }
  return { outDir, manifest, requirements, sha256, manifestOnly: false };
}

module.exports = {
  buildRuntimeBundle,
  tarBin,
  resolvePythonBuild,
  resolveNeo4jBuild,
  resolveJreBuild,
  filterRuntimeRequirements,
  bundleRuntimeRequirements,
  buildBundleManifest,
  BUNDLE_RUNTIME_REQUIREMENTS,
  BUNDLE_EXCLUDED_PACKAGES,
  PYTHON_VERSION,
  NEO4J_VERSION
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const manifestOnly = args.includes("--manifest-only");
  buildRuntimeBundle({ manifestOnly })
    .then((r) => {
      const m = r.manifest;
      console.log(
        `Runtime bundle (${m.platform}/${m.arch})${r.manifestOnly ? " [manifest-only]" : ""} at ${path.relative(DEFAULT_PROJECT_ROOT, r.outDir)}`
      );
      console.log(
        `  python ${m.components.python} · neo4j ${m.components.neo4j} · ${m.components.jre} · ${r.requirements.length} deps`
      );
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
