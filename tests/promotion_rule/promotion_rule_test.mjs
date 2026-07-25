// L13 acceptance — promotion decision function + additive eval growth.
// Scenarios ↔ delivery/tasks/L13.md gherkin. Pure lib; no I/O. Run: node --test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  sharedSlices,
  turnScore,
  crossTurnSeries
} from "../../server/coordination/lib/promotion_rule.mjs";

// metric vector: eval_nll (lower better, the honest anchor), agent_pass (higher better),
// cost (lower better), latency_ms (lower better).
const mv = (eval_nll, agent_pass, cost, latency_ms) => ({ eval_nll, agent_pass, cost, latency_ms });

// ---------------------------------------------------------------------------
test("Scenario: strict dominance decides", () => {
  const incumbent = mv(1.20, 0.80, 1.0, 2000);
  const better = mv(1.10, 0.85, 0.5, 1800); // better on EVERY metric
  const worse = mv(1.30, 0.75, 2.0, 2500); // worse on every metric
  assert.equal(decide(better, incumbent).verdict, "promote");
  assert.equal(decide(worse, incumbent).verdict, "reject");
});

test("Scenario: a Pareto trade-off resolves by rule (eval-anchored), deterministically", () => {
  const incumbent = mv(1.20, 0.80, 1.0, 2000);
  // gains eval (1.20 -> 1.10) but loses on cost (1.0 -> 1.5): a genuine trade-off.
  const evalGainCostLoss = mv(1.10, 0.80, 1.5, 2000);
  const d1 = decide(evalGainCostLoss, incumbent);
  assert.equal(d1.verdict, "promote"); // eval anchor: an eval gain carries the trade-off
  assert.match(d1.reason, /eval/);

  // the mirror: loses eval, gains cost — eval anchor rejects.
  const evalLossCostGain = mv(1.30, 0.80, 0.5, 2000);
  assert.equal(decide(evalLossCostGain, incumbent).verdict, "reject");

  // deterministic: same inputs → same verdict, every time.
  for (let i = 0; i < 5; i++) assert.equal(decide(evalGainCostLoss, incumbent).verdict, "promote");
});

test("eval tie with mixed secondaries is deterministic and conservative (no eval gain → no swap)", () => {
  const incumbent = mv(1.20, 0.80, 1.0, 2000);
  const evalTieMixed = mv(1.20, 0.90, 2.0, 2000); // same eval, better agent_pass, worse cost
  assert.equal(decide(evalTieMixed, incumbent).verdict, "reject");
  // but an eval tie where the candidate dominates every secondary IS a promote.
  const evalTieDominant = mv(1.20, 0.90, 0.5, 1800);
  assert.equal(decide(evalTieDominant, incumbent).verdict, "promote");
});

test("Scenario: a new eval slice does not rewrite history; comparisons use only shared slices", () => {
  // three turns of held-out eval; each slice carries added_in_turn.
  const turn1 = { turn: 1, slices: { s1: 1.30, s2: 1.40 } };
  const turn2 = { turn: 2, slices: { s1: 1.20, s2: 1.35 } };
  // s3 is ADDED in turn 3 — it must not retroactively change turn1/turn2's scores.
  const turn3 = { turn: 3, slices: { s1: 1.10, s2: 1.30, s3: 0.90 } };

  // turn1 vs turn2 compares only the slices both ran: {s1,s2}.
  assert.deepEqual(sharedSlices(turn1, turn2), ["s1", "s2"]);
  // turn2 vs turn3 also compares only {s1,s2} — s3 is excluded (turn2 never ran it).
  assert.deepEqual(sharedSlices(turn2, turn3), ["s1", "s2"]);

  // each turn's score on a fixed slice set is stable regardless of later-added slices.
  const score12before = turnScore(turn2, ["s1", "s2"]);
  const score12after = turnScore(turn2, sharedSlices(turn2, turn3));
  assert.equal(score12before, score12after); // turn2's {s1,s2} score is unchanged by s3 existing

  // the cross-turn series: each consecutive comparison uses only the shared slices,
  // and earlier turns' scores are byte-identical to a two-turn-only computation.
  const series = crossTurnSeries([turn1, turn2, turn3]);
  assert.equal(series[0].turn, 1);
  assert.equal(series[1].shared.join(","), "s1,s2");
  assert.equal(series[2].shared.join(","), "s1,s2"); // turn2↔turn3 shares only s1,s2
  // turn1's and turn2's scores in the series equal a standalone recompute (history frozen).
  assert.equal(series[0].score, turnScore(turn1, ["s1", "s2"]));
  assert.equal(series[1].score, turnScore(turn2, ["s1", "s2"]));
});

test("comparability: two turns with NO shared slices produce an empty comparison, not a bogus number", () => {
  const a = { turn: 1, slices: { s1: 1.2 } };
  const b = { turn: 2, slices: { s9: 1.1 } };
  assert.deepEqual(sharedSlices(a, b), []);
  assert.equal(turnScore(b, sharedSlices(a, b)), null); // no shared slices → no score, not 0
});
