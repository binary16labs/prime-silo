#!/usr/bin/env node
// One heartbeat sweep. Designed to be run on a schedule and to do nothing interesting
// most of the time.
//
// Two things this script gets right on purpose:
//
//   PER-MACHINE LOGS. The KEL is a hash chain — `prev` is the hash of the previous line —
//   so two nodes appending to one file over a share would interleave and corrupt it. Each
//   node owns `eventlog/heartbeat-<machine>.jsonl`; health is a fold over all of them.
//
//   ITS OWN LIVENESS. A heartbeat that has stopped running looks exactly like an estate
//   with nothing wrong. So every sweep stamps `last_run` into the state file, and
//   isHeartbeatStale() turns "no news" into "no news since 09:14" — which is the difference
//   between good news and no information.
//
// Usage:  node scripts/heartbeat_run.mjs [--root F:\estate-store] [--machine t480] [--quiet]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sweep,
  recordHeartbeat,
  localTargets,
  estateTargets,
  ESTATE_TARGETS,
  outages,
  isHeartbeatStale
} from "../server/coordination/lib/heartbeat.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const quiet = process.argv.includes("--quiet");

const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const MACHINE = (arg("machine", os.hostname()) || "unknown").toLowerCase();

const statePath = path.join(ROOT, "state", `heartbeat-${MACHINE}.json`);
const logPath = path.join(ROOT, "eventlog", `heartbeat-${MACHINE}.jsonl`);
const trailPath = path.join(ROOT, "logs", `heartbeat-${MACHINE}.log`);

const readJSON = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};

// A short human trail, capped. Its job is to show the scheduler is alive at all — the
// events file stays quiet by design, so without this a dead task and a healthy estate
// produce identical evidence on disk.
function appendTrail(line, keep = 2000) {
  try {
    fs.mkdirSync(path.dirname(trailPath), { recursive: true });
    const prior = fs.existsSync(trailPath)
      ? fs.readFileSync(trailPath, "utf8").split("\n").filter(Boolean)
      : [];
    prior.push(line);
    fs.writeFileSync(trailPath, prior.slice(-keep).join("\n") + "\n");
  } catch {
    /* the trail is a convenience; never let it fail a sweep */
  }
}

const prior = readJSON(statePath, { state: {}, last_run: null });

// What this node can honestly observe: itself over loopback (benny and neo4j bind
// loopback by deliberate default), plus whatever genuinely listens off-box elsewhere.
const targets = [
  ...localTargets(MACHINE, ESTATE_TARGETS),
  ...estateTargets(ESTATE_TARGETS, { exclude: MACHINE })
];

if (targets.length === 0) {
  const msg = `${new Date().toISOString()} ${MACHINE} — no targets; is this machine in ESTATE_TARGETS?`;
  appendTrail(msg);
  if (!quiet) console.error(msg);
  process.exit(2);
}

const current = await sweep(targets);
const {
  transitions,
  events,
  quiet: unchanged
} = recordHeartbeat(logPath, prior.state, current, {
  observer: MACHINE
});

const now = new Date().toISOString();
fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(
  statePath,
  JSON.stringify({ state: current, last_run: now, machine: MACHINE }, null, 2) + "\n"
);

const down = Object.values(current).filter((s) => s.service && !s.up);
const staleBefore = isHeartbeatStale(prior, { now: new Date() });

// ASCII only: this trail is read by cmd, PowerShell, Task Scheduler and humans, and a
// UTF-8 separator comes back as mojibake in half of them.
const summary =
  `${now} ${MACHINE} | ${Object.keys(current).length} probes | ` +
  `${transitions.length} transition${transitions.length === 1 ? "" : "s"} | ` +
  (down.length ? `DOWN: ${down.map((d) => `${d.machine}/${d.service}`).join(", ")}` : "all up") +
  (staleBefore.stale && prior.last_run
    ? ` | [gap: sweeps had stopped for ${Math.round(staleBefore.ageMs / 60000)}m]`
    : "");

appendTrail(summary);
if (!quiet) {
  console.log(summary);
  for (const t of transitions)
    console.log(`  ${t.key}: ${t.from} → ${t.to}${t.reason ? ` (${t.reason})` : ""}`);
  if (unchanged) console.log("  (nothing changed — no events written)");
}

// Exit code carries the headline so a scheduler or a wrapper can react without parsing:
// 0 = all good, 1 = something is down. Never throw for a probe failure; that is data.
process.exit(outages(readEvents(logPath)).length > 0 || down.length > 0 ? 1 : 0);

function readEvents(p) {
  try {
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
