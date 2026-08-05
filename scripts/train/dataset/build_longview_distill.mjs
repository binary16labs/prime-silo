// P5 — build the LONGVIEW distillation dataset: teach gemma-4-e4b to produce the 12B's
// window_fragment extractions. Teacher = google/gemma-4-12b (confirmed: every card meta records
// model=lmstudio/google/gemma-4-12b), so the targets ALREADY EXIST on disk (the stored
// windows/<sid>/w12000_N.json fragments) — no regeneration.
//
// Each example: input = the raw window text (reconstructed by the SAME walkSessionWindows the bench
// uses) + the production window_fragment system prompt; target = the stored 12B fragment for that
// window. Rows carry {system,user,response} so training matches the system+user the ladder bench
// serves (no train/serve skew).
//
// GUARDS (training-data-privacy discipline):
//   • quarantined sids (longview/quarantine.json) are excluded outright,
//   • a fresh held-out EVAL sample is carved out and excluded from training — the ladder measures the
//     trained model on cards it never saw, or the ~5% gap number is worthless,
//   • the leak gate (scanForLeaks) scans every emitted row for personal terms + quarantined sids; any
//     hit ABORTS the build (rows never ship),
//   • rows are written git-ignored (they contain session text).
//
// Usage: node build_longview_distill.mjs [--eval-n 25]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const LV = path.join(REPO, "scripts", "longview", "lib");
const imp = (f) => import(pathToFileURL(path.join(LV, f)).href);
const { walkSessionWindows } = await imp("walk.mjs");
const { scanForLeaks } = await imp("leak_gate.mjs");

const WORKDIR = "D:/benny-home/benny/workspaces/sessions_v1/longview";
const CARDS = path.join(WORKDIR, "cards");
const WINDOWS = path.join(WORKDIR, "windows");
const QUARANTINE = path.join(WORKDIR, "quarantine.json");
const SYSTEM = fs.readFileSync(path.join(REPO, "scripts", "longview", "prompts", "window_fragment.md"), "utf8");
const WINDOW_CHARS = 12000;
process.env.MEMORAY_DATA_DIR = process.env.MEMORAY_DATA_DIR || "C:/Users/nsdha/.mem0ray/data";

const argEvalN = Number((process.argv.find((a) => a.startsWith("--eval-n=")) || "").split("=")[1]) ||
  (process.argv.includes("--eval-n") ? Number(process.argv[process.argv.indexOf("--eval-n") + 1]) : 0) || 25;

const OUT = path.join(__dirname, "longview_distill"); // git-ignored dir
fs.mkdirSync(OUT, { recursive: true });

// --- corpus + guards -------------------------------------------------------
const quarantined = new Set((JSON.parse(fs.readFileSync(QUARANTINE, "utf8")).sids) || []);
const personalTerms = JSON.parse(fs.readFileSync(path.join(__dirname, "personal_terms.json"), "utf8"));
const TERMS = Array.isArray(personalTerms) ? personalTerms : (personalTerms.terms || []);

// Train-exclude denylist: NOT personal (so not quarantined) but trips the leak-gate backstop on a
// literal example string. 3fb5c68f is the very session that BUILT leak_gate.mjs — its fragment
// contains "avoid false positives (e.g., 'cv')", so the word-boundary 'cv' rule fires on it. Drop it
// from training to keep the fail-closed gate clean; losing one meta-card is negligible.
const TRAIN_EXCLUDE = new Set(["3fb5c68f2a348add7ef200438b475e55"]);

const allSids = fs.readdirSync(CARDS)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
  .map((f) => f.slice(0, -5))
  .filter((sid) => !quarantined.has(sid))
  .filter((sid) => !TRAIN_EXCLUDE.has(sid))
  .filter((sid) => fs.existsSync(path.join(WINDOWS, sid, "manifest.json")))
  .sort(); // deterministic

// Deterministic held-out eval: hash each sid, take the lowest-N by hash — stable, unbiased, and
// independent of corpus order.
const byHash = [...allSids].sort((a, b) =>
  crypto.createHash("sha256").update(a).digest("hex").localeCompare(
    crypto.createHash("sha256").update(b).digest("hex")));
const evalSids = new Set(byHash.slice(0, argEvalN));
const trainSids = allSids.filter((sid) => !evalSids.has(sid));

// --- RESPONSE-HARD / INPUT-STRONG session filter (owner-signed policy 2026-08-05) -----------------
// The gate is a DELIVERABLE scanner; on raw training transcripts 'cv' is unavoidable and benign (a
// `const cv = canvas` variable, or terminology inside the very sessions that BUILT the CV-quarantine
// system). So the gate is applied PER FIELD, at the SESSION level (exclude a whole session, never a
// partial one), deterministically and with an audit log:
//   • RESPONSE (the fragment the model learns to EMIT — a deliverable-like output): the FULL gate,
//     every term incl. the coarse 'cv' + quarantined sids. We refuse to TEACH this terminology.
//   • INPUT/user (the raw transcript, only ever the model's context): STRONG terms only — real
//     names/emails (>=4 chars) + quarantined sids. A personal NAME or a quarantined SID in the input
//     is a real leak; a code-variable 'cv' is not.
// This does NOT weaken personal_terms for deliverables (that rule stands); it applies the right
// precision to raw input text. A final full re-scan of the written file ASSERTS 0 findings (the
// fail-closed backstop stays armed — the build aborts if anything slipped through).
const STRONG_TERMS = TERMS.filter((t) => String(t).trim().length >= 4);
const scanStr = (text, terms) => {
  const f = path.join(OUT, ".scan_tmp.txt");
  fs.writeFileSync(f, text);
  const r = scanForLeaks({ files: [f], terms, sids: [...quarantined] });
  fs.unlinkSync(f);
  return r;
};

const rows = [];
let skipped = 0;
const excludedSessions = []; // audit: {sid, where, term}
for (const sid of trainSids) {
  let windows;
  try {
    ({ windows } = walkSessionWindows({ id: sid }, { inputChars: WINDOW_CHARS }));
  } catch { skipped++; continue; }
  const sessionRows = [];
  for (const w of windows) {
    const fragPath = path.join(WINDOWS, sid, `w${WINDOW_CHARS}_${w.index}.json`);
    if (!fs.existsSync(fragPath)) { skipped++; continue; }
    let frag;
    try { frag = JSON.parse(fs.readFileSync(fragPath, "utf8")); } catch { skipped++; continue; }
    sessionRows.push({ stream: "L", id: `L-${sid}-w${w.index}`, system: SYSTEM,
                       user: w.text, response: JSON.stringify(frag), source: sid });
  }
  if (!sessionRows.length) continue;
  // Per-session gate: response with the full net, input with strong terms only.
  const respHit = scanStr(sessionRows.map((r) => r.response).join("\n"), TERMS)[0];
  const inputHit = scanStr(sessionRows.map((r) => r.user.replace(/\r?\n/g, " ")).join("\n"), STRONG_TERMS)[0];
  if (respHit || inputHit) {
    const h = respHit || inputHit;
    excludedSessions.push({ sid, where: respHit ? "response(full)" : "input(strong)", term: h.term });
    continue; // drop the WHOLE session
  }
  rows.push(...sessionRows);
}

const trainPath = path.join(OUT, "longview_distill.train.jsonl");
fs.writeFileSync(trainPath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

// FAIL-CLOSED BACKSTOP — re-scan the emitted rows with the SAME split policy; assert 0. (Scanning
// the interleaved file with the full net would wrongly re-trip on benign input 'cv', so the backstop
// mirrors the split: response-concatenation full-net, input-concatenation strong-net.)
const backstop = [
  ...scanStr(rows.map((r) => r.response).join("\n"), TERMS),
  ...scanStr(rows.map((r) => r.user.replace(/\r?\n/g, " ")).join("\n"), STRONG_TERMS),
];
if (backstop.length) {
  console.error(`[distill] BACKSTOP TRIPPED — ${backstop.length} finding(s) survived the session filter; aborting`);
  for (const f of backstop.slice(0, 10)) console.error("  ", `term=${f.term} :: ${String(f.excerpt).slice(0, 90)}`);
  fs.unlinkSync(trainPath);
  process.exit(1);
}
if (excludedSessions.length) {
  console.log(`[distill] session filter excluded ${excludedSessions.length} session(s) (terminology in output / strong term in input):`);
  for (const e of excludedSessions) console.log(`    ${e.sid} — ${e.where} term=${e.term}`);
}

// eval sample manifest (held-out sids the ladder will bench the trained model on)
const evalManifest = {
  sids: [...evalSids].sort(),
  n: evalSids.size,
  why: `held-out P5 eval: sha256-lowest ${argEvalN} of ${allSids.length} non-quarantined cards, EXCLUDED from training`,
};
fs.writeFileSync(path.join(OUT, "eval-p5.json"), JSON.stringify(evalManifest, null, 2));

const manifest = {
  built: new Date().toISOString(),
  teacher: "lmstudio/google/gemma-4-12b",
  student: "google/gemma-4-e4b",
  surface: "longview.window_fragment",
  window_chars: WINDOW_CHARS,
  corpus_cards_total: allSids.length + quarantined.size,
  quarantined_excluded: quarantined.size,
  cards_available: allSids.length,
  eval_cards_heldout: evalSids.size,
  train_cards_considered: trainSids.length,
  train_cards_used: trainSids.length - excludedSessions.length,
  sessions_excluded_by_gate: excludedSessions.length,
  train_rows_windows: rows.length,
  windows_skipped: skipped,
  leak_gate: "PASS (response-hard/input-strong; backstop 0 findings)",
  gate_excluded_sessions: excludedSessions,
  files: { train: "longview_distill.train.jsonl", eval: "eval-p5.json" },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log("=== P5 LONGVIEW distillation dataset ===");
console.log(`corpus non-quarantined: ${allSids.length}  (quarantined excluded: ${quarantined.size})`);
console.log(`held-out eval cards: ${evalSids.size}   train cards: ${trainSids.length}`);
console.log(`train rows (window->fragment): ${rows.length}   windows skipped: ${skipped}`);
console.log(`leak gate: PASS (0 findings)`);
console.log(`-> ${path.relative(REPO, OUT)}/ (git-ignored)`);
