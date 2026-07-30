// N6 acceptance — next-cycle flywheel planner. Every Scenario in delivery/tasks/N6.md maps to a
// named test. planNextCycle is a pure projection over injected fixtures (drift + dataset manifest
// + eval numbers) — no fs, no network, no LM host. The additive-route scenario exercises estate_api.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planNextCycle } from "../../server/coordination/lib/estate_plan.mjs";
import { createEstateApi } from "../../server/coordination/lib/estate_api.mjs";

const MANIFEST = {
  source: { a_v3: { jsoncards: 188 } },
  streams: { A: { train: 1741, eval: 301 }, B: { train: 4201, eval: 799 } },
  total_rows: 7042,
  generated: "2026-07-24T05:48:41.060Z"
};
const EVAL = { a_pct: -38.3, b_pct: -70.5, agg_pct: -57 };

test("Scenario: project the next turn from drift", () => {
  const p = planNextCycle({ cleanCount: 20 }, MANIFEST, EVAL, { thinRate: 0.1 });
  assert.equal(p.newSessions, 20);
  assert.equal(p.projectedCards, 18, "20 clean sessions minus a 10% thin rate ~= 18 cards");
  assert.ok(p.projectedStreamARows > 0, "cards project to a positive Stream-A row estimate");
});

test("Scenario: recommend rebuild when the threshold is crossed", () => {
  // 210 cards now vs 188 baked into the last build -> 22 new since build >= 20 threshold
  const p = planNextCycle({ cleanCount: 0 }, MANIFEST, EVAL, {
    cardsNow: 210,
    rebuildThreshold: 20
  });
  assert.equal(p.newCardsSinceBuild, 22);
  assert.equal(p.crossesRebuildThreshold, true);
  assert.equal(p.recommendedAction, "rebuild");
  assert.match(p.reason, /Stream A/, "the reason names the Stream-A data gap");
});

test("Scenario: the projection is read-only and shareable", () => {
  const p = planNextCycle({ cleanCount: 5 }, MANIFEST, EVAL, {
    thinRate: 0.2,
    cardsNow: 190,
    rebuildThreshold: 20
  });
  // shape matches the :8788 flywheel block's contract so both surfaces agree
  for (const k of [
    "newSessions",
    "projectedCards",
    "projectedStreamARows",
    "cardsAtBuild",
    "newCardsSinceBuild",
    "crossesRebuildThreshold",
    "recommendedAction",
    "reason"
  ]) {
    assert.ok(k in p, `projection carries ${k}`);
  }
  // pure/deterministic: same inputs -> same output, no side effects
  const again = planNextCycle({ cleanCount: 5 }, MANIFEST, EVAL, {
    thinRate: 0.2,
    cardsNow: 190,
    rebuildThreshold: 20
  });
  assert.deepEqual(p, again);
  assert.equal(
    p.recommendedAction,
    "map",
    "pending clean sessions but under threshold -> map, not rebuild"
  );
});

test("Scenario: additive route, default unchanged", async () => {
  const api = createEstateApi({ kelLog: null, bus: { publish() {} } });
  const get = await callRoute(api, "GET", "/api/estate");
  assert.equal(get.status, 200, "the prior estate route still answers");
  assert.ok("summary" in get.body);
  // the new plan route is owned by the estate api (returns 200 with a projection or a null shape)
  const plan = await callRoute(api, "GET", "/api/estate/plan");
  assert.equal(plan.status, 200, "GET /api/estate/plan is owned and answers");
  assert.ok(
    "recommendedAction" in plan.body || plan.body.present === false,
    "plan returns a projection or an honest absent shape"
  );
});

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
    if (!api.tryHandle(req, res)) resolve({ status: 0, body: null, owned: false });
  });
}
