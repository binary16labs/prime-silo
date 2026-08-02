#!/usr/bin/env node
// estate registration key — generate / inspect the shared per-estate secret that gates
// POST /api/estate/register.
//
// Deliberately a SEPARATE, EXPLICIT act rather than something the server does at boot:
// creating a credential as a side effect of starting a process is how a network surface
// opens without anyone deciding to open it. Until this is run, no key resolves, the
// register route refuses every satellite, and live discovery stays off.
//
// The key is never printed by this tool. Moving it to the satellite is the owner's step —
// it is a secret, and it should travel the way the owner moves secrets, not via a log.
//
//   node scripts/estate_key.mjs --status
//   node scripts/estate_key.mjs --init
//   node scripts/estate_key.mjs --init --force     # rotate (re-key EVERY satellite)
import { initRegisterKey, resolveRegisterKey, keyPath } from "../server/coordination/lib/estate_register_key.mjs";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);

const p = keyPath();

if (flag("--init")) {
  const r = initRegisterKey({ force: flag("--force") });
  if (!r.ok) {
    console.error(`refused: ${r.reason}`);
    console.error(`  existing key: ${r.path}`);
    process.exit(2);
  }
  console.log(`registration key created (${r.bytes} bytes, mode 0600)`);
  console.log(`  ${r.path}`);
  console.log("\nThe register route is now armed on this hub (restart the server to pick it up).");
  console.log("To enrol a satellite, copy the key's CONTENTS to that machine as either:");
  console.log("  - the env var ESTATE_REGISTER_KEY, or");
  console.log("  - <BENNY_HOME>/state/estate-register-key");
  console.log("Not printed here on purpose — move it the way you move secrets.");
  process.exit(0);
}

// default: status. Reports presence, never the value.
const key = resolveRegisterKey();
console.log(`estate registration key`);
console.log(`  path       ${p}`);
console.log(`  configured ${key ? "yes" : "NO"}`);
console.log(`  source     ${process.env.ESTATE_REGISTER_KEY ? "ESTATE_REGISTER_KEY (env)" : key ? "keystore file" : "(none)"}`);
console.log(
  key
    ? "\nregister route is ARMED — satellites holding this key can announce themselves."
    : "\nregister route is CLOSED — every registration is refused as unauthenticated.\n  arm it with: node scripts/estate_key.mjs --init"
);
