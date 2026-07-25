#!/usr/bin/env node
// T2 — build the instruction + trajectory SFT dataset from the local corpus.
//
//   node scripts/train/build_dataset.mjs [--out <dir>]
//
// Reads the T1 clone (LONGVIEW cards + memo-ray traces) + repo ADRs, emits two
// leak-gated SFT streams with a disjoint held-out split, and a manifest. No LLM,
// no network, no fine-tune (that's T3) — data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { readCards, readADRs, readTraceEntities, makeEntityLoader } from "./lib/corpus.mjs";
import { buildStreamA, traceToRows } from "./lib/streams.mjs";
import {
  readJsonCards,
  readQuarantinedSids,
  readLogEntries,
  readContracts,
  readMethodDocs,
  readProse,
  readThoughts,
} from "./lib/corpus_v3.mjs";
import {
  jsonCardToPairs,
  logToPairs,
  contractToPairs,
  docToPairs,
  proseToPairs,
  thoughtToPairs,
} from "./lib/streams_v3.mjs";
import { splitRows } from "./lib/split.mjs";
import { validateRow } from "./lib/schema.mjs";
import { loadTerms, makeDetector, scanForLeaks } from "./lib/privacy.mjs";
import { guardHouseRows } from "./lib/authorship_cap.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { resolveHome } = require(path.join(ROOT, "packaging", "desktop", "home_resolver.js"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const OUT = path.resolve(arg("--out", path.join(ROOT, "scripts", "train", "dataset")));

function writeJSONL(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

// L11: recorded verifier passes (frozen-rubric or frontier sign-off) — an optional {sids:[...]} file
// pointed to by T2_HOUSE_VERIFIER_PASSES. Absent = no house session is pre-verified (empty set).
function readVerifierPasses() {
  const p = (process.env.T2_HOUSE_VERIFIER_PASSES || "").trim();
  if (!p || !fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).sids || [];
  } catch {
    return [];
  }
}

function main() {
  const home = resolveHome();
  const memDir = (process.env.MEMORAY_DATA_DIR || "").trim() || path.join(os.homedir(), ".mem0ray", "data");
  fs.mkdirSync(OUT, { recursive: true });

  // sessions_v1: the big LONGVIEW workspace (376 JSON cards + curated prose) — v3 Lever 1.
  const sessionsWs = (process.env.T2_SESSIONS_WS || "").trim() ||
    "D:\\benny-home\\benny\\workspaces\\sessions_v1";
  const sessionsLongview = path.join(sessionsWs, "longview");
  const sessionsDataOut = path.join(sessionsWs, "data_out");

  const spec = loadTerms({ home: home.root });
  // Structural privacy: quarantined sids from the sessions workspace join the leak-gate
  // sid list (previously term-matching only, sids: 0).
  for (const sid of readQuarantinedSids(sessionsLongview))
    if (!spec.sids.includes(sid)) spec.sids.push(sid);
  const detector = makeDetector(spec);

  // Stream A — method/voice from cards + ADRs (T2 core) + v3 sources (DATA-PLAN-v3 L1).
  const cards = readCards(home.bennyHome);
  const adrs = readADRs(ROOT);
  const a = buildStreamA(cards, adrs, { detector });

  const v3Counts = {};
  const addA = (label, pairs) => {
    let kept = 0;
    for (const p of pairs) {
      const flat = `${p.instruction}\n${p.response}\n${p.source.sid || ""}`;
      if (detector(flat)) {
        a.excluded.personal++;
        continue;
      }
      a.rows.push(p);
      kept++;
    }
    v3Counts[label] = kept;
  };
  addA("jsoncards", readJsonCards(sessionsLongview).flatMap(jsonCardToPairs));
  addA("log", readLogEntries(ROOT).flatMap(logToPairs));
  addA("contracts", readContracts(ROOT).flatMap(contractToPairs));
  addA("docs", readMethodDocs(ROOT).flatMap(docToPairs));
  addA("prose", readProse(sessionsDataOut).flatMap(proseToPairs));
  const thoughtMax = Number(process.env.T2_THOUGHT_MAX_ROWS) || 500;
  addA(
    "thoughts",
    readThoughts(memDir).flatMap(thoughtToPairs).slice(0, thoughtMax)
  );

  // Stream B — agent tool-use trajectories from memo-ray traces.
  const entities = readTraceEntities(memDir);
  const b = traceToRows(entities, { detector, getEntity: makeEntityLoader(memDir) });

  // L11 model-collapse guard (R38): house-authored sessions train only after a verifier pass, and
  // house-origin rows are fraction-capped per turn — so dogfooding (§8) never distils self-output.
  // Untagged rows default to non-house (the owner corpus), so this is a no-op until L6-tagged house
  // dogfood rows arrive. Verifier passes: an optional {sids:[...]} file; cap: a per-turn fraction.
  const verifiedSids = new Set(readVerifierPasses());
  const capFraction = process.env.T2_HOUSE_CAP_FRACTION != null ? Number(process.env.T2_HOUSE_CAP_FRACTION) : 0.5;
  const guardA = guardHouseRows(a.rows, { verifiedSids, capFraction });
  const guardB = guardHouseRows(b.rows, { verifiedSids, capFraction });
  a.rows = guardA.kept;
  b.rows = guardB.kept;

  // Validate every row up front — a malformed row is a builder bug, not output.
  for (const r of [...a.rows, ...b.rows]) {
    const v = validateRow(r);
    if (!v.ok) throw new Error(`invalid ${r.stream} row ${r.id}: ${v.errors.join("; ")}`);
  }

  // Carve the disjoint held-out split per stream (before any training).
  const splitA = splitRows(a.rows);
  const splitB = splitRows(b.rows);

  const files = {
    "stream_a.train.jsonl": splitA.train,
    "stream_a.eval.jsonl": splitA.eval,
    "stream_b.train.jsonl": splitB.train,
    "stream_b.eval.jsonl": splitB.eval,
  };
  for (const [name, rows] of Object.entries(files)) writeJSONL(path.join(OUT, name), rows);

  // Authoritative leak scan over the emitted files (the same gate the deliverable
  // pipeline uses) — defence in depth behind the build-time detector.
  const leaks = scanForLeaks({
    files: Object.keys(files).map((f) => path.join(OUT, f)),
    terms: spec.terms,
    sids: spec.sids,
  });

  const manifest = {
    generated: new Date().toISOString(),
    source: {
      home: home.root,
      cards: cards.length,
      adrs: adrs.length,
      sessions_ws: sessionsWs,
      a_v3: v3Counts,
      trace_entities_loaded: entities.size,
      memo_ray: memDir,
    },
    streams: {
      A: { train: splitA.train.length, eval: splitA.eval.length, excluded_personal: a.excluded.personal },
      B: {
        train: splitB.train.length,
        eval: splitB.eval.length,
        excluded_personal: b.excluded.personal,
        excluded_unparsed: b.excluded.unparsed,
        excluded_dedup: b.excluded.dedup,
        excluded_tool_capped: b.excluded.tool_capped,
        chain_rows: b.rows.filter((r) => r.source.variant === "chain").length,
      },
    },
    eval_pct: splitA.evalPct,
    privacy: { terms: spec.terms.length, sids: spec.sids.length, leak_findings: leaks.length },
    collapse_guard: {
      cap_fraction: capFraction,
      verifier_passes: verifiedSids.size,
      excluded_unverified_house: guardA.excluded_unverified + guardB.excluded_unverified,
      capped_house: guardA.capped + guardB.capped,
    },
    total_rows: a.rows.length + b.rows.length,
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `[build_dataset] A: ${splitA.train.length}+${splitA.eval.length} (excl ${a.excluded.personal}) | ` +
      `B: ${splitB.train.length}+${splitB.eval.length} (excl ${b.excluded.personal}) | ` +
      `leaks: ${leaks.length} | out: ${OUT}`
  );
  if (leaks.length) {
    console.error("[build_dataset] LEAK FINDINGS — refusing to bless output");
    process.exit(2);
  }
}

main();
