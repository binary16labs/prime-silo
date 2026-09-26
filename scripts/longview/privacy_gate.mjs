#!/usr/bin/env node
/**
 * LONGVIEW privacy gate — content-level pre-validation (ADR-005 governance).
 *
 * Runs BETWEEN map and model/graph, so it inspects the DISTILLED cards + the raw
 * evidence BEFORE anything reaches Neo4j, the vector store, the SAD or the book.
 * The title-level quarantine (inventory) catches obviously-named sessions; this
 * gate reads the full content and catches personal/CV/job-seeking/PII material a
 * title never revealed. Patterns live in privacy_patterns.json (tune without code).
 *
 *   node scripts/longview/privacy_gate.mjs [--gate|--enforce|--report] [--patterns FILE]
 *
 * Modes:
 *   --gate     (default) fail (exit 3) if any 'eject' match is found — a human
 *              decides. Use when a person is in the loop.
 *   --enforce  auto-quarantine every 'eject' match (merge into quarantine.json)
 *              and purge its card + evidence, then exit 0. Auditable + reversible
 *              (quarantine.json restore). The pipeline uses this by default.
 *   --report   list matches and exit 0; change nothing.
 *
 * 'review' matches are always printed as warnings and NEVER auto-ejected (they
 * are low-precision — legitimate technical sessions mention "cv"/"salary" too).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config, stateDir } from "./lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const mode = has("enforce") ? "enforce" : has("report") ? "report" : "gate";

// ------------------------------------------------------------------- patterns
function loadPatterns() {
  const file = opt("patterns") || path.join(__dirname, "privacy_patterns.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const compile = (arr) => (arr || []).map((p) => ({ src: p, re: new RegExp(p, "i") }));
  return { file, eject: compile(raw.eject), review: compile(raw.review) };
}

// --------------------------------------------------------------------- corpus
const cardsDir = () => stateDir("cards");
const evidenceDir = () => stateDir("evidence");
const quarantinePath = () => stateDir("quarantine.json");

function sidList() {
  const sids = new Set();
  for (const dir of [cardsDir(), evidenceDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".meta.json")) continue;
      sids.add(f.replace(/\.(json|md)$/, ""));
    }
  }
  return [...sids];
}

// The scannable text for a session: every card field value + the raw evidence.
function textFor(sid) {
  let text = "";
  const card = path.join(cardsDir(), `${sid}.json`);
  if (fs.existsSync(card)) {
    try {
      text += Object.values(JSON.parse(fs.readFileSync(card, "utf8")))
        .map(String)
        .join("\n");
    } catch {
      text += fs.readFileSync(card, "utf8");
    }
  }
  const ev = path.join(evidenceDir(), `${sid}.md`);
  if (fs.existsSync(ev)) text += "\n" + fs.readFileSync(ev, "utf8");
  return text;
}

function readQuarantine() {
  try {
    return JSON.parse(fs.readFileSync(quarantinePath(), "utf8"));
  } catch {
    return { sids: [] };
  }
}

function firstMatch(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) {
      const at = Math.max(0, m.index - 25);
      return {
        pattern: p.src,
        snippet: text
          .slice(at, m.index + m[0].length + 25)
          .replace(/\s+/g, " ")
          .trim()
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------------ run
function main() {
  const { file, eject, review } = loadPatterns();
  const already = new Set(readQuarantine().sids || []);
  const sids = sidList().filter((s) => !already.has(s));
  console.log(
    `[privacy] mode=${mode} · workspace=${config.WORKSPACE} · patterns=${path.basename(file)} · scanning ${sids.length} sessions (${already.size} already quarantined)`
  );

  const ejectHits = [];
  const reviewHits = [];
  for (const sid of sids) {
    const text = textFor(sid);
    if (!text) continue;
    const e = firstMatch(text, eject);
    if (e) {
      ejectHits.push({ sid, ...e });
      continue; // an eject match settles it; don't also list under review
    }
    const r = firstMatch(text, review);
    if (r) reviewHits.push({ sid, ...r });
  }

  if (reviewHits.length) {
    console.log(`\n[privacy] ${reviewHits.length} REVIEW (not auto-ejected — inspect):`);
    for (const h of reviewHits)
      console.log(`  ? ${h.sid.slice(0, 12)} · /${h.pattern}/ · "${h.snippet.slice(0, 80)}"`);
  }

  if (!ejectHits.length) {
    console.log(`\n[privacy] PASS — no 'eject' matches in ${sids.length} sessions.`);
    process.exit(0);
  }

  console.log(`\n[privacy] ${ejectHits.length} EJECT match(es):`);
  for (const h of ejectHits)
    console.log(`  ✗ ${h.sid.slice(0, 12)} · /${h.pattern}/ · "${h.snippet.slice(0, 80)}"`);

  if (mode === "report") {
    console.log("\n[privacy] --report: nothing changed.");
    process.exit(0);
  }
  if (mode === "gate") {
    console.error(
      `\n[privacy] GATE FAILED — ${ejectHits.length} session(s) contain personal/CV/PII content and would reach the graph.\n` +
        `Review, then re-run with --enforce to quarantine them (or add their sids to quarantine.json by hand).`
    );
    process.exit(3);
  }

  // enforce: merge into quarantine.json + purge card/evidence.
  const q = readQuarantine();
  const sidsSet = new Set(q.sids || []);
  const ejectSids = ejectHits.map((h) => h.sid);
  for (const s of ejectSids) sidsSet.add(s);
  q.sids = [...sidsSet];
  q.reason =
    (q.reason ? q.reason + " " : "") +
    `[privacy_gate ${new Date().toISOString().slice(0, 10)}: +${ejectSids.length} content-level]`;
  fs.writeFileSync(quarantinePath(), JSON.stringify(q, null, 1));
  let purged = 0;
  for (const sid of ejectSids) {
    for (const rel of [
      `cards/${sid}.json`,
      `cards/${sid}.meta.json`,
      `evidence/${sid}.md`,
      `evidence/${sid}.meta.json`
    ]) {
      const p = stateDir(rel);
      if (fs.existsSync(p)) {
        fs.rmSync(p);
        purged++;
      }
    }
  }
  console.log(
    `\n[privacy] ENFORCED — quarantined ${ejectSids.length} session(s), purged ${purged} card/evidence files. quarantine.json now holds ${q.sids.length} sids.`
  );
  process.exit(0);
}

main();
