// L0 acceptance — knowledge event log (KEL). Scenarios map 1:1 to delivery/tasks/L0.md gherkin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ulid,
  validateKelEvent,
  appendKelEvent,
  readKelEvents,
  foldProjection,
  CURRENT_SCHEMA_VERSION
} from "../../server/coordination/lib/kel.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kel-"));
const logfile = () => path.join(tmp(), "events.jsonl");

function evt(over = {}) {
  return {
    id: over.id ?? ulid(),
    schema_version: "1.0.0",
    type: "card_asserted",
    valid_time: "2022-01-01T00:00:00Z",
    txn_time: "2022-01-02T00:00:00Z",
    time_confidence: "known",
    hlc: "2022-01-02T00:00:00.000Z-0000-t480",
    machine: "t480",
    authorship: "house",
    sid: "sess_1",
    subject: { kind: "card", id: "card:X" },
    payload: {},
    ...over
  };
}

test("Scenario: a correction never mutates history", () => {
  const f = logfile();
  appendKelEvent(f, evt({ id: "E1", txn_time: "2022-01-02T00:00:00Z", payload: { v: 1 } }));
  appendKelEvent(
    f,
    evt({ id: "E2", txn_time: "2022-03-01T00:00:00Z", supersedes: ["E1"], payload: { v: 2 } })
  );
  const { ok, events } = readKelEvents(f);
  assert.equal(ok, true);

  // folding now yields the correction E2
  const now = foldProjection(events);
  assert.equal(now.get("card:X").event.id, "E2");

  // folding as-of the earlier transaction time still yields E1
  const past = foldProjection(events, { asOfTxnTime: "2022-01-02T00:00:00Z" });
  assert.equal(past.get("card:X").event.id, "E1");

  // E1's raw line on disk is unchanged (append-only, never mutated)
  const firstLine = fs.readFileSync(f, "utf8").split("\n")[0];
  assert.equal(JSON.parse(firstLine).id, "E1");
});

test("Scenario: the chain betrays an edited historical line", () => {
  const f = logfile();
  appendKelEvent(f, evt({ id: "A" }));
  appendKelEvent(f, evt({ id: "B" }));
  appendKelEvent(f, evt({ id: "C" }));

  // tamper with the first historical line
  const lines = fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const doctored = JSON.parse(lines[0]);
  doctored.machine = "evil-box";
  lines[0] = JSON.stringify(doctored);
  fs.writeFileSync(f, lines.join("\n") + "\n");

  const r = readKelEvents(f);
  assert.equal(r.ok, false);
  // the successor line (2) is the one whose prev-hash no longer matches
  assert.equal(r.badLine, 2);
});

test("Scenario: bi-temporal queries are answerable", () => {
  const f = logfile();
  // true-from 2020, recorded 2021
  appendKelEvent(
    f,
    evt({
      id: "Ea",
      subject: { kind: "card", id: "card:Y" },
      valid_time: "2020-01-01T00:00:00Z",
      txn_time: "2021-01-01T00:00:00Z"
    })
  );
  // corrected: true-from 2022, recorded 2023
  appendKelEvent(
    f,
    evt({
      id: "Eb",
      subject: { kind: "card", id: "card:Y" },
      valid_time: "2022-01-01T00:00:00Z",
      txn_time: "2023-01-01T00:00:00Z"
    })
  );
  const { events } = readKelEvents(f);

  // what was TRUE at valid-time 2021 → only Ea (Eb's valid-time is 2022)
  assert.equal(
    foldProjection(events, { asOfValidTime: "2021-06-01T00:00:00Z" }).get("card:Y").event.id,
    "Ea"
  );
  // what did we KNOW at txn-time 2022 → only Ea (Eb recorded 2023)
  assert.equal(
    foldProjection(events, { asOfTxnTime: "2022-06-01T00:00:00Z" }).get("card:Y").event.id,
    "Ea"
  );
  // now → the correction
  assert.equal(foldProjection(events).get("card:Y").event.id, "Eb");
});

test("Scenario: an out-of-version record still replays", () => {
  const e = evt({
    subject: { kind: "card", id: "card:Z" },
    schema_version: "1.0.0",
    payload: { a: 1 }
  });
  const converters = {
    "1.0.0->1.1.0": (x) => ({ ...x, payload: { ...x.payload, upconverted: true } })
  };
  const proj = foldProjection([e], { converters, target: "1.1.0" });
  const rec = proj.get("card:Z");
  assert.equal(rec.payload.upconverted, true);
  assert.equal(rec.event.schema_version, "1.1.0");
});

test("Scenario: a write failure never raises (non-blocking, G0 rule)", () => {
  // make the log path a directory → appendFileSync will fail
  const dir = tmp();
  const f = path.join(dir, "events.jsonl");
  fs.mkdirSync(f);
  let warned = 0;
  const r = appendKelEvent(f, evt(), { logger: { warn: () => warned++ } });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(warned, 1);
});

test("envelope: a missing required field is rejected", () => {
  const bad = evt();
  delete bad.authorship;
  const v = validateKelEvent(bad);
  assert.equal(v.ok, false);
  assert.match(v.reason, /authorship/);
  // append rejects it too (not degraded — a validation failure, not I/O)
  const r = appendKelEvent(logfile(), bad);
  assert.equal(r.ok, false);
  assert.notEqual(r.degraded, true);
});

test("envelope: a bad enum value is rejected", () => {
  assert.equal(validateKelEvent(evt({ authorship: "alien" })).ok, false);
  assert.equal(validateKelEvent(evt({ time_confidence: "maybe" })).ok, false);
  assert.equal(validateKelEvent(evt()).ok, true);
  assert.equal(CURRENT_SCHEMA_VERSION, "1.0.0");
});
