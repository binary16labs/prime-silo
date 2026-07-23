// T2 builder unit tests. Run: node --test scripts/train/tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cardToPairs, traceToRows, buildStreamA } from "../lib/streams.mjs";
import { validateRowA, validateRowB } from "../lib/schema.mjs";
import { makeDetector, loadTerms, scanForLeaks } from "../lib/privacy.mjs";

test("Stream A: one card -> a well-formed method/voice pair", () => {
  const card = {
    id: "longview_card_test",
    sid: "deadbeef",
    title: "Test card",
    sections: { Intent: "Fix the pypes plan command for local LLMs", Applications: "- benny\n- pypes" },
  };
  const pairs = cardToPairs(card);
  assert.equal(pairs.length, 1);
  const v = validateRowA(pairs[0]);
  assert.ok(v.ok, v.errors.join("; "));
  assert.match(pairs[0].instruction, /how did we approach/i);
  assert.match(pairs[0].response, /pypes plan/i); // real house text, not fabricated
  assert.equal(pairs[0].source.type, "card");
});

test("Stream B: one tool-use trace -> a (state + goal -> next tool call) row", () => {
  const entityMap = new Map([
    ["u1", { id: "u1", type: "User Input", content: "view the task log", children_ids: ["t1"] }],
    [
      "t1",
      {
        id: "t1",
        type: "Tool Call",
        agent: "Claude",
        content: JSON.stringify({ name: "view_file", args: { toolSummary: '"View the task log"' } }),
        metadata: { toolName: "view_file" },
        parent_id: "u1",
      },
    ],
  ]);
  const { rows } = traceToRows(entityMap, {});
  assert.equal(rows.length, 1);
  const v = validateRowB(rows[0]);
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(rows[0].tool_call.name, "view_file");
  assert.match(rows[0].state, /User Input/); // ancestor context reconstructed
  assert.match(rows[0].goal, /view the task log/i);
});

test("leak gate: a seeded CV/job row is rejected (build-time detector + file scan)", () => {
  const spec = loadTerms({ home: null });
  const detect = makeDetector(spec);
  // Build-time filter must catch it.
  const cvCard = {
    id: "longview_card_cv",
    sid: "cafe1234",
    title: "Draft cover letter",
    sections: { Intent: "Write a cover letter and update my curriculum vitae for a job application" },
  };
  const { rows, excluded } = buildStreamA([cvCard], [], { detector: detect });
  assert.equal(rows.length, 0, "CV-derived pair must be excluded at build time");
  assert.equal(excluded.personal, 1);

  // And the authoritative file scan (the gate's mechanism) must flag it too.
  const tmp = path.join(os.tmpdir(), `t2_leak_${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, JSON.stringify({ stream: "A", id: "x", instruction: "help", response: "update my curriculum vitae", source: { type: "card", id: "y" } }) + "\n");
  const leaks = scanForLeaks({ files: [tmp], terms: spec.terms, sids: spec.sids });
  fs.unlinkSync(tmp);
  assert.ok(leaks.length >= 1, "file scan must find the seeded CV term");
});

test("a clean row survives the same filter", () => {
  const spec = loadTerms({ home: null });
  const detect = makeDetector(spec);
  assert.equal(detect("Refactor the offload router and add a health check"), false);
  // 'cv' must not false-positive inside ordinary words.
  assert.equal(detect("the canvas element renders the graph"), false);
});
