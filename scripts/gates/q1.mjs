#!/usr/bin/env node
// Gate Q1 — reproducible supply chain. The build is a function of the repo:
//   - runtime/requirements.lock exists and is fully HASH-PINNED (uv/pip-compile, --generate-hashes);
//   - runtime/requirements.txt states intent (>=) — both committed;
//   - CI (lint.yml) installs its Python tooling FROM the lock, with no ad-hoc unpinned pip install;
//   - packaging installs constrained by the lock;
//   - weekly grouped dependabot;
//   - CycloneDX SBOMs (npm + pip) attached at release.
// Hermetic: reads repo files only (no network). Contract: delivery/tasks/Q1.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

// 1. The lock exists and is fully hash-pinned.
check(exists("runtime/requirements.lock"), "runtime/requirements.lock is missing");
if (exists("runtime/requirements.lock")) {
  const lock = read("runtime/requirements.lock");
  const hashes = (lock.match(/--hash=sha256:/g) || []).length;
  check(hashes > 500, `lock has too few hashes (${hashes}) — not hash-pinned`);
  // every top-level "name==version" requirement must carry at least one hash in its block.
  const blocks = lock.split(/\n(?=[A-Za-z0-9])/); // a new block starts at a non-indented line
  const unpinned = [];
  for (const b of blocks) {
    const m = b.match(/^([A-Za-z0-9._-]+)==/);
    if (m && !/--hash=sha256:/.test(b)) unpinned.push(m[1]);
  }
  check(unpinned.length === 0, `pinned-but-unhashed requirements: ${unpinned.slice(0, 5).join(", ")}`);
  check(/uv pip compile|pip-compile/.test(lock), "lock header does not record its pip-compile/uv provenance");
}

// 2. Direct deps state intent (>=); both files committed.
check(exists("runtime/requirements.txt"), "runtime/requirements.txt is missing");
if (exists("runtime/requirements.txt")) {
  check(/>=/.test(read("runtime/requirements.txt")), "requirements.txt direct deps should state intent with >=");
}

// 3. CI installs from the lock, no ad-hoc unpinned tool install.
check(exists(".github/workflows/lint.yml"), ".github/workflows/lint.yml is missing");
if (exists(".github/workflows/lint.yml")) {
  const lint = read(".github/workflows/lint.yml");
  check(/requirements\.lock/.test(lint), "lint.yml must install Python tooling from requirements.lock");
  check(!/pip install ["']ruff>=/.test(lint), "lint.yml still has an ad-hoc unpinned `pip install \"ruff>=...\"`");
}

// 4. Weekly grouped dependabot.
check(exists(".github/dependabot.yml"), ".github/dependabot.yml is missing");
if (exists(".github/dependabot.yml")) {
  const dep = read(".github/dependabot.yml");
  check(/interval:\s*["']?weekly/.test(dep), "dependabot must run weekly");
  check(/groups:/.test(dep), "dependabot updates must be grouped");
  check(/package-ecosystem:\s*["']?pip/.test(dep), "dependabot must cover pip");
}

// 5. Releases carry CycloneDX SBOMs (npm + pip).
check(exists(".github/workflows/release-desktop.yml"), "release-desktop.yml is missing");
if (exists(".github/workflows/release-desktop.yml")) {
  const rel = read(".github/workflows/release-desktop.yml");
  check(/cyclonedx/i.test(rel), "release workflow must generate CycloneDX SBOMs");
  check(/sbom/i.test(rel), "release workflow must attach an SBOM to the artifacts");
}

// 6. Packaging installs constrained by the lock.
check(exists("packaging/scripts/assemble-runtime-bundle.js"), "assemble-runtime-bundle.js missing");
if (exists("packaging/scripts/assemble-runtime-bundle.js")) {
  check(/requirements\.lock/.test(read("packaging/scripts/assemble-runtime-bundle.js")),
    "packaging must reference runtime/requirements.lock (version constraint)");
}

if (fails.length) {
  console.error("[q1] GATE FAILED:");
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log("[q1] supply chain: hash-pinned lock + lock-based CI/packaging installs + weekly grouped dependabot + CycloneDX SBOMs — verified");
console.log("[q1] GATE GREEN");
process.exit(0);
