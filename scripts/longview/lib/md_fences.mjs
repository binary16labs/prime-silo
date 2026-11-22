// Deterministic repair of LLM-written markdown fences, at the seam where model
// prose is assembled into a deliverable (SAD, book).
//
// Why (C0 SAD, 2026-11-22): the model's section text carried three fence defects,
// and the assembled document rendered wrongly from the first one onward:
//   1. prose wrapped in ```markdown … ``` → a whole section printed as code (11×)
//   2. a stray closing ``` with no opener → fence parity flipped for the rest of
//      the document: 102 of 387 diagrams printed as raw source, prose as code
//   3. an invented diagram type (`classDiagram-diagnostics`) → a syntax-error box
// No LLM is involved here: every fix is a rule, every fix is reported, and the
// caller keeps the raw text so a repair can always be inspected or undone.

const FENCE = /^\s*```\s*([\w-]*)/;
const fenceLang = (line) => {
  const m = FENCE.exec(line);
  return m ? m[1] : null; // null = not a fence; "" = bare fence
};

// Mermaid v11 diagram keywords (first token of the first content line).
export const MERMAID_TYPES = new Set([
  "flowchart", "graph", "sequenceDiagram", "classDiagram", "classDiagram-v2",
  "stateDiagram", "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie",
  "quadrantChart", "requirementDiagram", "gitGraph", "C4Context", "C4Container",
  "C4Component", "C4Dynamic", "C4Deployment", "mindmap", "timeline", "zenuml",
  "sankey-beta", "xychart-beta", "block-beta", "packet-beta", "kanban",
  "architecture-beta", "radar-beta", "treemap-beta"
]);

// Pass 1 — unwrap prose the model fenced as ```markdown / ```md. The wrapper's
// closer is the first bare fence not owned by a block opened inside it.
function unwrapProse(lines, fixes) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const lang = fenceLang(lines[i]);
    if (lang !== "markdown" && lang !== "md") {
      out.push(lines[i]);
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = fenceLang(lines[j]);
      if (l === null) continue;
      if (l !== "") depth++;
      else if (depth > 0) depth--;
      else {
        close = j;
        break;
      }
    }
    fixes.push({ line: i + 1, kind: "unwrapped_prose", detail: `\`\`\`${lang} wrapper removed` });
    if (close < 0) continue; // unclosed wrapper: drop the opener, keep the prose
    out.push(...lines.slice(i + 1, close));
    i = close;
  }
  return out;
}

// Pass 2 — fence parity. A closing fence never carries an info string, so:
//   • a bare fence OUTSIDE a block whose next fence is tagged (```mermaid) is a
//     stray closer, not an opener → dropped
//   • a tagged fence INSIDE a block means the block was never closed → a close
//     is inserted before it
//   • a block still open at the end is closed
function balance(lines, fixes, at) {
  const out = [];
  let open = null; // lang of the open block, or null
  for (let i = 0; i < lines.length; i++) {
    const lang = fenceLang(lines[i]);
    if (lang === null) {
      out.push(lines[i]);
      continue;
    }
    if (open === null) {
      if (lang === "") {
        let next = null;
        for (let j = i + 1; j < lines.length && next === null; j++) next = fenceLang(lines[j]);
        if (next) {
          fixes.push({ line: at(i), kind: "orphan_fence", detail: `stray \`\`\` before a \`\`\`${next} block removed` });
          continue;
        }
      }
      open = lang;
      out.push(lines[i]);
    } else if (lang === "") {
      open = null;
      out.push(lines[i]);
    } else {
      fixes.push({ line: at(i), kind: "unclosed_block", detail: `\`\`\`${open || "(code)"} closed before \`\`\`${lang}` });
      out.push("```", lines[i]);
      open = lang;
    }
  }
  if (open !== null) {
    fixes.push({ line: at(lines.length - 1), kind: "unclosed_block", detail: "block closed at end of document" });
    out.push("```");
  }
  return out;
}

// Pass 3 — mermaid header: `classDiagram-diagnostics` → `classDiagram`. Only a
// known type followed by "-suffix" is rewritten; anything else is left for the
// render check (and its labelled fallback) to judge.
function normaliseHeaders(lines, fixes) {
  let inMermaid = false;
  let headerDone = false;
  return lines.map((line, i) => {
    const lang = fenceLang(line);
    if (lang !== null) {
      inMermaid = lang === "mermaid";
      headerDone = false;
      return line;
    }
    if (!inMermaid || headerDone || !line.trim() || /^\s*(%%|---)/.test(line)) return line;
    headerDone = true;
    const tok = line.trim().split(/\s+/)[0];
    if (MERMAID_TYPES.has(tok)) return line;
    const base = [...MERMAID_TYPES].find((t) => tok.startsWith(t + "-"));
    if (!base) return line;
    fixes.push({ line: i + 1, kind: "mermaid_type", detail: `${tok} → ${base}` });
    return line.replace(tok, base);
  });
}

export function repairMarkdown(md) {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const fixes = [];
  let lines = md.split(/\r?\n/);
  lines = unwrapProse(lines, fixes);
  lines = balance(lines, fixes, (i) => i + 1);
  lines = normaliseHeaders(lines, fixes);
  return { md: lines.join(eol), fixes };
}

// Count opened mermaid blocks the way a correct parser would (tagged fence
// outside a block). The PDF gate compares this with the rendered SVG count.
export function mermaidBlocks(md) {
  let open = null;
  let n = 0;
  for (const line of md.split(/\r?\n/)) {
    const lang = fenceLang(line);
    if (lang === null) continue;
    if (open === null) {
      open = lang;
      if (lang === "mermaid") n++;
    } else if (lang === "") open = null;
  }
  return n;
}

// Fallback for diagrams that still fail to render: print the source as a
// labelled code block instead of an error box. indexes = mermaid block order.
export function fallbackDiagrams(md, indexes, note = "Diagram could not be rendered (Mermaid syntax error); source shown.") {
  const want = new Set(indexes);
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  let k = -1;
  let open = null;
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const lang = fenceLang(line);
    if (lang !== null && open === null) {
      open = lang;
      if (lang === "mermaid" && want.has(++k)) {
        out.push(`> ⚠ ${note}`, "", "```text");
        continue;
      }
    } else if (lang === "") open = null;
    out.push(line);
  }
  return out.join(eol);
}
