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

  // Sibling of the configured Benny home — the store belongs with the data, not the code.
  const bennyHome = String(process.env.BENNY_HOME || "").trim();
  if (bennyHome)
    return { root: path.join(path.dirname(bennyHome), "estate-store"), source: "benny-home" };

  return { root: path.join(process.cwd(), "estate-store"), source: "cwd-fallback" };
}

export function governanceLogPath() {
  const { root, source } = resolveEstateStore();
  return { file: path.join(root, "eventlog", "governance.jsonl"), root, source };
}

export function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
