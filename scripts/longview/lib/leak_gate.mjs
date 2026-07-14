// LONGVIEW leakage gate — the last deterministic check of the memory
// quarantine before any deliverable is shared. Scans data_out deliverables
// for sensitive terms and quarantined session ids ("(sid: ab12cd34)"
// citations) and refuses (exit 2) when anything leaks. No LLM, no network:
// a gate that can hallucinate a pass is not a gate.
//
//   node scripts/longview/lib/leak_gate.mjs --workspace <ws> --terms-file <path> [--json]
//
// terms-file: {"terms": ["cv", "t. rowe", ...], "sids": ["ab12cd34", ...]}
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- pure scan (exported so pipeline phases can gate in-process) -----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matching rule: terms shorter than 4 chars ("cv") get word boundaries
// (\bcv\b) — as plain substrings they false-positive inside ordinary words
// ("canvas", "cvs"). Terms of 4+ chars are distinctive enough to match as
// plain case-insensitive substrings, which also lets them span punctuation
// the way "t. rowe" needs. Sids are hex prefixes — always plain substrings.
function compileNeedles(terms = [], sids = []) {
  const needles = [];
  for (const t of terms) {
    const term = String(t).trim();
    if (!term) continue;
    needles.push({
      term,
      re:
        term.length < 4
          ? new RegExp(`\\b${escapeRe(term)}\\b`, "gi")
          : new RegExp(escapeRe(term), "gi")
    });
  }
  for (const s of sids) {
    const sid = String(s).trim();
    if (sid) needles.push({ term: sid, re: new RegExp(escapeRe(sid), "gi") });
  }
  return needles;
}

// 120-char excerpt centred on the hit, matched text wrapped in >>...<<.
function excerptAround(line, index, length) {
  const before = line.slice(Math.max(0, index - 50), index);
  const hit = line.slice(index, index + length);
  const after = line.slice(index + length);
  return `${before}>>${hit}<<${after}`.slice(0, 120);
}

// files: absolute paths; returns [{file, line, term, excerpt}]. Unreadable
// or binary-looking files are skipped — the gate covers text deliverables.
export function scanForLeaks({ files = [], terms = [], sids = [] }) {
  const needles = compileNeedles(terms, sids);
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary sneaked into skills/**
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const { term, re } of needles) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lines[i])) !== null) {
          findings.push({
            file,
            line: i + 1,
            term,
            excerpt: excerptAround(lines[i], m.index, m[0].length)
          });
          if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
        }
      }
    }
  }
  return findings;
}

// --- deliverable enumeration ------------------------------------------------

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // missing dirs are fine — skip silently
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// The shareable surface of a LONGVIEW run. dossiers/_private/ is the
// quarantine pen itself — its contents are private BY DESIGN, so the gate
// must not flag them.
function collectDeliverables(workspaceDir) {
  const out = workspaceDir("data_out");
  const files = [];
  for (const name of ["PORTFOLIO-REPORT.md", "PRD-WHAT-COMES-NEXT.md", "THEMES.md", "TIMELINE.md"]) {
    const p = path.join(out, name);
    if (fs.existsSync(p)) files.push(p);
  }
  const dossiers = path.join(out, "dossiers");
  files.push(
    ...walk(dossiers).filter(
      (p) =>
        p.endsWith(".md") &&
        !p.startsWith(path.join(dossiers, "_private") + path.sep)
    )
  );
  files.push(...walk(path.join(out, "skills"))); // any text file (binary skipped in scan)
  files.push(...walk(path.join(out, "book")).filter((p) => /\.(md|html)$/i.test(p)));
  files.push(
    ...walk(path.join(out, "opus", "sections")).filter(
      (p) => p.endsWith(".md") && path.dirname(p) === path.join(out, "opus", "sections")
    )
  );
  files.push(
    ...walk(path.join(out, "discovery")).filter(
      (p) => p.endsWith(".md") && path.dirname(p) === path.join(out, "discovery")
    )
  );
  return files;
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") args.workspace = argv[++i];
    else if (argv[i] === "--terms-file") args.termsFile = argv[++i];
    else if (argv[i] === "--json") args.json = true;
    else return null;
  }
  return args.workspace && args.termsFile ? args : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "usage: node scripts/longview/lib/leak_gate.mjs --workspace <ws> --terms-file <path> [--json]"
    );
    process.exit(1);
  }

  let spec;
  try {
    // strip BOM — PowerShell's default utf8 Out-File/Set-Content prepends one
    spec = JSON.parse(fs.readFileSync(args.termsFile, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    console.error(`cannot read terms file ${args.termsFile}: ${e.message}`);
    process.exit(1);
  }

  // config.mjs snapshots LONGVIEW_WORKSPACE at import time — set it BEFORE
  // the (dynamic) import or --workspace would be silently ignored, exactly
  // the manifest-override trap that bit the v2 run.
  process.env.LONGVIEW_WORKSPACE = args.workspace;
  const { workspaceDir } = await import("./config.mjs");

  const files = collectDeliverables(workspaceDir);
  const findings = scanForLeaks({
    files,
    terms: spec.terms || [],
    sids: spec.sids || []
  });

  if (args.json) {
    console.log(
      JSON.stringify({ ok: findings.length === 0, findings, files_scanned: files.length }, null, 2)
    );
  } else {
    const byFile = new Map();
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(f);
    }
    for (const [file, hits] of byFile) {
      console.log(`\n${file}`);
      for (const h of hits) console.log(`  L${h.line} [${h.term}] ${h.excerpt}`);
    }
    console.log(
      `\n${findings.length} findings in ${byFile.size} files (${files.length} files scanned)`
    );
  }
  process.exit(findings.length ? 2 : 0);
}

// Run the CLI only when executed directly — importers get scanForLeaks alone.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
