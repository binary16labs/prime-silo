#!/usr/bin/env node
// Estate map benchmark (S1) — time every available file adapter on the same volumes, then time the
// whole S0 sweep with the chosen adapter, and report against the plan §7 criteria. Numbers are
// reported as measured, including a criterion that fails.
//
// Usage:
//   node scripts/estate_map_bench.mjs --volumes C:,F: [--adapters everything,wiztree,walker]
//        [--sweep] [--public-roots F:/nas,F:/media] [--out bench.json]
//
// --sweep additionally runs the full S0 runSweep (index + totals) into a temporary database with the
// adapter each volume chose (decision.chosen), because the plan's "map completes" includes indexing, not only enumeration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  everythingAdapter,
  wiztreeAdapter,
  walkerAdapter,
  recommend,
  decidedCollectors
} from "../server/coordination/lib/estate_map_files.mjs";
import { openMap, runSweep } from "../server/coordination/lib/estate_map.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const list = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const volumes = list(opt("volumes", "C:,F:"));
const wanted = new Set(list(opt("adapters", "everything,wiztree,walker")));
const adapters = [everythingAdapter(), wiztreeAdapter(), walkerAdapter()].filter((a) =>
  wanted.has(a.name)
);
const CRITERION_SECONDS = 120; // plan §7: full metadata map of C: and F: under 120 s
const SPEEDUP_WORTH_IT = 5; // plan §7: an adapter must beat the walker >= 5x on F: to earn its install

async function time(adapter, volume) {
  const started = process.hrtime.bigint();
  let files = 0;
  try {
    if (!(await adapter.available(volume)))
      return { adapter: adapter.name, volume, ok: false, errorCode: "UNAVAILABLE" };
    for await (const _ of adapter.list(volume)) files++;
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    return { adapter: adapter.name, volume, ok: true, seconds: +seconds.toFixed(2), files };
  } catch (e) {
    // a failed adapter is reported with its time, rows seen and skip counts, never selected
    const seconds = +(Number(process.hrtime.bigint() - started) / 1e9).toFixed(2);
    const errorCode = e?.code || "FAILED";
    return {
      adapter: adapter.name,
      volume,
      ok: false,
      errorCode,
      seconds,
      files,
      skipped: e?.detail
    };
  }
}

const results = [];
for (const volume of volumes)
  for (const adapter of adapters) {
    process.stderr.write(`[bench] ${adapter.name} on ${volume}... `);
    const r = await time(adapter, volume);
    results.push(r);
    process.stderr.write(
      r.ok
        ? `${r.files} files in ${r.seconds}s\n`
        : `FAILED ${r.errorCode} after ${r.files} files, ${r.seconds}s ${JSON.stringify(r.skipped ?? {})}\n`
    );
  }

const decision = recommend(results);
const enumerationTotal = decision.reduce((n, d) => n + (d.seconds ?? 0), 0);
const report = {
  host: os.hostname(),
  at: new Date().toISOString(),
  volumes,
  results,
  decision,
  criteria: {
    enumeration_seconds_all_volumes: +enumerationTotal.toFixed(2),
    speedup_worth_install: decision.map((d) => ({
      volume: d.volume,
      speedupOverWalker: d.speedupOverWalker,
      met:
        d.speedupOverWalker === null
          ? "not measured (walker not run)"
          : d.speedupOverWalker >= SPEEDUP_WORTH_IT
    }))
  }
};

if (argv.includes("--sweep")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estate-map-bench-"));
  const db = openMap(path.join(dir, "bench.db"));
  const collectors = decidedCollectors(decision, adapters);
  const started = process.hrtime.bigint();
  const sweep = await runSweep({
    db,
    machine: os.hostname().toLowerCase(),
    collectors,
    scope: volumes,
    publicRoots: list(opt("public-roots", ""))
  });
  const seconds = +(Number(process.hrtime.bigint() - started) / 1e9).toFixed(2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  report.sweep = {
    seconds,
    files: sweep.counts.files,
    collectors: sweep.collectors.map(({ name, volume, status, rows, error_code }) => ({
      name,
      volume,
      status,
      rows,
      error_code
    })),
    indexing_seconds_estimate: +(seconds - enumerationTotal).toFixed(2)
  };
  report.criteria.full_map_under_120s = { seconds, met: seconds < CRITERION_SECONDS };
}

const out = opt("out", null);
if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.criteria, null, 2));
if (report.sweep) console.log(JSON.stringify(report.sweep, null, 2));
