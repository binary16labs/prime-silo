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
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, exts]) => exts.split(" ").map((e) => [e, k])));
export const kindOf = (name) => KIND_OF.get(path.extname(name).slice(1).toLowerCase()) ?? "other";

// Files still being written are not hashed (nas_catalog's rule): the next pass picks them up whole.
const SETTLE_MS = 60_000;
const PARTIAL_NAME = /(\.partial|\.crdownload|\.part|\.download|\.tmp)$|^~\$/iu;
const SKIP_TOP = new Set(["$recycle.bin", "system volume information"]);

const fold = (p) => path.resolve(p).toLowerCase();
const fullOf = (root, rel) => path.join(root.endsWith(":") ? `${root}${path.sep}` : root, ...rel.split("/"));
const privateTo = (rules) => (p) => isQuarantined([p, canonPath(p), canonPath(p).toLowerCase()], rules);

// KEYED BY THE DRIVE, NOT ITS LETTER (S20's lesson): F: may be another letter tomorrow, and a
// different drive may be F:. Paths are stored relative to the root for the same reason.
export const libraryPath = (dir, root) => {
  const id = rootIdentity(root);
  return id ? path.join(dir, `library-${id.replace(/[^A-Za-z0-9_-]+/gu, "_")}.db`) : null;
};

// EVERY CONNECTION WAITS FOR A LOCK RATHER THAN FAILING. The summary worker, a pass and the hub's
// reads share one catalogue; a read that met the worker's open threw "database is locked" at once and
// the hub answered 500 (claude-s21-verifier-2: 4 of 368 requests). Locks in WAL mode last
// milliseconds (an open's recovery); reads wait at most 2 s, because a read on the hub's thread blocks
// it while it waits.
const BUSY_MS = 10_000;
const READ_BUSY_MS = 2_000;

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
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
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
        if (!(dir === top && SKIP_TOP.has(e.name.toLowerCase())) && !skip.has(fold(full))) subdirs.push(full);
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
    const baseline = Boolean(db.prepare("SELECT 1 FROM passes WHERE finished_at IS NOT NULL LIMIT 1").get());
    let pass = db.prepare("SELECT * FROM passes WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1").get();
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
    const keepUnder = db.prepare("UPDATE files SET run = ? WHERE substr(path, 1, length(?) + 1) = ? || '/'");
    const upsert = db.prepare(`
      INSERT INTO files (path, size, mtime_ms, sha256, kind, first_seen, last_seen, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
        sha256 = excluded.sha256, kind = excluded.kind, last_seen = excluded.last_seen, run = excluded.run`);
    const c = { seen: 0, hashed: pass.hashed, bytes_hashed: pass.bytes_hashed, pending: 0, unreadable: 0, unreadable_dirs: 0 };
    // the last finished pass's count, if there is one: rows committed so far are not the drive
    const estimate = db.prepare("SELECT seen FROM passes WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get()?.seen ?? null;
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
      throw new Error(`${root} went away during the pass: what was committed is kept, and Catalogue again resumes`);
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
    const evicted = (rel, sha, why) => artifactEvictedEvent({ hash: sha, machine, path: evtPath(rel), reason: why });
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
      events.push(summaryEvent({ machine, root, passId: pass.id, at: iso(), payload: { phase, ...c, digest } }));
      const appended = appendKelEvents(logFile, events);
      if (!appended.ok) {
        db.exec("ROLLBACK");
        throw new Error(`library event log append failed: ${appended.reason}`);
      }
      db.prepare(
        "UPDATE passes SET seen = ?, hashed = ?, bytes_hashed = ?, pending = ?, unreadable = ?, unreadable_dirs = ?, digest = ? WHERE id = ?"
      ).run(c.seen, c.hashed, c.bytes_hashed, c.pending, c.unreadable, c.unreadable_dirs, digest, pass.id);
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
    for await (const f of walk(root, { skip: skipSet, unreadable: (d) => (c.unreadable_dirs++, unreadableDirs.push(d)) })) {
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
        const sha = await Promise.resolve(f.full).then(hash).catch(() => null);
        if (sha === null) {
          guard();
          c.unreadable++;
          if (before) touch.run(run, iso(), rel);
          continue;
        }
        c.hashed++;
        c.bytes_hashed += st.size;
        upsert.run(rel, st.size, mtime, sha, kindOf(f.name), before?.first_seen ?? iso(), iso(), run);
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
    for (const g of gone) if (baseline && !isPrivate(evtPath(g.path))) events.push(evicted(g.path, g.sha256, "removed"));
    db.prepare("DELETE FROM files WHERE run != ?").run(run);
    db.prepare("UPDATE passes SET finished_at = ?, stopped_at = NULL, removed = ? WHERE id = ?").run(iso(), gone.length, pass.id);
    commit("finished");
    return { finished: true, pass: pass.id, removed: gone.length, ...c };
  } finally {
    db.close();
  }
}

// --- questions asked of the catalogue ------------------------------------------------------------

const readOnly = (dbPath) =>
  dbPath && fs.existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true, timeout: READ_BUSY_MS }) : null;

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
      if (cur?.sha256 !== r.sha256) sets.push((cur = { sha256: r.sha256, size: r.size, copies: 0, paths: [], private: 0 }));
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
  ["sha256,bytes,path", ...sets.flatMap((s) => s.paths.map((p) => `${s.sha256},${s.size},"${p.replaceAll('"', '""')}"`))].join(
    "\r\n"
  ) + "\r\n";

// The last pass and when one last finished: one row each, cheap enough for any request.
function passOf(dbPath) {
  const db = readOnly(dbPath);
  if (!db) return null;
  try {
    const last = db.prepare("SELECT * FROM passes ORDER BY started_at DESC LIMIT 1").get() ?? null;
    return { last: last && { ...last }, finishedAt: db.prepare("SELECT MAX(finished_at) AS at FROM passes").get().at ?? null };
  } finally {
    db.close();
  }
}

// Which rules a summary was made under. A summary made under other rules is never shown: a name it
// lists may be one the owner has since made private.
export const policyKey = (rules) =>
  crypto
    .createHash("sha256")
    .update(rules.map((r) => (r instanceof RegExp ? `re:${r.source}/${r.flags}` : `s:${r}`)).join("\n"))
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
    .prepare("SELECT kind, COUNT(*) AS files, SUM(size) AS bytes FROM files GROUP BY kind ORDER BY bytes DESC")
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

// THE LIST IS NAMED FOR THE PASS AND RULES IT WAS MADE UNDER. The summary and its list are two files;
// a list under one shared name could be replaced by another hub's (other rules, same store on F:)
// while that hub's summary failed to save, and then be served as this one's (claude-s21-verifier-2).
const csvFor = (db, key) => `${db}.duplicates.${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}.csv`;

// The worker: one summary and its list, written beside the catalogue, then renamed into place so a
// download never reads half a file. Lists of earlier passes or other rules are removed only after the
// summary that replaces them has been saved.
if (!isMainThread && workerData?.librarySummary) {
  const { dbPath, root, rules, key } = workerData.librarySummary;
  const { state, csv } = summaryOf(dbPath, root, rules);
  const list = csvFor(dbPath, key);
  fs.writeFileSync(`${list}.tmp`, csv);
  fs.renameSync(`${list}.tmp`, list);
  fs.writeFileSync(`${dbPath}.summary.json.tmp`, JSON.stringify({ key, state }));
  fs.renameSync(`${dbPath}.summary.json.tmp`, `${dbPath}.summary.json`);
  const base = path.basename(dbPath);
  for (const f of fs.readdirSync(path.dirname(dbPath)))
    if (f.startsWith(`${base}.duplicates.`) && f.endsWith(".csv") && f !== path.basename(list))
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
    return { refused: `${root} has a catalogue that has never finished: finish cataloguing it first` };
  }
  const size = db.prepare("SELECT 1 FROM files WHERE size = ? LIMIT 1");
  const byHash = db.prepare("SELECT path, size, mtime_ms FROM files WHERE sha256 = ?");
  return {
    finishedAt,
    hasSize: (n) => Boolean(size.get(n)),
    byHash: (sha) => byHash.all(sha).map((r) => ({ full: fullOf(root, r.path), size: r.size, mtime_ms: r.mtime_ms })),
    close: () => db.close()
  };
}

// One pass at a time per hub, stoppable. `skip` is the estate store's folder: when it lives on the
// drive catalogued, its own files are never rows (the hub once skipped only <store>/library).
//
// THE SUMMARY IS NEVER WORKED OUT ON THE HUB'S THREAD. It reads the whole catalogue and judges every
// duplicate path against the rules (claude-s21-verifier measured 94 s on the real F:, the CSV 92 s
// more), and either one froze every request to the hub. A worker makes both once per pass and policy
// and writes them beside the catalogue; until it has, the page is told the duplicates are being
// worked out, beside the last summary made under the same rules if there is one.
export function createLibrarian({ dir, skip = [], rules = [], hash = hashFile }) {
  let running = null;
  let last = null;
  let ctl = null;
  const policy = policyKey(rules);
  const working = new Set();
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
    const w = new Worker(new URL(import.meta.url), { workerData: { librarySummary: { dbPath: db, root, rules, key } } });
    w.on("error", () => {});
    w.on("exit", () => working.delete(db));
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
    state(root) {
      const c = current(root);
      if (!c) return null;
      if (c.had?.key === c.key) return c.had.state;
      // the last answer under the same rules keeps its own pass, so its counts and its date agree
      const same = c.had?.key.endsWith(`|${policy}`) ? c.had.state : null;
      return same ? { ...same, computing: true } : { kinds: [], files: 0, bytes: 0, duplicates: null, ...c.pass, computing: true };
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
      const done = catalogue({ root, dbPath, skip: [dir, ...skip], rules, hash, signal: ctl.signal, onProgress: (p) => Object.assign(mine, p) })
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
