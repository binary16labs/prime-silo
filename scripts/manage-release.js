#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execSync, execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");

function readPackageJson() {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  return JSON.parse(content);
}

function writePackageJson(data) {
  fs.writeFileSync(packageJsonPath, JSON.stringify(data, null, 2) + "\n");
}

function getCurrentVersion() {
  const pkg = readPackageJson();
  return pkg.version;
}

function parseVersion(versionString) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(versionString);
  if (!match) {
    throw new Error(`Invalid version format: ${versionString}`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

function bumpVersion(versionString, releaseType) {
  const v = parseVersion(versionString);

  switch (releaseType.toLowerCase()) {
    case "major":
      return `${v.major + 1}.0.0`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      throw new Error(`Invalid release type: ${releaseType}`);
  }
}

function execGit(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function gitTagExists(tag) {
  try {
    execGit(["rev-parse", `refs/tags/${tag}`]);
    return true;
  } catch (_error) {
    return false;
  }
}

function createRelease(releaseType) {
  const currentVersion = getCurrentVersion();
  const newVersion = bumpVersion(currentVersion, releaseType);
  const tag = `v${newVersion}`;

  console.log(`\n📦 Creating ${releaseType} release: ${newVersion}`);

  if (gitTagExists(tag)) {
    throw new Error(`Tag ${tag} already exists`);
  }

  // Update package.json
  const pkg = readPackageJson();
  pkg.version = newVersion;
  writePackageJson(pkg);
  console.log(`✓ Updated package.json to version ${newVersion}`);

  // Commit version bump
  execGit(["add", "package.json"]);
  execGit(["commit", "-m", `Release: ${newVersion}`]);
  console.log(`✓ Created commit for version ${newVersion}`);

  // Create tag
  execGit(["tag", "-a", tag, "-m", `Release ${newVersion}`]);
  console.log(`✓ Created tag ${tag}`);

  console.log(`\n✅ Release prepared successfully!`);
  console.log(`\nNext step: Push the tag to trigger the release workflow`);
  console.log(`  git push origin ${tag}`);
  console.log(`\nOr push all commits and tags:`);
  console.log(`  git push origin main --tags`);

  return { version: newVersion, tag };
}

function listVersions() {
  try {
    const tags = execGit(["tag", "-l", "v*", "--sort=-version:refname"]);
    const versionList = tags.split("\n").filter(Boolean);

    if (versionList.length === 0) {
      console.log("No releases found.");
      return [];
    }

    console.log("\n📋 Available Releases:");
    versionList.forEach((tag, index) => {
      const version = tag.replace(/^v/, "");
      const isCurrent = version === getCurrentVersion();
      const marker = isCurrent ? " ← current" : "";
      console.log(`  ${index + 1}. ${version}${marker}`);
    });

    return versionList;
  } catch (_error) {
    console.log("No releases found.");
    return [];
  }
}

function initializeFirstRelease() {
  const currentVersion = getCurrentVersion();

  // If already released, don't reinitialize
  if (currentVersion !== "0.0.0" && currentVersion !== "0.1.0") {
    console.log(`✓ Already initialized with version ${currentVersion}`);
    return;
  }

  console.log("\n🚀 Initializing first release (v1.0.0)");

  const pkg = readPackageJson();
  pkg.version = "1.0.0";
  writePackageJson(pkg);
  console.log(`✓ Updated package.json to version 1.0.0`);

  // Commit
  execGit(["add", "package.json"]);
  execGit(["commit", "-m", "Release: 1.0.0 - Initial release"]);
  console.log(`✓ Created commit for version 1.0.0`);

  // Create tag
  execGit(["tag", "-a", "v1.0.0", "-m", "Release 1.0.0 - Initial release"]);
  console.log(`✓ Created tag v1.0.0`);

  console.log(`\n✅ First release initialized!`);
  console.log(`\nNext step: Push the tag to trigger the release workflow`);
  console.log(`  git push origin v1.0.0`);

  return { version: "1.0.0", tag: "v1.0.0" };
}

function showHelp() {
  console.log(`
Prime Silo Release Manager

Usage:
  node scripts/manage-release.js [command] [options]

Commands:
  init              Initialize first release (v1.0.0)
  patch             Create a patch release (e.g., 1.0.0 → 1.0.1)
  minor             Create a minor release (e.g., 1.0.0 → 1.1.0)
  major             Create a major release (e.g., 1.0.0 → 2.0.0)
  list              List all releases
  current           Show current version
  help              Show this help message

Examples:
  node scripts/manage-release.js patch
  node scripts/manage-release.js minor
  node scripts/manage-release.js list
`);
}

async function main() {
  const command = process.argv[2] || "help";

  try {
    switch (command) {
      case "init":
        initializeFirstRelease();
        break;
      case "patch":
        createRelease("patch");
        break;
      case "minor":
        createRelease("minor");
        break;
      case "major":
        createRelease("major");
        break;
      case "list":
        listVersions();
        break;
      case "current":
        console.log(getCurrentVersion());
        break;
      case "help":
      case "-h":
      case "--help":
        showHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getCurrentVersion,
  parseVersion,
  bumpVersion,
  createRelease,
  listVersions,
  initializeFirstRelease
};
