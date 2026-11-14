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
// A RULE THAT MATCHES A FOLDER MATCHES EVERYTHING UNDER IT. isQuarantined only ever judged the path
// it was handed, so an anchored rule naming a folder hid that folder's row at its parent and then
// named every file inside it on direct navigation — the folder was private and its contents were
// not. S26 is the first surface to claim folder names are included in the judgement, so this is
// where that claim has to become true. Each ancestor is judged as well as the path itself.
export const privateTo = (rules) => {
  const forms = (s) => [s, canonPath(s), canonPath(s).toLowerCase()];
  // JUDGED ONCE PER DIRECTORY, NOT ONCE PER FILE PER ANCESTOR. Judging every ancestor (D9) made the
  // judgement 3.7x dearer for every caller, and the near-side guard (D1) made duplicateNeighbours
  // ask it once per FILE rather than once per sha: 1,000 files in one folder cost 96 ms with no
  // rules and 409 ms with one, so the rules were three quarters of the bill. Every file in a folder
  // shares that folder's ancestry, and isQuarantined rebuilds a spellings Set on each call, so the
  // cache turns thousands of identical questions into one. It is per-matcher, so a changed policy
  // means a new matcher and never a stale verdict.
  const dirs = new Map();
  const dirPrivate = (dir) => {
    const had = dirs.get(dir);
    if (had !== undefined) return had;
    const at = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
    const verdict =
      isQuarantined(forms(dir), rules) || (at > 0 ? dirPrivate(dir.slice(0, at)) : false);
    dirs.set(dir, verdict);
    return verdict;
  };
  const judge = (full) => {
    if (isQuarantined(forms(full), rules)) return true;
    const at = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
    return at > 0 ? dirPrivate(full.slice(0, at)) : false;
  };
  // the cache is hung on the matcher so a test can SEE it: handed file paths instead of their
  // directories the answers stay identical and only the cost changes, which is a property no
  // assertion about answers can ever hold. 20,000 files in one tree must leave a handful of
  // entries, not 20,000.
  judge.dirs = dirs;
  return judge;
};

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
    -- the drive root's own files, which no path range can bound: a partial index on exactly the
    -- rows whose path holds no separator, so the one folder the panel opens first is a search
    -- rather than a scan of every row on the drive (226 ms at 500k, about half a second at F:)
    CREATE INDEX IF NOT EXISTS files_root ON files (path) WHERE instr(path, '/') = 0;
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
// `refused` and `asked` are BOOLEAN and NUMBER on purpose. A refusal's sentence names the thing
// refused — a folder path, which the caller supplies — so writing it here would be exactly S22's
// D11, a caller putting its own text into a tamper-evident log through a field nobody meant as an
// input. The log records THAT a question was refused; the reason goes to the caller, who asked.
// Is anyone still there to receive the answer? A client that hung up mid-check was audited as
// ANSWERED, so the log recorded an answer nobody got. It is a predicate rather than an inline
// condition because a condition inside a route is reachable only by aborting a real request at the
// right microsecond — which is to say, untestable, which is to say it was untested.
export const stillListening = (res) => res != null && !(res.writableEnded || res.destroyed);

export function libraryQueriedEvent({
  machine,
  root,
  pass,
  surface,
  kind,
  returned,
  withheld,
  refused = false,
  asked = null
}) {
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
    payload: {
      scope: "library",
      root,
      pass: pass || null,
      surface,
      kind,
      returned,
      withheld,
      refused: Boolean(refused),
      asked: Number.isFinite(asked) ? asked : null
    }
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
// THE QUERIES LIVE HERE, in one spelling, because a test that plans a SQL literal of its own
// plans a string the TEST owns and not the one the code runs. The guard added in round 3 to protect
// the index fix was exactly that tautology: reverting both routes to substr() left it green. It is
// the drives-panel harvest mistake a third time — a test reading a copy of the thing instead of
// the thing — so the thing is now exported and there is nothing to copy.
//
// `instr(substr(path, ?), '/') = 0` keeps the IMMEDIATE children: everything deeper has another
// separator after the folder's own prefix. At the drive root there is no prefix to range on, so the
// partial index files_root is what bounds it — without that the root's file query scans, and the
// root is what the panel opens first.
export const SQL = Object.freeze({
  neighbourMine:
    "SELECT path, sha256 FROM files WHERE size > 0 AND (path = ? OR (path >= ? AND path < ?))",
  neighbourOthers: "SELECT path, size FROM files WHERE sha256 = ?",
  folderRow: "SELECT files FROM folders WHERE path = ?",
  childFolders: (range) =>
    `SELECT * FROM folders WHERE path != '' ${range}
       AND instr(substr(path, ?), '/') = 0 ORDER BY bytes DESC LIMIT ? OFFSET ?`,
  childFiles: (range) =>
    `SELECT path, size, mtime_ms, kind FROM files WHERE 1 = 1 ${range}
       AND instr(substr(path, ?), '/') = 0 ORDER BY size DESC LIMIT ? OFFSET ?`,
  // THE DRIVE ROOT NEEDS ITS OWN SPELLING, not just its own index. `ORDER BY size DESC` lets
  // SQLite satisfy the sort from files_size and walk every row on the drive to do it — an index
  // scan rather than a table scan, and 226 ms at 500k rows either way. INDEXED BY forces the
  // partial index, which holds only the root's own files, and the sort then happens over that
  // handful. It is used only where it exists, because a catalogue written before this contract
  // has no files_root and INDEXED BY on a missing index is an error, not a hint.
  rootFiles: `SELECT path, size, mtime_ms, kind FROM files INDEXED BY files_root
       WHERE instr(path, '/') = 0 ORDER BY size DESC LIMIT ? OFFSET ?`,
  // WHICH SPELLING THE CODE CHOOSES, as a decision a test can make the code take rather than
  // re-derive. Planning SQL.rootFiles only proves that string is bounded; it says nothing about
  // whether folderView ever reaches it, and a verifier showed the equivalent gap twice over.
  childFilesFor: (at, hasRootIndex) => (!at && hasRootIndex ? "rootFiles" : "childFiles"),
  hasRootIndex: (db) => {
    try {
      return (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'files_root'")
          .get() != null
      );
    } catch {
      return false;
    }
  },
  range: (at) => (at ? "AND path >= ? AND path < ?" : ""),
  bounds: (at) => (at ? [`${at}/`, `${at}0`] : [])
});

// One page is one page: a caller asking for the whole drive gets a page of it instead.
export const FOLDER_PAGE_MAX = 1000;

// NO ROLLUP IS AN ANSWER, NOT AN EXCEPTION — for BOTH routes. Round 4 fixed this in
// duplicateNeighbours and left folderView reading `folders` unguarded one function away, which is
// the same defect the same number of steps from the same lesson: a verifier found it immediately.
// The librarian's folder() does guard the common case, because the worker writes the rollup's key
// LAST and so a missing key already means "computing" — but the key is in folders_meta and the rows
// are in folders, and anything that leaves one without the other (a restore of an older file, a
// manual drop, corruption) walks straight past that guard into a thrown route. S22's D7 settled
// what a route may do when the thing beneath it is missing: answer, never exit.
//
// It is a function rather than a try at each call site so that the two routes cannot drift apart
// again, which is exactly how they drifted this time.
export const rollupRows = (db, sql, args, what) => {
  try {
    return { rows: db.prepare(sql).all(...args) };
  } catch (e) {
    if (!/no such table|no such index/u.test(String(e?.message ?? e))) throw e;
    return {
      computing: true,
      why: `${what} has no folder rollup yet: try again in a minute`
    };
  }
};

// Ordered by size, because the question this surface answers is "where is the weight".
export function folderView(dbPath, root, rules = [], at = "", { offset = 0, limit = 200 } = {}) {
  const db = readOnly(dbPath);
  if (!db) return null;
  // THE CAP LIVES WITH THE QUERY, not only at the route. A verifier lifted the route's cap from
  // 1,000 to a billion and every test stayed green, then asked this function for 5,001 rows and got
  // 5,001: "the folder page cap is tested" was not true, and the one cap there was sat in
  // estate_api.mjs where a loopback caller is the only thing it binds.
  limit = Math.max(1, Math.min(Number(limit) || 200, FOLDER_PAGE_MAX));
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
    const own = rollupRows(db, "SELECT * FROM folders WHERE path = ?", [at], root);
    if (own.computing) return own;
    const self = own.rows[0];
    if (!self) return { missing: true };
    // AN INDEX RANGE, for the same reason duplicateNeighbours has one: `substr(path, 1, ?) = ?`
    // cannot use the path primary key, and a verifier read the plan as SCAN and timed this route at
    // 402 ms per click at 500k rows — about 0.9 s at F:'s 1.1 million, on the hub's thread. The
    // comment this contract added condemning substr() was written one function away from two more
    // of them. The DRIVE ROOT has no range: every path is under it, so the bound is the instr()
    // depth test alone, and the folders table it reads is one row per folder rather than per file.
    const range = SQL.range(at);
    const bounds = SQL.bounds(at);
    // THROUGH THE HELPER, even though the self read above has already answered if the table is
    // gone. I took this guard out when a mutation showed it unreachable — but unreachable TODAY is
    // an argument about the current order of two statements, and the next edit to reorder them
    // re-opens the defect silently. A verifier made the point better than my reasoning did: the
    // invariant worth holding is that `folders` is read in ONE place, and that is checkable at
    // source rather than argued from control flow. The test below enforces it; this is why the
    // mutation can die at all.
    const kidRows = rollupRows(
      db,
      SQL.childFolders(range),
      [...bounds, under.length + 1, limit, offset],
      root
    );
    if (kidRows.computing) return kidRows;
    const kids = kidRows.rows;
    const here =
      SQL.childFilesFor(at, SQL.hasRootIndex(db)) === "rootFiles"
        ? db.prepare(SQL.rootFiles).all(limit, offset)
        : db.prepare(SQL.childFiles(range)).all(...bounds, under.length + 1, limit, offset);

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
  if (live && fs.existsSync(live)) return { db: live };
  // S20'S LESSON, BROKEN AND NOW REPAIRED. The recorded root NAME is a last resort for a drive
  // that cannot be identified, not a fallback whenever the identity-keyed file is missing. As
  // built, pointing an attached, never-catalogued drive at a name another catalogue had recorded
  // served that other drive's folder names, sizes and duplicate figures with nothing saying so —
  // and estate-library.md claimed "identity still wins when the drive IS there". It now does: if
  // rootIdentity() answers, the identity is the answer and "no catalogue" is the truth.
  if (rootIdentity(root)) return { db: live };
  const found = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".db")) continue;
    const at = path.join(dir, f);
    const db = readOnly(at);
    if (!db) continue;
    try {
      if (db.prepare("SELECT root FROM folders_meta WHERE id = 1").get()?.root === root)
        found.push(at);
    } catch {
      // a catalogue with no rollup cannot say which root it is; leave it alone
    } finally {
      db.close();
    }
  }
  // A disk that has been F: twice leaves two catalogues both recording F:, which is the normal
  // case rather than the odd one. Whichever readdir yielded first is not an answer.
  if (found.length > 1)
    return {
      ambiguous:
        `${root} names ${found.length} catalogues and the drive is not here to say which is ` +
        `its own: attach it`
    };
  return found.length ? { db: found[0], byName: true } : { db: live };
}

// Which pass and policy the folder rollup was built for. Written only once the rollup is complete,
// so an interrupted one reads as absent rather than as current — the same rule the duplicates list
// follows, for the same reason.
// ONE SPELLING of what makes a rollup current: the catalogue's own pass, and the policy it was
// counted under. rollupKeyFor is exported because a test could otherwise only build a rollup that
// is PRESENT, never one that is CURRENT — and a fixture that cannot tell those apart cannot test
// the difference, which is how the pass half went unchecked for two rounds.
const keyFrom = (pass, policy) => `${JSON.stringify(pass)}|${policy}`;

export const rollupKeyFor = (dbPath, rules = []) => {
  const pass = passOf(dbPath);
  return pass ? keyFrom(pass, policyKey(rules)) : null;
};

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

// Measured, not chosen: 0.076 ms per file for the row read and the per-sha lookup, so 1,500 files
// is about 115 ms of hub thread. The folder's subtree file count is one indexed lookup into the
// rollup the worker already wrote, so the size of the work is known before any of it is done.
export const NEIGHBOURS_CAP_FILES = 1500;

export function duplicateNeighbours(dbPath, root, rules = [], folder = "", { limit = 8 } = {}) {
  // THE DRIVE ROOT HAS NO OUTSIDE. Every file on the drive is inside it, so the inside/outside test
  // can never fire: asked of the root this reported all 25,600 folders in a fixture as holding
  // outside copies of the root's own content — wrong, not merely slow, and 33 seconds wrong at
  // 500k rows. Only an x-show on a figure that is structurally 0 at the root kept the panel off it,
  // and any loopback caller could ask. The rollup already answers the root's question.
  if (!folder) return { refused: "the drive root has no outside: ask of a folder inside it" };
  const db = readOnly(dbPath);
  if (!db) return null;
  // THE PLACEMENT, NOT THE QUERY — the lesson of this epic, missed twice on this one route. Round 2
  // turned the lookup into an index range and left the work on the hub's SYNCHRONOUS thread, where
  // it then measured 93.5 s for a 250,000-file folder: sixteen times worse than the 5.7 s scan it
  // replaced, because D1's near-side guard made this one row per file and D9's ancestor judgement
  // made each one dearer. Two correct fixes composed into a frozen hub.
  //
  // A cap cannot be argued from taste, so it is measured: 0.076 ms per file with the judgement
  // memoised, which is the SQL row read and the per-sha lookup and nothing else. CAP_FILES is the
  // largest number of files that keeps this under about a tenth of a second. Above it the answer is
  // REFUSED rather than truncated, because "the other copies are in these folders" is a claim about
  // all of them — a partial answer to that question is a wrong one, not a shorter one.
  const isPrivate = privateTo(rules);
  // ONE SPELLING of the bound, used by both routes. The consolidation stopped a step short:
  // SQL.bounds was read only by folderView while this function kept its own copy, and the
  // Album0/1/2 fixture exercises THIS one - so changing SQL.bounds to `${at}1` left the gate green
  // and made folderView("Album") list a root-level file named Album0 among its contents.
  const [under, upper] = SQL.bounds(folder);
  // A RANGE over the path index, not substr(). `substr(path, 1, ?) = ?` cannot use the primary key,
  // so this was a full table scan on the hub's SYNCHRONOUS request thread — 5.7 seconds at 500k
  // rows, about 12 at F:'s 1.1 million, with the hub wholly blocked throughout. The rollup was
  // measured and moved to the worker; this route, added for the same panel in the same contract,
  // was neither measured nor capped. "/" is 0x2F, so "0" bounds the prefix immediately above it.
  try {
    // THE CAP IS WHAT MAKES THIS SAFE, so it is inside the try and it refuses rather than trusting.
    // Round 3 put the lookup above it: with no `folders` table yet — the window between a catalogue
    // finishing and the worker writing the rollup — it threw `no such table`, leaked the database
    // handle and escaped the route, which is S22's D5 and D10 in the guard added to fix a finding.
    // And `held !== null` meant a MISSING row skipped the refusal entirely, so a 30,000-file folder
    // did the full 2,990 ms of work: a cap enforced against a figure nobody checked is not a cap.
    // No rollup row, no comparison.
    const sized = rollupRows(db, SQL.folderRow, [folder], folder);
    if (sized.computing) return sized;
    const held = sized.rows[0]?.files ?? null;
    if (held === null)
      return {
        computing: true,
        why: `${folder} has no folder rollup yet, so its size is unknown: try again in a minute`
      };
    if (held > NEIGHBOURS_CAP_FILES)
      return {
        refused:
          `${folder} holds ${held} files, and comparing more than ${NEIGHBOURS_CAP_FILES} would ` +
          `block the hub: ask of a folder inside it`
      };
    const mine = db.prepare(SQL.neighbourMine).all(folder, under, upper);
    const others = db.prepare(SQL.neighbourOthers);
    const where = new Map();
    let withheld = 0;
    // THE NEAR SIDE IS JUDGED TOO. Guarding only the far copy identified a private file's CONTENT
    // by saying where else those bytes live: ask the neighbours of a public folder holding one
    // quarantined file and the answer named the folder holding its twin. That is exactly the
    // argument the comment below makes in the other direction (S22 D1), applied to the side it had
    // missed. A withheld near file is counted — its neighbours are simply never looked for, so the
    // figure says "one file here whose copies I will not go looking for", not a number of copies.
    const shas = new Set();
    for (const m of mine) {
      if (isPrivate(fullOf(root, m.path))) {
        withheld += 1;
        continue;
      }
      shas.add(m.sha256);
    }
    for (const sha of shas)
      for (const o of others.all(sha)) {
        if (o.path === folder || o.path.startsWith(under)) continue; // inside, not out
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
  // AN ENUMERATION SURFACE NOBODY CHOSE. `instr(lower(path), "")` is 1 for every row, so an empty
  // query matched the whole drive and returned the first `limit` of it — 1.1 million rows walked on
  // the hub's thread to answer a question nobody asked. A kind on its own ("every image") is a real
  // question and still allowed; neither is not.
  // String() ON BOTH, because a search for "0" is a real search and `!0` is true. The same
  // coercion is why `kind: null` must not slip past as a falsy-but-stringy value: `String(null)`
  // is "null", which would pass this guard and then match no kind in SQL, enumerating the drive —
  // so the kind is normalised to a string before either is tested.
  q = typeof q === "string" || typeof q === "number" ? String(q) : "";
  kind = typeof kind === "string" ? kind : "";
  if (!q && !kind)
    return {
      refused: "ask for a word in the path, or a kind of file: both empty would list the drive"
    };
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
    // `total` HERE IS MATCHES BEFORE THE LIMIT — how much there was to find, so a caller seeing
    // 50 of 4,000 knows to narrow the question. `check`'s `total` is a different number (the files
    // it was ASKED about), and one word for two meanings is how a caller comes to add them up.
    return {
      finishedAt: c.finishedAt,
      matches,
      withheld,
      total,
      total_means: "matches-before-limit"
    };
  } finally {
    c.db.close();
  }
}

// How many paths a caller may hand the hub at once. The walk has had a cap since S21; the INPUT
// list never did, and claude-s22-verifier-3 measured 20,000 paths costing 2.7 seconds of request
// thread — the same lesson as the 94-second summary, arriving by the one door nobody had shut.
export const MAX_CHECK_PATHS = 200;

// Is this file — or every file under this folder — already on the catalogued drive? It reads only
// what it was ASKED about: no file on the drive is ever opened for its data. S20's rule decides a
// copy (size, then bytes), and a row counts only while its file still has the catalogued size and
// mtime: a stale row reads as "changed", never a safe second copy, which is the point of asking.
export async function checkPaths(
  dbPath,
  root,
  rules = [],
  { paths = [], cap = 500, maxPaths = MAX_CHECK_PATHS, hash = hashFile, stat = fs.statSync } = {}
) {
  const c = finishedCatalogue(dbPath, root);
  if (!c.db) return c.missing ? null : { refused: c.refused };
  const isPrivate = privateTo(rules);
  // BOUNDED BEFORE ANYTHING IS HASHED, and said in the answer the way the walk cap already is. A
  // caller is told what it got rather than quietly given a prefix of what it asked for.
  const given = paths.length;
  // STRICTLY GREATER. At exactly the cap nothing was dropped, and `>=` made the answer say
  // "200 paths given and 200 is the most this will take at once: ask again with the rest" — an
  // instruction to re-ask for nothing.
  const over = given > maxPaths;
  paths = over ? paths.slice(0, maxPaths) : paths;
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
    // `total` HERE IS THE FILES IT WAS ASKED ABOUT, not matches before a limit, which is what
    // `find`'s total means. Both are now labelled at the point they are produced.
    // AND SOMETHING MUST HAVE BEEN WITHHELD. Without that clause an EMPTY folder was told its
    // own rules covered everything it held, "0 withheld", which is a sentence about nothing.
    const allWithheld = !files.length && withheld > 0;
    return {
      finishedAt: c.finishedAt,
      files,
      total: files.length,
      total_means: "files-asked-about",
      capped,
      paths_given: given,
      // NAMED FOR WHAT IT IS. `paths_capped` meant "how many were taken" in the documentation,
      // "how many were capped" in its name, and 0-when-one-was-taken in the code: one word with
      // three meanings, inside the contract whose items 2 and 5 exist because one word had two.
      paths_taken: Math.min(given, maxPaths),
      // ITEM 4: a bare `total: 0` told the owner nothing when the answer was "your own rules cover
      // everything you asked about". The count was already right; what was missing was the sentence.
      ...(allWithheld
        ? {
            why:
              `every path asked about is covered by this machine's own privacy rules, so none was ` +
              `looked up: ${withheld} withheld`
          }
        : {}),
      ...(over
        ? {
            why_capped:
              `${given} paths given and ${maxPaths} is the most this will take at once: ask again ` +
              `with the rest`
          }
        : {}),
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
  machine = os.hostname().toLowerCase(),
  retryMs = 60_000
}) {
  let running = null;
  let last = null;
  let ctl = null;
  const policy = policyKey(rules);
  const working = new Set();
  const failed = new Map();
  const rolled = new Map(); // db -> the key its rollup was last SEEN to carry
  let started = 0;
  const files = (db) => ({ json: `${db}.summary.json` });
  const keyOf = (pass) => keyFrom(pass, policy);
  const saved = (db) => {
    try {
      return JSON.parse(fs.readFileSync(files(db).json, "utf8"));
    } catch {
      return null;
    }
  };
  const workOut = (db, root, key) => {
    if (working.has(db) || running?.root === root) return; // a running pass changes it every batch
    // A BUILD THAT FAILED RESTS BEFORE IT IS TRIED AGAIN (S30). Starting clears the failure, and
    // every request starts one - so the reason was erased by the very request that came to read
    // it, and "reported with its reason" was true of no answer anyone could receive. It rests for
    // the same key only: a new pass or a new policy is a different job and starts at once.
    const before = failed.get(db);
    if (before?.key === key && Date.now() - before.at < retryMs) return;
    working.add(db);
    failed.delete(db);
    started += 1;
    const w = new Worker(new URL(import.meta.url), {
      workerData: { librarySummary: { dbPath: db, root, rules, key } }
    });
    // A SWALLOWED WORKER ERROR IS A SURFACE THAT WAITS FOR EVER. The TDZ bug above threw on every
    // run and nothing showed it: the panel would have said "still being worked out" until the owner
    // gave up. The error is kept so an answer can name it.
    w.on("error", (e) => {
      failed.set(db, { key, at: Date.now(), why: String(e?.message || e) });
    });
    w.on("exit", () => working.delete(db));
  };
  // ONE PLACE SAYS WHY A FOLDER FIGURE IS NOT THERE YET (S30). Two routes each carried their own
  // copy of "try again in a minute", and said it whether or not anything was working: with a pass
  // running nothing builds a rollup until the pass ends, which on a first pass of F: is eight hours
  // of being told a minute.
  const notYet = (c, root) => {
    const f = failed.get(c.db);
    if (f?.key === c.key) return { refused: `the folder rollup could not be built: ${f.why}` };
    const pass = c.pass.last?.id ?? null;
    return running?.root === root
      ? {
          computing: true,
          pass,
          why: `${root} is being catalogued: its folder figures are worked out when the pass ends`
        }
      : {
          computing: true,
          pass,
          why: `${root}'s folder rollup is still being worked out: try again in a minute`
        };
  };
  // A drive that is not there has no pass to read from the hub's point of view, but its catalogue
  // still holds one. Read it, and trust the rollup's own key rather than recomputing a current one.
  const detached = (root) => {
    const resolved = catalogueFor(dir, root);
    if (resolved.ambiguous) return { refused: resolved.ambiguous };
    const db = resolved.db;
    if (!db || !fs.existsSync(db)) return null;
    const pass = passOf(db);
    if (!pass) return null;
    const stored = rollupKey(db);
    if (!stored) return null;
    // TAKING THE KEY FROM THE ROLLUP AND THEN COMPARING IT WITH ITSELF CHECKS NOTHING. Round 2
    // fixed the POLICY half and excused the PASS half as impossible to re-derive for an absent
    // drive — and that excuse was wrong, as a verifier showed: passOf() reads the pass from the
    // CATALOGUE, which is the same witness the policy half was fixed against and is present by
    // definition. A rollup built before a later finished pass was therefore served stale while
    // wearing the NEW pass's finishedAt date: a figure missing a file, stamped current, under a
    // comment that says the date belongs on the answer.
    //
    // So the key is derived here exactly as current() derives it, and both halves are compared.
    const key = keyOf(pass);
    return { db, pass, key, stored, had: saved(db), byName: resolved.byName };
  };
  const current = (root) => {
    const db = libraryPath(dir, root);
    const pass = db && passOf(db);
    if (!pass) return null;
    const key = keyOf(pass);
    const had = saved(db);
    // S30: THE ROLLUP HAS ITS OWN KEY, AND IT IS ASKED TOO. Only the summary's was, so a catalogue
    // summarised before the rollup existed - the real F:, whose pass finished the day before S26
    // merged - had a current summary, started no worker, and answered "try again in a minute" for
    // as long as anyone asked. Every S26 test began from a fresh pass, which is the one state that
    // cannot show it. Seen current once, a key is remembered: this runs on every request.
    if (rolled.get(db) !== key && rollupKey(db) === key) rolled.set(db, key);
    if (had?.key !== key || rolled.get(db) !== key) workOut(db, root, key);
    return { db, pass, key, had };
  };
  return {
    status: () => ({ running: running && { ...running }, last }),
    lookup: (root) => catalogueLookup(libraryPath(dir, root), root),
    // S22: the agent's questions go through the same rules as the panel's, in one place
    find: (root, opts) => findFiles(libraryPath(dir, root), root, rules, opts),
    // S26: where the copies of one folder's content are. Asked for on demand, because it is a
    // query over that folder's own subtree rather than a stored figure — storing it for every
    // folder is what took 45 minutes on the real F:.
    neighbours(root, { path: at = "", limit = 8 } = {}) {
      const c = current(root) ?? detached(root);
      if (!c) return null;
      if (c.refused) return c;
      if (!c.pass.finishedAt)
        return {
          refused: `${root} has a catalogue that has never finished: finish cataloguing it first`
        };
      // THE SAME CURRENCY CHECK THE FOLDER ROUTE HAS. The answer is computed live under the current
      // rules, so a stale POLICY never reached it — but the cap this route now depends on is read
      // from the rollup, and round 3 enforced it against a figure the route had never verified. A
      // rollup for an older pass can say a 250,000-file folder holds ten.
      if (c.stored && c.stored !== c.key)
        return {
          refused:
            `${root}'s folder figures were counted for an earlier pass or a different privacy ` +
            `policy, and the drive is not here to recount them: attach it`
        };
      // THE COMMON CASE, which is the one an owner actually meets: right after cataloguing, waiting
      // on the folder ROLLUP. The passthrough was built and then two of its three producers carried
      // no sentence, so this still read "the duplicates are still being worked out".
      if (rollupKey(c.db) !== c.key) return notYet(c, root);
      return duplicateNeighbours(c.db, root, rules, at, { limit });
    },
    // S26: one folder of the tree, from the rollup the worker built. `computing` rather than a
    // half-answer while the key says the rollup is for an older pass or policy: a folder listing
    // built from one pass and counted from another would be quietly wrong.
    folder(root, { path: at = "", offset = 0, limit = 200 } = {}) {
      const c = current(root) ?? detached(root);
      if (!c) return null;
      if (c.refused) return c;
      if (!c.pass.finishedAt)
        return {
          refused: `${root} has a catalogue that has never finished: finish cataloguing it first`
        };
      // a detached drive cannot be recounted, so a rollup that does not match the catalogue's own
      // pass and the hub's own policy is REFUSED with the reason rather than reported as
      // "computing" — nothing is going to compute it while the drive is away
      if (c.stored && c.stored !== c.key)
        return {
          refused:
            `${root}'s folder figures were counted for an earlier pass or a different privacy ` +
            `policy, and the drive is not here to recount them: attach it`
        };
      if (rollupKey(c.db) !== c.key) return notYet(c, root);
      const v = folderView(c.db, root, rules, at, { offset, limit });
      // the date belongs on the answer: a figure with no age invites being read as live
      // a figure resolved by NAME rather than identity says so on the answer, because the owner
      // cannot otherwise tell it is reading a different disk's catalogue
      return v && !v.missing
        ? { ...v, finishedAt: c.pass.finishedAt, ...(c.byName ? { by_name: true } : {}) }
        : v;
    },
    // how many workers this hub has started: read by tests that must show NONE was, which no
    // amount of waiting can show
    workersStarted: () => started,
    // one event per question, in the drive's own library log beside its catalogue
    // THE CHECK AND THE WRITE ARE ONE CALL. Moving the listening guard from before the write to
    // after it left all 97 tests green, because the test that was meant to prevent that asserted a
    // TEXT MATCH on the route's source — so what got tested was the lift, not the guard. There is
    // no "after" to move it to now: a caller that is gone cannot be audited because the only way to
    // audit is through here.
    audit(root, info, to = null) {
      if (to !== null && !stillListening(to)) return false;
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
