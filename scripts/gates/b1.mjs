#!/usr/bin/env node
// Gate B1 — coordination ledger served over HTTP + live SSE broadcast.
// Accepted appends are folded, visible, and broadcast within 2s; invalid appends 422 with the
// validator's reason and leave the ledger byte-unchanged; per-task history + topic-filtered
// knowledge. Hermetic: temp coordDir, embedded server. Contract: delivery/tasks/B1.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const rel of ["server/coordination/lib/bus.mjs", "server/coordination/http_api.mjs"]) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`[b1] FAIL: required artifact missing: ${rel}`);
    process.exit(1);
  }
}

// Structural: app.js must actually wire the coordination API (not just define it) — the endpoints
// are only live if app.js mounts createCoordinationApi ahead of the generic handler.
const appJs = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
if (!/createCoordinationApi/.test(appJs) || !/tryHandle/.test(appJs)) {
  console.error("[b1] FAIL: server/app.js does not wire createCoordinationApi(...).tryHandle");
  process.exit(1);
}

const t = spawnSync(process.execPath, ["--test", "tests/coordination/b1_api_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[b1] GATE FAILED (coordination API / SSE scenarios)");
  process.exit(1);
}

console.log("[b1] coord API: folded state + per-task history + validated append (422 byte-unchanged) + live SSE broadcast + topic knowledge — verified");
console.log("[b1] GATE GREEN");
process.exit(0);
