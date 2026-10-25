// The librarian (S21): one catalogue per drive of every file on it — path, size, mtime, full sha256,
// kind — so "what is duplicated" and "is this already on F:" are questions asked of the catalogue,
// not of the disk. REPORT ONLY: it reads the drive and writes its own catalogue; it moves nothing.
//
// IT READS IN FOLDER ORDER, ONCE. F: is a USB hard disk: S20 hashed its files as it compared, in
// size order, and managed 26 files/s of scattered seeks; the same files walked folder by folder read
// at 85 (measured 2026-10-03). Each folder's files are hashed as the walk reaches them.
//
// IT KEEPS WHAT IT HAS DONE. The first pass of a 1.4 TB drive takes a night. Rows are committed in
// batches, and a row whose size and mtime are already in the catalogue is not read again, so a pass
// that is stopped, or dies, resumes where it last committed. Only a pass that FINISHED removes rows:
// a file the walk has not reached yet is not a file that has gone.
//
// Names stay on this machine. The catalogue holds them (you cannot manage files you cannot find);
// everything served from it judges each path against the quarantine rules and counts, never names,
// what they match. Its history follows the owner's 2026-10-10 answer: one summary event per committed
// batch, and per-file events only for changes found after a first pass has finished.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { appendKelEvents, ulid, CURRENT_SCHEMA_VERSION } from "./kel.mjs";
import { artifactPlacedEvent, artifactEvictedEvent } from "./artifacts.mjs";
import { hashFile } from "./nas_catalog.mjs";
import { canonPath, isQuarantined } from "./estate_map.mjs";
import { rootIdentity } from "./estate_compare.mjs";

const KINDS = {
  documents: "pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub",
  images: "jpg jpeg png gif bmp tif tiff webp heic cr2 nef arw dng psd svg",
  video: "mp4 mkv avi mov wmv m4v webm mpg mpeg",
  audio: "mp3 flac wav m4a aac ogg wma opus",
  archives: "zip 7z rar tar gz tgz bz2 xz iso",
  code: "js mjs ts py json yaml yml html css c cpp h cs java go rs sh ps1 ipynb",
  models: "gguf safetensors pt pth onnx ckpt"
};
const KIND_OF = new Map(
  Object.entries(KINDS).flatMap(([k, exts]) => exts.split(" ").map((e) => [e, k]))
);
export const kindOf = (name) => KIND_OF.get(path.extname(name).slice(1).toLowerCase()) ?? "other";

// Files still being written are not hashed (nas_catalog's rule): the next pass picks them up whole.
const SETTLE_MS = 60_000;
const PARTIAL_NAME = /(\.partial|\.crdownload|\.part|\.download|\.tmp)$|^~\$/iu;
const SKIP_TOP = new Set(["$recycle.bin", "system volume information"]);

const fold = (p) => path.resolve(p).toLowerCase();
const fullOf = (root, rel) =>
  path.join(root.endsWith(":") ? `${root}${path.sep}` : root, ...rel.split("/"));
const privateTo = (rules) => (p) =>
  isQuarantined([p, canonPath(p), canonPath(p).toLowerCase()], rules);

// KEYED BY THE DRIVE, NOT ITS LETTER (S20's lesson): F: may be another letter tomorrow, and a
// different drive may be F:. Paths are stored relative to the root for the same reason.
export const libraryPath = (dir, root) => {
  const id = rootIdentity(root);
  return id ? path.join(dir, `library-${id.replace(/[^A-Za-z0-9_-]+/gu, "_")}.db`) : null;
};

// EVERY CONNECTION WAITS FOR A LOCK RATHER THAN FAILING: a read meeting the summary worker's open threw
// "database is locked" and the hub answered 500 (claude-s21-verifier-2). WAL locks last milliseconds;
// waits are capped at 2 s because reads and passes run on the hub's thread (verifier-3 froze it at 10 s).
const BUSY_MS = 2_000;

export function openLibrary(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: BUSY_MS });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, sha256 TEXT NOT NULL,
      kind TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, run TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS files_sha256 ON files (sha256);
    CREATE INDEX IF NOT EXISTS files_size ON files (size);
    CREATE TABLE IF NOT EXISTS passes (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, stopped_at TEXT,
      seen INTEGER NOT NULL DEFAULT 0, hashed INTEGER NOT NULL DEFAULT 0,
      bytes_hashed INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
      unreadable INTEGER NOT NULL DEFAULT 0, unreadable_dirs INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0, digest TEXT NOT NULL DEFAULT '');
  `);
  // a catalogue from before the round-1 fixes: rows marked by pass, no unreadable-folder count
  const cols = (t) =>
    db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name);
  if (!cols("files").includes("run")) db.exec("ALTER TABLE files RENAME COLUMN pass TO run");
  if (!cols("passes").includes("unreadable_dirs"))
    db.exec("ALTER TABLE passes ADD COLUMN unreadable_dirs INTEGER NOT NULL DEFAULT 0");
  return db;
}

// Folder order: a folder's files as the walk meets them, then its subfolders in listed order. A folder
// that cannot be read is reported, so the pass can keep every row beneath it rather than lose them.
async function* walk(root, { skip, unreadable }) {
  const top = fullOf(root, "");
  const stack = [top];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // an unreadable ROOT is a drive that is not there: walking on would "finish" with nothing
      // seen and remove every row
      if (dir === top) throw new Error(`${root} cannot be read (${e.code || "unreadable"})`);
      unreadable(dir);
      continue;
    }
    const subdirs = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!(dir === top && SKIP_TOP.has(e.name.toLowerCase())) && !skip.has(fold(full)))
          subdirs.push(full);
      } else if (e.isFile()) yield { full, name: e.name };
    }
    stack.push(...subdirs.reverse());
  }
}

function summaryEvent({ machine, root, passId, at, payload }) {
  const sid = `sweep:${machine}:library:${passId}:${at}`;
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "sweep_recorded",
    valid_time: at,
    txn_time: new Date().toISOString(),
    time_confidence: "known",
    hlc: `${at}-0000-${machine}`,
    machine,
    authorship: "house",
    sid,
    subject: { kind: "sweep", id: sid },
    payload: { scope: "library", root, pass: passId, ...payload }
  };
}

// One pass over `root`. Resumes the last unfinished pass of this drive's catalogue if there is one.
export async function catalogue({
  root,
  dbPath,
  skip = [],
  rules = [],
  machine = os.hostname().toLowerCase(),
  signal = null,
  hash = hashFile,
  batch = 500,
  batchMs = 30_000,
  now = () => Date.now(),
  onProgress = () => {}
}) {
  const db = openLibrary(dbPath);
  const logFile = dbPath.replace(/\.db$/u, ".jsonl");
  const isPrivate = privateTo(rules);
  try {
    const iso = () => new Date(now()).toISOString();
    // per-file history only once there is a finished catalogue to differ from
    const baseline = Boolean(
      db.prepare("SELECT 1 FROM passes WHERE finished_at IS NOT NULL LIMIT 1").get()
    );
    let pass = db
      .prepare("SELECT * FROM passes WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get();
    if (!pass) {
      pass = { id: ulid(now()), hashed: 0, bytes_hashed: 0, digest: "" };
      db.prepare("INSERT INTO passes (id, started_at) VALUES (?, ?)").run(pass.id, iso());
    }
    // EVERY RUN MARKS WHAT IT REACHES WITH ITS OWN ID, not the pass's. Every run walks the whole
    // drive (committed files cost a stat, not a read), so the run that finishes has reached every
    // file still there, and whatever it did not mark has gone. Marked with the pass id, rows a
    // stopped run had reached looked reached to the run that finished, and a file moved or deleted
    // between the two stayed in the catalogue for ever (claude-s21-verifier).
    const run = ulid(now());
    const known = db.prepare("SELECT size, mtime_ms, sha256, first_seen FROM files WHERE path = ?");
    const touch = db.prepare("UPDATE files SET run = ?, last_seen = ? WHERE path = ?");
    const keepUnder = db.prepare(
      "UPDATE files SET run = ? WHERE substr(path, 1, length(?) + 1) = ? || '/'"
    );
    const upsert = db.prepare(`
      INSERT INTO files (path, size, mtime_ms, sha256, kind, first_seen, last_seen, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
        sha256 = excluded.sha256, kind = excluded.kind, last_seen = excluded.last_seen, run = excluded.run`);
    const c = {
      seen: 0,
      hashed: pass.hashed,
      bytes_hashed: pass.bytes_hashed,
      pending: 0,
      unreadable: 0,
      unreadable_dirs: 0
    };
    // the last finished pass's count, if there is one: rows committed so far are not the drive
    const estimate =
      db
        .prepare(
          "SELECT seen FROM passes WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1"
        )
        .get()?.seen ?? null;
    // THE DRIVE MUST STAY THE DRIVE. Unplugged mid-pass, the walk met nothing more and "finished"
    // with 2 of 9 files (claude-s21-verifier); swapped for another drive at the same letter, it
    // would catalogue that one into this one. Its identity is checked before every commit, on any
    // read that fails, and before finishing; if it has changed, the open batch is undone, what was
    // committed is kept, and the pass stays unfinished for Catalogue to resume.
    const identity = rootIdentity(root);
    const stillThere = () => rootIdentity(root) === identity;
    const guard = () => {
      if (identity && stillThere()) return;
      if (open) db.exec("ROLLBACK");
      open = false;
      db.prepare("UPDATE passes SET stopped_at = ? WHERE id = ?").run(iso(), pass.id);
      throw new Error(
        `${root} went away during the pass: what was committed is kept, and Catalogue again resumes`
      );
    };
    const since = now();
    let digest = pass.digest;
    let events = [];
    let rows = [];
    let open = false;
    let lastCommit = now();
    const relOf = (full) => path.relative(fullOf(root, ""), full).split(path.sep).join("/");
    const evtPath = (rel) => fullOf(root, rel);
    const placed = (rel, sha, why) =>
      artifactPlacedEvent({ hash: sha, machine, path: evtPath(rel), purpose: `library:${why}` });
    const evicted = (rel, sha, why) =>
      artifactEvictedEvent({ hash: sha, machine, path: evtPath(rel), reason: why });
    const begin = () => open || (db.exec("BEGIN"), (open = true));
    const progress = (phase) =>
      onProgress({ phase, ...c, estimate, rate: c.seen / Math.max(1, (now() - since) / 1000) });
    // Log first, then catalogue (nas_catalog's order): if the process dies between the two, the
    // next pass re-derives the same rows and the log already holds them.
    const commit = (phase) => {
      if (!open) return;
      guard();
      const h = crypto.createHash("sha256").update(digest);
      for (const r of rows) h.update(`${r}\n`);
      digest = h.digest("hex");
      events.push(
        summaryEvent({
          machine,
          root,
          passId: pass.id,
          at: iso(),
          payload: { phase, ...c, digest }
        })
      );
      const appended = appendKelEvents(logFile, events);
      if (!appended.ok) {
        db.exec("ROLLBACK");
        throw new Error(`library event log append failed: ${appended.reason}`);
      }
      db.prepare(
        "UPDATE passes SET seen = ?, hashed = ?, bytes_hashed = ?, pending = ?, unreadable = ?, unreadable_dirs = ?, digest = ? WHERE id = ?"
      ).run(
        c.seen,
        c.hashed,
        c.bytes_hashed,
        c.pending,
        c.unreadable,
        c.unreadable_dirs,
        digest,
        pass.id
      );
      db.exec("COMMIT");
      open = false;
      events = [];
      rows = [];
      lastCommit = now();
      progress(phase);
    };

    const skipSet = new Set(skip.map(fold));
    const unreadableDirs = [];
    // every row under a folder that could not be read stays: unread is not gone
    const keepUnreadable = () => {
      if (unreadableDirs.length) guard(); // a drive that has gone makes every folder unreadable
      for (const d of unreadableDirs.splice(0)) keepUnder.run(run, relOf(d), relOf(d));
    };
    for await (const f of walk(root, {
      skip: skipSet,
      unreadable: (d) => (c.unreadable_dirs++, unreadableDirs.push(d))
    })) {
      if (signal?.aborted) break;
      begin();
      keepUnreadable();
      c.seen++;
      const rel = relOf(f.full);
      const before = known.get(rel);
      const st = await fsp.stat(f.full).catch(() => null);
      const mtime = st ? Math.floor(st.mtimeMs) : 0;
      if (st && before && before.size === st.size && before.mtime_ms === mtime) {
        touch.run(run, iso(), rel); // unchanged, or committed before a stop: never read twice
      } else if (!st || PARTIAL_NAME.test(f.name) || now() - mtime < SETTLE_MS) {
        if (!st) guard();
        c.pending++;
        if (before) touch.run(run, iso(), rel);
      } else {
        const sha = await Promise.resolve(f.full)
          .then(hash)
          .catch(() => null);
        if (sha === null) {
          guard();
          c.unreadable++;
          if (before) touch.run(run, iso(), rel);
          continue;
        }
        c.hashed++;
        c.bytes_hashed += st.size;
        upsert.run(
          rel,
          st.size,
          mtime,
          sha,
          kindOf(f.name),
          before?.first_seen ?? iso(),
          iso(),
          run
        );
        rows.push(`${rel}\0${sha}\0${st.size}`);
        if (baseline && !isPrivate(evtPath(rel)) && before?.sha256 !== sha) {
          if (before) events.push(evicted(rel, before.sha256, "replaced by new content"));
          events.push(placed(rel, sha, before ? "changed" : "added"));
        }
      }
      if (c.seen % batch === 0 || now() - lastCommit >= batchMs) commit("cataloguing");
    }
    begin();
    keepUnreadable();
    if (signal?.aborted) {
      db.prepare("UPDATE passes SET stopped_at = ? WHERE id = ?").run(iso(), pass.id);
      commit("stopped");
      return { stopped: true, pass: pass.id, ...c };
    }
    // Only a finished walk, by the drive it started on, removes: what this run did not reach has gone.
    // The removal sits in the open batch, and commit() checks the drive before it commits, so a drive
    // that went away after the last file undoes the removal too.
    const gone = db.prepare("SELECT path, sha256 FROM files WHERE run != ?").all(run);
    for (const g of gone)
      if (baseline && !isPrivate(evtPath(g.path)))
        events.push(evicted(g.path, g.sha256, "removed"));
    db.prepare("DELETE FROM files WHERE run != ?").run(run);
    db.prepare(
      "UPDATE passes SET finished_at = ?, stopped_at = NULL, removed = ? WHERE id = ?"
    ).run(iso(), gone.length, pass.id);
    commit("finished");
    return { finished: true, pass: pass.id, removed: gone.length, ...c };
  } finally {
    db.close();
  }
}

// --- questions asked of the catalogue ------------------------------------------------------------

const readOnly = (dbPath) =>
  dbPath && fs.existsSync(dbPath)
    ? new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_MS })
    : null;

// Every set of two or more files with the same bytes, the most space wasted first. Empty files are
// not duplicates of anything worth reclaiming. A private copy is counted in the set, never named.
export function duplicateSets(dbPath, root, rules = [], open = readOnly(dbPath)) {
  const db = open;
  if (!db) return null;
  const isPrivate = privateTo(rules);
  try {
    const sets = [];
    let cur = null;
    for (const r of db
      .prepare(
        `SELECT sha256, size, path FROM files WHERE sha256 IN
           (SELECT sha256 FROM files WHERE size > 0 GROUP BY sha256 HAVING COUNT(*) > 1)
         ORDER BY sha256, path`
      )
      .iterate()) {
      if (cur?.sha256 !== r.sha256)
        sets.push((cur = { sha256: r.sha256, size: r.size, copies: 0, paths: [], private: 0 }));
      cur.copies++;
      const full = fullOf(root, r.path);
      if (isPrivate(full)) cur.private++;
      else cur.paths.push(full);
    }
    for (const s of sets) s.wasted = (s.copies - 1) * s.size;
    return sets.sort((a, b) => b.wasted - a.wasted);
  } finally {
    db.close();
  }
}

export const duplicatesCsv = (sets) =>
  [
    "sha256,bytes,path",
    ...sets.flatMap((s) => s.paths.map((p) => `${s.sha256},${s.size},"${p.replaceAll('"', '""')}"`))
  ].join("\r\n") + "\r\n";

// The last pass and when one last finished: one row each, cheap enough for any request.
function passOf(dbPath) {
  const db = readOnly(dbPath);
  if (!db) return null;
  try {
    const last = db.prepare("SELECT * FROM passes ORDER BY started_at DESC LIMIT 1").get() ?? null;
    return {
      last: last && { ...last },
      finishedAt: db.prepare("SELECT MAX(finished_at) AS at FROM passes").get().at ?? null
    };
  } finally {
    db.close();
  }
}

// Which rules a summary was made under. A summary made under other rules is never shown: a name it
// lists may be one the owner has since made private.
export const policyKey = (rules) =>
  crypto
    .createHash("sha256")
    .update(
      rules.map((r) => (r instanceof RegExp ? `re:${r.source}/${r.flags}` : `s:${r}`)).join("\n")
    )
    .digest("hex");

// What the panel shows for one drive: the last pass, totals by kind, and the duplicates of the
// catalogue as it stands. No names except duplicate paths the rules allow. On the real F: (1.1M
// rows, 237,510 duplicate sets) this takes about 90 s, so the hub never calls it on its own thread:
// see createLibrarian.
export function libraryState(dbPath, root, rules = [], opts = {}) {
  return summaryOf(dbPath, root, rules, opts)?.state ?? null;
}

function summaryOf(dbPath, root, rules = [], { top = 10 } = {}) {
  const db = readOnly(dbPath);
  if (!db) return null;
  const { last, finishedAt } = passOf(dbPath);
  const kinds = db
    .prepare(
      "SELECT kind, COUNT(*) AS files, SUM(size) AS bytes FROM files GROUP BY kind ORDER BY bytes DESC"
    )
    .all()
    .map((k) => ({ ...k }));
  const sets = duplicateSets(dbPath, root, rules, db); // closes db
  const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
  const state = {
    last,
    finishedAt,
    kinds,
    files: sum(kinds, (k) => k.files),
    bytes: sum(kinds, (k) => k.bytes),
    duplicates: {
      sets: sets.length,
      wasted: sum(sets, (s) => s.wasted),
      private: sum(sets, (s) => s.private),
      // a set whose copies are all private is in the totals and nowhere else
      top: sets.filter((s) => s.paths.length).slice(0, top)
    }
  };
  return { state, csv: duplicatesCsv(sets) };
}

// THE LIST IS NAMED FOR ITS RULES, THEN ITS PASS. Under one shared name another hub's list (other rules,
// same store) could be served as this one's (claude-s21-verifier-2); and a worker removes only its own
// rules' lists, never one another hub may be streaming (claude-s21-verifier-3: that race crashed it).
const listPrefix = (db, key) => `${db}.duplicates.${key.split("|").pop().slice(0, 12)}.`;
const NL = String.fromCharCode(10);
const csvFor = (db, key) =>
  `${listPrefix(db, key)}${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}.csv`;

// The worker: one summary and its list, written beside the catalogue, then renamed into place so a
// download never reads half a file. Lists of earlier passes or other rules are removed only after the
// summary that replaces them has been saved.
if (!isMainThread && workerData?.librarySummary) {
  const { dbPath, root, rules, key } = workerData.librarySummary;
  // S26: THE ROLLUP RUNS HERE, in the worker that already exists, because it is 157 s on the real
  // F: — the hub's request thread is where claude-s21-verifier's D3 lived and nothing goes back on
  // it. The key is written LAST, so a rollup interrupted half way is never mistaken for a current
  // one: a reader checks the key, not the table's existence.
  await buildFolderRollup(dbPath, root, rules);
  markRollup(dbPath, key, root);
  const { state, csv } = summaryOf(dbPath, root, rules);
  const list = csvFor(dbPath, key);
  fs.writeFileSync(`${list}.tmp`, csv);
  fs.renameSync(`${list}.tmp`, list);
  fs.writeFileSync(`${dbPath}.summary.json.tmp`, JSON.stringify({ key, state }));
  fs.renameSync(`${dbPath}.summary.json.tmp`, `${dbPath}.summary.json`);
  const mine = path.basename(listPrefix(dbPath, key)); // and a half-written one a killed worker left
  for (const f of fs.readdirSync(path.dirname(dbPath)))
    if (f.startsWith(mine) && f !== path.basename(list))
      fs.rmSync(path.join(path.dirname(dbPath), f), { force: true });
  parentPort.postMessage("done");
}

// What a comparison asks: is there any file this size, and where are the files with these bytes.
// Null when the drive has no catalogue; refused when it has one that has never finished, because
// "not in the catalogue" would then mean "not reached yet", not "not on the drive".
export function catalogueLookup(dbPath, root) {
  const db = readOnly(dbPath);
  if (!db) return null;
  const finishedAt = db.prepare("SELECT MAX(finished_at) AS at FROM passes").get().at ?? null;
  if (!finishedAt) {
    db.close();
    return {
      refused: `${root} has a catalogue that has never finished: finish cataloguing it first`
    };
  }
  const size = db.prepare("SELECT 1 FROM files WHERE size = ? LIMIT 1");
  const byHash = db.prepare("SELECT path, size, mtime_ms FROM files WHERE sha256 = ?");
  return {
    finishedAt,
    hasSize: (n) => Boolean(size.get(n)),
    byHash: (sha) =>
      byHash
        .all(sha)
        .map((r) => ({ full: fullOf(root, r.path), size: r.size, mtime_ms: r.mtime_ms })),
    close: () => db.close()
  };
}

// S22 point 10: an agent's question is audited WITHOUT ITS WORDS - surface, kind, counts and the
// pass, never the query text or a path, because "find my CV" is itself private. An auditor sees
// that an agent asked and how much it was told, without the log becoming the leak.
export function libraryQueriedEvent({ machine, root, pass, surface, kind, returned, withheld }) {
  const at = new Date().toISOString();
  const sid = `sweep:${machine}:library:${pass || "none"}:${at}`;
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "library_queried",
    valid_time: at,
    txn_time: at,
    time_confidence: "known",
    hlc: `${at}-0000-${machine}`,
    machine,
    authorship: "house",
    sid,
    subject: { kind: "sweep", id: sid },
    payload: { scope: "library", root, pass: pass || null, surface, kind, returned, withheld }
  };
}

// --- S26: the folder rollup ---------------------------------------------------------------------
//
// A LIST OF DUPLICATES IS NOT A DECISION. The real F: holds 237,508 duplicate sets, and nobody makes
// 237,508 judgements. A folder that knows how much of itself exists somewhere ELSE is a judgement,
// and it is the one that retires a tree. So every folder gets a row, and two figures that must not
// be confused:
//
//   dup_out — files here whose bytes also exist OUTSIDE this folder's subtree. A tree duplicated
//             against another tree: this is the one that can be retired.
//   dup_in  — files here whose bytes also exist somewhere INSIDE it. A tree duplicated against
//             itself, which retiring the tree would not fix.
//
// On the real F: the single biggest pair is a folder duplicated against itself (42.4 GB inside
// Pictures/2016/Pictures), so conflating the two would send the owner at the wrong job.
//
// A file can be both, and is counted in both; the figures answer different questions and neither is
// a share of the other. Private files are counted and never named, folder names included: a
// quarantined path is quarantined whichever column it would appear in.
// A declaration, not a const: the worker block at the top of this file runs at module evaluation,
// so a const here would be in its temporal dead zone and the rollup would throw the moment a worker
// called it — which is exactly what happened, invisibly, because worker errors were swallowed.
function ancestorsOf(rel) {
  const parts = rel.split("/");
  const out = [""];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out; // every folder holding this file, the drive root first
}

export async function buildFolderRollup(dbPath, root, rules = [], { signal, onProgress } = {}) {
  const db = new DatabaseSync(dbPath, { timeout: BUSY_MS });
  const isPrivate = privateTo(rules);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        path TEXT PRIMARY KEY, files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
        private INTEGER NOT NULL DEFAULT 0,
        dup_out_files INTEGER NOT NULL DEFAULT 0, dup_out_bytes INTEGER NOT NULL DEFAULT 0,
        dup_in_files INTEGER NOT NULL DEFAULT 0, dup_in_bytes INTEGER NOT NULL DEFAULT 0);
    `);

    const acc = new Map();
    const of = (f) => {
      let r = acc.get(f);
      if (!r)
        acc.set(f, (r = { files: 0, bytes: 0, private: 0, do_f: 0, do_b: 0, di_f: 0, di_b: 0 }));
      return r;
    };

    // Nothing here awaited, so a 1.1M-row catalogue held the event loop for 45 minutes and a
    // timer set for every 250 ms never fired once. A worker nobody can see the progress of is a
    // worker that looks hung, so both passes breathe.
    let seen = 0;
    const breathe = async () => {
      if (++seen % 20000) return;
      onProgress?.({ rows: seen });
      await new Promise((r) => setImmediate(r));
    };

    // pass 1: totals, which every folder has whether or not anything is duplicated
    for (const r of db.prepare("SELECT path, size FROM files").iterate()) {
      if (signal?.aborted) throw new Error("rollup stopped");
      await breathe();
      const priv = isPrivate(fullOf(root, r.path)) ? 1 : 0;
      for (const f of ancestorsOf(r.path)) {
        const a = of(f);
        a.files += 1;
        a.bytes += r.size;
        a.private += priv;
      }
    }

    // pass 2: the duplicated sets, one sha at a time. For a folder F holding k of a set's T copies,
    // every one of those k has a copy outside F exactly when T > k, and one inside F when k > 1 —
    // so the two figures fall out of counting copies per ancestor, without comparing paths.
    let sha = null;
    let group = [];
    const flush = () => {
      if (group.length < 2) return (group = []);
      const perFolder = new Map();
      for (const g of group)
        for (const f of ancestorsOf(g.path)) perFolder.set(f, (perFolder.get(f) ?? 0) + 1);
      const size = group[0].size;
      for (const [f, k] of perFolder) {
        const a = of(f);
        if (group.length > k) {
          // bytes here that also exist outside: what retiring this folder frees, because the
          // copies outside survive it
          a.do_f += k;
          a.do_b += k * size;
        }
        if (k > 1) {
          // RECLAIMABLE, not total: k copies inside means k-1 are redundant. Counting all k read as
          // waste and was not — the drive root reported 497.8 GB where the real figure is 267.6.
          a.di_f += k - 1;
          a.di_b += (k - 1) * size;
        }
      }
      group = [];
    };
    for (const r of db
      .prepare("SELECT sha256, path, size FROM files WHERE size > 0 ORDER BY sha256, path")
      .iterate()) {
      if (signal?.aborted) throw new Error("rollup stopped");
      await breathe();
      if (r.sha256 !== sha) {
        flush();
        sha = r.sha256;
      }
      group.push({ path: r.path, size: r.size });
    }
    flush();

    const put = db.prepare(
      `INSERT INTO folders (path, files, bytes, private, dup_out_files, dup_out_bytes,
         dup_in_files, dup_in_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET files = excluded.files, bytes = excluded.bytes,
         private = excluded.private, dup_out_files = excluded.dup_out_files,
         dup_out_bytes = excluded.dup_out_bytes, dup_in_files = excluded.dup_in_files,
         dup_in_bytes = excluded.dup_in_bytes`
    );
    db.exec("BEGIN");
    db.prepare("DELETE FROM folders").run();
    for (const [f, a] of acc)
      put.run(f, a.files, a.bytes, a.private, a.do_f, a.do_b, a.di_f, a.di_b);
    db.exec("COMMIT");
    return { folders: acc.size };
  } finally {
    db.close();
  }
}

// Where the copies of THIS folder's content are. Worked out for the one folder being looked at
// rather than stored for every folder: storing it meant testing every copy of every set against
// every ancestor, which is O(copies squared x depth) and took 45 minutes on the real F:. The
// folder's own subtree bounds this, and the drive root never needs it — nothing is outside the root.
//
// A private copy is counted and its folder never named: "your private file is a copy of this photo"
// is the content of that file by a longer route (S22 D1).
// One folder of the tree: its own figures, its immediate subfolders with theirs, and the files
// sitting directly in it. Children are found by comparing path prefixes rather than with LIKE, so a
// folder named with % or _ is a folder and not a pattern.
//
// Ordered by size, because the question this surface answers is "where is the weight".
export function folderView(dbPath, root, rules = [], at = "", { offset = 0, limit = 200 } = {}) {
  const db = readOnly(dbPath);
  if (!db) return null;
  const isPrivate = privateTo(rules);
  const under = at ? `${at}/` : "";
  const row = (f) => ({
    path: f.path,
    name: f.path.includes("/") ? f.path.slice(f.path.lastIndexOf("/") + 1) : f.path,
    files: f.files,
    bytes: f.bytes,
    private: f.private,
    dup_out_files: f.dup_out_files,
    dup_out_bytes: f.dup_out_bytes,
    dup_in_files: f.dup_in_files,
    dup_in_bytes: f.dup_in_bytes,
    all_elsewhere: f.files > 0 && f.dup_out_files === f.files
  });
  try {
    const self = db.prepare("SELECT * FROM folders WHERE path = ?").get(at);
    if (!self) return { missing: true };
    const kids = db
      .prepare(
        `SELECT * FROM folders WHERE path != '' AND substr(path, 1, ?) = ?
           AND instr(substr(path, ?), '/') = 0 ORDER BY bytes DESC LIMIT ? OFFSET ?`
      )
      .all(under.length, under, under.length + 1, limit, offset);
    const here = db
      .prepare(
        `SELECT path, size, mtime_ms, kind FROM files WHERE substr(path, 1, ?) = ?
           AND instr(substr(path, ?), '/') = 0 ORDER BY size DESC LIMIT ? OFFSET ?`
      )
      .all(under.length, under, under.length + 1, limit, offset);

    // the same judgement as everywhere else: counted, never named — a folder's own name included,
    // because a quarantine rule matches a path and a folder has one
    let withheld = 0;
    const folders = [];
    for (const k of kids) {
      if (isPrivate(fullOf(root, k.path))) withheld += 1;
      else folders.push(row(k));
    }
    const files = [];
    for (const f of here) {
      if (isPrivate(fullOf(root, f.path))) withheld += 1;
      else
        files.push({
          path: f.path,
          name: f.path.slice(f.path.lastIndexOf("/") + 1),
          size: f.size,
          mtime_ms: f.mtime_ms,
          kind: f.kind
        });
    }
    const parts = at ? at.split("/") : [];
    return {
      at,
      breadcrumb: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") })),
      self: row(self),
      folders,
      files,
      withheld,
      more: kids.length === limit || here.length === limit
    };
  } finally {
    db.close();
  }
}

// THE DRIVE NEED NOT BE THERE. libraryPath() names the file from rootIdentity(), which asks the
// filesystem — so an unplugged drive could not be found at all, and the Scenario promising the
// catalogue answers without it was false. A catalogue records which root it describes, so when the
// drive cannot be asked, the store is searched for the one that says it is this root.
//
// Identity still wins when the drive IS there: that is S20's lesson, that F: may be another drive
// tomorrow. This is only the fallback, and it trusts a name rather than an identity, which is the
// most that can be known about something that is not plugged in.
export function catalogueFor(dir, root) {
  const live = libraryPath(dir, root);
  if (live && fs.existsSync(live)) return live;
  let found = null;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".db")) continue;
    const at = path.join(dir, f);
    const db = readOnly(at);
    if (!db) continue;
    try {
      if (db.prepare("SELECT root FROM folders_meta WHERE id = 1").get()?.root === root) found = at;
    } catch {
      // a catalogue with no rollup cannot say which root it is; leave it alone
    } finally {
      db.close();
    }
    if (found) break;
  }
  return found ?? live;
}

// Which pass and policy the folder rollup was built for. Written only once the rollup is complete,
// so an interrupted one reads as absent rather than as current — the same rule the duplicates list
// follows, for the same reason.
export function markRollup(dbPath, key, root = "") {
  const db = new DatabaseSync(dbPath, { timeout: BUSY_MS });
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS folders_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, root TEXT NOT NULL DEFAULT '')`
    );
    if (
      !db
        .prepare("PRAGMA table_info(folders_meta)")
        .all()
        .some((c) => c.name === "root")
    )
      db.exec("ALTER TABLE folders_meta ADD COLUMN root TEXT NOT NULL DEFAULT ''");
    db.prepare(
      `INSERT INTO folders_meta (id, key, root) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET key = excluded.key, root = excluded.root`
    ).run(key, root);
  } finally {
    db.close();
  }
}

export function rollupKey(dbPath) {
  const db = readOnly(dbPath);
  if (!db) return null;
  try {
    return db.prepare("SELECT key FROM folders_meta WHERE id = 1").get()?.key ?? null;
  } catch {
    return null; // no rollup has ever been written for this catalogue
  } finally {
    db.close();
  }
}

export function duplicateNeighbours(dbPath, root, rules = [], folder = "", { limit = 8 } = {}) {
  const db = readOnly(dbPath);
  if (!db) return null;
  const isPrivate = privateTo(rules);
  const under = folder ? folder + "/" : "";
  try {
    const mine = folder
      ? db
          .prepare(
            "SELECT DISTINCT sha256 FROM files WHERE size > 0 AND (path = ? OR substr(path, 1, ?) = ?)"
          )
          .all(folder, under.length, under)
      : db.prepare("SELECT DISTINCT sha256 FROM files WHERE size > 0").all();
    const others = db.prepare("SELECT path, size FROM files WHERE sha256 = ?");
    const where = new Map();
    let withheld = 0;
    for (const m of mine)
      for (const o of others.all(m.sha256)) {
        if (o.path === folder || (under && o.path.startsWith(under))) continue; // inside, not out
        if (isPrivate(fullOf(root, o.path))) {
          withheld += 1;
          continue;
        }
        const top = o.path.includes("/") ? o.path.slice(0, o.path.lastIndexOf("/")) : "";
        const w = where.get(top) ?? { path: top, files: 0, bytes: 0 };
        w.files += 1;
        w.bytes += o.size;
        where.set(top, w);
      }
    return {
      where: [...where.values()].sort((a, c) => c.bytes - a.bytes).slice(0, limit),
      folders: where.size,
      withheld
    };
  } finally {
    db.close();
  }
}

// --- S22: the questions Benny asks of the catalogue ---------------------------------------------
//
// THE PRIVACY JUDGEMENT HAPPENS HERE, once, for every caller — panel, in-app skill and outside MCP
// client alike. An agent's answer can be harvested into a training trace (EP-A P5), so a name
// withheld from the panel but handed to a tool would leak by the longer route.
//
// A missing catalogue is null; one that has never FINISHED is refused, because "no match" would
// then mean "not reached yet" (catalogueLookup's rule, applied to queries too).
function finishedCatalogue(dbPath, root) {
  const db = readOnly(dbPath);
  if (!db) return { missing: true };
  const finishedAt = db.prepare("SELECT MAX(finished_at) AS at FROM passes").get().at ?? null;
  if (!finishedAt) {
    db.close();
    return {
      refused: `${root} has a catalogue that has never finished: finish cataloguing it first`
    };
  }
  return { db, finishedAt };
}

// Files whose path contains `q`, case-insensitively, optionally of one kind. `instr` not LIKE, so a
// query holding % or _ is text and not a pattern. `limit` caps what is NAMED, `total` says how many
// matched - a capped or filtered answer is visibly so.
export function findFiles(dbPath, root, rules = [], { q = "", kind = "", limit = 50 } = {}) {
  const c = finishedCatalogue(dbPath, root);
  if (!c.db) return c.missing ? null : { refused: c.refused };
  const isPrivate = privateTo(rules);
  try {
    const sql = `SELECT path, size, mtime_ms, kind FROM files WHERE instr(lower(path), ?) > 0${
      kind ? " AND kind = ?" : ""
    } ORDER BY path`;
    const args = [String(q).toLowerCase(), ...(kind ? [String(kind)] : [])];
    const matches = [];
    let withheld = 0;
    let total = 0;
    for (const r of c.db.prepare(sql).iterate(...args)) {
      total++;
      const full = fullOf(root, r.path);
      if (isPrivate(full)) withheld++;
      else if (matches.length < limit)
        matches.push({ full, size: r.size, mtime_ms: r.mtime_ms, kind: r.kind });
    }
    return { finishedAt: c.finishedAt, matches, withheld, total };
  } finally {
    c.db.close();
  }
}

// Is this file — or every file under this folder — already on the catalogued drive? It reads only
// what it was ASKED about: no file on the drive is ever opened for its data. S20's rule decides a
// copy (size, then bytes), and a row counts only while its file still has the catalogued size and
// mtime: a stale row reads as "changed", never a safe second copy, which is the point of asking.
export async function checkPaths(
  dbPath,
  root,
  rules = [],
  { paths = [], cap = 500, hash = hashFile, stat = fs.statSync } = {}
) {
  const c = finishedCatalogue(dbPath, root);
  if (!c.db) return c.missing ? null : { refused: c.refused };
  const isPrivate = privateTo(rules);
  try {
    const hasSize = c.db.prepare("SELECT 1 FROM files WHERE size = ? LIMIT 1");
    const byHash = c.db.prepare("SELECT path, size, mtime_ms FROM files WHERE sha256 = ?");
    const asked = [];
    let capped = false;
    let withheld = 0;
    // THE RULES JUDGE THE PATH, WHICHEVER SIDE OF THE QUESTION IT IS ON (claude-s22-verifier D1).
    // Filtering only the catalogue side let a caller name every quarantined file simply by asking
    // about the folder holding them - the same rules, bypassed by changing the question.
    const add = (f) => {
      if (isPrivate(f)) return (withheld += 1);
      return asked.length < cap ? asked.push(f) : (capped = true);
    };
    for (const given of paths) {
      let st = null;
      try {
        st = stat(given);
      } catch {
        add(given); // an unreadable thing is reported, not silently dropped
        continue;
      }
      if (!st.isDirectory()) {
        add(given);
        continue;
      }
      const stack = [given];
      while (stack.length && !capped) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile()) add(full);
        }
      }
    }
    const files = [];
    for (const f of asked) {
      let st = null;
      try {
        st = stat(f);
      } catch {
        files.push({ path: f, verdict: "unreadable" });
        continue;
      }
      if (!hasSize.get(st.size)) {
        files.push({ path: f, verdict: "absent" });
        continue;
      }
      // A FILE THAT STATS BUT WILL NOT OPEN IS A VERDICT (claude-s22-verifier-3 D7). An open .pst,
      // a VM disk, a SQLite file in use: ordinary. The catalogue pass already catches exactly this
      // and counts it `unreadable`, so the write path survived what the read path died of.
      let sha;
      try {
        sha = await hash(f);
      } catch {
        files.push({ path: f, verdict: "unreadable" });
        continue;
      }
      const rows = byHash.all(sha);
      if (!rows.length) {
        files.push({ path: f, verdict: "absent" });
        continue;
      }
      const at = [];
      let changed = 0;
      for (const r of rows) {
        const full = fullOf(root, r.path);
        let there = null;
        try {
          there = stat(full);
        } catch {
          // the catalogued file is gone: the row is stale, which is not a copy
        }
        // the same floor() the pass stored, or every fresh file would read as changed
        if (there && there.size === r.size && Math.floor(there.mtimeMs) === r.mtime_ms)
          at.push(full);
        else changed++;
      }
      // the catalogue side stays filtered too: this is where the bytes WERE found, and a
      // quarantined location is counted, never named (D4 - the mutation that survived round 1)
      const named = at.filter((n) => !isPrivate(n));
      if (at.length)
        files.push({ path: f, verdict: "on-root", at: named, withheld: at.length - named.length });
      else files.push({ path: f, verdict: "changed", changed });
    }
    // `withheld` counts both sides: paths never walked because the rules cover them, and
    // catalogued locations not named. A count is the most that may be said about either.
    const atWithheld = files.reduce((n, f) => n + (f.withheld || 0), 0);
    return {
      finishedAt: c.finishedAt,
      files,
      total: files.length,
      capped,
      withheld: withheld + atWithheld
    };
  } finally {
    c.db.close();
  }
}

// One pass at a time per hub, stoppable. `skip` is the estate store's folder: when it lives on the
// drive catalogued, its own files are never rows (the hub once skipped only <store>/library).
//
// THE SUMMARY IS NEVER WORKED OUT ON THE HUB'S THREAD. It reads the whole catalogue and judges every
// duplicate path against the rules (claude-s21-verifier measured 94 s on the real F:, the CSV 92 s
// more), and either one froze every request to the hub. A worker makes both once per pass and policy
// and writes them beside the catalogue; until it has, the page is told the duplicates are being
// worked out, beside the last summary made under the same rules if there is one.
export function createLibrarian({
  dir,
  skip = [],
  rules = [],
  hash = hashFile,
  machine = os.hostname().toLowerCase()
}) {
  let running = null;
  let last = null;
  let ctl = null;
  const policy = policyKey(rules);
  const working = new Set();
  const failed = new Map();
  const files = (db) => ({ json: `${db}.summary.json` });
  const keyOf = (pass) => `${JSON.stringify(pass)}|${policy}`;
  const saved = (db) => {
    try {
      return JSON.parse(fs.readFileSync(files(db).json, "utf8"));
    } catch {
      return null;
    }
  };
  const workOut = (db, root, key) => {
    if (working.has(db) || running?.root === root) return; // a running pass changes it every batch
    working.add(db);
    failed.delete(db);
    const w = new Worker(new URL(import.meta.url), {
      workerData: { librarySummary: { dbPath: db, root, rules, key } }
    });
    // A SWALLOWED WORKER ERROR IS A SURFACE THAT WAITS FOR EVER. The TDZ bug above threw on every
    // run and nothing showed it: the panel would have said "still being worked out" until the owner
    // gave up. The error is kept so an answer can name it.
    w.on("error", (e) => {
      failed.set(db, String(e?.message || e));
    });
    w.on("exit", () => working.delete(db));
  };
  // A drive that is not there has no pass to read from the hub's point of view, but its catalogue
  // still holds one. Read it, and trust the rollup's own key rather than recomputing a current one.
  const detached = (root) => {
    const db = catalogueFor(dir, root);
    if (!db || !fs.existsSync(db)) return null;
    const pass = passOf(db);
    if (!pass) return null;
    const key = rollupKey(db);
    return key ? { db, pass, key, had: saved(db) } : null;
  };
  const current = (root) => {
    const db = libraryPath(dir, root);
    const pass = db && passOf(db);
    if (!pass) return null;
    const key = keyOf(pass);
    const had = saved(db);
    if (had?.key !== key) workOut(db, root, key);
    return { db, pass, key, had };
  };
  return {
    status: () => ({ running: running && { ...running }, last }),
    lookup: (root) => catalogueLookup(libraryPath(dir, root), root),
    // S22: the agent's questions go through the same rules as the panel's, in one place
    find: (root, opts) => findFiles(libraryPath(dir, root), root, rules, opts),
    // S26: one folder of the tree, from the rollup the worker built. `computing` rather than a
    // half-answer while the key says the rollup is for an older pass or policy: a folder listing
    // built from one pass and counted from another would be quietly wrong.
    folder(root, { path: at = "", offset = 0, limit = 200 } = {}) {
      const c = current(root) ?? detached(root);
      if (!c) return null;
      if (!c.pass.finishedAt)
        return {
          refused: `${root} has a catalogue that has never finished: finish cataloguing it first`
        };
      if (rollupKey(c.db) !== c.key) {
        const why = failed.get(c.db);
        return why
          ? { refused: `the folder rollup could not be built: ${why}` }
          : { computing: true, pass: c.pass.last?.id ?? null };
      }
      return folderView(c.db, root, rules, at, { offset, limit });
    },
    // one event per question, in the drive's own library log beside its catalogue
    audit(root, info) {
      const db = libraryPath(dir, root);
      if (!db) return false;
      const pass = (passOf(db)?.last?.id ?? null) || null;
      const evt = libraryQueriedEvent({ machine, root, pass, ...info });
      return appendKelEvents(`${db.slice(0, -3)}.jsonl`, [evt]).ok;
    },
    check: (root, opts) => checkPaths(libraryPath(dir, root), root, rules, opts),
    // Sets beyond the panel's top ten, from the list the WORKER already wrote for this pass and
    // policy. Never recomputed here: that is ~90 s on the real F:, on the hub's thread - D3.
    duplicatesPage(root, { offset = 0, limit = 20 } = {}) {
      const c = current(root);
      if (!c) return null;
      // "any question of it" includes this one (claude-s22-verifier D2): find and check both
      // refuse an unfinished catalogue, and answering here from a partial pass would read as
      // "these are the duplicates" when it means "these are the ones reached so far".
      if (!c.pass.finishedAt)
        return {
          refused: `${root} has a catalogue that has never finished: finish cataloguing it first`
        };
      const csv = csvFor(c.db, c.key);
      if (!fs.existsSync(csv)) return { computing: true, pass: c.pass.last?.id ?? null };
      const want = offset + limit;
      const sets = [];
      const fd = fs.openSync(csv, "r");
      try {
        const buf = Buffer.allocUnsafe(1 << 16);
        let tail = "";
        let header = true;
        let read = 0;
        while (sets.length <= want && (read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
          const lines = (tail + buf.toString("utf8", 0, read)).split(NL);
          tail = lines.pop() ?? "";
          for (const line of lines) {
            if (header) {
              header = false;
              continue;
            }
            const row = line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line;
            if (!row) continue;
            const [sha, bytes, ...rest] = row.split(",");
            const file = rest.join(",").replace(/^"|"$/gu, "").replaceAll('""', '"');
            const cur = sets.at(-1);
            if (cur?.sha256 === sha) cur.paths.push(file);
            else sets.push({ sha256: sha, size: Number(bytes), paths: [file] });
            if (sets.length > want) break;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      // "named", because a private copy is in the set but not in this list: calling it "copies"
      // would overstate what the caller can see
      const page = sets.slice(offset, want).map((x) => ({
        sha256: x.sha256,
        size: x.size,
        copies_named: x.paths.length,
        wasted_named: (x.paths.length - 1) * x.size,
        paths: x.paths
      }));
      return { pass: c.pass.last?.id ?? null, offset, sets: page, more: sets.length > want };
    },
    state(root) {
      const c = current(root);
      if (!c) return null;
      if (c.had?.key === c.key) return c.had.state;
      // the last answer under the same rules keeps its own pass, so its counts and its date agree
      const same = c.had?.key.endsWith(`|${policy}`) ? c.had.state : null;
      return same
        ? { ...same, computing: true }
        : { kinds: [], files: 0, bytes: 0, duplicates: null, ...c.pass, computing: true };
    },
    // the duplicates list made for this pass under these rules; its name says which, so no other is ever served
    csvPath(root) {
      const c = current(root);
      return c && fs.existsSync(csvFor(c.db, c.key)) ? csvFor(c.db, c.key) : null;
    },
    start(root) {
      if (running) return { started: false, since: running.since };
      const dbPath = libraryPath(dir, root);
      if (!dbPath) return { started: false, since: null, reason: `${root} cannot be read` };
      ctl = new AbortController();
      running = { root, since: new Date().toISOString(), phase: "starting", seen: 0, hashed: 0 };
      const mine = running;
      const done = catalogue({
        root,
        dbPath,
        skip: [dir, ...skip],
        rules,
        hash,
        signal: ctl.signal,
        onProgress: (p) => Object.assign(mine, p)
      })
        .catch((e) => ({ failed: String(e?.message || e) }))
        .then((r) => {
          last = { root, at: new Date().toISOString(), ...r };
          running = null;
          return r;
        });
      return { started: true, since: mine.since, done };
    },
    stop() {
      if (!running) return false;
      ctl.abort();
      return true;
    }
  };
}
