#!/usr/bin/env node
// Gate N7 — live satellite discovery. Pure functions + additive route; hermetic (no real net).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = "server/coordination/lib/estate_register.mjs";
if (!fs.existsSync(path.join(ROOT, mod))) { console.error(`[n7] FAIL: ${mod} missing`); process.exit(1); }

const t = spawnSync(process.execPath, ["--test", "tests/estate_register/estate_register.test.mjs"], { cwd: ROOT, stdio: "inherit" });
if (t.status !== 0) { console.log("[n7] GATE FAILED (scenarios)"); process.exit(1); }

console.log("[n7] register: hashes-only manifest (R31), LAN+key auth, drift recompute on register, additive route — green");
console.log("[n7] GATE GREEN");
process.exit(0);
