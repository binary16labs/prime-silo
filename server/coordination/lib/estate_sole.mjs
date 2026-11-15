// U6 — WHAT IS ONLY OUTSIDE F:, FROM THE CATALOGUES ALONE. Stage 2 of the signed
// PLAN-consolidate-first: for each source the T480 has catalogued, the content F:'s catalogue does
// not hold - by sha256, not by path, so a file F: keeps under another name is "on F:". Nothing here
// reads a disk: both sides are already fingerprinted. A row with no fingerprint (OneDrive's
// cloud-only files) is "cannot tell", never "on F:". A source's own repeats are one thing to copy.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { privateTo, rollupKeyFor } from "./library.mjs";

const open = (db) => new DatabaseSync(db, { readOnly: true, timeout: 2_000 });
const fullOf = (root, rel) =>
  path.join(root.endsWith(":") ? `${root}${path.sep}` : root, ...rel.split("/"));
const hasTable = (db, t) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

// the last finished pass of a catalogue, which is what a result is current for
export function finishedPass(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const db = open(dbPath);
  try {
    const p = db
      .prepare("SELECT id, finished_at FROM passes WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
      .get();
    return p ? { id: p.id, finished_at: p.finished_at } : null;
  } finally {
    db.close();
  }
}

// round 2: a catalogue whose LAST pass (stopped or running) has not finished holds rows of two
// passes at once - a file can be in `files` and `online_only` both - so it is never answered from
export function unfinished(dbPath) {
  const db = open(dbPath);
  try {
    const last = db.prepare("SELECT finished_at FROM passes ORDER BY started_at DESC LIMIT 1").get();
    return Boolean(last && !last.finished_at);
  } finally {
    db.close();
  }
}

// a source is named by its catalogue (the drive's identity), never by a letter another drive can take
export const sourceId = (dbPath) => path.basename(dbPath, ".db");

// One source against the target. Returns counts and the CSV of what to copy (private rows counted,
// never written). Synchronous: it runs in the worker below, never on the hub's thread.
export function soleContent({ sourceDb, sourceRoot, targetDb, rules = [] }) {
  const isPrivate = privateTo(rules);
  const src = open(sourceDb);
  const tgt = open(targetDb);
  try {
    const onTarget = tgt.prepare("SELECT 1 FROM files WHERE sha256 = ? LIMIT 1");
    const out = {
      files: 0,
      on_f: { files: 0, bytes: 0 },
      to_copy: { files: 0, bytes: 0, unique_bytes: 0, repeat_bytes: 0 },
      cannot_tell: { files: 0, bytes: 0 },
      kinds: {},
      private: 0
    };
    const seen = new Set();
    const lines = ["path,bytes,sha256,kind"];
    for (const r of src.prepare("SELECT path, size, sha256, kind FROM files WHERE size > 0").iterate()) {
      out.files++;
      if (onTarget.get(r.sha256)) {
        out.on_f.files++;
        out.on_f.bytes += r.size;
        continue;
      }
      out.to_copy.files++;
      out.to_copy.bytes += r.size;
      if (seen.has(r.sha256)) out.to_copy.repeat_bytes += r.size;
      else {
        seen.add(r.sha256);
        out.to_copy.unique_bytes += r.size;
      }
      const k = (out.kinds[r.kind] ??= { files: 0, bytes: 0 });
      k.files++;
      k.bytes += r.size;
      const full = fullOf(sourceRoot, r.path);
      if (isPrivate(full)) out.private++;
      else lines.push(`"${full.replaceAll('"', '""')}",${r.size},${r.sha256},${r.kind}`);
    }
    if (hasTable(src, "online_only")) {
      const c = src.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM online_only WHERE size > 0").get();
      out.cannot_tell = { files: c.n, bytes: c.b };
      out.files += c.n;
    }
    return { counts: out, csv: `${lines.join("\r\n")}\r\n` };
  } finally {
    src.close();
    tgt.close();
  }
}

// round 2: the codebase's one currency rule (rollupKeyFor): each side's LAST pass in any state, its
// finish date and the policy - so a stopped or new pass, or new rules, is never served a stale answer
const keyFor = (sourceDb, targetDb, rules) => JSON.stringify([rollupKeyFor(sourceDb, rules), rollupKeyFor(targetDb, rules)]);
const fileFor = (dir, sourceDb) =>
  path.join(dir, `sole-${crypto.createHash("sha256").update(path.resolve(sourceDb).toLowerCase()).digest("hex").slice(0, 16)}`);

// The hub's side: answers from the saved result when it is current for both catalogues' last
// passes and the policy, otherwise starts one worker for that source and says it is working.
export function createSoleReporter({ dir, rules = [], retryMs = 60_000 }) {
  const working = new Set();
  const failed = new Map();
  const saved = (base) => {
    try {
      return JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
    } catch {
      return null;
    }
  };
  return {
    report({ sourceRoot, sourceDb, targetDb }) {
      const src = finishedPass(sourceDb);
      const tgt = finishedPass(targetDb);
      const id = sourceId(sourceDb);
      if (!src) return { id, root: sourceRoot, why: "not catalogued yet" };
      if (!tgt) return { id, root: sourceRoot, why: "F: has no finished catalogue" };
      if (unfinished(sourceDb)) return { id, root: sourceRoot, why: "its last pass did not finish: catalogue it again to finish it" };
      if (unfinished(targetDb)) return { id, root: sourceRoot, why: "F:'s last pass did not finish: catalogue F: again to finish it" };
      const base = fileFor(dir, sourceDb);
      const key = keyFor(sourceDb, targetDb, rules);
      const had = saved(base);
      const dates = { source_at: src.finished_at, f_at: tgt.finished_at };
      if (had?.key === key) return { id, root: sourceRoot, ...dates, ...had.counts, csv: `${base}.csv` };
      const f = failed.get(base);
      // a failure rests for its own key only, and is tried again after retryMs (the S30 rule)
      if (f?.key === key && Date.now() - f.at < retryMs) return { id, root: sourceRoot, ...dates, why: `could not be worked out: ${f.why}` };
      if (!working.has(base)) {
        working.add(base);
        const w = new Worker(new URL(import.meta.url), {
          workerData: { soleContent: { sourceDb, sourceRoot, targetDb, rules, base, key } }
        });
        failed.delete(base);
        w.on("error", (e) => failed.set(base, { key, at: Date.now(), why: String(e?.message || e) }));
        w.on("exit", () => working.delete(base));
      }
      return { id, root: sourceRoot, ...dates, computing: true, last: had?.counts ?? null };
    },
    busy: () => working.size > 0
  };
}

if (!isMainThread && workerData?.soleContent) {
  const { sourceDb, sourceRoot, targetDb, rules, base, key } = workerData.soleContent;
  // the folder is made here, in the worker, so a bad one is a reported failure and never a throw on
  // the hub's request thread
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const { counts, csv } = soleContent({ sourceDb, sourceRoot, targetDb, rules });
  fs.writeFileSync(`${base}.csv.tmp`, csv);
  fs.renameSync(`${base}.csv.tmp`, `${base}.csv`);
  // the key is written last, with the counts, so a half-finished result is never read as current
  fs.writeFileSync(`${base}.json.tmp`, JSON.stringify({ key, counts }));
  fs.renameSync(`${base}.json.tmp`, `${base}.json`);
}
