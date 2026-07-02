// Append-only ledger + status heartbeat (ADR-005 §7). The ledger is the only
// source any reported number may come from — memo-ray token-audit lesson.
import fs from "fs";
import { stateDir } from "./config.mjs";

const ledgerPath = () => stateDir("ledger.jsonl");
const statusPath = () => stateDir("status.json");

export function appendLedger(entry) {
  fs.appendFileSync(
    ledgerPath(),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
  );
}

export function readLedger() {
  if (!fs.existsSync(ledgerPath())) return [];
  return fs
    .readFileSync(ledgerPath(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Latest MAP verdict per session wins — a session can be retried after a failure
// or remapped after a delta detects new activity.
export function mapVerdicts() {
  const verdicts = new Map();
  for (const e of readLedger()) {
    if (e.phase === "map" && e.session_id) verdicts.set(e.session_id, e);
  }
  return verdicts;
}

export function writeStatus(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(statusPath(), "utf8"));
  } catch {
    /* first write */
  }
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(statusPath(), JSON.stringify(next, null, 2));
  return next;
}

export function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusPath(), "utf8"));
  } catch {
    return null;
  }
}
