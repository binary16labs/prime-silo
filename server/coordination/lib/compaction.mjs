// Storage/compaction budget (L7 / EP-L). Append-only + bi-temporal + never-delete on a finite
// drive needs a stated budget and a compaction policy that is itself ADDITIVE and JOURNALLED —
// compaction moves old log segments to a journal (never erases), so the pre-compaction state is
// always reconstructable (replay = journal + active). Extends R5–R7; R42. Design: SOLUTION §4.7.
import fs from "node:fs";
import path from "node:path";

const readLines = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
    : [];

// Compact an append-only log: move all but the newest `keep` lines into the journal (append),
// leaving the active log with the tail. Lossless — journalled, never deleted.
export function compactLog(logFile, journalFile, { keep = 0 } = {}) {
  const lines = readLines(logFile);
  const cut = Math.max(0, lines.length - keep);
  const moved = lines.slice(0, cut);
  const kept = lines.slice(cut);
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  if (moved.length) fs.appendFileSync(journalFile, moved.join("\n") + "\n");
  fs.writeFileSync(logFile, kept.length ? kept.join("\n") + "\n" : "");
  return { moved: moved.length, kept: kept.length };
}

// Replay the journal followed by the active log → the full pre-compaction state, in order.
export function reconstruct(journalFile, logFile) {
  return [...readLines(journalFile), ...readLines(logFile)];
}

function dirSize(root) {
  let total = 0;
  if (!fs.existsSync(root)) return 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

// Budget check: growth past the configured budget is flagged (naming the overage), never silent.
export function checkStorageBudget(root, maxBytes) {
  const size = dirSize(root);
  const overage = Math.max(0, size - maxBytes);
  return { ok: size <= maxBytes, size, maxBytes, overage };
}
