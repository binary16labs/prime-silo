// Single authority for resolving the Prime-Silo home on the Node side.
//
// Historically the app had four competing notions of "home": the tray's
// config.homeDir, the tray's config.bennyHome, the CUSTOMWARE_PATH runtime
// param, and repo-relative fallbacks. This module collapses them into one
// declared root with everything else derived from it:
//
//   <root>/                  ← PRIME_SILO_HOME (the one declared home)
//   ├── customware/          ← CUSTOMWARE_PATH (Space server L1/L2)
//   └── benny/               ← BENNY_HOME (portable Benny runtime)
//
// Resolution precedence for the root (highest wins):
//   1. PRIME_SILO_HOME env var        → source "env"
//   2. homeDir in prime-silo-config.json → source "config"
//   3. per-user default (<appData>/Prime-Silo/prime-silo-home) → source "default"
//
// Explicit BENNY_HOME / CUSTOMWARE_PATH env overrides and the legacy
// config.bennyHome key remain honored — but they are reported with their own
// source tag and a divergence warning when they point outside the declared
// root, so `benny doctor`, /api/home, and the tray can surface the drift
// instead of hiding it.
//
// Kept dependency-free and Electron-free: Electron callers pass the parsed
// config + userData path in; non-Electron callers (server API, CLI, tests)
// rely on the built-in per-platform config locator.
//
// The Python runtime has a mirror of this logic in
// runtime/benny/portable/home.py (resolve_home) — keep the two in sync.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes } = require("node:crypto");

const CONFIG_DIR_NAME = "Prime-Silo";
const CONFIG_FILENAME = "prime-silo-config.json";
const DEFAULT_HOME_DIRNAME = "prime-silo-home";
const CUSTOMWARE_SUBDIR = "customware";
const BENNY_SUBDIR = "benny";
// Pre-unification per-user defaults (main.js used userData/customware and
// userData/benny-home when nothing was configured). Installs that already
// have data there keep working untouched.
const LEGACY_CUSTOMWARE_DIRNAME = "customware";
const LEGACY_BENNY_DIRNAME = "benny-home";

function trimmed(value) {
  return String(value == null ? "" : value).trim();
}

// Per-user application-data base without Electron: the same directory
// Electron's app.getPath("userData") resolves to for this app.
function appDataBase(platform, env, homedir) {
  if (platform === "win32") {
    return trimmed(env.APPDATA) || path.join(homedir, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support");
  }
  return trimmed(env.XDG_CONFIG_HOME) || path.join(homedir, ".config");
}

function defaultUserDataPath({ platform = process.platform, env = process.env } = {}) {
  return path.join(appDataBase(platform, env, os.homedir()), CONFIG_DIR_NAME);
}

function configFilePath(options = {}) {
  const userDataPath = trimmed(options.userDataPath) || defaultUserDataPath(options);
  return path.join(userDataPath, CONFIG_FILENAME);
}

// Best-effort read of prime-silo-config.json for callers that don't already
// have it parsed (server API, CLI). Electron callers keep their own reader.
function readDesktopConfig(options = {}) {
  try {
    const file = configFilePath(options);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8")) || {};
    }
  } catch {
    // Unreadable config is treated as absent; resolution falls to defaults.
  }
  return {};
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Resolve the declared home root and the two derived paths.
//
// options:
//   env          — environment map (default process.env)
//   config       — parsed prime-silo-config.json (default: read from disk)
//   userDataPath — Electron userData dir (default: per-platform equivalent)
//   platform     — default process.platform
//
// returns {
//   root, source,                 // "env" | "config" | "default"
//   customwarePath, customwareSource, // "derived" | "env-override" | "legacy-default"
//   bennyHome, bennyHomeSource,   // "derived" | "env-override" | "legacy-config" | "legacy-default"
//   configPath,                   // where the config file lives
//   warnings                      // human-readable divergence notes
// }
function resolveHome(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const userDataPath = trimmed(options.userDataPath) || defaultUserDataPath({ platform, env });
  const config =
    options.config && typeof options.config === "object"
      ? options.config
      : readDesktopConfig({ userDataPath });

  const warnings = [];

  // 1. The declared root.
  let root;
  let source;
  const envRoot = trimmed(env.PRIME_SILO_HOME);
  const configRoot = trimmed(config.homeDir);
  if (envRoot) {
    root = path.resolve(envRoot);
    source = "env";
    if (configRoot && path.resolve(configRoot) !== root) {
      warnings.push(`PRIME_SILO_HOME env (${root}) overrides configured homeDir (${configRoot}).`);
    }
  } else if (configRoot) {
    root = path.resolve(configRoot);
    source = "config";
  } else {
    root = path.join(userDataPath, DEFAULT_HOME_DIRNAME);
    source = "default";
  }

  // 2. Benny home: env override > legacy config key > legacy per-user default
  //    (pre-unification installs) > derived.
  let bennyHome;
  let bennyHomeSource;
  const envBenny = trimmed(env.BENNY_HOME);
  const legacyConfigBenny = trimmed(config.bennyHome);
  const legacyDefaultBenny = path.join(userDataPath, LEGACY_BENNY_DIRNAME);
  if (envBenny) {
    bennyHome = path.resolve(envBenny);
    bennyHomeSource = "env-override";
  } else if (legacyConfigBenny) {
    bennyHome = path.resolve(legacyConfigBenny);
    bennyHomeSource = "legacy-config";
    warnings.push(
      `Benny home comes from the legacy config key "bennyHome" (${bennyHome}); ` +
        `adopt the unified home to derive it from ${root}.`
    );
  } else if (source === "default" && dirExists(legacyDefaultBenny)) {
    bennyHome = legacyDefaultBenny;
    bennyHomeSource = "legacy-default";
    warnings.push(
      `Benny home uses the pre-unification default (${bennyHome}); ` +
        `adopt the unified home to move it under ${root}.`
    );
  } else {
    bennyHome = path.join(root, BENNY_SUBDIR);
    bennyHomeSource = "derived";
  }
  if (bennyHomeSource === "env-override" && !isInside(bennyHome, root)) {
    warnings.push(
      `BENNY_HOME env override (${bennyHome}) points outside the declared home (${root}).`
    );
  }

  // 3. Customware: env override > legacy per-user default > derived.
  let customwarePath;
  let customwareSource;
  const envCustomware = trimmed(env.CUSTOMWARE_PATH);
  const legacyDefaultCustomware = path.join(userDataPath, LEGACY_CUSTOMWARE_DIRNAME);
  if (envCustomware) {
    customwarePath = path.resolve(envCustomware);
    customwareSource = "env-override";
    if (!isInside(customwarePath, root)) {
      warnings.push(
        `CUSTOMWARE_PATH env override (${customwarePath}) points outside the declared home (${root}).`
      );
    }
  } else if (source === "default" && dirExists(legacyDefaultCustomware)) {
    customwarePath = legacyDefaultCustomware;
    customwareSource = "legacy-default";
    warnings.push(
      `Customware uses the pre-unification default (${customwarePath}); ` +
        `adopt the unified home to move it under ${root}.`
    );
  } else {
    customwarePath = path.join(root, CUSTOMWARE_SUBDIR);
    customwareSource = "derived";
  }

  return {
    root,
    source,
    customwarePath,
    customwareSource,
    bennyHome,
    bennyHomeSource,
    configPath: path.join(userDataPath, CONFIG_FILENAME),
    warnings
  };
}

function dirExists(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function ensureBennyKeystore(options = {}) {
  const bennyHome = trimmed(options.bennyHome);
  const env = options.env || process.env;

  if (!bennyHome) {
    return false;
  }

  if (!env.BENNY_HOME) {
    env.BENNY_HOME = bennyHome;
  }

  if (env.BENNY_API_KEY || env.BENNY_AGENT_API_KEY) {
    return false;
  }

  try {
    const stateDir = path.join(bennyHome, "state");
    const hmacKeyFile = path.join(stateDir, "hmac-key");
    if (!fs.existsSync(hmacKeyFile)) {
      fs.mkdirSync(stateDir, { recursive: true });
      const freshKey = randomBytes(32).toString("hex");
      fs.writeFileSync(hmacKeyFile, freshKey, "utf8");
      return true;
    }
  } catch (error) {
    console.warn("[home_resolver] failed to seed benny keystore:", error?.message || error);
  }

  return false;
}

module.exports = {
  resolveHome,
  ensureBennyKeystore,
  readDesktopConfig,
  defaultUserDataPath,
  configFilePath,
  CONFIG_FILENAME,
  DEFAULT_HOME_DIRNAME,
  CUSTOMWARE_SUBDIR,
  BENNY_SUBDIR
};
