// N5 acceptance — governed approve-to-sync. Every Scenario in delivery/tasks/N5.md maps to a
// named test. estate_govern is pure logic over injected deps (a spy syncSource + bus), so the
// gate is hermetic — no real fs/network. The additive-route scenario exercises estate_api.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proposeSync,
  signProposal,
  applySync
} from "../../server/coordination/lib/estate_govern.mjs";
import { createEstateApi } from "../../server/coordination/lib/estate_api.mjs";

// A spy syncSource that mimics L4 idempotence: content seen once is not "new" again.
function makeSyncSpy() {
  const seen = new Set();
  const calls = [];
  const fn = (kelLog, stagingRoot, source) => {
    calls.push((source.sessions || []).map((s) => s.sid));
    const fresh = (source.sessions || []).filter((s) => !seen.has(s.content ?? s.sid));
    fresh.forEach((s) => seen.add(s.content ?? s.sid));
    return { sessionsNew: fresh.length };
  };
  return { fn, calls };
}
function makeBus() {
  const events = [];
  return { events, publish: (topic, ev) => events.push({ topic, ev }) };
}

test("Scenario: no sync without an owner signature", () => {
  const spy = makeSyncSpy();
  const bus = makeBus();
  const proposal = proposeSync(
    { clean: ["s1", "s2"], quarantined: { count: 0 } },
    { satellite: "asus" }
  );
  assert.equal(proposal.approved, false, "a fresh proposal is never auto-approved");
  const r = applySync(
    proposal,
    { machine: "asus", driveLabel: "claude", sessions: [{ sid: "s1", content: "a" }] },
    { syncSource: spy.fn, bus }
  );
  assert.equal(r.applied, false, "an unapproved proposal moves nothing");
  assert.equal(spy.calls.length, 0, "syncSource is never invoked");
  assert.equal(bus.events.length, 0, "no approval event is emitted");
});

test("Scenario: approved sync stages only the clean delta, idempotently", () => {
  const spy = makeSyncSpy();
  const bus = makeBus();
  const signed = signProposal(
    proposeSync({ clean: ["s1", "s2"], quarantined: { count: 0 } }, { satellite: "asus" }),
    "darkhorse 2026-07-28"
  );
  const source = {
    machine: "asus",
    driveLabel: "claude",
    sessions: [
      { sid: "s1", content: "a" },
      { sid: "s2", content: "b" },
      { sid: "sX", content: "x" }
    ]
  };
  const r1 = applySync(signed, source, { syncSource: spy.fn, bus });
  assert.deepEqual(
    spy.calls[0].sort(),
    ["s1", "s2"],
    "only the clean sids are staged (sX excluded)"
  );
  assert.equal(r1.syncResult.sessionsNew, 2, "first run stages both clean sessions");
  assert.equal(bus.events.length, 1, "exactly one approval event on a real sync");
  const r2 = applySync(signed, source, { syncSource: spy.fn, bus });
  assert.equal(r2.syncResult.sessionsNew, 0, "re-apply stages nothing (idempotent via the cursor)");
  assert.equal(r2.noop, true, "the second run is a no-op");
  assert.equal(bus.events.length, 1, "no second event — a no-op emits nothing");
});

test("Scenario: a quarantined sid can never enter a proposal", () => {
  // even if the drift's clean list erroneously carried a quarantined sid, proposeSync drops it (R31 defense-in-depth)
  const p = proposeSync(
    { clean: ["s1", "q"], quarantined: { count: 1 } },
    { satellite: "asus", quarantine: ["q"] }
  );
  assert.deepEqual(p.clean, ["s1"], "the quarantined sid is excluded from the proposal");
  assert.equal(p.privacy.attested, true, "the proposal carries a privacy attestation");
  assert.equal(
    JSON.stringify(p).includes('"q"'),
    false,
    "no quarantined sid appears anywhere in the proposal"
  );
  assert.ok(p.privacy.quarantinedExcluded >= 1, "the attestation counts the exclusion");
});

test("Scenario: additive route, default unchanged", async () => {
  const api = createEstateApi({ kelLog: null, bus: makeBus(), syncSource: makeSyncSpy().fn });
  // prior route still answers exactly as before
  const get = await callRoute(api, "GET", "/api/estate");
  assert.equal(get.status, 200);
  assert.ok("summary" in get.body, "GET /api/estate still returns the estate + summary");
  // the new propose route is owned by the estate api
  const prop = await callRoute(api, "POST", "/api/estate/sync/propose", {
    delta: { clean: ["s1"], quarantined: { count: 0 } },
    satellite: "asus"
  });
  assert.equal(prop.status, 200);
  assert.equal(prop.body.approved, false, "propose returns an unapproved proposal");
  assert.deepEqual(prop.body.clean, ["s1"]);
});

// Minimal mock req/res to exercise tryHandle without a live server.
function callRoute(api, method, path, body) {
  return new Promise((resolve) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      url: path,
      on(ev, cb) {
        if (ev === "data") chunks.forEach((c) => cb(c));
        if (ev === "end") cb();
        return req;
      }
    };
    let status = 0,
      raw = "";
    const res = {
      writeHead(s) {
        status = s;
        return res;
      },
      end(d) {
        raw = d || "";
        resolve({ status, body: raw ? JSON.parse(raw) : null });
      }
    };
    const owned = api.tryHandle(req, res);
    if (!owned) resolve({ status: 0, body: null, owned: false });
  });
}
