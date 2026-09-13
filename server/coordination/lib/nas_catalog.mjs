// NAS catalog — what is on the shared drive, where it came from, and every change to it.
//
// The T480 shares F:\nas to the rest of the estate so large files (models, images, downloads,
// datasets) stop being copied machine to machine. A share on its own answers none of the
// questions that matter a month later: what is this 40 GB file, who put it here, is it the same
// model the ASUS already has, and where did it go? This module is that record.
//
// Three stores, each doing one job:
//
//   catalog.db (SQLite)   CURRENT state, queryable: one row per file with hash, size, origin.
//                         It is a projection — rebuildable — so it lives beside the share, not
//                         inside it, and clients never write to it.
//
//   eventlog/nas-<machine>.jsonl   HISTORY, tamper-evident: every add, change, move and removal
//                         as the estate's existing artifact_* KEL events, so the lineage and
//                         evidence folds already understand them. One writer (the machine that
//                         owns the disk), because the log is a hash chain.
//
//   <share>/.receipts/*.json   INTENT from clients: "optimus put models/x.gguf here, copied from
//                         D:\downloads, because ...". Clients cannot write the log over SMB, so
//                         they drop a receipt and the owning machine folds it into the next scan.
//
// Identity is the content hash, not the path: a rename is a move of the same artifact, and the
// same model placed twice is one artifact with two placements.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ulid, CURRENT_SCHEMA_VERSION, appendKelEvents } from "./kel.mjs";
import { artifactAcquiredEvent, artifactPlacedEvent, artifactEvictedEvent } from "./artifacts.mjs";

export const NAS_CATEGORIES = Object.freeze(["models", "images", "downloads", "datasets"]);
export const RECEIPTS_DIR = ".receipts";

// Files still being written must not be hashed: a half-copied 30 GB model would be recorded,
// then "changed", then "changed" again. Skip anything modified within the settle window or
// carrying a partial-download name; the next scan picks it up whole.
const DEFAULT_SETTLE_MS = 60_000;
const PARTIAL_NAME = /(\.partial|\.crdownload|\.part|\.download|\.tmp)$|^~\$/iu;
const SKIP_DIRS = new Set([RECEIPTS_DIR, ".catalog", "$RECYCLE.BIN", "System Volume Information"]);

const toRel = (root, full) => path.relative(root, full).split(path.sep).join("/");
const categoryOf = (rel) => {
  const top = rel.split("/")[0];
  return NAS_CATEGORIES.includes(top) ? top : "other";
};

// --- catalog (SQLite) ------------------------------------------------------------------

export const catalogDir = (estateRoot) => path.join(estateRoot, "nas");
export const nasLogFile = (estateRoot, machine) =>
  path.join(estateRoot, "eventlog", `nas-${machine}.jsonl`);

export function openCatalog(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      path           TEXT PRIMARY KEY,
      sha256         TEXT NOT NULL,
      size           INTEGER NOT NULL,
      mtime_ms       INTEGER NOT NULL,
      category       TEXT NOT NULL,
      first_seen     TEXT NOT NULL,
      last_seen      TEXT NOT NULL,
      origin_machine TEXT,
      origin_path    TEXT,
      reason         TEXT
    );
    CREATE INDEX IF NOT EXISTS files_sha256 ON files (sha256);
    CREATE TABLE IF NOT EXISTS scans (
      id          TEXT PRIMARY KEY,
      started_at  TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      files_total INTEGER NOT NULL,
      bytes_total INTEGER NOT NULL,
      added       INTEGER NOT NULL,
      changed     INTEGER NOT NULL,
      moved       INTEGER NOT NULL,
      removed     INTEGER NOT NULL,
      pending     INTEGER NOT NULL,
      bytes_hashed INTEGER NOT NULL
    );
  `);
  return db;
}

// --- walking + hashing -----------------------------------------------------------------

export function walkShare(root, { now = Date.now(), settleMs = DEFAULT_SETTLE_MS } = {}) {
  const files = [];
  const pending = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip, never abort the scan
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!(dir === root && SKIP_DIRS.has(e.name))) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const rel = toRel(root, full);
      if (PARTIAL_NAME.test(e.name) || now - st.mtimeMs < settleMs) {
        pending.push(rel);
        continue;
      }
      files.push({ rel, full, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    }
  }
  return { files, pending };
}

export function hashFile(full) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(full, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

// --- receipts ----------------------------------------------------------------------------

export function readReceipts(root) {
  const dir = path.join(root, RECEIPTS_DIR);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
      const dest = String(r.dest || "")
        .replace(/\\/gu, "/")
        .replace(/^\/+/u, "");
      if (!dest) continue;
      out.push({
        file,
        dest,
        origin_machine: String(r.origin_machine || "").toLowerCase() || null,
        origin_path: r.origin_path || null,
        reason: r.reason || null,
        created: r.created || null
      });
    } catch {
      // malformed receipt: leave it for a human, do not guess
    }
  }
  return out;
}

// --- reconcile: the pure heart. Given what the catalog believed and what the disk shows (with
//     hashes), decide what happened. No I/O, so every case is testable directly. -----------

export function reconcile(previousRows, observed, receipts = []) {
  const prevByPath = new Map(previousRows.map((r) => [r.path, r]));
  const seenPaths = new Set(observed.map((o) => o.rel));
  const receiptByDest = new Map(receipts.map((r) => [r.dest, r]));
  const changes = [];
  const usedReceipts = new Set();

  // Paths that vanished, indexed by hash, are the candidates a new path could have moved from.
  const vanished = new Map();
  for (const r of previousRows) {
    if (seenPaths.has(r.path)) continue;
    if (!vanished.has(r.sha256)) vanished.set(r.sha256, []);
    vanished.get(r.sha256).push(r);
  }

  const withReceipt = (change) => {
    const receipt = receiptByDest.get(change.path);
    if (receipt) {
      usedReceipts.add(receipt);
      change.origin_machine = receipt.origin_machine;
      change.origin_path = receipt.origin_path;
      change.reason = receipt.reason;
    }
    return change;
  };

  for (const o of observed) {
    const before = prevByPath.get(o.rel);
    if (before && before.sha256 === o.sha256) continue; // unchanged
    if (before) {
      changes.push(
        withReceipt({
          kind: "changed",
          path: o.rel,
          sha256: o.sha256,
          size: o.size,
          from_sha256: before.sha256
        })
      );
      continue;
    }
    const candidates = vanished.get(o.sha256);
    if (candidates && candidates.length) {
      const from = candidates.shift();
      changes.push({
        kind: "moved",
        path: o.rel,
        sha256: o.sha256,
        size: o.size,
        from_path: from.path,
        // a move keeps the artifact's origin; it did not arrive anew
        origin_machine: from.origin_machine,
        origin_path: from.origin_path,
        reason: from.reason
      });
      continue;
    }
    changes.push(withReceipt({ kind: "added", path: o.rel, sha256: o.sha256, size: o.size }));
  }

  for (const rows of vanished.values())
    for (const r of rows)
      changes.push({ kind: "removed", path: r.path, sha256: r.sha256, size: r.size });

  return { changes, usedReceipts: [...usedReceipts] };
}

// --- events: map each change onto the artifact vocabulary the estate already folds --------

export function changeEvents(changes, { machine, root, knownHashes = new Set() }) {
  const events = [];
  const at = (rel) => path.join(root, ...rel.split("/"));
  const extra = (evt, fields) => {
    for (const [k, v] of Object.entries(fields))
      if (v !== null && v !== undefined) evt.payload[k] = v;
    return evt;
  };
  const known = new Set(knownHashes);

  for (const c of changes) {
    const who = c.origin_machine
      ? { origin_machine: c.origin_machine, origin_path: c.origin_path }
      : {};
    const authorship = c.origin_machine && c.kind !== "moved" ? "human" : "house";
    const placed = () =>
      extra(
        artifactPlacedEvent({
          hash: c.sha256,
          machine,
          path: at(c.path),
          purpose: c.reason || `nas:${categoryOf(c.path)}`,
          authorship
        }),
        { nas_path: c.path, category: categoryOf(c.path), size: c.size, ...who }
      );

    if (c.kind === "added" || c.kind === "changed") {
      if (c.kind === "changed")
        events.push(
          extra(
            artifactEvictedEvent({
              hash: c.from_sha256,
              machine,
              path: at(c.path),
              reason: "replaced by new content"
            }),
            { nas_path: c.path, change: "changed" }
          )
        );
      if (!known.has(c.sha256)) {
        known.add(c.sha256);
        events.push(
          extra(
            artifactAcquiredEvent({
              hash: c.sha256,
              machine,
              sourceUri: c.origin_path
                ? `file://${c.origin_machine || "unknown"}/${String(c.origin_path).replace(/\\/gu, "/")}`
                : `nas://${machine}/${c.path}`,
              size: c.size,
              label: path.posix.basename(c.path),
              authorship
            }),
            { nas_path: c.path, change: c.kind, ...who }
          )
        );
      }
      events.push(extra(placed(), { change: c.kind }));
    } else if (c.kind === "moved") {
      events.push(
        extra(
          artifactEvictedEvent({
            hash: c.sha256,
            machine,
            path: at(c.from_path),
            reason: `moved to ${c.path}`
          }),
          { nas_path: c.from_path, change: "moved", to_path: c.path }
        )
      );
      events.push(extra(placed(), { change: "moved", from_path: c.from_path }));
    } else if (c.kind === "removed") {
      events.push(
        extra(
          artifactEvictedEvent({
            hash: c.sha256,
            machine,
            path: at(c.path),
            reason: "removed from the NAS"
          }),
          { nas_path: c.path, change: "removed", size: c.size }
        )
      );
    }
  }
  return events;
}

export function scanSummaryEvent({ machine, root, startedAt, finishedAt, counts }) {
  const sid = `sweep:${machine}:nas:${finishedAt}`;
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "sweep_recorded",
    valid_time: finishedAt,
    txn_time: new Date().toISOString(),
    time_confidence: "known",
    hlc: `${finishedAt}-0000-${machine}`,
    machine,
    authorship: "house",
    sid,
    subject: { kind: "sweep", id: sid },
    payload: { scope: "nas", root, started_at: startedAt, ...counts }
  };
}

// --- orchestrator: the only function here that writes ---------------------------------------

// `root` is the share (F:/nas); `estateRoot` is the estate store (F:/estate-store), which holds
// the catalog under nas/ and the event log under eventlog/ beside every other ledger.
export async function scanNas({
  root,
  estateRoot,
  machine,
  now = () => Date.now(),
  settleMs = DEFAULT_SETTLE_MS,
  onProgress = null
}) {
  const startedAt = new Date(now()).toISOString();
  const store = catalogDir(estateRoot);
  const db = openCatalog(path.join(store, "catalog.db"));
  const logFile = nasLogFile(estateRoot, machine);
  try {
    const previousRows = db.prepare("SELECT * FROM files").all();
    const prevByPath = new Map(previousRows.map((r) => [r.path, r]));
    const { files, pending } = walkShare(root, { now: now(), settleMs });

    // Hash only what could have changed: a file whose size and mtime match the catalog keeps
    // its recorded hash. That is what makes a scan of a mostly-unchanged share cheap.
    let bytesHashed = 0;
    const observed = [];
    for (const f of files) {
      const before = prevByPath.get(f.rel);
      if (before && before.size === f.size && before.mtime_ms === f.mtimeMs) {
        observed.push({ ...f, sha256: before.sha256 });
        continue;
      }
      onProgress?.({ hashing: f.rel, size: f.size });
      let sha256;
      try {
        sha256 = await hashFile(f.full);
      } catch {
        pending.push(f.rel); // locked or vanished mid-scan: try again next time
        continue;
      }
      bytesHashed += f.size;
      observed.push({ ...f, sha256 });
    }

    const pendingSet = new Set(pending);
    const receipts = readReceipts(root);
    // A file still settling is not "removed"; keep its previous row out of the vanished set.
    const comparable = previousRows.filter((r) => !pendingSet.has(r.path));
    const { changes, usedReceipts } = reconcile(comparable, observed, receipts);

    const knownHashes = new Set(previousRows.map((r) => r.sha256));
    const events = changeEvents(changes, { machine, root, knownHashes });
    const finishedAt = new Date(now()).toISOString();
    const counts = {
      files_total: observed.length,
      bytes_total: observed.reduce((n, o) => n + o.size, 0),
      added: changes.filter((c) => c.kind === "added").length,
      changed: changes.filter((c) => c.kind === "changed").length,
      moved: changes.filter((c) => c.kind === "moved").length,
      removed: changes.filter((c) => c.kind === "removed").length,
      pending: pending.length,
      bytes_hashed: bytesHashed
    };
    if (changes.length)
      events.push(scanSummaryEvent({ machine, root, startedAt, finishedAt, counts }));

    // Log first, then catalog: if the process dies between the two, the next scan re-derives
    // the same changes from a stale catalog and the log has them already, rather than the
    // catalog silently holding changes the history never recorded.
    const appended = appendKelEvents(logFile, events);
    if (!appended.ok) throw new Error(`NAS event log append failed: ${appended.reason}`);

    const changeByPath = new Map(changes.map((c) => [c.path, c]));
    db.exec("BEGIN");
    try {
      const upsert = db.prepare(`
        INSERT INTO files (path, sha256, size, mtime_ms, category, first_seen, last_seen, origin_machine, origin_path, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          sha256 = excluded.sha256, size = excluded.size, mtime_ms = excluded.mtime_ms,
          category = excluded.category, last_seen = excluded.last_seen,
          origin_machine = COALESCE(excluded.origin_machine, files.origin_machine),
          origin_path = COALESCE(excluded.origin_path, files.origin_path),
          reason = COALESCE(excluded.reason, files.reason)`);
      for (const o of observed) {
        const c = changeByPath.get(o.rel);
        const first =
          c?.kind === "moved"
            ? prevByPath.get(c.from_path)?.first_seen
            : prevByPath.get(o.rel)?.first_seen;
        upsert.run(
          o.rel,
          o.sha256,
          o.size,
          o.mtimeMs,
          categoryOf(o.rel),
          first || finishedAt,
          finishedAt,
          c?.origin_machine ?? null,
          c?.origin_path ?? null,
          c?.reason ?? null
        );
      }
      const del = db.prepare("DELETE FROM files WHERE path = ?");
      for (const c of changes) {
        if (c.kind === "removed") del.run(c.path);
        if (c.kind === "moved") del.run(c.from_path);
      }
      db.prepare(
        `INSERT INTO scans (id, started_at, finished_at, files_total, bytes_total, added, changed, moved, removed, pending, bytes_hashed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ulid(),
        startedAt,
        finishedAt,
        counts.files_total,
        counts.bytes_total,
        counts.added,
        counts.changed,
        counts.moved,
        counts.removed,
        counts.pending,
        counts.bytes_hashed
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    // Receipts that were folded in are archived next to the catalog, never deleted: they are
    // the only record of the client's own words about why a file exists.
    const archive = path.join(store, "receipts", finishedAt.slice(0, 10));
    for (const r of usedReceipts) {
      fs.mkdirSync(archive, { recursive: true });
      try {
        fs.renameSync(r.file, path.join(archive, path.basename(r.file)));
      } catch {
        fs.copyFileSync(r.file, path.join(archive, path.basename(r.file)));
        fs.rmSync(r.file, { force: true });
      }
    }

    return { startedAt, finishedAt, counts, changes, events: events.length, logFile, pending };
  } finally {
    db.close();
  }
}

export function findFiles(dbPath, { query = "", category = null, sha256 = null, limit = 50 } = {}) {
  const db = openCatalog(dbPath);
  try {
    const where = [];
    const args = [];
    if (query) {
      where.push("path LIKE ?");
      args.push(`%${query}%`);
    }
    if (category) {
      where.push("category = ?");
      args.push(category);
    }
    if (sha256) {
      where.push("sha256 LIKE ?");
      args.push(`${String(sha256).replace(/^sha256:/u, "")}%`);
    }
    const sql = `SELECT * FROM files ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY last_seen DESC LIMIT ?`;
    return db.prepare(sql).all(...args, limit);
  } finally {
    db.close();
  }
}

export function catalogStats(dbPath) {
  const db = openCatalog(dbPath);
  try {
    return {
      byCategory: db
        .prepare(
          "SELECT category, COUNT(*) AS files, SUM(size) AS bytes FROM files GROUP BY category ORDER BY bytes DESC"
        )
        .all(),
      duplicates: db
        .prepare(
          "SELECT sha256, COUNT(*) AS copies, MAX(size) AS size FROM files GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY size DESC LIMIT 20"
        )
        .all(),
      lastScan: db.prepare("SELECT * FROM scans ORDER BY finished_at DESC LIMIT 1").get() || null
    };
  } finally {
    db.close();
  }
}
