const path = require("node:path");
const { createRequire } = require("node:module");

const PACKAGING_ROOT = path.join(__dirname, "..");
const PROJECT_ROOT = path.join(PACKAGING_ROOT, "..");
const packagingRequire = createRequire(path.join(PACKAGING_ROOT, "package.json"));

function createMissingPackagingDependencyError(packageName) {
  const suffix = packageName ? ` Missing package: ${packageName}.` : "";
  return new Error(
    `Packaging dependencies are not installed.${suffix} Run "npm install --prefix packaging" before using desktop or packaging commands.`
  );
}

function isMissingPackagingDependency(error) {
  return error && error.code === "MODULE_NOT_FOUND";
}

function loadPackagingDependency(packageName) {
  try {
    return packagingRequire(packageName);
  } catch (error) {
    if (isMissingPackagingDependency(error)) {
      throw createMissingPackagingDependencyError(packageName);
    }

    throw error;
  }
}

function resolvePackagingDependency(packageName) {
  try {
    return packagingRequire.resolve(packageName);
  } catch (error) {
    if (isMissingPackagingDependency(error)) {
      throw createMissingPackagingDependencyError(packageName);
    }

    throw error;
  }
}

module.exports = {
  PACKAGING_ROOT,
  PROJECT_ROOT,
  loadPackagingDependency,
  resolvePackagingDependency
};
