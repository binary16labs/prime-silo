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
import { splitRows } from "./lib/split.mjs";
import { validateRow } from "./lib/schema.mjs";
import { loadTerms, makeDetector, scanForLeaks } from "./lib/privacy.mjs";

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

function main() {
  const home = resolveHome();
  const memDir = (process.env.MEMORAY_DATA_DIR || "").trim() || path.join(os.homedir(), ".mem0ray", "data");
  fs.mkdirSync(OUT, { recursive: true });

  const spec = loadTerms({ home: home.root });
  const detector = makeDetector(spec);

  // Stream A — method/voice from cards + ADRs.
  const cards = readCards(home.bennyHome);
  const adrs = readADRs(ROOT);
  const a = buildStreamA(cards, adrs, { detector });

  // Stream B — agent tool-use trajectories from memo-ray traces.
  const entities = readTraceEntities(memDir);
  const b = traceToRows(entities, { detector, getEntity: makeEntityLoader(memDir) });

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
      },
    },
    eval_pct: splitA.evalPct,
    privacy: { terms: spec.terms.length, sids: spec.sids.length, leak_findings: leaks.length },
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
