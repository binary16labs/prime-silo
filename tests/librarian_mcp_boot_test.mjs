// S22 TDD item 4, met rather than waived.
//
// I previously claimed this could not be done here, because @modelcontextprotocol/sdk was not in
// node_modules and mcp/server.js connects a stdio transport at import. claude-s22-verifier
// disproved both halves: the SDK is a declared dependency of mcp/package.json with a committed
// lockfile, and connecting a stdio transport at import is exactly what makes the server BOOTABLE -
// spawn it as a child, speak JSON-RPC down its stdin, which is what every MCP client does.
//
// So this file boots the shipped server for real, calls all three library tools against a live test
// hub, compares the answers byte for byte with what the route itself returns, stops the hub, and
// proves with a preloaded fs spy that no catalogue file was opened in that process.
//
// It SKIPS, visibly and with the command to fix it, when the SDK is not installed, so the gate
// stays hermetic on a fresh clone rather than failing for a missing optional dependency.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { catalogue, libraryPath } from "../server/coordination/lib/library.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = path.join(ROOT, "mcp", "node_modules", "@modelcontextprotocol", "sdk");
const skip = fs.existsSync(SDK) ? false : "the MCP SDK is not installed — run: npm ci --prefix mcp";

const made = [];
test.after(() => {
  for (const d of made)
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "s22mcp-"))) - 1];
const OLD = new Date(Date.now() - 3_600_000);
const write = (root, rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, OLD, OLD);
  return f;
};

// one catalogued drive with a public and a quarantined file, and a hub serving it
async function liveHub() {
  const root = tmp();
  write(root, "Open/beach.jpg", "beach bytes");
  write(root, "Open/beach-copy.jpg", "beach bytes");
  write(root, "Private/passport.pdf", "secret bytes");
  const store = tmp();
  const dir = path.join(store, "library");
  assert.equal(
    (await catalogue({ root, dbPath: libraryPath(dir, root), rules: ["passport"] })).finished,
    true
  );

  const api = createEstateApi({
    quarantine: ["passport"],
    producer: {
      machine: "T480",
      dbPath: path.join(tmp(), "estate", "estate-map-T480.db"),
      roots: () => [root],
      estateStore: store
    }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, base, close: () => new Promise((r) => server.close(r)) };
}

// an MCP client: the shipped server as a child process, JSON-RPC newline-framed down its stdin
function mcpClient({ api, spyFile }) {
  const child = spawn(process.execPath, ["mcp/server.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PRIME_SILO_API: api,
      BENNY_API_KEY: "test-key-not-a-secret",
      NODE_OPTIONS: `--require ${spyFile}`
    }
  });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const r = waiting.get(msg.id);
        if (r) {
          waiting.delete(msg.id);
          r(msg);
        }
      } catch {
        // the server's own logging is not JSON-RPC; ignore it
      }
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      waiting.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), 20_000).unref();
    });
  return { call, stop: () => child.kill() };
}

test("Scenario: outside agents get the same answer through the same judge", { skip }, async () => {
  const hub = await liveHub();
  const spyDir = tmp();
  const spyFile = path.join(spyDir, "spy.cjs");
  const opened = path.join(spyDir, "opened.txt");
  // every read the child makes, recorded from inside its own process
  fs.writeFileSync(
    spyFile,
    `const fs = require("node:fs");
const log = (p) => { try { fs.appendFileSync(${JSON.stringify(opened)}, String(p) + "\\n"); } catch {} };
for (const fn of ["openSync", "readFileSync", "createReadStream", "open", "readFile"]) {
  const real = fs[fn];
  if (typeof real !== "function") continue;
  fs[fn] = function (p, ...rest) { log(p); return real.call(this, p, ...rest); };
}
`
  );
  const mcp = mcpClient({ api: hub.base, spyFile });
  try {
    const init = await mcp.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "s22-test", version: "1" }
    });
    assert.ok(init.result, `initialize answered: ${JSON.stringify(init).slice(0, 300)}`);

    const list = await mcp.call("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    for (const t of ["library_find", "library_duplicates", "library_check"])
      assert.ok(names.includes(t), `${t} is listed: ${names.join(", ")}`);
    const find = list.result.tools.find((t) => t.name === "library_find");
    assert.deepEqual(find.inputSchema.required, ["root", "q"], "with its schema");

    // THE CLAIM: the tool returns exactly what the route returns
    const direct = await fetch(
      `${hub.base}/api/estate/library/find?root=${encodeURIComponent(hub.root)}&q=beach&surface=mcp`
    ).then((r) => r.json());
    const viaTool = await mcp.call("tools/call", {
      name: "library_find",
      arguments: { root: hub.root, q: "beach" }
    });
    const body = JSON.parse(viaTool.result.content[0].text);
    assert.equal(body.ok, true);
    assert.deepEqual(body.matches, direct.matches, "the tool's matches are the route's matches");
    assert.equal(body.withheld, direct.withheld);
    assert.equal(body.hub, hub.base, "and it names the hub it asked");
    assert.equal(body.address_from, "PRIME_SILO_API", "and where that address came from");

    // the quarantined file is named by neither
    assert.equal(JSON.stringify(body).includes("passport"), false);

    const dup = await mcp.call("tools/call", {
      name: "library_duplicates",
      arguments: { root: hub.root }
    });
    assert.equal(JSON.parse(dup.result.content[0].text).ok, true);
    const chk = await mcp.call("tools/call", {
      name: "library_check",
      arguments: { root: hub.root, path: path.join(hub.root, "Open") }
    });
    assert.equal(JSON.parse(chk.result.content[0].text).ok, true);

    // with the hub stopped: it says so, and still does not read the catalogue
    await hub.close();
    const down = await mcp.call("tools/call", {
      name: "library_find",
      arguments: { root: hub.root, q: "beach" }
    });
    assert.equal(down.result.isError, true);
    assert.match(JSON.parse(down.result.content[0].text).error, /hub is not running/u);

    // NOTHING IN THAT PROCESS OPENED A CATALOGUE
    const reads = fs.existsSync(opened)
      ? fs.readFileSync(opened, "utf8").split("\n").filter(Boolean)
      : [];
    assert.ok(reads.length > 0, "the spy recorded the child's reads");
    for (const r of reads)
      assert.equal(
        /\.db$|\.db-wal$|\.jsonl$/u.test(r),
        false,
        `the tool opened a catalogue file: ${r}`
      );
  } finally {
    mcp.stop();
    await hub.close().catch(() => {});
  }
});
