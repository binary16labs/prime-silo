// The Windows updater feed shipped describing only arm64 for v1.22.1, v1.23.0 and v1.24.0.
// Every Windows x64 machine asking "is there an update?" was answered with an arm64 installer,
// because electron-updater falls back to the FIRST entry when no filename matches process.arch
// (electron-updater/out/providers/Provider.js: `?? filteredFiles.shift()`).
//
// These tests pin the two properties that stop it recurring: a merged feed names every
// architecture that was built, and it fails loudly when it cannot.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const MERGE = path.join(REPO, "packaging", "scripts", "release-metadata-merge.js");

function feed(version, exeName, size, sha = "AAAA==") {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${exeName}`,
    `    sha512: "${sha}"`,
    `    size: ${size}`,
    `path: ${exeName}`,
    `sha512: "${sha}"`,
    ""
  ].join("\n");
}

// Lay out a release-assets/ tree the way actions/download-artifact does: one directory per
// build job, named for the matrix artifact_name.
function stage(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relmeta-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const run = (root) => execFileSync(process.execPath, [MERGE, root], { encoding: "utf8" });

test("both Windows arches land in one feed when each job names its file the same", () => {
  // The case that actually shipped broken: an arm64 runner treats arm64 as native, so
  // electron-builder writes `metadata-latest-windows.yml` — identical to the x64 job's name.
  const root = stage({
    "windows-x64/metadata-latest-windows.yml": feed("1.24.0", "Setup-x64.exe", 129632231),
    "windows-arm64/metadata-latest-windows.yml": feed("1.24.0", "Setup-arm64.exe", 131556759)
  });
  run(root);
  const out = fs.readFileSync(path.join(root, "metadata-latest-windows.yml"), "utf8");
  assert.ok(out.includes("Setup-x64.exe"), "x64 installer missing from the feed");
  assert.ok(out.includes("Setup-arm64.exe"), "arm64 installer missing from the feed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the arch-suffixed filename is collected too", () => {
  // The other naming electron-builder uses: `<channel>-arm64.yml` when arm64 is not native.
  // Matching only the exact canonical basename skipped this file entirely.
  const root = stage({
    "windows-x64/metadata-latest-windows.yml": feed("1.24.0", "Setup-x64.exe", 1),
    "windows-arm64/metadata-latest-windows-arm64.yml": feed("1.24.0", "Setup-arm64.exe", 2)
  });
  run(root);
  const out = fs.readFileSync(path.join(root, "metadata-latest-windows.yml"), "utf8");
  assert.ok(out.includes("Setup-x64.exe") && out.includes("Setup-arm64.exe"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("x64 is the top-level default, because that is electron-updater's fallback", () => {
  const root = stage({
    "windows-arm64/metadata-latest-windows.yml": feed("1.24.0", "Setup-arm64.exe", 2),
    "windows-x64/metadata-latest-windows.yml": feed("1.24.0", "Setup-x64.exe", 1)
  });
  run(root);
  const out = fs.readFileSync(path.join(root, "metadata-latest-windows.yml"), "utf8");
  const top = out.split("\n").find((l) => l.startsWith("path:"));
  assert.equal(top, "path: Setup-x64.exe", "top-level path must default to x64");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a feed that drops an architecture fails the release", () => {
  // Both jobs contributed but emitted the SAME filename, so the url-dedupe collapses them
  // into one entry — one installer for two architectures. That must stop the release.
  const root = stage({
    "windows-x64/metadata-latest-windows.yml": feed("1.24.0", "Setup.exe", 1),
    "windows-arm64/metadata-latest-windows.yml": feed("1.24.0", "Setup.exe", 2)
  });
  let threw = "";
  try {
    run(root);
  } catch (e) {
    threw = String(e.stdout || "") + String(e.stderr || "");
  }
  assert.match(
    threw,
    /one architecture was dropped/,
    "expected the coverage guard to fail the merge"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a genuinely single-arch platform still promotes, and says which arch", () => {
  const root = stage({
    "linux-x64/metadata-latest-linux.yml": feed("1.24.0", "App-x64.AppImage", 1)
  });
  const out = run(root);
  assert.ok(fs.existsSync(path.join(root, "metadata-latest-linux.yml")));
  assert.match(out, /Promoted/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("raw electron-builder names without an arch token do not trip the guard", () => {
  // At merge time the x64 url is "<Product> Setup <version>.exe" with no arch in it; canonical
  // arch-bearing names are applied later by release-assets-stage.js. An earlier version of the
  // guard looked for arch tokens here and would have failed every release.
  const root = stage({
    "windows-x64/metadata-latest-windows.yml": feed("1.24.0", "Prime-Silo Setup 1.24.0.exe", 1),
    "windows-arm64/metadata-latest-windows.yml": feed(
      "1.24.0",
      "Prime-Silo Setup 1.24.0-arm64.exe",
      2
    )
  });
  const out = run(root);
  assert.match(out, /Merged 2/);
  const feedText = fs.readFileSync(path.join(root, "metadata-latest-windows.yml"), "utf8");
  assert.ok(feedText.includes("Prime-Silo Setup 1.24.0.exe"));
  assert.ok(feedText.includes("Prime-Silo Setup 1.24.0-arm64.exe"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("Windows installer names carry the arch, so native arm64 and x64 builds cannot collide", () => {
  // v1.24.2 failed to publish at this guard: with no nsis.artifactName both runners build their
  // native arch and emit "Prime-Silo Setup <version>.exe", so the merge collapsed them into one
  // entry. The name must differ per arch and still match the "*Setup*.exe" upload filter.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const template = String(pkg.build?.nsis?.artifactName || "");
  const render = (arch) =>
    template
      .replace("${productName}", pkg.build.productName)
      .replace("${version}", "1.24.3")
      .replace("${arch}", arch)
      .replace("${ext}", "exe");
  assert.ok(template.includes("${arch}"), "nsis.artifactName must include ${arch}: " + template);
  assert.notEqual(render("x64"), render("arm64"));
  for (const name of [render("x64"), render("arm64")]) {
    assert.match(name, /Setup.*\.exe$/u, name + " would be skipped by release-asset-filters.yaml");
    assert.doesNotMatch(name, / /u, "spaces are rewritten to dashes in the feed url: " + name);
  }

  // End to end through merge + stage with those names: the published feed lists both arches.
  const root = stage({
    [`windows-x64/${render("x64")}`]: "x".repeat(10),
    [`windows-arm64/${render("arm64")}`]: "a".repeat(20),
    "windows-x64/metadata-latest-windows.yml": feed("1.24.3", render("x64"), 10),
    "windows-arm64/metadata-latest-windows.yml": feed("1.24.3", render("arm64"), 20)
  });
  run(root);
  const upload = path.join(root, "..", path.basename(root) + "-upload");
  execFileSync(
    process.execPath,
    [path.join(REPO, "packaging", "scripts", "release-assets-stage.js"), root, upload, "1.24.3"],
    { encoding: "utf8" }
  );
  const published = fs.readFileSync(path.join(upload, "metadata-latest-windows.yml"), "utf8");
  assert.ok(published.includes("Prime-Silo-1.24.3-windows-x64.exe"), published);
  assert.ok(published.includes("Prime-Silo-1.24.3-windows-arm64.exe"), published);
  assert.match(published, /^path: Prime-Silo-1\.24\.3-windows-x64\.exe$/mu);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(upload, { recursive: true, force: true });
});

test("each Linux feed is built from its own arch only, under either electron-builder name", () => {
  // v1.24.3 built all six targets and failed to publish with "Expected exactly one
  // metadata-latest-linux.yml file for linux, found 2": the x64 spec's stem also matched the
  // arm64 job's metadata-latest-linux-arm64.yml.
  for (const armName of ["metadata-latest-linux-arm64.yml", "metadata-latest-linux.yml"]) {
    const root = stage({
      "linux-x64/metadata-latest-linux.yml": feed("1.24.3", "Prime-Silo-1.24.3.AppImage", 1),
      [`linux-arm64/${armName}`]: feed("1.24.3", "Prime-Silo-1.24.3-arm64.AppImage", 2)
    });
    run(root);
    const x64 = fs.readFileSync(path.join(root, "metadata-latest-linux.yml"), "utf8");
    const arm = fs.readFileSync(path.join(root, "metadata-latest-linux-arm64.yml"), "utf8");
    assert.ok(!x64.includes("arm64"), armName + " leaked into the x64 feed: " + x64);
    assert.ok(arm.includes("Prime-Silo-1.24.3-arm64.AppImage"), armName + ": " + arm);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
