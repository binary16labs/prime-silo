// L8 acceptance — bi-temporal projectors + time-travel query.
// Scenarios ↔ delivery/tasks/L8.md gherkin. Hermetic: temp KEL fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendKelEvent, readKelEvents } from "../../server/coordination/lib/kel.mjs";
import {
  rebuild,
  cardSink,
  graphSink,
  projectionHash,
  reprojectIncremental
} from "../../server/coordination/lib/projector.mjs";
import {
  queryValidTime,
  queryTxnTime,
  computeWatermark,
  reconstructCorpus
} from "../../server/coordination/lib/timetravel.mjs";
import { processDelta } from "../../server/coordination/lib/delta.mjs";

// --- fixture helpers -------------------------------------------------------
const logfile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")), "events.jsonl");

// A card_asserted KEL event for `id`, true-at `vt`, recorded-at `tt`.
function assertCard(
  f,
  id,
  payload,
  { vt, tt = vt, hlc, type = "card_asserted", machine = "t480" }
) {
  const r = appendKelEvent(f, {
    id: `evt-${id}-${tt}`,
    schema_version: "1.0.0",
    type,
    valid_time: vt,
    txn_time: tt,
    time_confidence: "known",
    hlc: hlc || `${tt}-0000-${machine}`,
    machine,
    authorship: "house",
    sid: `sess-${id}`,
    subject: { kind: "card", id },
    payload
  });
  assert.ok(r.ok, `append failed: ${r.reason}`);
  return r;
}

const D = {
  t0: "2026-01-01T00:00:00Z",
  t1: "2026-02-01T00:00:00Z",
  t2: "2026-03-01T00:00:00Z",
  t3: "2026-04-01T00:00:00Z"
};

// ---------------------------------------------------------------------------
test("Scenario: a projection rebuilds from the log alone (rebuildable = replay)", () => {
  const f = logfile();
  assertCard(f, "cardA", { text: "alpha" }, { vt: D.t0 });
  assertCard(f, "cardB", { text: "beta" }, { vt: D.t1 });

  const first = rebuild(f, { sink: cardSink });
  const before = projectionHash(first);
  // delete the projection (there is no store but the hash) and re-fold: identical.
  const second = rebuild(f, { sink: cardSink });
  assert.equal(projectionHash(second), before);
  assert.deepEqual(second, { cardA: { text: "alpha" }, cardB: { text: "beta" } });
});

test("Scenario: what was true at T (valid-time) ignores later corrections", () => {
  const f = logfile();
  // world: cardA was "v1" true from t0; a correction says it became "v2" true from t2.
  assertCard(f, "cardA", { text: "v1" }, { vt: D.t0 });
  assertCard(f, "cardA", { text: "v2" }, { vt: D.t2 });

  // as of valid_time t1 (between the two), the world still held v1.
  const atT1 = queryValidTime(f, D.t1);
  assert.deepEqual(atT1, { cardA: { text: "v1" } });
  // as of valid_time t3, the later truth holds.
  const atT3 = queryValidTime(f, D.t3);
  assert.deepEqual(atT3, { cardA: { text: "v2" } });
});

test("Scenario: what did we know at T (transaction-time)", () => {
  const f = logfile();
  // cardC was true-in-world at t0, but we only RECORDED it at t2.
  assertCard(f, "cardC", { text: "known-late" }, { vt: D.t0, tt: D.t2 });

  // at txn_time t1 we had not yet recorded it → empty knowledge.
  assert.deepEqual(queryTxnTime(f, D.t1), {});
  // at txn_time t2 we knew it.
  assert.deepEqual(queryTxnTime(f, D.t2), { cardC: { text: "known-late" } });
});

test("Scenario: reconstruct the exact corpus a model trained on (knowledge_watermark)", () => {
  const f = logfile();
  assertCard(f, "cardA", { text: "alpha" }, { vt: D.t0, tt: D.t0 });
  assertCard(f, "cardB", { text: "beta" }, { vt: D.t1, tt: D.t1 });

  // A training run at txn_time t1 stamps its knowledge_watermark over the inputs it saw.
  const watermark = computeWatermark(f, { asOfValidTime: D.t1, asOfTxnTime: D.t1 });
  const execRecord = {
    exec_id: "01J-train",
    kind: "train",
    config: { knowledge_watermark: watermark }
  };

  // Later events land AFTER the run — reconstruction must not include them.
  assertCard(f, "cardC", { text: "gamma" }, { vt: D.t2, tt: D.t2 });

  const { store, verified } = reconstructCorpus(f, execRecord);
  assert.equal(verified, true);
  assert.deepEqual(store, { cardA: { text: "alpha" }, cardB: { text: "beta" } });
  // the corpus hash equals the watermark's committed content hash.
  assert.equal("sha256:" + projectionHash(store), watermark.split("|").pop());
});

test("Scenario: a change reprojects incrementally (only affected records, via L4 cursors)", () => {
  const f = logfile();
  // three sessions build the initial store.
  assertCard(f, "cardA", { text: "alpha" }, { vt: D.t0, tt: D.t0 });
  assertCard(f, "cardB", { text: "beta" }, { vt: D.t0, tt: D.t0 });
  assertCard(f, "cardC", { text: "gamma" }, { vt: D.t0, tt: D.t0 });
  const full0 = rebuild(f, { sink: cardSink });
  assert.equal(Object.keys(full0).length, 3);

  // ONE session changes: cardB gets a new assertion (later txn_time).
  assertCard(f, "cardB", { text: "beta-2" }, { vt: D.t2, tt: D.t2 });

  // L4 cursor picks the changed input: only cardB's session is "not done".
  const CFG = { stage: "project", codeCommit: "c1", configHash: "cfg1" };
  processDelta(f, [{ content_hash: "sess-cardA" }, { content_hash: "sess-cardC" }], CFG); // pre-mark A,C done
  const changed = [];
  processDelta(
    f,
    [
      { content_hash: "sess-cardA" },
      { content_hash: "sess-cardB" },
      { content_hash: "sess-cardC" }
    ],
    {
      ...CFG,
      run: (i) => {
        changed.push(i.content_hash);
        return [];
      }
    }
  );
  assert.deepEqual(changed, ["sess-cardB"]); // only the changed session is reprocessed

  // reproject only the changed session's events onto the prior store.
  const { events } = readKelEvents(f);
  const changedEvents = events.filter(
    (e) => e.type === "card_asserted" && e.sid === "sess-cardB" && e.txn_time === D.t2
  );
  const { store, touched } = reprojectIncremental(full0, changedEvents);
  assert.deepEqual(touched, ["cardB"]); // only cardB rebuilt, not the whole store
  // and the incremental result equals a full rebuild from the log.
  assert.deepEqual(store, rebuild(f, { sink: cardSink }));
  assert.deepEqual(store, {
    cardA: { text: "alpha" },
    cardB: { text: "beta-2" },
    cardC: { text: "gamma" }
  });
});

test("corpus reconstruction REJECTS a tampered watermark (integrity is enforced, not decorative)", () => {
  const f = logfile();
  assertCard(f, "cardA", { text: "alpha" }, { vt: D.t0, tt: D.t0 });
  const watermark = computeWatermark(f, { asOfValidTime: D.t1, asOfTxnTime: D.t1 });

  // flip one hex char of the committed content hash → reconstruction must throw, never silently pass.
  const tampered = watermark.slice(0, -1) + (watermark.endsWith("0") ? "1" : "0");
  assert.throws(
    () => reconstructCorpus(f, { config: { knowledge_watermark: tampered } }),
    /mismatch/,
    "a tampered watermark must be rejected"
  );
  // a missing watermark is also refused, not treated as 'reconstruct everything'.
  assert.throws(
    () => reconstructCorpus(f, { config: {} }),
    /knowledge_watermark/,
    "a missing watermark must be rejected"
  );
  // the genuine watermark still reconstructs cleanly (guard is not over-broad).
  assert.equal(reconstructCorpus(f, { config: { knowledge_watermark: watermark } }).verified, true);
});

test("projection-sink interface is plug-and-play (cards reference; graph adapter conforms)", () => {
  const f = logfile();
  assertCard(f, "cardA", { text: "alpha", concepts: ["x"] }, { vt: D.t0 });
  // the same fold drives a different sink shape without touching the engine.
  const g = rebuild(f, { sink: graphSink });
  assert.ok(Array.isArray(g.nodes) && g.nodes.some((n) => n.id === "cardA"));
});

test("tombstone removes a subject from the projection at that txn_time", () => {
  const f = logfile();
  assertCard(f, "cardA", { text: "alpha" }, { vt: D.t0, tt: D.t0 });
  assertCard(f, "cardA", {}, { vt: D.t2, tt: D.t2, type: "tombstoned" });
  assert.deepEqual(queryTxnTime(f, D.t1), { cardA: { text: "alpha" } }); // before deletion
  assert.deepEqual(rebuild(f, { sink: cardSink }), {}); // after deletion, gone
});
