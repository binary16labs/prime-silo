#!/usr/bin/env node
// The estate board — every node's heartbeat, folded into one view.
//
// Each node writes its own hash-chained log (they must: concatenating two chains breaks
// every `prev` from the join onward). This pulls the remote ones over SSH into a local
// `collected/` directory, verifies each chain SEPARATELY, and folds only the view.
//
// A node's log tells you what its services were doing. Its state file tells you whether the
// node is still LOOKING. Both are collected, because "benny up" in a log that stopped
// updating yesterday is not the same claim as "benny up now" — and the difference is
// exactly the failure this whole subsystem exists to catch.
//
// Usage:
//   node scripts/heartbeat_estate.mjs                       # local only
//   node scripts/heartbeat_estate.mjs --pull optimus=nsdha@100.85.245.86:C:/estate-store
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { estateBoard } from "../server/coordination/lib/heartbeat.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const pulls = argv.reduce((acc, a, i) => (argv[i - 1] === "--pull" ? [...acc, a] : acc), []);

const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const COLLECTED = path.join(ROOT, "collected");

const readJSON = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};

// Pull a remote node's log + state over SSH. `type` rather than `cat` because the far side
// is Windows; output is captured rather than streamed so a partial transfer never lands as
// a truncated log that would then fail its own chain check for the wrong reason.
function pull(spec) {
  const [machine, target] = spec.split("=");
  // The FIRST colon separates host from path. lastIndexOf() is wrong here because a Windows
  // remote root contains its own colon (C:/estate-store) and would be split mid-drive.
  const at = target.indexOf(":");
  const host = target.slice(0, at);
  const remoteRoot = target.slice(at + 1).replace(/\\/g, "/");
  fs.mkdirSync(COLLECTED, { recursive: true });

  const grab = (remote, local) => {
    try {
      const out = execFileSync(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host, `Get-Content -Raw '${remote}'`],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
      );
      fs.writeFileSync(local, out.replace(/\r\n/g, "\n"));
      return true;
    } catch (e) {
      console.error(
        `  ! could not pull ${remote} from ${machine}: ${(e.message || "").split("\n")[0]}`
      );
      return false;
    }
  };

  const okLog = grab(
    `${remoteRoot}/eventlog/heartbeat-${machine}.jsonl`,
    path.join(COLLECTED, `heartbeat-${machine}.jsonl`)
  );
  grab(
    `${remoteRoot}/state/heartbeat-${machine}.json`,
    path.join(COLLECTED, `heartbeat-${machine}.json`)
  );
  return okLog;
}

// A node we FAILED to collect must not simply be absent from the board. Absence reading as
// health is the precise failure this whole subsystem exists to prevent, so an unreachable
// node is carried through as a blind spot instead of quietly disappearing.
const unreachable = [];
for (const spec of pulls) {
  const machine = spec.split("=")[0];
  process.stdout.write(`pulling ${machine} … `);
  const ok = pull(spec);
  process.stdout.write(ok ? "ok\n" : "FAILED\n");
  if (!ok) unreachable.push(machine);
}

// Local logs first, then anything collected from elsewhere.
const sources = [];
const states = {};
const addLog = (file, stateFile) => {
  const m = path.basename(file).match(/^heartbeat-(.+)\.jsonl$/);
  if (!m) return;
  const machine = m[1];
  const { ok, events, badLine } = readKelEvents(file);
  sources.push({ machine, events, ok, badLine });
  const st = readJSON(stateFile, null);
  if (st) states[machine] = st;
};

for (const dir of [path.join(ROOT, "eventlog"), COLLECTED]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /^heartbeat-.+\.jsonl$/.test(x))) {
    const machine = f.replace(/^heartbeat-|\.jsonl$/g, "");
    const stateFile =
      dir === COLLECTED
        ? path.join(COLLECTED, `heartbeat-${machine}.json`)
        : path.join(ROOT, "state", `heartbeat-${machine}.json`);
    addLog(path.join(dir, f), stateFile);
  }
}

// carry the uncollectable nodes into the board so they appear, and appear as unknown
for (const machine of unreachable) {
  if (!sources.some((s) => s.machine === machine)) {
    sources.push({ machine, events: [], ok: true, badLine: null });
    states[machine] = { last_run: null }; // never run, from here — reads as stale, not healthy
  }
}

const board = estateBoard(sources, states);

const age = (ms) =>
  ms == null ? "never" : ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;

// Built as text rather than printed directly, so a scheduled run can persist the board.
// A collector whose only output is stdout leaves nothing behind when nobody is watching —
// which is the same "no evidence" problem the heartbeat itself exists to solve.
const out = [];
const say = (line = "") => out.push(line);

say("ESTATE BOARD  " + new Date().toISOString());
say("-".repeat(66));
say("nodes");
for (const n of board.nodes) {
  const flag = !n.chainOk ? "CHAIN BROKEN" : n.stale ? `STALE (${n.reason})` : "watching";
  say(
    `  ${n.machine.padEnd(16)} ${flag.padEnd(22)} last sweep ${age(n.ageMs)} ago  ${n.events} events`
  );
}

say("");
say("services");
const svc = board.health.filter((h) => h.service);
for (const h of svc.sort((a, b) => a.key.localeCompare(b.key))) {
  say(
    `  ${h.key.padEnd(28)} ${(h.up ? "up" : "DOWN").padEnd(6)} since ${h.since}  (via ${h.observed_by || "?"})`
  );
}

say("");
if (board.anyBroken)
  say("!! a log failed its chain check — its events are EXCLUDED from this board");
say(
  board.outages.length === 0
    ? "no outages"
    : `OUTAGES: ${board.outages.map((o) => `${o.key} for ${age(o.downMs)}`).join(", ")}`
);
// A stale node is not good news; it is no news. Exit non-zero so a caller can react.
const blind = board.nodes.filter((n) => n.stale || !n.chainOk);
if (blind.length) say(`blind spots: ${blind.map((n) => n.machine).join(", ")}`);

const text = out.join("\n") + "\n";
if (!argv.includes("--quiet")) console.log("\n" + text);

const outFile = arg("out", null);
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
  if (!argv.includes("--quiet")) console.log(`written to ${outFile}`);
}

process.exit(board.outages.length || blind.length ? 1 : 0);
