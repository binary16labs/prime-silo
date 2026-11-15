// U7 — THE COPY PLAN. Stage 3a of the signed PLAN-consolidate-first: from the catalogues alone,
// what each source would add to F: (the one consolidation drive; the T480 is its only writer), to
// which folder, with what left out and why. NOTHING IS COPIED HERE (U8 copies) and nothing is
// approved here: a plan is raised as a governance proposal and only the owner signs it, through
// gov_sign. The digest of the exact file list rides on the proposal, so U8 can refuse anything
// other than what was signed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { privateTo, rollupKeyFor } from "./library.mjs";
import { sourceId, unfinished } from "./estate_sole.mjs";

// The owner's answers at signature (2026-11-15): `.git` is kept; these are never copied.
export const DEFAULT_POLICY = Object.freeze({
  target: "F:",
  folder: "consolidated",
  exclude: ["node_modules", ".venv", "venv", "__pycache__"],
  never: []
});

// A policy can change what is excluded and which sources are never proposed. It can never move the
// target off the signed drive, nor the folder out from under it.
export function validatePolicy(p = {}, { target = DEFAULT_POLICY.target } = {}) {
  const out = { ...DEFAULT_POLICY, ...p };
  if (out.target !== target) throw new Error(`the target is the signed consolidation drive, ${target}`);
  if (typeof out.folder !== "string" || !/^[A-Za-z0-9 _-]{1,64}$/u.test(out.folder))
    throw new Error("the folder is one plain folder name on the target");
  for (const k of ["exclude", "never"])
    if (!Array.isArray(out[k]) || out[k].some((x) => typeof x !== "string" || !x.trim() || /[\\/]/u.test(x)))
      throw new Error(`${k} is a list of plain names`);
  return out;
}

export function readPolicy(file, opts) {
  try {
    return validatePolicy(JSON.parse(fs.readFileSync(file, "utf8")), opts);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

const open = (db) => new DatabaseSync(db, { readOnly: true, timeout: 2_000 });
const hasTable = (db, t) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
// "dir/name.ext" -> "dir/name (from Downloads).ext": a planned rename, never an overwrite
const renamed = (rel, source) => {
  const ext = path.posix.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)} (from ${source})${ext}`;
};

// One source's plan, from its catalogue and F:'s. Returns the counts and the item list (the exact
// copies U8 would make, and the repeats that point at them). Synchronous: it runs in the worker.
export function planCopy({ sourceDb, sourceRoot, sourceName, targetDb, policy, rules = [] }) {
  const isPrivate = privateTo(rules);
  const src = open(sourceDb);
  const tgt = open(targetDb);
  try {
    const onTarget = tgt.prepare("SELECT 1 FROM files WHERE sha256 = ? LIMIT 1");
    const atPath = tgt.prepare("SELECT sha256 FROM files WHERE path = ?");
    const base = `${policy.folder}/${sourceName}`;
    const excludes = policy.exclude.map((x) => x.toLowerCase());
    const first = new Map();
    const items = [];
    const out = {
      copy: { files: 0, bytes: 0 },
      repeats: { files: 0, bytes: 0 },
      excluded: {},
      cannot_tell: { files: 0, bytes: 0 },
      renames: 0,
      private: 0,
      on_f: 0
    };
    for (const r of src.prepare("SELECT path, size, sha256 FROM files WHERE size > 0 ORDER BY path").iterate()) {
      const dirs = r.path.split("/").slice(0, -1).map((s) => s.toLowerCase());
      const rule = excludes.find((x) => dirs.includes(x));
      if (rule) {
        const e = (out.excluded[rule] ??= { files: 0, bytes: 0 });
        e.files++;
        e.bytes += r.size;
        continue;
      }
      if (onTarget.get(r.sha256)) {
        out.on_f++;
        continue;
      }
      if (first.has(r.sha256)) {
        out.repeats.files++;
        out.repeats.bytes += r.size;
        items.push({ from: r.path, same_as: first.get(r.sha256) });
        continue;
      }
      let to = `${base}/${r.path}`;
      const there = atPath.get(to);
      if (there && there.sha256 !== r.sha256) {
        to = renamed(to, sourceName);
        out.renames++;
      }
      first.set(r.sha256, to);
      out.copy.files++;
      out.copy.bytes += r.size;
      if (isPrivate(path.join(sourceRoot, ...r.path.split("/")))) out.private++;
      items.push({ from: r.path, to, sha256: r.sha256, size: r.size });
    }
    if (hasTable(src, "online_only")) {
      const c = src.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM online_only WHERE size > 0").get();
      out.cannot_tell = { files: c.n, bytes: c.b };
    }
    const lines = items.map((i) => JSON.stringify(i));
    const digest = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
    return { counts: out, folder: base, digest, items: lines };
  } finally {
    src.close();
    tgt.close();
  }
}

const policyHash = (policy) => crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
const keyFor = (sourceDb, targetDb, rules, policy) =>
  JSON.stringify([rollupKeyFor(sourceDb, rules), rollupKeyFor(targetDb, rules), policyHash(policy)]);

// The hub's side, as U6's: a saved plan current for both catalogues' last passes, the privacy
// rules and the policy is served; otherwise one worker per source builds it, off the hub's thread.
export function createCopyPlanner({ dir, rules = [], retryMs = 60_000 }) {
  const working = new Set();
  const failed = new Map();
  return {
    plan({ sourceRoot, sourceName, sourceDb, targetDb, policy }) {
      const id = sourceId(sourceDb);
      if (policy.never.some((n) => n.toLowerCase() === String(sourceName).toLowerCase()))
        return { id, source: sourceName, never: true };
      if (unfinished(sourceDb) || unfinished(targetDb))
        return { id, source: sourceName, why: "a catalogue's last pass did not finish: catalogue it again first" };
      const base = path.join(dir, `plan-${id}`);
      const key = keyFor(sourceDb, targetDb, rules, policy);
      let had = null;
      try {
        had = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
      } catch {
        // none yet
      }
      if (had?.key === key) return { id, source: sourceName, key, ...had.plan, items_file: `${base}.items.jsonl` };
      const f = failed.get(base);
      if (f?.key === key && Date.now() - f.at < retryMs) return { id, source: sourceName, why: `could not be planned: ${f.why}` };
      if (!working.has(base)) {
        working.add(base);
        failed.delete(base);
        const w = new Worker(new URL(import.meta.url), {
          workerData: { copyPlan: { sourceDb, sourceRoot, sourceName, targetDb, policy, rules, base, key } }
        });
        w.on("error", (e) => failed.set(base, { key, at: Date.now(), why: String(e?.message || e) }));
        w.on("exit", () => working.delete(base));
      }
      return { id, source: sourceName, computing: true };
    }
  };
}

if (!isMainThread && workerData?.copyPlan) {
  const { sourceDb, sourceRoot, sourceName, targetDb, policy, rules, base, key } = workerData.copyPlan;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const { counts, folder, digest, items } = planCopy({ sourceDb, sourceRoot, sourceName, targetDb, policy, rules });
  fs.writeFileSync(`${base}.items.jsonl.tmp`, `${items.join("\n")}\n`);
  fs.renameSync(`${base}.items.jsonl.tmp`, `${base}.items.jsonl`);
  fs.writeFileSync(`${base}.json.tmp`, JSON.stringify({ key, plan: { ...counts, folder, digest } }));
  fs.renameSync(`${base}.json.tmp`, `${base}.json`);
}
