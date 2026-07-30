// Data-plan v3 builders — red-first tests (docs/train/DATA-PLAN-v3.md).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  jsonCardToPairs,
  logToPairs,
  contractToPairs,
  docToPairs,
  proseToPairs,
  thoughtToPairs
} from "../lib/streams_v3.mjs";
import { readJsonCards } from "../lib/corpus_v3.mjs";
import { validateRowA } from "../lib/schema.mjs";

test("readJsonCards: loads sessions_v1-style JSON cards and drops quarantined sids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3v3_cards_"));
  fs.mkdirSync(path.join(dir, "cards"));
  fs.writeFileSync(
    path.join(dir, "cards", "aaaa1111.json"),
    JSON.stringify({
      project: "prime-silo",
      intent: "Fix the router",
      decisions: ["kept it additive"]
    })
  );
  fs.writeFileSync(
    path.join(dir, "cards", "bbbb2222.json"),
    JSON.stringify({ project: "jobs", intent: "secret personal work" })
  );
  fs.writeFileSync(path.join(dir, "quarantine.json"), JSON.stringify({ sids: ["bbbb2222"] }));
  const cards = readJsonCards(dir);
  assert.equal(cards.length, 1, "quarantined card must be dropped structurally");
  assert.equal(cards[0].sid, "aaaa1111");
});

test("jsonCardToPairs: intent/decisions -> valid Stream A pair", () => {
  const p = jsonCardToPairs({
    sid: "aaaa1111",
    project: "prime-silo",
    intent: "Fix the pypes planner for local models",
    applications: ["benny"],
    capabilities: ["planning"],
    decisions: ["strategy flag added", "auto picks incremental for local models"]
  });
  assert.equal(p.length, 1);
  const v = validateRowA(p[0]);
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(p[0].source.type, "jsoncard");
  assert.match(p[0].instruction, /pypes planner/i);
  assert.match(p[0].response, /strategy flag added/);
});

test("logToPairs: a LOG line becomes a method pair; author/verify noise lines skipped", () => {
  const good = logToPairs({
    ts: "2026-07-06T08:45:00Z",
    id: "A8",
    event: "authored",
    agent: "claude",
    note: "Root cause of overnight ingest loop (40/161 stuck): default-role model resolution falls through to lemonade catalog models[0] -> two engines evict each other per call; 4h client timeout hid each failure. Contract A8 authored (roulette kill, run affinity, 600s timeouts, per-card checkpoint)."
  });
  assert.equal(good.length, 1);
  assert.ok(validateRowA(good[0]).ok);
  assert.equal(good[0].source.type, "log");
  assert.match(good[0].response, /root cause/i);
  // short/mechanical notes carry no method — skipped
  const noise = logToPairs({
    ts: "t",
    id: "B0",
    event: "claimed",
    agent: "claude",
    note: "topmost READY per protocol"
  });
  assert.equal(noise.length, 0);
});

test("contractToPairs: Goal + gherkin become two pairs", () => {
  const md = [
    "---",
    "id: X1",
    "---",
    "",
    "# X1 — Example task",
    "",
    "## Goal",
    "Prove the widget end-to-end with a number, not a claim.",
    "",
    "## TDD plan",
    "1. gate red first",
    "",
    "## Acceptance (BDD)",
    "```gherkin",
    "Feature: honest widget",
    "  Scenario: it works",
    "    Given a widget",
    "    Then it is measured",
    "```"
  ].join("\n");
  const pairs = contractToPairs({ id: "X1", body: md });
  assert.equal(pairs.length, 2);
  for (const p of pairs) assert.ok(validateRowA(p).ok, validateRowA(p).errors.join("; "));
  assert.match(pairs[0].response, /number, not a claim/);
  assert.match(pairs[1].response, /Scenario: it works/);
  assert.equal(pairs[1].source.type, "contract");
});

test("docToPairs + proseToPairs: sectioned markdown -> chunked pairs", () => {
  const doc = docToPairs({
    id: "OPERATING_MANUAL",
    title: "Operating manual",
    sections: { "How we verify": "Author never verifies their own task. ".repeat(10) }
  });
  assert.ok(doc.length >= 1);
  assert.equal(doc[0].source.type, "doc");
  assert.ok(validateRowA(doc[0]).ok);

  const prose = proseToPairs({
    id: "dossier-agent-os",
    title: "agent-os-dashboard",
    sections: { Trajectory: "The project began with stabilizing the core UI. ".repeat(60) } // ~2800 chars -> 2 chunks
  });
  assert.ok(prose.length >= 2, "long sections must chunk (<=1600 chars each)");
  for (const p of prose) assert.ok(p.response.length <= 1700);
  assert.equal(prose[0].source.type, "prose");
});

test("thoughtToPairs: filtered reasoning pair; short/decision-free thoughts skipped", () => {
  const good = thoughtToPairs({
    id: "t1",
    sid: "s1",
    agent: "Claude",
    content:
      "The gate failed because the eval report is missing agg_nll. I will re-run the eval harness first to regenerate the report, then re-run the gate — verifying the instrument before trusting the number.",
    state: "Tool Result: gate RED reason=no_eval"
  });
  assert.equal(good.length, 1);
  assert.ok(validateRowA(good[0]).ok);
  assert.equal(good[0].source.type, "thought");
  assert.match(good[0].instruction, /gate RED/);
  const short = thoughtToPairs({
    id: "t2",
    sid: "s1",
    agent: "Claude",
    content: "ok, next.",
    state: "x"
  });
  assert.equal(short.length, 0);
});
