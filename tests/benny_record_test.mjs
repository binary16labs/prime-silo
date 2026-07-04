#!/usr/bin/env node
//
// Benny Record player (ADR-005 observability) — pure-helper tests.
//
// The player forks the memo-ray step_through experience but consumes the
// disk-truth /api/longview_record timeline instead of the memo-ray store. These
// tests pin the classification helpers that drive the scrubber milestones, the
// gate chips, the token meter, and the graph-delta chips — the enrichments that
// distinguish Benny Record from step_through. DOM/Alpine wiring is exercised in
// the browser; here we lock the deterministic logic.

import assert from "node:assert/strict";

import { __testing as br } from "../app/L0/_all/mod/_prime_silo/benny_record/benny_record.js";

function testMilestones() {
  // run pin, gate fail, book section, coverage → milestones.
  assert.equal(br.isMilestone({ content: { action: "run_config" } }), true);
  assert.equal(br.isMilestone({ content: { status: "failed" } }), true);
  assert.equal(br.isMilestone({ content: { ok: false } }), true);
  assert.equal(br.isMilestone({ content: { phase: "opus", artifact: "section:p2c4s1" } }), true);
  assert.equal(br.isMilestone({ content: { artifact: "coverage" } }), true);
  // an ordinary clean map step is not a milestone.
  assert.equal(br.isMilestone({ content: { phase: "map", status: "ok" } }), false);
}

function testGate() {
  assert.equal(br.gateOf({ content: { phase: "map", status: "ok" } }).pass, true);
  const fail = br.gateOf({
    content: { status: "failed", gate_errors: ["too short", "1 citation"] }
  });
  assert.equal(fail.pass, false);
  assert.deepEqual(fail.errors, ["too short", "1 citation"]);
  // a step with no gate signal → null (no chip).
  assert.equal(br.gateOf({ content: { phase: "code" } }), null);
}

function testTokens() {
  // top-level tokens field wins.
  assert.equal(br.tokensOf({ tokens: 512, content: {} }), 512);
  // else sum prompt + completion.
  assert.equal(br.tokensOf({ content: { prompt_tokens: 300, completion_tokens: 119 } }), 419);
  assert.equal(br.tokensOf(null), 0);
}

function testGraphDelta() {
  const chips = br.graphDeltaOf({
    content: { concepts_added: 12, similarity_links: 3, related_concepts: ["a", "b"], merged: 0 }
  });
  assert.ok(chips.includes("+12 concepts"));
  assert.ok(chips.includes("+3 sim links"));
  assert.ok(chips.includes("+2 cross-session"));
  // zero deltas produce no chips.
  assert.equal(br.graphDeltaOf({ content: { merged: 0 } }).length, 0);
}

function testContentBody() {
  const body = br.contentBody({
    content: {
      phase: "map", // hidden (structural)
      status: "ok", // hidden
      session_id: "b4e58880deadbeef",
      concepts: ["retrieval", "gates", "determinism"]
    }
  });
  assert.ok(body.includes("session_id: b4e58880deadbeef"));
  assert.ok(body.includes("concepts: retrieval, gates, determinism"));
  assert.ok(!body.includes("phase:"), "structural fields are stripped from the content pane");
}

function testDeterminism() {
  // Same input → same output (sorted/pure helpers).
  const a = { content: { concepts_added: 5, links_added: 2 } };
  assert.deepEqual(br.graphDeltaOf(a), br.graphDeltaOf(a));
}

function main() {
  testMilestones();
  testGate();
  testTokens();
  testGraphDelta();
  testContentBody();
  testDeterminism();
  console.log("benny_record_test: ok");
}

main();
