// EP-A trajectory harvester (clone stage) — behavioural-clone the tool-use decisions in the
// Claude Code sessions the memo-ray store already holds, into stream-`T` training pairs:
//     (rendered context up to a Tool Call)  ->  (that Tool Call's JSON {name, input})
//
// Source of truth is the same store LONGVIEW reads (scripts/longview/lib/store.mjs readTimeline).
// Each session is a tree of typed nodes; `Tool Call` nodes carry metadata.toolName + a JSON body.
//
// Privacy is REUSED VERBATIM from build_longview_distill.mjs (owner-signed policy 2026-08-05):
//   • quarantined sids (longview/quarantine.json) excluded outright,
//   • RESPONSE-HARD / INPUT-STRONG per-session gate — the Tool Call we TEACH is scanned with the
//     full net (incl. coarse 'cv'); the context transcript with STRONG terms (>=4-char names/emails)
//     + quarantined sids. Whole-session exclude, never partial.
//   • deterministic sha256 held-out split (excluded from training),
//   • fail-closed backstop re-scans the written rows and aborts on any finding.
// Rows are git-ignored. Never weaken personal_terms.json to make a build pass.
//
// Usage: node build_agent_traces.mjs [--eval-n 25] [--context-chars 6000] [--max-nodes 4000]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const LV = path.join(REPO, "scripts", "longview", "lib");
const imp = (f) => import(pathToFileURL(path.join(LV, f)).href);
const { readIndex, readTimeline } = await imp("store.mjs");
const { scanForLeaks } = await imp("leak_gate.mjs");

const WORKDIR = "D:/benny-home/benny/workspaces/sessions_v1/longview";
const QUARANTINE = path.join(WORKDIR, "quarantine.json");
process.env.MEMORAY_DATA_DIR = process.env.MEMORAY_DATA_DIR || "C:/Users/nsdha/.mem0ray/data";

const argNum = (flag, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return Number(eq.split("=")[1]) || dflt;
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) || dflt : dflt;
};
const EVAL_N = argNum("--eval-n", 25);
const CONTEXT_CHARS = argNum("--context-chars", 6000);
const MAX_NODES = argNum("--max-nodes", 4000);

const OUT = path.join(__dirname, "agent_distill"); // dir carries a .gitignore for *.jsonl
fs.mkdirSync(OUT, { recursive: true });

const SYSTEM =
  "You are a coding + analysis agent operating over a code repository and a knowledge store. " +
  "Given the task and the transcript so far, decide the single next tool call. " +
  "Respond with ONLY a JSON object {\"name\": <tool>, \"input\": {...}} — no prose.";

// --- corpus + guards (mirror build_longview_distill.mjs) -------------------
const quarantined = new Set((JSON.parse(fs.readFileSync(QUARANTINE, "utf8")).sids) || []);
const personalTerms = JSON.parse(fs.readFileSync(path.join(__dirname, "personal_terms.json"), "utf8"));
const TERMS = Array.isArray(personalTerms) ? personalTerms : (personalTerms.terms || []);
// Same rationale as P5: the session that BUILT the leak gate trips its own 'cv' example rule.
const TRAIN_EXCLUDE = new Set(["3fb5c68f2a348add7ef200438b475e55"]);

const allSids = (readIndex().sessions || [])
  .filter((sid) => !quarantined.has(sid))
  .filter((sid) => !TRAIN_EXCLUDE.has(sid))
  .sort();

// Deterministic held-out eval: lowest-N by sha256(sid) — stable, corpus-order-independent.
const byHash = [...allSids].sort((a, b) =>
  crypto.createHash("sha256").update(a).digest("hex").localeCompare(
    crypto.createHash("sha256").update(b).digest("hex")));
const evalSids = new Set(byHash.slice(0, EVAL_N));
const trainSids = allSids.filter((sid) => !evalSids.has(sid));

const STRONG_TERMS = TERMS.filter((t) => String(t).trim().length >= 4);
const scanStr = (text, terms) => {
  const f = path.join(OUT, ".scan_tmp.txt");
  fs.writeFileSync(f, text);
  const r = scanForLeaks({ files: [f], terms, sids: [...quarantined] });
  fs.unlinkSync(f);
  return r;
};

// --- render one node as a compact labelled line (mirrors walk.mjs renderStep) ---
function renderNode(e) {
  const label = e.type || "Step";
  const meta = e.metadata || {};
  const tag = meta.toolName ? ` ${meta.toolName}` : meta.fileName ? ` ${meta.fileName}` : "";
  const body = (e.content || "").replace(/\s+/g, " ").trim();
  return `[${label}${tag}]${body ? " " + body : ""}`;
}

// Keep only the tail of the context that fits CONTEXT_CHARS (recent nodes matter most).
function tailContext(lines) {
  let out = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (total + l.length + 1 > CONTEXT_CHARS && out.length) break;
    out.unshift(l);
    total += l.length + 1;
  }
  return out.join("\n");
}

// Antigravity narration fields carried inside args — not real tool arguments.
const NARRATION_KEYS = new Set(["toolAction", "toolSummary", "toolName", "Blocking", "SafeToAutoRun"]);

// Antigravity double-encodes arg values as quoted JSON strings ("\"f:\\optimus\\README.md\"").
// Unwrap one layer so the taught action is clean.
function unwrapValue(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch { /* leave as-is */ }
  }
  return v;
}
function cleanArgs(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return a ?? {};
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (NARRATION_KEYS.has(k)) continue;
    out[k] = unwrapValue(v);
  }
  return out;
}

// Normalise a Tool Call body into the {name, input} action we teach. Handles BOTH dialects:
// Claude Code ({name, input}) and Antigravity ({name, args:{...+narration}}).
function toolCallAction(e) {
  const raw = (e.content || "").trim();
  let name = e.metadata?.toolName || null;
  let input;
  try {
    const o = JSON.parse(raw);
    name = o.name || name;
    input = cleanArgs(o.input ?? o.args ?? o.arguments ?? {});
  } catch {
    // Non-JSON body: keep the raw string as the single argument (rare; e.g. legacy nodes).
    if (name) input = { _raw: raw };
  }
  if (!name || input === undefined) return null;
  // Drop pairs that recovered NO arguments from a non-empty body — teaching an argless call
  // for a tool that clearly took arguments is worse than nothing.
  if (raw.length > 40 && input && typeof input === "object" && !Object.keys(input).length) return null;
  return JSON.stringify({ name, input });
}

function harvestSession(sid) {
  let tl;
  try { tl = readTimeline(sid, MAX_NODES); } catch { return { rows: [], skipped: 1 }; }
  const steps = tl.filter((e) => e.type !== "Session");
  const rows = [];
  const ctxLines = [];
  let idx = 0;
  for (const e of steps) {
    if (e.type === "Tool Call") {
      const action = toolCallAction(e);
      if (action && ctxLines.length) {
        rows.push({
          stream: "T", id: `T-${sid.slice(0, 8)}-${idx++}`,
          system: SYSTEM, user: tailContext(ctxLines), response: action, source: sid,
        });
      }
    }
    ctxLines.push(renderNode(e)); // every node (incl. the Tool Call + its Result) feeds later context
  }
  return { rows, skipped: 0 };
}

// --- emit train + eval with the per-session gate ---------------------------
function buildSplit(sids) {
  const rows = [];
  const excluded = []; // {sid, where, term}
  let skipped = 0;
  for (const sid of sids) {
    const { rows: sessionRows, skipped: sk } = harvestSession(sid);
    skipped += sk;
    if (!sessionRows.length) continue;
    const respHit = scanStr(sessionRows.map((r) => r.response).join("\n"), TERMS)[0];
    const inputHit = scanStr(sessionRows.map((r) => r.user.replace(/\r?\n/g, " ")).join("\n"), STRONG_TERMS)[0];
    if (respHit || inputHit) {
      excluded.push({ sid, where: respHit ? "response(full)" : "input(strong)", term: (respHit || inputHit).term });
      continue; // drop the WHOLE session
    }
    rows.push(...sessionRows);
  }
  return { rows, excluded, skipped };
}

const train = buildSplit(trainSids);
const evalOut = buildSplit([...evalSids].sort());

const trainPath = path.join(OUT, "agent_traces.train.jsonl");
const evalPath = path.join(OUT, "agent_traces.eval.jsonl");
const write = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
write(trainPath, train.rows);
write(evalPath, evalOut.rows);

// FAIL-CLOSED BACKSTOP — re-scan emitted rows with the SAME split policy; assert 0.
const backstop = [];
for (const { rows } of [train, evalOut]) {
  backstop.push(...scanStr(rows.map((r) => r.response).join("\n"), TERMS));
  backstop.push(...scanStr(rows.map((r) => r.user.replace(/\r?\n/g, " ")).join("\n"), STRONG_TERMS));
}
if (backstop.length) {
  console.error(`[agent-traces] BACKSTOP TRIPPED — ${backstop.length} finding(s) survived the session filter; aborting`);
  for (const f of backstop.slice(0, 10)) console.error("  ", `term=${f.term} :: ${String(f.excerpt).slice(0, 90)}`);
  fs.unlinkSync(trainPath); fs.unlinkSync(evalPath);
  process.exit(1);
}

// --- audit report ----------------------------------------------------------
const toolHist = (rows) => {
  const h = {};
  for (const r of rows) { try { const n = JSON.parse(r.response).name; h[n] = (h[n] || 0) + 1; } catch { /**/ } }
  return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]));
};
const report = {
  sessions_indexed: allSids.length + quarantined.size,
  quarantined: quarantined.size,
  sessions_train: trainSids.length, sessions_eval: evalSids.size,
  excluded_by_gate: [...train.excluded, ...evalOut.excluded],
  train_pairs: train.rows.length, eval_pairs: evalOut.rows.length,
  train_tool_hist: toolHist(train.rows),
};
fs.writeFileSync(path.join(OUT, "agent_traces.report.json"), JSON.stringify(report, null, 2));
console.log(`[agent-traces] sessions: ${trainSids.length} train / ${evalSids.size} eval (${quarantined.size} quarantined)`);
console.log(`[agent-traces] gate excluded ${report.excluded_by_gate.length} session(s)`);
for (const e of report.excluded_by_gate.slice(0, 12)) console.log(`    ${e.sid.slice(0, 8)} — ${e.where} term=${e.term}`);
console.log(`[agent-traces] pairs: ${train.rows.length} train / ${evalOut.rows.length} eval -> ${trainPath}`);
console.log(`[agent-traces] top tools:`, Object.entries(report.train_tool_hist).slice(0, 12).map(([k, v]) => `${k}:${v}`).join("  "));
