// What is on a backup drive that is not already on F: (S20). REPORT ONLY: it reads both, moves
// nothing, and its names never leave this machine.
//
// The owner is consolidating backup drives onto F: Elements, and both plug into the same machine, so
// this is a comparison of two roots on one machine — no satellite, nothing new on the wire.
//
// IT DECIDES BY CONTENT, AND READS AS LITTLE AS IT CAN. A drive file whose size matches nothing on the
// target cannot be a copy, so it is "only on the drive" without being opened. On a size match, a
// partial hash (first and last 4 MB, plus the size) rules most pairs in or out. Only a FULL hash match
// is "on the target". After the cheap pass, "only on the drive" is already certain — a different
// partial hash is different content — and the full pass only settles the partial matches, which
// stay "unconfirmed" until it does. Nothing is ever called copied on a partial match.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonPath, isQuarantined } from "./estate_map.mjs";
import { everythingAdapter, selectAdapters, walkerAdapter } from "./estate_map_files.mjs";

const PART = 4 * 1024 * 1024;

// Every file under a root, through Everything where it can see the root, else the walker.
export async function* listRoot(root) {
  const chosen = await selectAdapters([root], [everythingAdapter(), walkerAdapter()]);
  yield* chosen.get(root).list(root);
}

export async function partialHash(file, size) {
  const h = crypto.createHash("sha256");
  const fh = await fsp.open(file, "r");
  try {
    const head = Buffer.alloc(Math.min(PART, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > PART) {
      const tail = Buffer.alloc(Math.min(PART, size - PART));
      await fh.read(tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
  } finally {
    await fh.close();
  }
  return h.update(String(size)).digest("hex");
}

export function fullHash(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

const tally = () => ({ files: 0, bytes: 0 });
const add = (t, size) => {
  t.files++;
  t.bytes += size;
};

// The folder a drive-only file is reported under: the drive and up to two folders below it, so the
// owner sees "G:\Photos\2019 — 12 GB" rather than a million lines.
const folderOf = (root, file) => {
  const rel = path.relative(root, file).split(/[\\/]/u).slice(0, -1).slice(0, 2);
  return path.join(root, ...rel);
};

// compareRoots — `list(root)` yields { path, size } for every file under a root (the Everything
// adapter, or the walker where Everything cannot see). `rules` are the hub's quarantine rules: a file
// they match is counted in every total and listed nowhere.
export async function compareRoots({
  from,
  to,
  list,
  rules = [],
  hashers = { partialHash, fullHash },
  onProgress = () => {}
}) {
  const progress = (phase, done, total) => onProgress({ phase, done, total });
  progress("listing the target", 0, 0);
  const bySize = new Map();
  for await (const r of list(to)) {
    const size = Number(r.size) || 0;
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push(r.path);
  }

  const result = {
    from,
    to,
    drive: tally(),
    onTarget: tally(),
    onlyHere: tally(),
    unconfirmed: tally(),
    unreadable: tally(),
    privateCounted: tally(),
    only: [],
    folders: []
  };
  const listed = (file) => !isQuarantined([file, canonPath(file), canonPath(file).toLowerCase()], rules);
  const onlyHere = (file, size) => {
    add(result.onlyHere, size);
    if (listed(file)) result.only.push({ path: file, size });
    else add(result.privateCounted, size);
  };

  // cheap pass: size, then partial hash; what survives it is a candidate for the full pass. The
  // target's files of a size are hashed ONCE and grouped by partial hash, so a drive file is looked
  // up, not compared with each: a drive of thumbnails and empty files has tens of thousands at one
  // size, and comparing pairwise was 20,000 x 20,000 lookups for one size alone.
  const byPartial = new Map();
  const targetsLike = async (size) => {
    if (!byPartial.has(size)) {
      const groups = new Map();
      for (const t of bySize.get(size)) {
        try {
          const p = await hashers.partialHash(t, size);
          if (!groups.has(p)) groups.set(p, []);
          groups.get(p).push(t);
        } catch {
          /* an unreadable target file is simply not a match */
        }
      }
      byPartial.set(size, groups);
    }
    return byPartial.get(size);
  };
  const candidates = [];
  progress("listing the drive", 0, 0);
  const driveFiles = [];
  for await (const r of list(from)) driveFiles.push({ path: r.path, size: Number(r.size) || 0 });
  for (const [i, f] of driveFiles.entries()) {
    if (i % 500 === 0) progress("comparing sizes and partial hashes", i, driveFiles.length);
    add(result.drive, f.size);
    const same = bySize.get(f.size);
    if (!same) {
      onlyHere(f.path, f.size);
      continue;
    }
    let mine;
    try {
      mine = await hashers.partialHash(f.path, f.size);
    } catch {
      add(result.unreadable, f.size); // cannot be read: neither "copied" nor "only here"
      continue;
    }
    const matches = (await targetsLike(f.size)).get(mine) ?? [];
    if (matches.length) candidates.push({ ...f, matches });
    else onlyHere(f.path, f.size);
  }

  // full pass: only a full-hash match is "on the target"; one that cannot be finished is unconfirmed
  const fulls = new Map();
  const fullOf = async (file) => {
    if (!fulls.has(file)) fulls.set(file, await hashers.fullHash(file));
    return fulls.get(file);
  };
  for (const [i, c] of candidates.entries()) {
    progress("confirming by full hash", i, candidates.length);
    try {
      const mine = await fullOf(c.path);
      let found = false;
      for (const t of c.matches) {
        try {
          if ((await fullOf(t)) === mine) {
            found = true;
            break;
          }
        } catch {
          /* try the next candidate */
        }
      }
      if (found) add(result.onTarget, c.size);
      else onlyHere(c.path, c.size);
    } catch {
      add(result.unconfirmed, c.size);
    }
  }

  const byFolder = new Map();
  for (const f of result.only) {
    const k = folderOf(from, f.path);
    const t = byFolder.get(k) ?? { folder: k, files: 0, bytes: 0 };
    add(t, f.size);
    byFolder.set(k, t);
  }
  result.folders = [...byFolder.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 25);
  progress("done", driveFiles.length, driveFiles.length);
  return result;
}

// The drive-only list as CSV, for the owner to copy from. Quoted, because a path may hold a comma.
export const onlyCsv = (result) =>
  ["path,bytes", ...result.only.map((f) => `"${f.path.replaceAll('"', '""')}",${f.size}`)].join("\r\n") + "\r\n";

// One comparison at a time, keeping the latest result per drive pair on disk with when it was taken.
// A drive that has since been unplugged keeps its last result, dated — never treated as coverage.
export function createComparer({ dir, rules, list, now = Date.now }) {
  let running = null;
  const file = (from, to, ext) =>
    path.join(dir, `${`${from}__${to}`.replace(/[^A-Za-z0-9_-]+/gu, "_")}.${ext}`);
  const latest = (from, to) => {
    try {
      return JSON.parse(fs.readFileSync(file(from, to, "json"), "utf8"));
    } catch {
      return null;
    }
  };
  return {
    status: () => running,
    latest,
    csvPath: (from, to) => file(from, to, "csv"),
    start(from, to) {
      if (running) return { started: false, since: running.since };
      running = { from, to, since: new Date(now()).toISOString(), phase: "starting", done: 0, total: 0 };
      const mine = running;
      const done = (async () => {
        let summary;
        try {
          const r = await compareRoots({ from, to, list, rules, onProgress: (p) => Object.assign(mine, p) });
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file(from, to, "csv"), onlyCsv(r));
          const { only, ...rest } = r;
          summary = { ...rest, ok: true, at: new Date(now()).toISOString(), listed: only.length };
        } catch (e) {
          summary = { from, to, ok: false, at: new Date(now()).toISOString(), reason: String(e?.message || e) };
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file(from, to, "json"), JSON.stringify(summary));
        running = null;
      })();
      return { started: true, since: mine.since, done };
    }
  };
}
