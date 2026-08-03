#!/usr/bin/env node
// Gate B2 — every agent surface speaks the same ledger.
// CLI (`benny coord ls|claim|progress|done|note`) and the prime-silo-nexus MCP tools
// (coord_list/coord_claim/coord_report/coord_note) are thin clients of the B1 API when the server
// is up, and fall back to direct-file access via the same B0 validator lib when it is not.
// Claim mutual-exclusion is the atomic wx lease in BOTH modes, so already-claimed is identical
// whether or not the server is running. Hermetic: temp coordDir, embedded server.
// Contract: delivery/tasks/B2.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`[b2] FAIL: ${msg}`);
  process.exit(1);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

for (const rel of [
  "runtime/benny/agentamp/coord_client.mjs",
  "runtime/benny/agentamp/coord.py",
  "tests/coordination/b2_surfaces_test.mjs"
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`required artifact missing: ${rel}`);
}

// Structural: the surfaces must actually be wired, not merely present.
const cli = read("runtime/benny_cli.py");
if (!/add_parser\(\s*["']coord["']/.test(cli)) fail("benny_cli.py registers no `coord` subcommand");
if (!/args\.cmd == ["']coord["']/.test(cli)) fail("benny_cli.py never dispatches `coord`");

const mcp = read("mcp/server.js");
for (const tool of ["coord_list", "coord_claim", "coord_report", "coord_note"]) {
  if (!mcp.includes(tool)) fail(`mcp/server.js does not expose the ${tool} tool`);
}
if (!/coord_client\.mjs/.test(mcp)) fail("mcp/server.js does not import the shared coord client");

// Reuse, not reimplementation: the client must sit on the B0 validator lib (contract §Context).
const client = read("runtime/benny/agentamp/coord_client.mjs");
if (!/server\/coordination\/lib\/ledger\.mjs/.test(client))
  fail("coord_client.mjs does not reuse server/coordination/lib/ledger.mjs");
// The Python surface must not fork the protocol — it shells out to the one JS implementation.
const py = read("runtime/benny/agentamp/coord.py");
if (!/coord_client\.mjs/.test(py)) fail("coord.py does not delegate to coord_client.mjs");

const t = spawnSync(process.execPath, ["--test", "tests/coordination/b2_surfaces_test.mjs"], {
  cwd: ROOT,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[b2] GATE FAILED (agent-surface scenarios)");
  process.exit(1);
}

console.log(
  "[b2] agent surfaces: cross-surface already-claimed + identical server-up/server-down protocol " +
    "+ atomic wx lease in both modes + one shared client — verified"
);
console.log("[b2] GATE GREEN");
process.exit(0);
