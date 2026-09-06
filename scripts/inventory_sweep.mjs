#!/usr/bin/env node
// Estate inventory sweep — look at the world, then hold the ledger to it.
//
// orphan-artifact and unrecorded-action have been NOT MEASURABLE since the evidence pack was
// written, because neither can be counted from inside the log. This is the outside look.
//
// The sweep itself becomes evidence: the snapshot is stored in the CAS (so the numbers in the
// pack can be re-derived from the exact observation that produced them, not from a re-run that
// would see a different disk), and a `sweep_recorded` event carries the counts and the scope.
// An audit finding whose underlying observation cannot be retrieved is an assertion.
//
// Usage:
//   node scripts/inventory_sweep.mjs [--root F:/estate-store] [--include <dir> ...]
//                                    [--record] [--json] [--quiet]
//
//   --record   append a sweep_recorded event and store the snapshot in the CAS.
//              Without it the sweep only looks and reports — safe to run any time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepEstate, reconcile, subjectId } from "../server/coordination/lib/inventory.mjs";
import { collectLedgers } from "../server/coordination/lib/evidence.mjs";
import { casStore } from "../server/coordination/lib/staging.mjs";
import { appendKelEvent, ulid, CURRENT_SCHEMA_VERSION } from "../server/coordination/lib/kel.mjs";

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const args = (n) => argv.reduce((a, v, i) => (argv[i - 1] === `--${n}` ? [...a, v] : a), []);
const has = (n) => argv.includes(`--${n}`);

const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const MACHINE = String(process.env.COMPUTERNAME || os.hostname() || "unknown").toLowerCase();
const QUIET = has("quiet") || has("json");

if (!fs.existsSync(ROOT)) {
  console.error(`no estate store at ${ROOT} — pass --root or set ESTATE_STORE`);
  process.exit(2);
}

const inventory = sweepEstate(ROOT, { include: args("include") });
const ledgers = collectLedgers(ROOT);

// A reconciliation against a ledger that does not verify is not evidence of anything: the
// claims it is checking may themselves have been edited. Say so and stop rather than
// producing numbers that look authoritative.
const broken = ledgers.filter((l) => !l.ok);
if (broken.length) {
  console.error(
    `refusing to reconcile: ${broken.length} ledger(s) do not verify — ` +
      broken.map((b) => `${b.name}@${b.badLine}`).join(", ")
  );
  process.exit(1);
}

const events = ledgers.flatMap((l) => l.events);
const result = reconcile(inventory, events);

const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;
const say = (...m) => {
  if (!QUIET) console.log(...m);
};

say(`Estate inventory sweep — ${MACHINE} — ${result.swept_at}`);
say(`\nScope (this is the boundary every number below is true within):`);
for (const r of inventory.scope.roots) say(`  ${r.exists ? "walked " : "ABSENT "} ${r.path}`);
say(
  `\nObserved: ${result.counts.blobs_held} blob(s), ${result.counts.files_seen} file(s)` +
    ` · ledger claims ${result.counts.placements_claimed} placement(s)` +
    ` (${result.counts.placements_in_scope} in scope, ${result.counts.placements_unseen} unseen)`
);

say(`\norphan-artifact — bytes on disk nothing accounts for`);
if (result.orphans.count === 0) say(`  none in scope`);
else {
  say(`  ${result.orphans.count} object(s), ${mb(result.orphans.bytes)}`);
  for (const b of result.orphans.blobs.slice(0, 10)) say(`    blob ${b.hash} (${mb(b.size)})`);
  for (const f of result.orphans.files.slice(0, 10)) say(`    file ${f.path} (${mb(f.size)})`);
}

say(`\nunrecorded-action — the ledger asserts it; the disk disagrees`);
if (result.unrecorded.count === 0) say(`  none in scope`);
else {
  for (const p of result.unrecorded.missing_placements)
    say(`    placement gone: ${p.path} (${p.machine}, claimed ${p.at})`);
  for (const b of result.unrecorded.missing_blobs) say(`    blob missing: ${b.hash}`);
}

// Reported on its own, never folded into either verdict above.
if (result.unseen.length) {
  say(`\nUnseen — outside this sweep's reach, neither present nor missing:`);
  for (const c of result.unseen) say(`    ${c.machine}: ${c.path}`);
  say(`  Run a sweep on that node, or pass --include, to bring these into scope.`);
}

if (has("record")) {
  // The snapshot goes into the CAS first, so the event can point at the exact bytes it
  // summarises. Recording counts without the observation behind them would leave a finding
  // no one can re-check.
  const snapshot = casStore(ROOT, Buffer.from(JSON.stringify({ inventory, result }, null, 2)));
  const at = result.swept_at;
  const sid = subjectId.sweep(MACHINE, at);
  const evt = {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "sweep_recorded",
    valid_time: at,
    txn_time: new Date().toISOString(),
    time_confidence: "known", // the sweep observed the disk at a time we actually know
    hlc: `${at}-0000-${MACHINE}`,
    machine: MACHINE,
    authorship: "house", // deterministic observation, not judgement (R38)
    sid,
    subject: { kind: "sweep", id: sid },
    payload: {
      scope: inventory.scope.walked,
      counts: result.counts,
      orphans: { count: result.orphans.count, bytes: result.orphans.bytes },
      unrecorded: result.unrecorded.count,
      unseen: result.unseen.length,
      snapshot: `sha256:${snapshot.hash}`
    }
  };
  const res = appendKelEvent(path.join(ROOT, "eventlog", "inventory.jsonl"), evt);
  if (!res.ok) {
    console.error(`failed to record the sweep: ${res.reason}`);
    process.exit(1);
  }
  say(`\nrecorded ${sid}\n  snapshot sha256:${snapshot.hash}`);
}

if (has("json")) console.log(JSON.stringify(result, null, 2));

// Exit code is the headline, matching evidence_pack.mjs: non-zero when the estate and the
// ledger disagree. Unseen placements do not fail the run — not looking is not a defect, it
// is a smaller scope, and it is already printed.
process.exit(result.orphans.count + result.unrecorded.count > 0 ? 1 : 0);
