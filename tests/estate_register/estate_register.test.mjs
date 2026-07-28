// N7 acceptance — live satellite registration. Every Scenario in delivery/tasks/N7.md maps to a
// named test. Pure functions over injected inputs (no fs/network); the additive-route scenario
// exercises estate_api. Privacy R31: only content-hashes + quarantine flags cross the wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, register, isLanOrigin } from "../../server/coordination/lib/estate_register.mjs";
import { createEstateApi } from "../../server/coordination/lib/estate_api.mjs";

test("Scenario: a satellite coming online updates drift live", () => {
  const hub = { satellites: {} };
  const manifest = buildManifest("asus", [{ sid: "s1", content: "aaa" }, { sid: "s2", content: "bbb" }]);
  const r = register(hub, manifest, { key: "shared", expectedKey: "shared", remoteAddress: "192.168.68.125", hubHashes: [] });
  assert.equal(r.ok, true);
  const sat = r.state.satellites.asus;
  assert.equal(sat.reachable, true, "reachability flips to live");
  assert.ok(sat.lastSeen > 0, "last-seen updates");
  assert.equal(sat.drift.cleanCount, 2, "drift is recomputed from the manifest hashes (hub had neither)");
  assert.notEqual(r.state, hub, "input hub state is not mutated");
});

test("Scenario: unauthenticated or non-LAN registration is refused", () => {
  const hub = { satellites: {} };
  const manifest = buildManifest("asus", [{ sid: "s1", content: "aaa" }]);
  const badKey = register(hub, manifest, { key: "wrong", expectedKey: "shared", remoteAddress: "192.168.68.125" });
  assert.equal(badKey.ok, false, "a wrong shared key is rejected");
  assert.deepEqual(badKey.state, hub, "hub state is unchanged");
  const nonLan = register(hub, manifest, { key: "shared", expectedKey: "shared", remoteAddress: "8.8.8.8" });
  assert.equal(nonLan.ok, false, "a non-LAN origin is refused");
  assert.deepEqual(nonLan.state, hub, "hub state is unchanged");
  assert.equal(isLanOrigin("127.0.0.1"), true);
  assert.equal(isLanOrigin("192.168.1.5"), true);
  assert.equal(isLanOrigin("8.8.8.8"), false);
});

test("Scenario: only hashes cross the wire (R31)", () => {
  const manifest = buildManifest("asus", [{ sid: "cv", content: "secret cover letter text", quarantined: true }, { sid: "s1", content: "aaa" }]);
  // the manifest carries content-hashes + quarantine flags ONLY — never a session's text
  for (const s of manifest.sessions) {
    assert.ok(s.contentHash && s.contentHash.startsWith("sha256:"), "each session carries a content-hash");
    assert.equal("content" in s, false, "no session content on the wire");
    assert.equal("text" in s, false, "no session text on the wire");
  }
  assert.equal(JSON.stringify(manifest).includes("secret cover letter"), false, "no payload leaks into the manifest");
  const cv = manifest.sessions.find((s) => s.sid === "cv");
  assert.equal(cv.quarantined, true, "the quarantine flag rides along (a flag, not the content)");
  // and register REJECTS a hand-crafted manifest that smuggled content
  const bad = register({ satellites: {} }, { machine: "asus", sessions: [{ sid: "x", contentHash: "sha256:z", content: "leak" }] }, { key: "k", expectedKey: "k", remoteAddress: "127.0.0.1" });
  assert.equal(bad.ok, false, "a manifest carrying payload is rejected (R31 at the boundary)");
});

test("Scenario: additive route, default unchanged", async () => {
  const api = createEstateApi({ kelLog: null, bus: { publish() {} }, registerKey: "shared" });
  const get = await callRoute(api, "GET", "/api/estate");
  assert.equal(get.status, 200, "the prior estate route still answers");
  assert.ok("summary" in get.body);
  const manifest = buildManifest("asus", [{ sid: "s1", content: "aaa" }]);
  const reg = await callRoute(api, "POST", "/api/estate/register", { manifest, key: "shared" });
  assert.equal(reg.status, 200, "POST /api/estate/register is owned and answers on a valid key");
  assert.equal(reg.body.ok, true);
});

function callRoute(api, method, path, body) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = { method, url: path, socket: { remoteAddress: "127.0.0.1" }, on(ev, cb) { if (ev === "data") chunks.forEach((c) => cb(c)); if (ev === "end") cb(); return req; } };
    let status = 0, raw = "";
    const res = { writeHead(s) { status = s; return res; }, end(d) { raw = d || ""; resolve({ status, body: raw ? JSON.parse(raw) : null }); } };
    if (!api.tryHandle(req, res)) resolve({ status: 0, body: null, owned: false });
  });
}
