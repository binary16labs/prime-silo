// The authorisation invariant (SS1/23 Principle 2).
//
// Before this, a run could complete with a full execution register — commit, model, cost,
// outcome — and still not answer "who approved this?", because approval lived in a button
// press rather than in the log. An unauthorised run and an authorised one were byte-identical
// after the fact.
//
// The invariant that fixes it is one line: ONLY A HUMAN MAY SIGN. Everything below exists
// because that line is worth nothing unless it survives the two ways it actually breaks —
// a builder that accepts `authorship` as a parameter, and a reader that checks a signature
// EXISTS without checking WHO wrote it.
//
// These are positive controls: each proves the check REJECTS something, rather than proving
// it was merely called. "authorised: false" is what a working check reports for an unsigned
// run and exactly what a dead one reports always — so every test here pairs a pass with a
// fail on the same shape.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendKelEvent, readKelEvents } from "../server/coordination/lib/kel.mjs";
import {
  GOVERNANCE_TYPES,
  proposalRaisedEvent,
  proposalSignedEvent,
  proposalDeclinedEvent,
  buildGovernance,
  isAuthorised,
  unauthorisedRuns
} from "../server/coordination/lib/governance.mjs";

const raise = (id, over = {}) =>
  proposalRaisedEvent({
    proposalId: id,
    machine: "t480",
    title: "Add a heartbeat monitor for the Benny mesh",
    rationale: "t480 ran with Benny down for ~12h and nothing surfaced it",
    evidence: ["uptime gap 2026-09-04T22:5x → 2026-09-05T10:36"],
    reversible: true,
    ...over
  });

const sign = (id, over = {}) =>
  proposalSignedEvent({ proposalId: id, machine: "t480", signer: "nsdha", ...over });

test("a signed proposal is authorised — and an unsigned one is not", () => {
  const signed = [raise("p1"), sign("p1")];
  const unsigned = [raise("p2")];

  assert.equal(isAuthorised(signed, "p1"), true);
  // the paired negative: same shape, no signature, must come back false
  assert.equal(isAuthorised(unsigned, "p2"), false);
});

test("the signer builder cannot be talked into a non-human signature", () => {
  // A caller passing authorship must NOT be able to influence it. If this ever regresses,
  // agent self-authorisation becomes one keyword argument away.
  const evt = proposalSignedEvent({
    proposalId: "p3",
    machine: "t480",
    signer: "nsdha",
    authorship: "frontier" // ignored by construction
  });
  assert.equal(evt.authorship, "human");
  assert.equal(evt.type, GOVERNANCE_TYPES.signed);
});

test("a forged frontier-authored signature does not authorise", () => {
  // The builder is safe, so the remaining attack is a hand-written event appended directly.
  // isAuthorised must check WHO signed, not merely that a signature-shaped event exists.
  const forged = { ...sign("p4"), authorship: "frontier" };
  assert.equal(forged.type, GOVERNANCE_TYPES.signed); // it looks exactly like a signature
  assert.equal(isAuthorised([raise("p4"), forged], "p4"), false);

  const genuine = sign("p4");
  assert.equal(isAuthorised([raise("p4"), genuine], "p4"), true);
});

test("an unsigned run is named as the defect; a signed one is not", () => {
  const events = [raise("p5"), sign("p5"), raise("p6")];
  const runs = [
    { run_id: "r-signed", proposal_id: "p5" },
    { run_id: "r-unsigned", proposal_id: "p6" },
    { run_id: "r-orphan" } // ran with no proposal at all
  ];
  const bad = unauthorisedRuns(events, runs);
  assert.deepEqual(bad.map((b) => b.run_id).sort(), ["r-orphan", "r-unsigned"]);
});

test("declining is recorded, and never reads as approval", () => {
  const events = [
    raise("p7"),
    proposalDeclinedEvent({ proposalId: "p7", machine: "t480", signer: "nsdha", reason: "not now" })
  ];
  const state = buildGovernance(events);
  assert.equal(state.declined.length, 1);
  assert.equal(state.signed.length, 0);
  assert.equal(isAuthorised(events, "p7"), false);
});

test("a signature for an unknown proposal authorises nothing in the fold", () => {
  // Guards against a signature arriving out of order or for a deleted proposal quietly
  // creating an approved record with no rationale attached to it.
  const state = buildGovernance([sign("ghost")]);
  assert.equal(state.proposals.length, 0);
});

test("the events are valid KEL envelopes and chain on disk", () => {
  // The schema `type` enum is closed, so this is also the proof that the enum extension
  // landed: appendKelEvent validates before writing and returns ok:false if it did not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-kel-"));
  const log = path.join(dir, "governance.jsonl");
  try {
    for (const evt of [raise("p8"), sign("p8")]) {
      const res = appendKelEvent(log, evt);
      assert.equal(res.ok, true, `rejected: ${res.reason}`);
    }
    const read = readKelEvents(log);
    assert.equal(read.ok, true, "chain must verify");
    assert.equal(read.events.length, 2);
    assert.equal(read.events[0].prev, "genesis");
    assert.equal(isAuthorised(read.events, "p8"), true);

    // tamper: rewrite the first line's payload and the chain must report the break
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    const edited = JSON.parse(lines[0]);
    edited.payload.title = "something else entirely";
    fs.writeFileSync(log, [JSON.stringify(edited), lines[1]].join("\n") + "\n");
    const after = readKelEvents(log);
    assert.equal(after.ok, false);
    assert.equal(after.badLine, 2); // the successor of the edit is where it shows
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bi-temporal fields are honest about precision", () => {
  // steer 8: an unknown valid_time must equal txn_time and be marked inferred, never
  // back-dated to look more precise than the record actually is.
  const inferred = sign("p9");
  assert.equal(inferred.time_confidence, "inferred");
  assert.equal(inferred.valid_time, inferred.txn_time);

  const known = sign("p10", { valid_time: "2026-09-05T09:00:00.000Z" });
  assert.equal(known.time_confidence, "known");
  assert.equal(known.valid_time, "2026-09-05T09:00:00.000Z");
});

test("an unattributed signature is refused outright", () => {
  assert.throws(
    () => proposalSignedEvent({ proposalId: "p11", machine: "t480" }),
    /signer is required/
  );
});
