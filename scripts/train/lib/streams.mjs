// T2 row builders. Deterministic — the corpus is already house-voiced (LONGVIEW
// cards + ADRs ARE the synthesis), so Stream A responses are the real text, never
// fabricated. Stream B reconstructs (state + goal -> next tool call) from the
// memo-ray conversation tree.
import { validateRowA, validateRowB } from "./schema.mjs";

const clip = (s, n) =>
  String(s || "").length > n ? String(s).slice(0, n).trim() + " …" : String(s || "").trim();
const firstLine = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .find((l) => l.trim()) || "";
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
    if (s.Decisions && firstLine(s.Decisions))
      responseParts.push(`Decisions: ${clip(s.Decisions, 800)}`);
  } else {
    responseParts.push(`Overview: ${overview.trim()}`);
    if (s["What happened"]) responseParts.push(`What happened: ${clip(s["What happened"], 900)}`);
    if (s["Threads and signals"])
      responseParts.push(`Threads and signals: ${clip(s["Threads and signals"], 600)}`);
  }
  // Deterministic per-card template pick (FNV-1a over the card id) so the model learns the
  // method/voice, not a single fixed instruction phrase (55/56 rows sharing one template
  // taught template-matching). Same card always gets the same phrasing => rebuilds are stable
  // and the hash-based train/eval split stays consistent.
  const topic = clip(firstLine(primary), 160);
  const templates = [
    `In the Prime-Silo estate, how did we approach this task and what was the method: "${topic}"?`,
    `Walk me through how this was handled in our estate, in our usual working style: "${topic}"`,
    `What was our approach and reasoning for: "${topic}"?`,
    `Describe the method and key decisions behind this piece of work: "${topic}"`
  ];
  let h = 0x811c9dc5;
  for (const ch of String(card.id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [
    {
      stream: "A",
      id: `A-card-${card.id}`,
      instruction: templates[h % templates.length],
      response: responseParts.join("\n\n"),
      source: { type: "card", id: card.id, sid: card.sid || undefined }
    }
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
      source: { type: "adr", id: adr.id }
    }
  ];
}

// --- Stream B: (state + goal -> next tool call) from the memo-ray tree ----------
// For each Tool Call entity, walk up to `maxAncestors` parents (present in the
// loaded slice) for state, derive the goal from the step's own toolSummary/action
// or the nearest User Input, and emit the tool call as the target.
export function traceToRows(
  entityMap,
  {
    detector = () => false,
    getEntity,
    maxRows = Number(process.env.T2_TRACE_MAX_ROWS) || 500,
    maxAncestors = Number(process.env.T2_TRACE_MAX_ANCESTORS) || 8,
    // Lever 2: no single tool may dominate the stream (Bash was 30% in v2).
    maxToolShare = Number(process.env.T2_TRACE_MAX_TOOL_SHARE) || 0.2
  } = {}
) {
  const rows = [];
  const excluded = { personal: 0, unparsed: 0, dedup: 0, tool_capped: 0 };
  const maxPerTool = Math.max(1, Math.ceil(maxRows * maxToolShare));
  const perTool = new Map();
  const seenTargets = new Set(); // near-dup collapse: tool + normalized args
  // Resolve ancestors from the slice first, then on-demand from disk (an entity's
  // filename is its id), so trajectory context is reconstructed. Cached loader.
  const resolve = (id) =>
    entityMap.has(id) ? entityMap.get(id) : getEntity ? getEntity(id) : null;
  for (const e of entityMap.values()) {
    if (e.type !== "Tool Call") continue;
    if (rows.length >= maxRows) break;
    // Two source formats: Antigravity stores {name, args}; Claude stores {name, input}.
    // If the content doesn't parse (truncated JSON etc.) the args are unrecoverable — exclude
    // the row rather than emit a degenerate `{name, args:{}}` target the model would learn.
    const parsed = safeJSON(e.content);
    const name = e.metadata?.toolName || parsed?.name;
    if (!name || !parsed) {
      excluded.unparsed++;
      continue;
    }
    const rawArgs = parsed.args ?? parsed.input;
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    // goal: this step's own summary/action/description (key casing varies by agent),
    // else nearest ancestor User Input.
    let goal = unquote(
      args.toolSummary ||
        args.ToolSummary ||
        args.toolAction ||
        args.ToolAction ||
        args.description ||
        args.Description ||
        ""
    );
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
      // goal fallbacks by proximity: User Input states the ask; a Thought's first
      // line usually states intent (Lever 2 — cuts the "invoke X" residual).
      if (!goal && cur.type === "User Input") goal = clip(firstLine(cur.content), 200);
      if (!goal && cur.type === "Thought") goal = clip(firstLine(cur.content), 200);
    }
    if (!goal) goal = `invoke ${name}`;
    const state = chain.length
      ? chain.join("\n")
      : `Session start (agent ${e.agent || "unknown"}); no prior step in the loaded window.`;

    // Near-dup collapse: same tool + same args modulo paths/hex/numbers teaches nothing new.
    const norm = JSON.stringify(args)
      .toLowerCase()
      .replace(/[a-f0-9]{8,}/g, "#")
      .replace(/\d+/g, "#");
    const dupKey = `${name}|${norm}`;
    if (seenTargets.has(dupKey)) {
      excluded.dedup++;
      continue;
    }
    // Per-tool share cap (applied in corpus order — deterministic).
    if ((perTool.get(name) || 0) >= maxPerTool) {
      excluded.tool_capped++;
      continue;
    }

    const row = {
      stream: "B",
      id: `B-trace-${e.id}`,
      state,
      goal,
      tool_call: { name, args },
      source: { type: "trace", id: e.id, sid, agent: e.agent }
    };
    // Lever 3: tag result-conditioned rows (state carries a prior Tool Result) so the
    // chain share is measurable; stays stream B, same schema, extra provenance only.
    if (state.includes("Tool Result:")) row.source.variant = "chain";
    // Privacy: drop the row if any of its text carries personal/job context.
    const flat = `${state}\n${goal}\n${JSON.stringify(row.tool_call)}\n${row.source.sid}`;
    if (detector(flat)) {
      excluded.personal++;
      continue;
    }
    seenTargets.add(dupKey);
    perTool.set(name, (perTool.get(name) || 0) + 1);
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
