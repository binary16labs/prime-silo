#!/usr/bin/env node
// NAS catalog CLI — scan the shared drive into the catalog and the estate event log, and query it.
//
// Runs on the machine that owns the disk (the T480), on a schedule, so the record keeps itself.
// Clients never run `scan`: they drop a receipt into <share>/.receipts and the next scan folds
// it in (see estate/nas-client.ps1).
//
// Usage:
//   node scripts/nas_catalog.mjs scan   [--share F:/nas] [--root F:/estate-store] [--machine t480] [--quiet]
//   node scripts/nas_catalog.mjs find   <text> [--category models] [--hash <sha256-prefix>] [--json]
//   node scripts/nas_catalog.mjs stats  [--json]
//   node scripts/nas_catalog.mjs verify
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanNas,
  findFiles,
  catalogStats,
  catalogDir,
  nasLogFile,
  NAS_CATEGORIES
} from "../server/coordination/lib/nas_catalog.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";

const argv = process.argv.slice(2);
const command = argv[0];
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const quiet = has("quiet");
const say = (...m) => {
  if (!quiet) console.log(...m);
};

const SHARE = arg("share", process.env.NAS_SHARE || "F:/nas");
const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const MACHINE = (arg("machine", os.hostname()) || "unknown").toLowerCase();
const DB = path.join(catalogDir(ROOT), "catalog.db");

const gb = (n) => `${(Number(n || 0) / 1024 ** 3).toFixed(2)} GB`;

async function main() {
  switch (command) {
    case "scan": {
      if (!fs.existsSync(SHARE)) {
        console.error(`Share root ${SHARE} does not exist. Run estate/setup-nas-share.ps1 first.`);
        process.exit(2);
      }
      for (const c of NAS_CATEGORIES) fs.mkdirSync(path.join(SHARE, c), { recursive: true });
      const r = await scanNas({
        root: SHARE,
        estateRoot: ROOT,
        machine: MACHINE,
        onProgress: quiet ? null : ({ hashing, size }) => say(`  hashing ${hashing} (${gb(size)})`)
      });
      const c = r.counts;
      say(
        `NAS scan ${r.finishedAt}: ${c.files_total} files, ${gb(c.bytes_total)} — ` +
          `+${c.added} ~${c.changed} >${c.moved} -${c.removed}, ${c.pending} still copying, ` +
          `${gb(c.bytes_hashed)} hashed, ${r.events} events → ${r.logFile}`
      );
      // A scheduled scan that runs must also be SEEN to run, or a dead scheduler looks like a
      // quiet share. Stamp last_run the same way the heartbeat does.
      const statePath = path.join(ROOT, "state", `nas-${MACHINE}.json`);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ last_run: r.finishedAt, counts: c }, null, 2) + "\n"
      );
      break;
    }
    case "find": {
      const query = argv[1] && !argv[1].startsWith("--") ? argv[1] : "";
      const rows = findFiles(DB, {
        query,
        category: arg("category", null),
        sha256: arg("hash", null)
      });
      if (has("json")) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return say("No matching files in the NAS catalog.");
      for (const r of rows)
        say(
          `${r.path}  ${gb(r.size)}  sha256:${r.sha256.slice(0, 12)}  ` +
            `${r.origin_machine ? `from ${r.origin_machine}` : "origin unrecorded"}${r.reason ? ` — ${r.reason}` : ""}`
        );
      break;
    }
    case "stats": {
      const s = catalogStats(DB);
      if (has("json")) return console.log(JSON.stringify(s, null, 2));
      say("By category:");
      for (const c of s.byCategory)
        say(`  ${c.category.padEnd(10)} ${String(c.files).padStart(7)} files  ${gb(c.bytes)}`);
      if (s.duplicates.length) {
        say("Duplicate content (same bytes at more than one path):");
        for (const d of s.duplicates)
          say(`  sha256:${d.sha256.slice(0, 12)}  ${d.copies} copies  ${gb(d.size)} each`);
      }
      say(s.lastScan ? `Last scan: ${s.lastScan.finished_at}` : "No scans recorded yet.");
      break;
    }
    case "verify": {
      const log = nasLogFile(ROOT, MACHINE);
      const r = readKelEvents(log);
      if (r.ok) say(`OK: ${log} verifies (${r.events.length} events).`);
      else {
        console.error(`BROKEN: ${log} fails at line ${r.badLine} (${r.reason}).`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error("Usage: node scripts/nas_catalog.mjs <scan|find|stats|verify> [options]");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
