#!/usr/bin/env node
// DATA-PLAN-v3 Lever 4: emit the stratified gold-audit sample for OWNER hand-review.
//
//   node scripts/train/audit_sample.mjs [--n 200] [--out dataset/gold_sample.jsonl]
//
// Deterministic (FNV-1a ordering, no RNG): the same dataset always yields the same
// sample. Stratified proportionally per (stream, source.type) cell with a floor of
// 3 rows per non-empty cell so small sources (adr, doc) are always represented.
// The owner reviews the emitted file; corrections become exclusion rules in the
// builder (never hand-edits to generated rows).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fnv } from "./lib/streams_v3.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const N = Number(arg("--n", 200));
const DATASET = path.join(HERE, "dataset");
const OUT = path.resolve(arg("--out", path.join(DATASET, "gold_sample.jsonl")));

const rows = [];
for (const f of [
  "stream_a.train.jsonl",
  "stream_a.eval.jsonl",
  "stream_b.train.jsonl",
  "stream_b.eval.jsonl"
]) {
  const p = path.join(DATASET, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (line.trim()) rows.push({ ...JSON.parse(line), _file: f });
  }
}
if (!rows.length) {
  console.error("[audit_sample] no dataset rows found — build first");
  process.exit(1);
}

// Group by (stream, source.type); order rows within a cell by FNV of id (deterministic shuffle).
const cells = new Map();
for (const r of rows) {
  const key = `${r.stream}:${r.source?.type || "?"}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(r);
}
for (const list of cells.values()) list.sort((x, y) => fnv(x.id) - fnv(y.id));

const FLOOR = 3;
const total = rows.length;
const sample = [];
for (const [key, list] of [...cells.entries()].sort()) {
  const proportional = Math.round((list.length / total) * N);
  const take = Math.min(list.length, Math.max(FLOOR, proportional));
  sample.push(...list.slice(0, take));
}
// Trim overshoot deterministically (largest cells lose first via interleave order).
sample.sort((x, y) => fnv(x.id) - fnv(y.id));
const final = sample.slice(0, N);

fs.writeFileSync(OUT, final.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

const byCell = {};
for (const r of final) {
  const key = `${r.stream}:${r.source?.type}`;
  byCell[key] = (byCell[key] || 0) + 1;
}
console.log(`[audit_sample] ${final.length} rows -> ${OUT}`);
console.log(`[audit_sample] strata:`, JSON.stringify(byCell));
console.log(
  "[audit_sample] OWNER: review each row — mark bad ones and report back; " +
    "fixes become builder exclusion rules, never hand-edits to generated files."
);
