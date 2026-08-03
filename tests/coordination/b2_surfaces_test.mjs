// B2 acceptance — every agent surface speaks the same ledger.
// Scenarios ↔ delivery/tasks/B2.md gherkin. Hermetic: temp coordDir, embedded http server on port 0.
// The CLI and MCP surfaces are both thin clients of runtime/benny/agentamp/coord_client.mjs, so the
// tests drive that client the way each surface does: two independent contexts over one ledger.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initCoordination, readEvents } from "../../server/coordination/lib/ledger.mjs";
import { createBus } from "../../server/coordination/lib/bus.mjs";
import { createCoordinationApi } from "../../server/coordination/http_api.mjs";
import * as coord from "../../runtime/benny/agentamp/coord_client.mjs";

const DEAD_URL = "http://127.0.0.1:1"; // nothing listens on port 1 — forces the file path

function tmpCoordDir(tag) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)), "coordination");
  initCoordination(dir);
  return dir;
}

async function boot() {
  const coordDir = tmpCoordDir("b2");
  const bus = createBus();
  const api = createCoordinationApi({ coordDir, bus });
  const server = http.createServer((req, res) => {
    Promise.resolve(api.tryHandle(req, res)).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { coordDir, bus, server, baseUrl };
}

// --- Scenario 1 -------------------------------------------------------------
test("Scenario: claim visibility across surfaces", async () => {
  const { coordDir, server, baseUrl } = await boot();
  try {
    // Given the CLI claims task T
    const cli = await coord.connect({ coordDir, baseUrl });
    assert.equal(cli.mode, "server", "server is up, so the CLI must be a thin client");
    const claimed = await coord.claim(cli, "T", "claude");
    assert.equal(claimed.ok, true);

    // When an MCP client lists tasks and attempts to claim T
    const mcp = await coord.connect({ coordDir, baseUrl });
    const listed = await coord.list(mcp);
    const t = listed.find((x) => x.task_id === "T");

    // Then it sees T claimed and receives already-claimed
    assert.equal(t.state, "claimed");
    assert.equal(t.agent, "claude");
    const second = await coord.claim(mcp, "T", "antigravity");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "already-claimed");

    // the losing claim must not have written anything
    const { events } = readEvents(coordDir);
    assert.equal(events.filter((e) => e.type === "task_claimed").length, 1);
  } finally {
    server.close();
  }
});

// --- Scenario 2 -------------------------------------------------------------
test("Scenario: offline fallback preserves the protocol", async () => {
  const coordDir = tmpCoordDir("b2-offline");

  // Given the B1 server is stopped
  const cli = await coord.connect({ coordDir, baseUrl: DEAD_URL });
  assert.equal(cli.mode, "file");

  // When the same claim/report sequence runs
  const claimed = await coord.claim(cli, "T", "claude");
  const mcp = await coord.connect({ coordDir, baseUrl: DEAD_URL });
  const listed = await coord.list(mcp);
  const t = listed.find((x) => x.task_id === "T");
  const second = await coord.claim(mcp, "T", "antigravity");
  const done = await coord.done(cli, "T", "claude", { note: "finished" });

  // Then results are identical via direct-file access with the same validation
  assert.equal(claimed.ok, true);
  assert.equal(t.state, "claimed");
  assert.equal(t.agent, "claude");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-claimed");
  assert.equal(done.ok, true);
  assert.equal((await coord.list(cli)).find((x) => x.task_id === "T").state, "done");
  assert.equal(readEvents(coordDir).ok, true, "hash chain intact after direct-file appends");
});

// --- the two modes must agree, not merely each work ------------------------
test("Scenario: server-up and server-down produce the same protocol results", async () => {
  const { coordDir: onlineDir, server, baseUrl } = await boot();
  const offlineDir = tmpCoordDir("b2-parity");
  try {
    const shape = async (ctx) => {
      const first = await coord.claim(ctx, "T", "claude");
      const clash = await coord.claim(ctx, "T", "antigravity");
      const bad = await coord.claim(ctx, "T2", "kremlin").catch((e) => ({ ok: false, err: true }));
      return {
        first: first.ok,
        clash: [clash.ok, clash.reason],
        badRejected: bad.ok === false,
        state: (await coord.list(ctx)).find((x) => x.task_id === "T").state
      };
    };
    const online = await shape(await coord.connect({ coordDir: onlineDir, baseUrl }));
    const offline = await shape(await coord.connect({ coordDir: offlineDir, baseUrl: DEAD_URL }));
    assert.deepEqual(online, offline, "the protocol must not change with the server's presence");
    assert.equal(offline.badRejected, true, "an unregistered agent is refused in both modes");
  } finally {
    server.close();
  }
});

// --- server stays the single appender when it is up ------------------------
test("Scenario: a server-up claim is appended by the server and broadcast on the bus", async () => {
  const { coordDir, bus, server, baseUrl } = await boot();
  try {
    const seen = [];
    bus.subscribe({
      write: (chunk) => seen.push(String(chunk)),
      on: () => {},
      writeHead: () => {},
      end: () => {}
    });
    const ctx = await coord.connect({ coordDir, baseUrl });
    await coord.claim(ctx, "T", "claude");
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      seen.some((s) => s.includes("task_claimed")),
      "a claim made while the server is up must reach live subscribers"
    );
  } finally {
    server.close();
  }
});

// --- the lease is the mutual-exclusion primitive, and it is atomic ---------
test("Scenario: a stale lease may be taken over but a live one may not", async () => {
  const coordDir = tmpCoordDir("b2-lease");
  const ctx = await coord.connect({ coordDir, baseUrl: DEAD_URL });

  // a live lease blocks — asserted with a full-length TTL so the test cannot race the clock
  assert.equal((await coord.claim(ctx, "T", "claude")).ok, true);
  assert.equal((await coord.claim(ctx, "T", "benny")).reason, "already-claimed");

  // an expired lease is reclaimable — expiry is forced on disk rather than slept for
  const p = path.join(coordDir, "leases", "T.json");
  const stale = JSON.parse(fs.readFileSync(p, "utf8"));
  stale.expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(p, JSON.stringify(stale, null, 2));
  const takeover = await coord.claim(ctx, "T", "benny");
  assert.equal(takeover.ok, true);
  assert.equal(takeover.takeover, true);
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).agent, "benny");
});

// --- a rejected append must not leave a lease stranded --------------------
test("Scenario: a claim whose append is rejected releases its lease", async () => {
  const coordDir = tmpCoordDir("b2-rollback");
  const ctx = await coord.connect({ coordDir, baseUrl: DEAD_URL });
  await assert.rejects(() => coord.claim(ctx, "T", "kremlin"));
  assert.equal(
    fs.existsSync(path.join(coordDir, "leases", "T.json")),
    false,
    "an unregistered agent must not hold a lease for an event that never landed"
  );
  assert.equal((await coord.claim(ctx, "T", "claude")).ok, true, "T is still claimable");
});
