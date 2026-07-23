// T2 row builders. Deterministic — the corpus is already house-voiced (LONGVIEW
// cards + ADRs ARE the synthesis), so Stream A responses are the real text, never
// fabricated. Stream B reconstructs (state + goal -> next tool call) from the
// memo-ray conversation tree.
import { validateRowA, validateRowB } from "./schema.mjs";

const clip = (s, n) => (String(s || "").length > n ? String(s).slice(0, n).trim() + " …" : String(s || "").trim());
const firstLine = (s) => String(s || "").split(/\r?\n/).find((l) => l.trim()) || "";
const unquote = (s) => String(s || "").replace(/^["'\s]+|["'\s]+$/g, "");
function safeJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Stream A: method/voice pairs ----------------------------------------------
export function cardToPairs(card) {
  const s = card.sections || {};
  // Cards come in two template shapes: v1 (Intent/Applications/Decisions) and
  // arc/v2 (Overview/"What happened"/"Threads and signals"). Handle both.
  const intent = s.Intent && firstLine(s.Intent) ? s.Intent : null;
  const overview = s.Overview && firstLine(s.Overview) ? s.Overview : null;
  const primary = intent || overview;
  if (!primary) return [];
  const responseParts = [];
  if (intent) {
    responseParts.push(`Intent: ${intent.trim()}`);
    if (s.Applications) responseParts.push(`What we used: ${s.Applications.trim()}`);
    if (s.Decisions && firstLine(s.Decisions)) responseParts.push(`Decisions: ${clip(s.Decisions, 800)}`);
  } else {
    responseParts.push(`Overview: ${overview.trim()}`);
    if (s["What happened"]) responseParts.push(`What happened: ${clip(s["What happened"], 900)}`);
    if (s["Threads and signals"]) responseParts.push(`Threads and signals: ${clip(s["Threads and signals"], 600)}`);
  }
  return [
    {
      stream: "A",
      id: `A-card-${card.id}`,
      instruction: `In the Prime-Silo estate, how did we approach this task and what was the method: "${clip(firstLine(primary), 160)}"?`,
      response: responseParts.join("\n\n"),
      source: { type: "card", id: card.id, sid: card.sid || undefined },
    },
  ];
}

export function adrToPairs(adr) {
  const decision = adr.sections?.Decision || adr.sections?.["Decision Drivers"];
  const context = adr.sections?.Context;
  const body = decision || context;
  if (!body || !firstLine(body)) return [];
  const parts = [];
  if (context) parts.push(`Context: ${clip(context, 800)}`);
  if (decision) parts.push(`Decision: ${clip(decision, 1200)}`);
  return [
    {
      stream: "A",
      id: `A-adr-${adr.id}`,
      instruction: `What is our architectural decision in "${clip(adr.title, 120)}", and what's the rationale?`,
      response: parts.join("\n\n") || clip(body, 1200),
      source: { type: "adr", id: adr.id },
    },
  ];
}

// --- Stream B: (state + goal -> next tool call) from the memo-ray tree ----------
// For each Tool Call entity, walk up to `maxAncestors` parents (present in the
// loaded slice) for state, derive the goal from the step's own toolSummary/action
// or the nearest User Input, and emit the tool call as the target.
export function traceToRows(entityMap, { detector = () => false, getEntity, maxRows = Number(process.env.T2_TRACE_MAX_ROWS) || 500, maxAncestors = 4 } = {}) {
  const rows = [];
  const excluded = { personal: 0, unparsed: 0 };
  // Resolve ancestors from the slice first, then on-demand from disk (an entity's
  // filename is its id), so trajectory context is reconstructed. Cached loader.
  const resolve = (id) => (entityMap.has(id) ? entityMap.get(id) : getEntity ? getEntity(id) : null);
  for (const e of entityMap.values()) {
    if (e.type !== "Tool Call") continue;
    if (rows.length >= maxRows) break;
    const parsed = safeJSON(e.content) || {};
    const name = e.metadata?.toolName || parsed.name;
    if (!name) {
      excluded.unparsed++;
      continue;
    }
    const args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
    // goal: this step's own summary/action, else nearest ancestor User Input.
    let goal = unquote(args.toolSummary || args.toolAction || "");
    // Single bounded ancestor walk builds the state chain AND the session anchor
    // (topmost ancestor reached) — no separate deep traversal (that was O(depth)
    // disk reads per row and dominated build time).
    const chain = [];
    let cur = e,
      hops = 0,
      sid = e.id;
    while (cur?.parent_id && hops < maxAncestors) {
      const p = resolve(cur.parent_id);
      if (!p) break;
      cur = p;
      hops++;
      sid = cur.id;
      const c = clip(firstLine(cur.content) || cur.metadata?.toolName || "", 180);
      if (c) chain.unshift(`${cur.type}: ${c}`);
      if (!goal && cur.type === "User Input") goal = clip(firstLine(cur.content), 200);
    }
    if (!goal) goal = `invoke ${name}`;
    const state = chain.length ? chain.join("\n") : `Session start (agent ${e.agent || "unknown"}); no prior step in the loaded window.`;
    const row = {
      stream: "B",
      id: `B-trace-${e.id}`,
      state,
      goal,
      tool_call: { name, args },
      source: { type: "trace", id: e.id, sid, agent: e.agent },
    };
    // Privacy: drop the row if any of its text carries personal/job context.
    const flat = `${state}\n${goal}\n${JSON.stringify(row.tool_call)}\n${row.source.sid}`;
    if (detector(flat)) {
      excluded.personal++;
      continue;
    }
    rows.push(row);
  }
  return { rows, excluded };
}

// Emit Stream A from cards + ADRs, applying the same personal-context filter.
export function buildStreamA(cards, adrs, { detector = () => false } = {}) {
  const rows = [];
  const excluded = { personal: 0 };
  for (const pair of [...cards.flatMap(cardToPairs), ...adrs.flatMap(adrToPairs)]) {
    if (detector(`${pair.instruction}\n${pair.response}\n${pair.source.id}`)) {
      excluded.personal++;
      continue;
    }
    rows.push(pair);
  }
  return { rows, excluded };
}

export { validateRowA, validateRowB };
