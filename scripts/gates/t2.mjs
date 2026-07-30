#!/usr/bin/env node
// Gate T2 — a clean, split, house-voiced training set exists.
//
// Validates the built dataset (scripts/train/dataset/): both SFT streams exist and
// are schema-valid, the held-out split is disjoint from train, and the leak gate
// reports ZERO personal-context hits across every emitted row. Build it first with
//   node scripts/train/build_dataset.mjs
//
// verify: node scripts/gates/t2.mjs   (exit 0 = green)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateRow } from "../train/lib/schema.mjs";
import { loadTerms, scanForLeaks } from "../train/lib/privacy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DS = path.resolve(
  process.env.T2_DATASET_DIR || path.join(ROOT, "scripts", "train", "dataset")
);

// The generated rows carry real internal session traces and are git-ignored
// (kept local by design). If they're absent, build them first from the local
// clone so the single verify command works on the trainer. On a box without the
// clone the build yields no rows and the gate fails honestly (empty_stream).
if (!fs.existsSync(path.join(DS, "manifest.json"))) {
  console.log("[t2] dataset absent — building from the local corpus first…");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "train", "build_dataset.mjs")], {
      stdio: "inherit"
    });
  } catch (e) {
    console.log(`[t2] reason=build_failed — ${e.message}`);
    console.log("[t2] GATE RED");
    process.exit(1);
  }
}
const FILES = {
  A: ["stream_a.train.jsonl", "stream_a.eval.jsonl"],
  B: ["stream_b.train.jsonl", "stream_b.eval.jsonl"]
};

function fail(reason, detail = "") {
  console.log(`[t2] reason=${reason}${detail ? " — " + detail : ""}`);
  console.log("[t2] GATE RED");
  process.exit(1);
}
const readJSONL = (p) =>
  fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        fail("bad_jsonl", `${path.basename(p)} line ${i + 1}: ${e.message}`);
      }
    });

if (!fs.existsSync(path.join(DS, "manifest.json")))
  fail("no_dataset", `run build_dataset.mjs first (${DS})`);

// Every file present, every row schema-valid; collect train/eval ids per stream.
const idsByStream = {
  A: { train: new Set(), eval: new Set() },
  B: { train: new Set(), eval: new Set() }
};
let total = 0;
const allFiles = [];
for (const [stream, names] of Object.entries(FILES)) {
  let streamRows = 0;
  for (const name of names) {
    const p = path.join(DS, name);
    if (!fs.existsSync(p)) fail("missing_file", name);
    allFiles.push(p);
    const split = name.includes(".train.") ? "train" : "eval";
    for (const row of readJSONL(p)) {
      const v = validateRow(row);
      if (!v.ok) fail("schema_invalid", `${name} id=${row?.id}: ${v.errors.join("; ")}`);
      if (row.stream !== stream) fail("stream_mismatch", `${name} has stream ${row.stream}`);
      idsByStream[stream][split].add(row.id);
      streamRows++;
      total++;
    }
  }
  if (streamRows === 0) fail("empty_stream", `stream ${stream} has no rows`);
}

// Held-out must be disjoint from train (per stream).
for (const s of ["A", "B"]) {
  const overlap = [...idsByStream[s].eval].filter((id) => idsByStream[s].train.has(id));
  if (overlap.length)
    fail("split_not_disjoint", `stream ${s}: ${overlap.length} ids in both (e.g. ${overlap[0]})`);
}

// Authoritative leak scan over every emitted row.
const spec = loadTerms();
const leaks = scanForLeaks({ files: allFiles, terms: spec.terms, sids: spec.sids });
if (leaks.length)
  fail(
    "leak",
    `${leaks.length} personal-context hits (e.g. ${leaks[0].file && path.basename(leaks[0].file)} [${leaks[0].term}])`
  );

console.log(
  `[t2] streams: A=${idsByStream.A.train.size}+${idsByStream.A.eval.size} B=${idsByStream.B.train.size}+${idsByStream.B.eval.size} | ` +
    `total ${total} rows | split disjoint | leak-gate 0 hits (${spec.terms.length} terms / ${spec.sids.length} sids)`
);
console.log(
  "[t2] evidence " +
    JSON.stringify({
      A_train: idsByStream.A.train.size,
      A_eval: idsByStream.A.eval.size,
      B_train: idsByStream.B.train.size,
      B_eval: idsByStream.B.eval.size,
      leaks: leaks.length
    })
);
console.log("[t2] GATE GREEN");
