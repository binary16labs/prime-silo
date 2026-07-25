// Promotion decision function + additive eval growth (L13 / EP-L). Pure; no I/O.
// Design: SOLUTION §4.6 (R44/R45) + §5.5 (decision_vector, slice added_in_turn). This decides the
// VERDICT ("N+1 ≥ N") that a human then signs (L12 owns the signed swap + rollback). "Better" is a
// RULE, not relitigated per turn: strict dominance decides cleanly; a Pareto trade-off is broken by
// the EVAL ANCHOR (held-out eval NLL is the honest metric). And the held-out instrument grows
// additively — new slices carry added_in_turn and a cross-turn comparison uses only slices present in
// BOTH turns, so adding a slice never invalidates a historical turn's score. R44, R45.

// Metric directions: eval_nll ↓ better (the anchor), agent_pass ↑ better, cost ↓ better, latency_ms ↓ better.
const METRICS = [
  { key: "eval_nll", dir: -1 },
  { key: "agent_pass", dir: +1 },
  { key: "cost", dir: -1 },
  { key: "latency_ms", dir: -1 },
];

// per-metric comparison of candidate vs incumbent: +1 candidate better, -1 worse, 0 equal/absent.
function cmp(cand, inc, { key, dir }) {
  const a = cand?.[key];
  const b = inc?.[key];
  if (a == null || b == null || a === b) return 0;
  return (a < b ? -1 : 1) * dir;
}

export const DECISION_RULE = "dominates-or-pareto-with-eval-anchor";

// decide(candidate, incumbent) → { verdict: "promote"|"reject", reason, rule }.
// Deterministic and total: same vectors always yield the same verdict.
export function decide(candidate, incumbent, { rule = DECISION_RULE } = {}) {
  const scores = METRICS.map((m) => cmp(candidate, incumbent, m));
  const anyBetter = scores.some((s) => s > 0);
  const anyWorse = scores.some((s) => s < 0);

  // strict dominance: better on at least one, worse on none → promote; the mirror → reject.
  if (anyBetter && !anyWorse) return { verdict: "promote", reason: "dominates", rule };
  if (anyWorse && !anyBetter) return { verdict: "reject", reason: "dominated", rule };

  // Pareto / mixed (or all-equal): break the tie on the eval anchor.
  const evalCmp = cmp(candidate, incumbent, METRICS[0]); // eval_nll direction-adjusted
  if (evalCmp > 0) return { verdict: "promote", reason: "pareto-eval-anchor-gain", rule };
  if (evalCmp < 0) return { verdict: "reject", reason: "pareto-eval-anchor-loss", rule };
  // eval tie: only promote if every secondary is ≥ and at least one > (dominant secondaries);
  // otherwise a swap is not justified by any eval improvement — reject (conservative, deterministic).
  return { verdict: "reject", reason: "eval-tie-no-gain", rule };
}

// --- additive eval growth (R45) ---------------------------------------------
// A turn eval is { turn, slices: { <sliceId>: score } }. Slices carry added_in_turn implicitly by
// simply being absent from earlier turns' slice maps — history is whatever that turn actually ran.

// slices present in BOTH turns (sorted, deterministic).
export function sharedSlices(turnA, turnB) {
  const a = new Set(Object.keys(turnA.slices || {}));
  return Object.keys(turnB.slices || {})
    .filter((s) => a.has(s))
    .sort();
}

// aggregate a turn's score over an explicit slice set (mean). null when the set is empty — a
// comparison with no shared slices yields no score rather than a bogus 0.
export function turnScore(turnEval, sliceIds) {
  if (!sliceIds || sliceIds.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const id of sliceIds) {
    const v = turnEval.slices?.[id];
    if (v == null) continue;
    sum += v;
    n++;
  }
  return n === 0 ? null : sum / n;
}

// cross-turn series: each consecutive pair is compared only on its shared slices, and each turn's
// reported score is computed on the slices shared with its PREDECESSOR (turn 1 uses its own slices),
// so a slice added later never rewrites an earlier turn's number.
export function crossTurnSeries(turnEvals) {
  const out = [];
  for (let i = 0; i < turnEvals.length; i++) {
    const cur = turnEvals[i];
    const shared = i === 0 ? Object.keys(cur.slices || {}).sort() : sharedSlices(turnEvals[i - 1], cur);
    out.push({ turn: cur.turn, shared, score: turnScore(cur, shared) });
  }
  return out;
}
