#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { listFiles, mergeMetadataFiles } = require("./release-metadata");

const CANONICAL_METADATA_SPECS = [
  { fileName: "metadata-latest-windows.yml", platform: "windows", merge: true },
  { fileName: "metadata-latest-mac.yml", platform: "macos", merge: true },
  { fileName: "metadata-latest-linux.yml", platform: "linux", merge: false },
  { fileName: "metadata-latest-linux-arm64.yml", platform: "linux", merge: false }
];

function toPosixPath(value) {
  return String(value || "").replace(/\\/gu, "/");
}

// Which arch's build directory a metadata file came from. The DIRECTORY is the authority, not
// the filename: electron-builder names the feed `<channel>.yml` for a runner's native arch and
// `<channel>-<arch>.yml` otherwise, so on an arm64 Windows runner the arm64 feed is called
// `metadata-latest-windows.yml` — identical to the x64 one. Keying on the artifact directory
// (windows-x64/ vs windows-arm64/) is true under either naming.
function archOfPath(rootDir, filePath, platform) {
  const rel = toPosixPath(path.relative(rootDir, filePath));
  const match = rel.match(new RegExp("^" + platform + "-(x64|arm64)/", "u"));
  return match ? match[1] : "";
}

// Every feed this platform's build jobs produced, whatever electron-builder chose to call it.
// Matching on the exact canonical basename missed `<channel>-arm64.yml` entirely, so a
// two-arch platform could contribute one file, "merge" a single input, and publish a feed
// describing one architecture — which is what shipped for three releases.
function collectMetadataFiles(rootDir, files, spec) {
  const stem = spec.fileName.replace(/\.yml$/u, "");
  const namePattern = new RegExp("^" + stem + "(-(x64|arm64))?\\.yml$", "u");
  return files
    .filter((filePath) => namePattern.test(path.basename(filePath)))
    .filter((filePath) => archOfPath(rootDir, filePath, spec.platform))
    .sort((a, b) => {
      // x64 first: serializeUpdateMetadata takes the top-level `path`/`sha512` from files[0],
      // and electron-updater falls back to the FIRST entry when it cannot match an arch
      // (Provider.js findFile: `?? filteredFiles.shift()`). The fallback should land on the
      // majority architecture, not on whichever name sorted first alphabetically.
      const aa = archOfPath(rootDir, a, spec.platform);
      const ba = archOfPath(rootDir, b, spec.platform);
      if (aa !== ba) return aa === "x64" ? -1 : ba === "x64" ? 1 : aa.localeCompare(ba);
      return a.localeCompare(b);
    });
}

// A merged feed must describe every architecture that was built. This is the check that would
// have caught the arm64-only Windows feed at release time instead of on a user's machine three
// versions later: the merge was a no-op, the step logged success, and nothing compared what
// came out against what went in.
function assertArchCoverage(rootDir, metadataFiles, merged, spec) {
  const builtArches = new Set(metadataFiles.map((f) => archOfPath(rootDir, f, spec.platform)));
  if (builtArches.size < 2) return;

  // Count entries, do not look for arch tokens in the urls. At this point the urls are still
  // electron-builder's raw output names ("<Product> Setup <version>.exe"), and the x64 one
  // carries no arch token at all — canonical arch-bearing names are applied later, by
  // release-assets-stage.js. A token check here would fail every release.
  //
  // What must hold is simply that no architecture was dropped. mergeMetadataFiles dedupes by
  // url, so two builds emitting the SAME filename silently collapse into one entry — and one
  // entry for two architectures is precisely the defect: half your users get the other half's
  // installer.
  if (merged.files.length < builtArches.size) {
    throw new Error(
      spec.fileName +
        " was built for [" +
        [...builtArches].sort().join(", ") +
        "] but the merged feed lists only " +
        merged.files.length +
        " installer(s): " +
        merged.files.map((f) => f.url).join(", ") +
        ". Two builds produced the same filename, so one architecture was dropped and those " +
        "machines would be offered the other architecture's build."
    );
  }
}

function copyCanonicalMetadata(inputPath, outputPath) {
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    return false;
  }

  fs.copyFileSync(inputPath, outputPath);
  return true;
}

function main() {
  const rootDir = path.resolve(process.argv[2] || "release-assets");
  if (!fs.existsSync(rootDir)) {
    throw new Error("Release assets directory does not exist: " + rootDir);
  }

  const files = listFiles(rootDir);

  CANONICAL_METADATA_SPECS.forEach((spec) => {
    const metadataFiles = collectMetadataFiles(rootDir, files, spec);
    if (!metadataFiles.length) {
      return;
    }

    const outputPath = path.join(rootDir, spec.fileName);

    if (spec.merge) {
      if (metadataFiles.length === 1) {
        // One arch built (or one uploaded). Promote it, but say which arch it describes —
        // "Promoted <path>" alone reads the same whether the platform is single-arch by
        // design or half its jobs went missing.
        const only = archOfPath(rootDir, metadataFiles[0], spec.platform);
        if (copyCanonicalMetadata(metadataFiles[0], outputPath)) {
          console.log(
            "Promoted " + metadataFiles[0] + " to " + outputPath + " (" + only + " only)."
          );
        }
        return;
      }

      const merged = mergeMetadataFiles(metadataFiles, outputPath);
      assertArchCoverage(rootDir, metadataFiles, merged, spec);
      console.log(
        "Merged " +
          metadataFiles.length +
          " updater metadata file(s) into " +
          outputPath +
          " covering [" +
          merged.files.map((f) => f.url).join(", ") +
          "]."
      );
      return;
    }

    if (metadataFiles.length !== 1) {
      throw new Error(
        "Expected exactly one " +
          spec.fileName +
          " file for " +
          spec.platform +
          ", found " +
          metadataFiles.length +
          "."
      );
    }

    if (copyCanonicalMetadata(metadataFiles[0], outputPath)) {
      console.log("Promoted " + metadataFiles[0] + " to " + outputPath + ".");
    }
  });
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
