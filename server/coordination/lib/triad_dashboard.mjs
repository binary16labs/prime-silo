// Compound-value triad dashboard (L14 / EP-L). Proves the flywheel TURNS: the triad — held-out eval
// delta (the honest anchor) + agent task pass-rate + cost/task — shown TOGETHER over loop turns, and
// NEVER collapsed into one gameable composite (steer 6; R23/R24/R26/R30). A non-improving turn is
// shown and flagged, not hidden (R24). Every point traces to the executions.jsonl records it
// summarizes (auditable, R33). The view is a pure function of the L5 register — same input, same
// render (rebuildable). It SHOWS; it does not decide (L13) or promote (L12). Design: SOLUTION §4.5.
import { readRegister } from "./exec_register.mjs";

const turnOf = (r) => r.config?.turn ?? r.turn ?? null;
const evalOf = (r) => r.metrics?.quality?.eval_nll ?? null;
// an agent execution "passes" when its gate_pass is true (fallback: a judge score ≥ 0.5).
const agentPassOf = (r) => {
  const q = r.metrics?.quality ?? {};
  if (typeof q.gate_pass === "boolean") return q.gate_pass ? 1 : 0;
  if (typeof q.judge === "number") return q.judge >= 0.5 ? 1 : 0;
  return null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// buildTriad(records) → { turns:[{turn, eval_nll, eval_delta, agent_pass, cost_per_task, improved,
// exec_ids}], series:{eval_delta, agent_pass, cost_per_task} }. Pure + deterministic (turn-sorted,
// order-independent). Deliberately carries NO composite score — the three series stand on their own.
export function buildTriad(records) {
  const byTurn = new Map();
  for (const r of records) {
    const t = turnOf(r);
    if (t == null) continue; // only records stamped with a loop turn belong on the flywheel view
    if (!byTurn.has(t)) byTurn.set(t, []);
    byTurn.get(t).push(r);
  }

  const turns = [];
  let prevEval = null;
  for (const t of [...byTurn.keys()].sort((a, b) => a - b)) {
    const rs = byTurn.get(t);
    const eval_nll = mean(rs.map(evalOf).filter((v) => v != null));
    const agentPasses = rs
      .filter((r) => r.kind === "agent")
      .map(agentPassOf)
      .filter((v) => v != null);
    const agent_pass = mean(agentPasses);
    const cost_per_task = mean(rs.map((r) => r.metrics?.cost_est ?? 0));
    // eval delta vs the previous turn's eval; lower eval_nll is better, so delta ≤ 0 = improvement.
    const eval_delta = prevEval == null || eval_nll == null ? null : eval_nll - prevEval;
    const improved = eval_delta == null ? null : eval_delta <= 0;
    turns.push({
      turn: t,
      eval_nll,
      eval_delta,
      agent_pass,
      cost_per_task,
      improved,
      exec_ids: rs.map((r) => r.exec_id).sort()
    });
    if (eval_nll != null) prevEval = eval_nll;
  }

  return {
    turns,
    // three SEPARATE series — never a single composite (that is the whole point of the triad).
    series: {
      eval_delta: turns.map((t) => ({ turn: t.turn, value: t.eval_delta })),
      agent_pass: turns.map((t) => ({ turn: t.turn, value: t.agent_pass })),
      cost_per_task: turns.map((t) => ({ turn: t.turn, value: t.cost_per_task }))
    }
  };
}

export function triadFromRegister(registerPath) {
  return buildTriad(readRegister(registerPath));
}

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const fmt = (v) =>
  v == null ? "—" : typeof v === "number" ? v.toFixed(4).replace(/\.?0+$/, "") : esc(v);

// renderTriadHtml(triad) → a deterministic HTML fragment: three labelled series as one row per turn,
// a regression flagged (not hidden), each row carrying its source exec_ids for drill-down (auditable).
export function renderTriadHtml(triad) {
  const rows = triad.turns
    .map((t) => {
      const flag =
        t.improved === false
          ? ' <span class="flag" title="eval regressed">⚠ regression</span>'
          : "";
      return (
        `<tr class="${t.improved === false ? "regressed" : ""}">` +
        `<td>${fmt(t.turn)}</td>` +
        `<td class="eval">${fmt(t.eval_delta)}${flag}</td>` +
        `<td class="pass">${fmt(t.agent_pass)}</td>` +
        `<td class="cost">${fmt(t.cost_per_task)}</td>` +
        `<td class="prov" title="${esc(t.exec_ids.join(" "))}">${t.exec_ids.length} execs</td>` +
        `</tr>`
      );
    })
    .join("\n");
  return (
    '<table class="triad">\n' +
    "<thead><tr><th>turn</th><th>eval Δ (anchor)</th><th>agent pass-rate</th><th>cost / task</th><th>provenance</th></tr></thead>\n" +
    `<tbody>\n${rows}\n</tbody>\n</table>`
  );
}
