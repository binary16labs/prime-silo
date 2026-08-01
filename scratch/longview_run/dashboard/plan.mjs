// longview_v2 dashboard — PLAN pass (read-only, no LLM, no LM-host calls).
//
// Walks every session's timeline deterministically (the SAME walk the map uses) to
// get the EXACT window count per session — the denominator that turns the ETA from
// an estimate into a measured projection. Pure fs reads on the store's JSON files +
// string ops; runs safely alongside a live map (the machine is idle waiting on the
// LM host anyway). Writes plan.json to the dashboard dir — NEVER the workspace state.
//
// Run from prime-silo root, with the same env as build_v2.sh:
//   LONGVIEW_WORKSPACE, LONGVIEW_WINDOW_CHARS, MEMORAY_DATA_DIR, MEM0RAY_CLAUDE_DIRS
import fs from "fs";
import path from "path";
import { walkSessionWindows } from "../../../scripts/longview/lib/walk.mjs";

const WS = process.env.LONGVIEW_WORKSPACE || "sessions_v1";
const WIN = Number(process.env.LONGVIEW_WINDOW_CHARS || 12000);
const THIN = Number(process.env.LONGVIEW_THIN_CHARS || 200);
// Honour BENNY_HOME like collect.mjs does — the corpus moved to D:. Hardcoding the
// legacy AppData path made plan.mjs fail silently, so the dashboard kept serving
// denominators from an older backlog (map read "265/185 · 118%", windows 4742/4020),
// which reads as an inconsistent, untrustworthy console.
const BH = (process.env.BENNY_HOME || "C:/Users/nsdha/AppData/Roaming/space-agent/benny-home/benny").replace(/\\/g, "/");
const ROOT = `${BH}/workspaces/${WS}/longview`;
const DASH_DIR = "C:/Users/nsdha/OneDrive/binary16/prime-silo/scratch/longview_run/dashboard";
const OUT = path.join(DASH_DIR, "plan.json");

const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "inventory.json"), "utf8"));
const evDir = path.join(ROOT, "evidence");

const signalOf = (sid) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(evDir, `${sid}.meta.json`), "utf8")).signal_chars || 0;
  } catch {
    return 0;
  }
};

const sessions = [];
let totalWindows = 0,
  thinCount = 0,
  err = 0;
const t0 = Date.now();
for (const s of inventory) {
  const signal = signalOf(s.id);
  let windows = 0,
    thin = signal < THIN;
  if (!thin) {
    try {
      windows = walkSessionWindows({ id: s.id }, { inputChars: WIN }).windows.length;
    } catch {
      err++;
      windows = 1; // conservative: assume at least one window if the walk hiccups
    }
  }
  totalWindows += windows;
  if (thin) thinCount++;
  sessions.push({
    sid: s.id,
    agent: s.agent || "unknown",
    project: s.project || "unknown",
    title: (s.title || "").slice(0, 120),
    ts: s.timestamp || null,
    signal_chars: signal,
    windows,
    thin
  });
}

const plan = {
  generated: new Date().toISOString(),
  workspace: WS,
  window_chars: WIN,
  thin_chars: THIN,
  totals: {
    sessions: sessions.length,
    active: sessions.length - thinCount,
    thin: thinCount,
    windows: totalWindows
  },
  walk_ms: Date.now() - t0,
  walk_errors: err,
  sessions
};
fs.writeFileSync(OUT, JSON.stringify(plan, null, 2));
console.log(
  `[plan] ${sessions.length} sessions · ${plan.totals.active} active · ${thinCount} thin · ${totalWindows} total windows · walked in ${plan.walk_ms}ms${err ? ` · ${err} walk errors` : ""}`
);
console.log(`[plan] → ${OUT}`);
