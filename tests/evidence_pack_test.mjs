// The evidence pack — and its refusal to overstate.
//
// Everything else in the coordination layer produces evidence; this is the thing that hands
// it to a reviewer. Which makes its most important property a negative one: it must not
// report a clean bill of health it has not earned.
//
// Two of the four closure defects are computable from the ledgers today (unauthorised runs,
// broken chains) and two are not, because nothing yet enumerates deliverables or state
// changes to compare against. A pack that silently dropped the unmeasured pair would show
// all green — and would be exactly the kind of false assurance an audit exists to catch.
//
// So the tests below are mostly about what the pack REFUSES to say.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidencePack,
  renderPack,
  collectLedgers
} from "../server/coordination/lib/evidence.mjs";
import {
  proposalRaisedEvent,
  proposalSignedEvent
} from "../server/coordination/lib/governance.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ledger = (name, events, ok = true, badLine = null) => ({
  file: `eventlog/${name}.jsonl`,
  name,
  ok,
  badLine,
  reason: ok ? null : "chain-break",
  events
});

test("unmeasured defects are never reported as a pass", () => {
  // The load-bearing negative. Chains verify, nothing is wrong with what we CAN see — and
  // the pack still must not call itself complete.
  const pack = buildEvidencePack([ledger("clean", [])]);
  assert.equal(pack.verdict.measured_clean, true, "what is measured is clean");
  assert.equal(pack.verdict.complete, false, "but complete requires measuring everything");
  assert.equal(pack.verdict.unmeasured, 3);

  const md = renderPack(pack);
  assert.match(md, /NOT YET MEASURABLE/);
  assert.doesNotMatch(md, /\*\*Complete\.\*\*/);
});

test("everything measured and zero is the only way to be complete", () => {
  const events = [
    proposalRaisedEvent({ proposalId: "p1", machine: "t480", title: "do a thing" }),
    proposalSignedEvent({ proposalId: "p1", machine: "t480", signer: "nsdha" })
  ];
  // supplying a run inventory makes defect 1 measurable
  const pack = buildEvidencePack([ledger("gov", events)], {
    runs: [{ run_id: "r1", proposal_id: "p1" }]
  });
  const unauth = pack.defects.find((d) => d.id === "unauthorised-run");
  assert.equal(unauth.state, "measured");
  assert.equal(unauth.count, 0);
  // still not complete: two defects remain structurally unmeasurable
  assert.equal(pack.verdict.complete, false);
  assert.equal(pack.verdict.unmeasured, 2);
});

test("a run with no human signature is named, not summarised away", () => {
  const events = [proposalRaisedEvent({ proposalId: "p2", machine: "t480", title: "unsigned" })];
  const pack = buildEvidencePack([ledger("gov", events)], {
    runs: [{ run_id: "r-good", proposal_id: "p2" }, { run_id: "r-orphan" }]
  });
  const unauth = pack.defects.find((d) => d.id === "unauthorised-run");
  assert.equal(unauth.count, 2, "an unsigned proposal and a run with none at all both count");
  assert.match(unauth.note, /r-good/);
  assert.match(unauth.note, /r-orphan/);
});

test("a broken chain is counted as a defect and its events are excluded", () => {
  const good = [proposalRaisedEvent({ proposalId: "p3", machine: "t480", title: "kept" })];
  const bad = [proposalRaisedEvent({ proposalId: "p4", machine: "t480", title: "dropped" })];
  const pack = buildEvidencePack([ledger("good", good), ledger("bad", bad, false, 7)]);

  const chain = pack.defects.find((d) => d.id === "broken-chain");
  assert.equal(chain.state, "measured");
  assert.equal(chain.count, 1);
  assert.match(chain.note, /@7/);
  assert.equal(pack.verdict.measured_clean, false);
  // the tampered ledger's proposal must not appear in the governance summary
  assert.equal(pack.governance.proposals, 1);
});

test("signatures are listed with who and when, not just a count", () => {
  // A count is not evidence. "signed by nsdha at 2026-09-05T…" is.
  const events = [
    proposalRaisedEvent({ proposalId: "p5", machine: "t480", title: "add a heartbeat" }),
    proposalSignedEvent({ proposalId: "p5", machine: "t480", signer: "nsdha" })
  ];
  const pack = buildEvidencePack([ledger("gov", events)]);
  assert.equal(pack.governance.signed, 1);
  assert.equal(pack.governance.signatures[0].signer, "nsdha");
  assert.match(renderPack(pack), /signed by nsdha/);
});

test("collectLedgers verifies each file separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evi-"));
  try {
    const dir = path.join(root, "eventlog");
    fs.mkdirSync(dir, { recursive: true });
    // a deliberately corrupt chain: second line's prev will not match
    fs.writeFileSync(
      path.join(dir, "broken.jsonl"),
      JSON.stringify({ id: "1", type: "x", subject: { id: "s" }, prev: "genesis" }) +
        "\n" +
        JSON.stringify({ id: "2", type: "x", subject: { id: "s" }, prev: "nope" }) +
        "\n"
    );
    const ledgers = collectLedgers(root);
    assert.equal(ledgers.length, 1);
    assert.equal(ledgers[0].ok, false);
    assert.equal(ledgers[0].badLine, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
