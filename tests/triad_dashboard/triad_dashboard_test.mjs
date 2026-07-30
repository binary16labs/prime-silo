// L14 acceptance — compound-value triad dashboard. Scenarios ↔ delivery/tasks/L14.md gherkin.
// Pure over the L5 register; no network. Run: node --test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTriad,
  renderTriadHtml,
  triadFromRegister
} from "../../server/coordination/lib/triad_dashboard.mjs";

// L5 executions.jsonl record shape (subset): kind, config, metrics.quality, metrics.cost_est.
// Each record is stamped with the loop turn it belongs to (config.turn).
const rec = (exec_id, turn, kind, quality, cost_est = 0) => ({
  exec_id,
  kind,
  config: { turn, model_id: "house/m" },
  metrics: { cost_est, quality }
});

// three turns: eval improves 1.30 -> 1.20 (turn2) then REGRESSES 1.20 -> 1.25 (turn3, honest negative).
function fixture() {
  return [
    rec("e1", 1, "train", { eval_nll: 1.3 }),
    rec("a1", 1, "agent", { gate_pass: true }, 0.0),
    rec("a2", 1, "agent", { gate_pass: false }, 0.0),
    rec("e2", 2, "train", { eval_nll: 1.2 }),
    rec("a3", 2, "agent", { gate_pass: true }, 0.0),
    rec("a4", 2, "agent", { gate_pass: true }, 0.0),
    rec("e3", 3, "train", { eval_nll: 1.25 }), // eval got WORSE
    rec("a5", 3, "agent", { gate_pass: true }, 0.0)
  ];
}

// ---------------------------------------------------------------------------
test("Scenario: the triad is shown together, not composited", () => {
  const triad = buildTriad(fixture());
  // three distinct series over turns...
  assert.ok(triad.series.eval_delta, "eval_delta series present");
  assert.ok(triad.series.agent_pass, "agent_pass series present");
  assert.ok(triad.series.cost_per_task, "cost_per_task series present");
  // ...and NO single collapsed composite score anywhere.
  assert.equal(triad.composite, undefined);
  for (const t of triad.turns)
    assert.ok(!("composite" in t) && !("score" in t), "no composite per turn");
  // the html renders three labelled series, not one number.
  const html = renderTriadHtml(triad);
  assert.match(html, /eval/i);
  assert.match(html, /pass/i);
  assert.match(html, /cost/i);
  assert.doesNotMatch(html, /composite/i);
});

test("Scenario: a non-improving turn is not hidden", () => {
  const triad = buildTriad(fixture());
  // all three turns are present (none omitted).
  assert.deepEqual(
    triad.turns.map((t) => t.turn),
    [1, 2, 3]
  );
  // turn 3 regressed on eval — it is shown AND flagged, not dropped.
  const t3 = triad.turns.find((t) => t.turn === 3);
  assert.equal(t3.improved, false);
  assert.ok(t3.eval_delta > 0, "eval_nll rose = a regression");
  // and the renderer marks it rather than hiding it.
  const html = renderTriadHtml(triad);
  assert.match(html, /regress|flag|worse/i);
});

test("Scenario: each point is auditable (traces to the executions it summarizes)", () => {
  const triad = buildTriad(fixture());
  const t1 = triad.turns.find((t) => t.turn === 1);
  // turn 1 summarizes exactly the exec_ids that fed it.
  assert.deepEqual(t1.exec_ids.sort(), ["a1", "a2", "e1"]);
  // agent pass-rate for turn 1 = 1 of 2 = 0.5.
  assert.equal(t1.agent_pass, 0.5);
});

test("determinism: the view is a pure function of the register (same input → same render)", () => {
  const a = renderTriadHtml(buildTriad(fixture()));
  const b = renderTriadHtml(buildTriad(fixture()));
  assert.equal(a, b);
  // and order-independent: shuffling the input records yields the same triad.
  const shuffled = [...fixture()].reverse();
  assert.deepEqual(buildTriad(shuffled).turns, buildTriad(fixture()).turns);
});

test("triadFromRegister reads an executions.jsonl register (L5 data source)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triad-"));
  const p = path.join(dir, "executions.jsonl");
  fs.writeFileSync(
    p,
    fixture()
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  );
  const triad = triadFromRegister(p);
  assert.deepEqual(
    triad.turns.map((t) => t.turn),
    [1, 2, 3]
  );
  assert.equal(triad.turns.find((t) => t.turn === 2).eval_nll, 1.2);
});

test("eval_delta is null for the first turn (no predecessor to compare)", () => {
  const triad = buildTriad(fixture());
  assert.equal(triad.turns.find((t) => t.turn === 1).eval_delta, null);
});
