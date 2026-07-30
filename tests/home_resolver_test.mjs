#!/usr/bin/env node
//
// home_resolver — the single Node-side authority for the declared Prime-Silo
// home. Verifies root precedence (env > config > default), derivation of
// benny/ + customware/, legacy-key and legacy-default handling, and that
// divergence always produces a warning instead of being hidden.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveHome,
  ensureBennyKeystore,
  DEFAULT_HOME_DIRNAME
} = require("../packaging/desktop/home_resolver.js");

// Hermetic base: userData under a temp dir, empty env unless a case sets one.
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ps-home-resolver-"));
const userDataPath = path.join(tmpBase, "Prime-Silo");
fs.mkdirSync(userDataPath, { recursive: true });

function resolve({ env = {}, config = {} } = {}) {
  return resolveHome({ env, config, userDataPath });
}

// ── root precedence ─────────────────────────────────────────────────────────
{
  const byDefault = resolve();
  assert.equal(byDefault.source, "default");
  assert.equal(byDefault.root, path.join(userDataPath, DEFAULT_HOME_DIRNAME));

  const byConfig = resolve({ config: { homeDir: path.join(tmpBase, "cfg-home") } });
  assert.equal(byConfig.source, "config");
  assert.equal(byConfig.root, path.resolve(tmpBase, "cfg-home"));

  const byEnv = resolve({
    env: { PRIME_SILO_HOME: path.join(tmpBase, "env-home") },
    config: { homeDir: path.join(tmpBase, "cfg-home") }
  });
  assert.equal(byEnv.source, "env");
  assert.equal(byEnv.root, path.resolve(tmpBase, "env-home"));
  // Env overriding a configured home is flagged, not silent.
  assert.ok(byEnv.warnings.some((w) => w.includes("PRIME_SILO_HOME")));
}

// ── derived children ────────────────────────────────────────────────────────
{
  const home = resolve({ config: { homeDir: path.join(tmpBase, "cfg-home") } });
  assert.equal(home.bennyHome, path.join(home.root, "benny"));
  assert.equal(home.bennyHomeSource, "derived");
  assert.equal(home.customwarePath, path.join(home.root, "customware"));
  assert.equal(home.customwareSource, "derived");
  assert.equal(home.warnings.length, 0);
}

// ── explicit env overrides win and warn when outside the root ───────────────
{
  const outside = path.join(tmpBase, "elsewhere", "benny");
  const home = resolve({
    env: { BENNY_HOME: outside, CUSTOMWARE_PATH: path.join(tmpBase, "elsewhere", "cw") },
    config: { homeDir: path.join(tmpBase, "cfg-home") }
  });
  assert.equal(home.bennyHome, path.resolve(outside));
  assert.equal(home.bennyHomeSource, "env-override");
  assert.equal(home.customwareSource, "env-override");
  assert.ok(home.warnings.some((w) => w.includes("BENNY_HOME")));
  assert.ok(home.warnings.some((w) => w.includes("CUSTOMWARE_PATH")));

  // An env override INSIDE the declared root is fine — no warning.
  const inside = resolve({
    env: { BENNY_HOME: path.join(tmpBase, "cfg-home", "benny") },
    config: { homeDir: path.join(tmpBase, "cfg-home") }
  });
  assert.equal(inside.bennyHomeSource, "env-override");
  assert.ok(!inside.warnings.some((w) => w.includes("BENNY_HOME")));
}

// ── legacy config.bennyHome still honored, flagged for adoption ─────────────
{
  const legacy = path.join(tmpBase, "old-benny-home");
  const home = resolve({ config: { bennyHome: legacy } });
  assert.equal(home.bennyHome, path.resolve(legacy));
  assert.equal(home.bennyHomeSource, "legacy-config");
  assert.ok(home.warnings.some((w) => w.includes("bennyHome")));
}

// ── pre-unification per-user defaults keep working when they exist ──────────
{
  // Simulate an existing install: userData/benny-home and userData/customware
  // populated, no config keys.
  fs.mkdirSync(path.join(userDataPath, "benny-home"), { recursive: true });
  fs.mkdirSync(path.join(userDataPath, "customware"), { recursive: true });

  const home = resolve();
  assert.equal(home.bennyHome, path.join(userDataPath, "benny-home"));
  assert.equal(home.bennyHomeSource, "legacy-default");
  assert.equal(home.customwarePath, path.join(userDataPath, "customware"));
  assert.equal(home.customwareSource, "legacy-default");
  assert.equal(home.warnings.length, 2);

  // But a configured home takes precedence over legacy defaults: once the
  // user declares a home, everything derives from it.
  const adopted = resolve({ config: { homeDir: path.join(tmpBase, "adopted") } });
  assert.equal(adopted.bennyHomeSource, "derived");
  assert.equal(adopted.customwareSource, "derived");
}

// ── ensureBennyKeystore seeds per-install hmac-key and sets BENNY_HOME ──────
{
  const testBennyHome = path.join(tmpBase, "keystore-test-benny");
  const testEnv = {};
  const seeded = ensureBennyKeystore({ bennyHome: testBennyHome, env: testEnv });
  assert.equal(seeded, true);
  assert.equal(testEnv.BENNY_HOME, testBennyHome);
  const keyFile = path.join(testBennyHome, "state", "hmac-key");
  assert.ok(fs.existsSync(keyFile));
  const keyText = fs.readFileSync(keyFile, "utf8").trim();
  assert.equal(keyText.length, 64);
  assert.match(keyText, /^[0-9a-f]{64}$/);

  // Idempotent: second call does not overwrite or return true.
  const second = ensureBennyKeystore({ bennyHome: testBennyHome, env: testEnv });
  assert.equal(second, false);
  assert.equal(fs.readFileSync(keyFile, "utf8").trim(), keyText);

  // Skipped when BENNY_API_KEY is already in env.
  const envWithKey = { BENNY_API_KEY: "custom-key" };
  const untouchedHome = path.join(tmpBase, "untouched-benny");
  assert.equal(ensureBennyKeystore({ bennyHome: untouchedHome, env: envWithKey }), false);
  assert.ok(!fs.existsSync(path.join(untouchedHome, "state", "hmac-key")));
}

fs.rmSync(tmpBase, { recursive: true, force: true });
console.log("home_resolver_test: ok");
