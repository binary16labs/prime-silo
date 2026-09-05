// Where the estate ledgers live.
//
// The store holds the hash-chained logs the governance surfaces read and append to. It is
// deliberately OUTSIDE the repo: the blobs beside it run to hundreds of megabytes and the repo
// sits in OneDrive, which has already broken one build and one scheduled task by dehydrating
// files under it.
//
// Resolution order is explicit rather than clever, and the resolved path is returned to callers
// so a surface can show the operator exactly which ledger it is reading. A governance screen
// that cannot say where its evidence came from is not much of a governance screen.
import fs from "node:fs";
import path from "node:path";

export const ESTATE_STORE_ENV = "ESTATE_STORE";

export function resolveEstateStore() {
  const fromEnv = String(process.env[ESTATE_STORE_ENV] || "").trim();
  if (fromEnv) return { root: fromEnv, source: "env" };

  // Without an explicit setting, try the plausible places and PREFER ONE THAT EXISTS. Guessing
  // a path that happens to be empty is worse than guessing wrong loudly: an absent ledger reads
  // as an empty queue, and "nothing to approve" is the most dangerous thing a governance screen
  // can say when it is not true.
  const bennyHome = String(process.env.BENNY_HOME || "").trim();
  const candidates = [];
  if (bennyHome) {
    candidates.push({
      root: path.join(path.dirname(bennyHome), "estate-store"),
      source: "benny-home"
    });
    const { root: drive } = path.parse(path.resolve(bennyHome));
    if (drive)
      candidates.push({ root: path.join(drive, "estate-store"), source: "benny-home-drive" });
  }
  candidates.push({ root: path.join(process.cwd(), "estate-store"), source: "cwd-fallback" });

  for (const c of candidates) {
    if (fs.existsSync(path.join(c.root, "eventlog")))
      return { ...c, source: `${c.source} (found)` };
  }
  return candidates[0];
}

export function governanceLogPath() {
  const { root, source } = resolveEstateStore();
  const file = path.join(root, "eventlog", "governance.jsonl");
  // Whether the ledger is actually there is part of the answer, not an implementation detail:
  // a surface that cannot tell "no proposals" from "no ledger" will report the second as the first.
  return { file, root, source, exists: fs.existsSync(file) };
}

export function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
