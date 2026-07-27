#!/usr/bin/env node
// Gate N2 — estate console page + live API. Hermetic: embedded server on port 0, no app boot.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (m) => { console.error(`[n2] FAIL: ${m}`); process.exit(1); };

for (const f of ["server/coordination/lib/estate_api.mjs", "server/pages/estate.html"])
  if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} missing`);

// additive-mount contract: app.js must mount estate AHEAD of the generic handler and fall through
const appjs = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
if (!appjs.includes("createEstateApi")) fail("app.js does not import createEstateApi");
if (!/estateApi\.tryHandle\(req, res\)/.test(appjs)) fail("app.js does not mount estateApi.tryHandle");
if (!/if \(estateApi\.tryHandle\(req, res\)\) return undefined;[\s\S]*return requestHandler/.test(appjs))
  fail("estate mount must run BEFORE the generic requestHandler (fall-through preserved)");

const t = spawnSync(process.execPath, ["--test", "tests/estate_api/estate_api.test.mjs"], { cwd: ROOT, stdio: "inherit" });
if (t.status !== 0) { console.log("[n2] GATE FAILED (scenarios)"); process.exit(1); }

console.log("[n2] estate API + live SSE + additive mount + no-JS page — green");
console.log("[n2] GATE GREEN");
process.exit(0);
