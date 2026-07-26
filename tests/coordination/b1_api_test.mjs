// B1 acceptance — coordination ledger served over HTTP + live SSE broadcast.
// Scenarios ↔ delivery/tasks/B1.md gherkin. Hermetic: temp coordDir, embedded http server on port 0.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initCoordination, ulid } from "../../server/coordination/lib/ledger.mjs";
import { createBus } from "../../server/coordination/lib/bus.mjs";
import { createCoordinationApi } from "../../server/coordination/http_api.mjs";

// --- embedded server harness -----------------------------------------------
function boot() {
  const coordDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b1-")), "coordination");
  initCoordination(coordDir); // seeds agents.json (claude/…/human) + dirs
  const bus = createBus();
  const api = createCoordinationApi({ coordDir, bus });
  const server = http.createServer((req, res) => {
    Promise.resolve(api.tryHandle(req, res)).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ coordDir, bus, server, port, tasksFile: path.join(coordDir, "tasks.jsonl") });
    });
  });
}

function req(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const event = (over = {}) => ({
  id: ulid(),
  ts: new Date().toISOString(),
  type: "task_claimed",
  agent: "claude",
  task_id: "TASK-1",
  payload: {},
  ...over,
});

// ---------------------------------------------------------------------------
test("Scenario: accepted appends are visible and broadcast within 2s", async () => {
  const { port, server } = await boot();
  try {
    // subscribe to the SSE stream BEFORE the append.
    const received = new Promise((resolve, reject) => {
      const r = http.get({ host: "127.0.0.1", port, path: "/api/coord/stream" }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          const m = buf.match(/event: coord\ndata: (.+)\n\n/);
          if (m) { r.destroy(); resolve(JSON.parse(m[1])); }
        });
      });
      r.on("error", reject);
      setTimeout(() => { r.destroy(); reject(new Error("no SSE broadcast within 2s")); }, 2000);
    });
    await new Promise((r) => setTimeout(r, 100)); // let the subscription register

    const ev = event({ task_id: "TASK-42" });
    const post = await req(port, "POST", "/api/coord/events", ev);
    assert.equal(post.status, 201);

    // folded state reflects the new claim.
    const tasks = await req(port, "GET", "/api/coord/tasks");
    assert.equal(tasks.status, 200);
    const t = tasks.json.find((x) => x.task_id === "TASK-42");
    assert.equal(t.state, "claimed");
    assert.equal(t.agent, "claude");

    // and the SSE broadcast carried the event.
    const broadcast = await received;
    assert.equal(broadcast.task_id, "TASK-42");
    assert.equal(broadcast.type, "task_claimed");
  } finally {
    server.close();
  }
});

test("Scenario: invalid events never touch the ledger (422, byte-unchanged)", async () => {
  const { port, server, tasksFile } = await boot();
  try {
    // seed one valid event so the file exists and has content.
    await req(port, "POST", "/api/coord/events", event({ task_id: "SEED" }));
    const before = fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile) : Buffer.alloc(0);

    // an event from an UNREGISTERED agent.
    const bad = await req(port, "POST", "/api/coord/events", event({ agent: "kremlin", task_id: "EVIL" }));
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, /kremlin/); // the validator's reason

    const after = fs.readFileSync(tasksFile);
    assert.ok(before.equals(after), "the ledger file must be byte-unchanged by a rejected append");
  } finally {
    server.close();
  }
});

test("Scenario: per-task event history", async () => {
  const { port, server } = await boot();
  try {
    await req(port, "POST", "/api/coord/events", event({ type: "task_created", task_id: "T", agent: "human" }));
    await req(port, "POST", "/api/coord/events", event({ type: "task_claimed", task_id: "T", agent: "claude" }));
    await req(port, "POST", "/api/coord/events", event({ type: "task_claimed", task_id: "OTHER", agent: "claude" }));

    const hist = await req(port, "GET", "/api/coord/tasks/T/events");
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.json.map((e) => e.type), ["task_created", "task_claimed"]);
    assert.ok(hist.json.every((e) => e.task_id === "T"));
  } finally {
    server.close();
  }
});

test("Scenario: knowledge query filters by topic", async () => {
  const { port, server } = await boot();
  try {
    await req(port, "POST", "/api/coord/events", event({ type: "knowledge_added", task_id: "-", agent: "claude", payload: { topic: "egpu", note: "wedges transiently" } }));
    await req(port, "POST", "/api/coord/events", event({ type: "knowledge_added", task_id: "-", agent: "benny", payload: { topic: "router", note: "additive" } }));

    const all = await req(port, "GET", "/api/coord/knowledge");
    assert.equal(all.json.length, 2);
    const egpu = await req(port, "GET", "/api/coord/knowledge?topic=egpu");
    assert.equal(egpu.json.length, 1);
    assert.equal(egpu.json[0].payload.topic, "egpu");
  } finally {
    server.close();
  }
});
