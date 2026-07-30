// L9 acceptance — privacy-honoring history + keep-both-and-flag conflict.
// Scenarios ↔ delivery/tasks/L9.md gherkin. Hermetic: temp KEL + temp quarantine/journal only.
// Honors the SAME quarantine.json shape ({ sids, updated }) the LONGVIEW teleport tool writes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendKelEvent, readKelEvents } from "../../server/coordination/lib/kel.mjs";
import { rebuild, cardSink } from "../../server/coordination/lib/projector.mjs";
import {
  loadQuarantine,
  quarantineFilter,
  projectWithPrivacy,
  privacyDelete,
  restorePrivacyDeletion
} from "../../server/coordination/lib/privacy_history.mjs";

// --- fixtures ---------------------------------------------------------------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "priv-"));
function card(f, id, payload, { vt, tt = vt, sid, type = "card_asserted", hlc, machine = "t480" }) {
  const r = appendKelEvent(f, {
    id: `evt-${id}-${tt}-${sid}`,
    schema_version: "1.0.0",
    type,
    valid_time: vt,
    txn_time: tt,
    time_confidence: "known",
    hlc: hlc || `${tt}-0000-${machine}`,
    machine,
    authorship: "house",
    sid,
    subject: { kind: "card", id },
    payload
  });
  assert.ok(r.ok, `append failed: ${r.reason}`);
}
const writeQuarantine = (p, sids) =>
  fs.writeFileSync(p, JSON.stringify({ sids, updated: "2026-07-25T00:00:00Z" }));
const D = {
  t0: "2026-01-01T00:00:00Z",
  t1: "2026-02-01T00:00:00Z",
  t2: "2026-03-01T00:00:00Z",
  t3: "2026-04-01T00:00:00Z"
};

// ---------------------------------------------------------------------------
test("Scenario: a teleported sid stays excluded across all valid/txn time", () => {
  const dir = tmp();
  const f = path.join(dir, "events.jsonl");
  const q = path.join(dir, "quarantine.json");
  card(f, "keep", { text: "public" }, { vt: D.t0, sid: "goodsid1" });
  card(f, "secret", { text: "private" }, { vt: D.t0, sid: "teleported1" });
  writeQuarantine(q, ["teleported1"]);

  // at NO bi-temporal point does the teleported sid's subject appear.
  for (const asOf of [undefined, D.t0, D.t1, D.t3]) {
    const { store } = projectWithPrivacy(f, { quarantineFile: q, asOfValidTime: asOf });
    assert.deepEqual(store, { keep: { text: "public" } }, `leaked at validTime=${asOf}`);
    const { store: byTxn } = projectWithPrivacy(f, { quarantineFile: q, asOfTxnTime: asOf });
    assert.ok(!("secret" in byTxn), `leaked at txnTime=${asOf}`);
  }
  // and the raw (ungoverned) rebuild WOULD have shown it — proving the filter is doing the work.
  assert.ok("secret" in rebuild(f, { sink: cardSink }));
});

test("Scenario: a privacy deletion is reversible, not erased (tombstone + journal)", () => {
  const dir = tmp();
  const f = path.join(dir, "events.jsonl");
  const journal = path.join(dir, "privacy-journal.jsonl");
  card(f, "cardA", { text: "sensitive" }, { vt: D.t0, tt: D.t0, sid: "s1" });
  assert.deepEqual(rebuild(f, { sink: cardSink }), { cardA: { text: "sensitive" } });

  const rawLinesBefore = fs.readFileSync(f, "utf8");
  const del = privacyDelete(f, journal, {
    subjectId: "cardA",
    sid: "s1",
    reason: "gdpr-erasure",
    machine: "t480"
  });
  assert.ok(del.ok);

  // projection no longer shows it...
  assert.deepEqual(rebuild(f, { sink: cardSink }), {});
  // ...but nothing was hard-erased: the original assertion line is still in the append-only log,
  const rawAfter = fs.readFileSync(f, "utf8");
  assert.ok(rawAfter.startsWith(rawLinesBefore), "original KEL lines must not be rewritten/erased");
  assert.ok(readKelEvents(f).ok, "chain intact after tombstone append");
  // ...and the deleted payload is journalled (restorable).
  const journalled = fs
    .readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(journalled.at(-1).subject_id, "cardA");
  assert.deepEqual(journalled.at(-1).payload, { text: "sensitive" });

  // restore brings it back (reversible).
  const res = restorePrivacyDeletion(f, journal, { subjectId: "cardA", machine: "t480" });
  assert.ok(res.ok);
  assert.deepEqual(rebuild(f, { sink: cardSink }), { cardA: { text: "sensitive" } });
});

test("Scenario: contradictory facts at the same valid_time are kept AND flagged (never auto-picked)", () => {
  const dir = tmp();
  const f = path.join(dir, "events.jsonl");
  const q = path.join(dir, "quarantine.json");
  const review = path.join(dir, "review.jsonl");
  writeQuarantine(q, []);
  // two events assert contradictory facts about the SAME subject at the SAME valid_time.
  card(
    f,
    "fact",
    { claim: "the sky is blue" },
    { vt: D.t1, tt: D.t1, sid: "sA", hlc: `${D.t1}-0000-t480` }
  );
  card(
    f,
    "fact",
    { claim: "the sky is green" },
    { vt: D.t1, tt: D.t2, sid: "sB", hlc: `${D.t2}-0000-t480` }
  );

  const { store, conflicts } = projectWithPrivacy(f, { quarantineFile: q, reviewLog: review });

  // BOTH are present under a conflict marker; neither silently wins.
  assert.equal(store.fact.conflict, true);
  const claims = store.fact.candidates.map((c) => c.claim).sort();
  assert.deepEqual(claims, ["the sky is blue", "the sky is green"]);
  assert.ok(!("claim" in store.fact), "must not collapse to a single auto-picked payload");

  // a conflict_flagged REVIEW event is emitted (surfaced for a human, not resolved here).
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].subject_id, "fact");
  const reviewEvents = readKelEvents(review).events.filter((e) => e.type === "conflict_flagged");
  assert.equal(reviewEvents.length, 1);
  assert.equal(reviewEvents[0].subject.id, "fact");
});

test("non-conflicting subjects still fold normally (guard is not over-broad)", () => {
  const dir = tmp();
  const f = path.join(dir, "events.jsonl");
  const q = path.join(dir, "quarantine.json");
  writeQuarantine(q, []);
  // same subject, DIFFERENT valid_times = a correction over time, NOT a conflict.
  card(f, "cardA", { v: 1 }, { vt: D.t0, tt: D.t0, sid: "s1" });
  card(f, "cardA", { v: 2 }, { vt: D.t2, tt: D.t2, sid: "s1" });
  const { store, conflicts } = projectWithPrivacy(f, { quarantineFile: q });
  assert.deepEqual(store, { cardA: { v: 2 } }); // latest valid-time wins, no conflict marker
  assert.equal(conflicts.length, 0);
});

test("loadQuarantine + quarantineFilter honor the { sids } shape", () => {
  const dir = tmp();
  const q = path.join(dir, "quarantine.json");
  writeQuarantine(q, ["x1", "x2"]);
  const { sids } = loadQuarantine(q);
  assert.ok(sids.has("x1") && sids.has("x2"));
  const keep = quarantineFilter(q);
  assert.equal(keep({ sid: "x1" }), false);
  assert.equal(keep({ sid: "other" }), true);
  // a missing file is treated as an empty quarantine (fail-open on read, not a crash).
  const keep2 = quarantineFilter(path.join(dir, "nope.json"));
  assert.equal(keep2({ sid: "anything" }), true);
});
