// N2 acceptance — estate console page + live API. Each Scenario in delivery/tasks/N2.md
// maps to a named test. Hermetic: OS temp KEL, an embedded http server on port 0, no app boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendKelEvent } from "../../server/coordination/lib/kel.mjs";
import { estateMachineEvent, estateDriveEvent, estateSessionEvent } from "../../server/coordination/lib/estate.mjs";
import { createBus } from "../../server/coordination/lib/bus.mjs";
import { createEstateApi } from "../../server/coordination/lib/estate_api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function seedKel() {
  const kel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "n2-")), "kel.jsonl");
  appendKelEvent(kel, estateMachineEvent({ machine: "t480", role: "hub" }));
  appendKelEvent(kel, estateSessionEvent({ machine: "t480", contentHash: "sha256:aa", sid: "s1" }));
  appendKelEvent(kel, estateDriveEvent({ machine: "t480", label: "F", role: "source", fingerprint: "fp", sessionHashes: ["sha256:aa"] }));
  return kel;
}
function serve(api) {
  const server = http.createServer((req, res) => {
    if (api.tryHandle(req, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("fallthrough");
  });
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port, close })));
}
const getJson = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ port, path: p }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }).on("error", reject);
  });

test("Scenario: estate model over the API", async () => {
  const bus = createBus();
  const api = createEstateApi({ kelLog: seedKel(), bus });
  const { close, port } = await serve(api);
  try {
    const r = await getJson(port, "/api/estate");
    assert.equal(r.status, 200);
    const est = JSON.parse(r.body);
    assert.ok(est.machines && est.drives && est.sessions, "returns machines, drives, sessions");
    assert.equal(est.machines.t480.role, "hub");
    assert.equal(est.summary.machines, 1);
    assert.equal(est.summary.sessions, 1);
  } finally { await close(); }
});

test("Scenario: live estate stream", async () => {
  const bus = createBus();
  const api = createEstateApi({ kelLog: seedKel(), bus });
  const { close, port } = await serve(api);
  let req, pubT, failT;
  try {
    const got = await new Promise((resolve, reject) => {
      req = http.get({ port, path: "/api/estate/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => { if (chunk.includes("event: estate")) resolve(chunk); });
      });
      req.on("error", reject);
      pubT = setTimeout(() => bus.publish("estate", { kind: "sync", stored: 3 }), 150); // after subscribe
      failT = setTimeout(() => reject(new Error("no estate SSE within 2s")), 2000);
    });
    assert.match(got, /event: estate/);
    assert.match(got, /"stored":3/);
  } finally {
    clearTimeout(pubT); clearTimeout(failT);
    try { req?.destroy(); } catch { /* ignore */ }
    await close();
  }
});

test("Scenario: additive mount preserves existing routes", () => {
  const api = createEstateApi({ kelLog: seedKel(), bus: createBus() });
  let touched = false;
  const mockRes = { writeHead() { touched = true; }, end() { touched = true; }, write() { touched = true; } };
  const handled = api.tryHandle({ method: "GET", url: "/api/config" }, mockRes);
  assert.equal(handled, false, "estate does not own /api/config");
  assert.equal(touched, false, "the response is untouched so the real handler serves it");
  // sanity: it DOES own its own prefix
  const owned = api.tryHandle({ method: "GET", url: "/api/estate" }, { writeHead() {}, end() {} });
  assert.equal(owned, true);
});

test("Scenario: page is complete without JS", () => {
  const html = fs.readFileSync(path.join(ROOT, "server/pages/estate.html"), "utf8");
  assert.match(html, /data-role="hub"[\s\S]*data-machine="t480"/, "hub node present in markup");
  assert.match(html, /data-role="satellite"/, "satellite node present in markup");
  assert.ok(/data-machine="asus"/.test(html), "ASUS satellite present");
  for (const node of ["F: main", "D: runner", "eGPU"]) assert.ok(html.includes(node), `cascade node ${node} present`);
  // the live wiring exists but the page does not depend on it for structure
  assert.ok(html.includes("/api/estate/stream"), "subscribes to the live stream");
});
