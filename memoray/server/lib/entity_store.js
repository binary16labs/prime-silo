// In-memory entity cache.
//
// Routes used to re-read every entity JSON from disk on each request — at
// ~3k entities that is thousands of file reads per dashboard refresh. This
// store loads them once and invalidates when `index.json`'s mtime changes
// (the parsers save the index exactly once, at the end of a sync run, so
// the mtime is a reliable "data changed" signal).
//
// `invalidate()` is also called explicitly after /api/sync.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { dataDir } = require("./config");

const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, "entities");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

// Phase 2 — persistent warm index. The cold path (reading 80k+ loose entity
// files) took ~20s. We persist the built Map as one gzipped base snapshot plus
// an append-only delta log of just the entities each sync touched. Boot reads
// the base (one file) and replays the small log instead of stat/opening every
// loose file. Compaction (rewrite base, truncate log) runs when the log grows.
// Disk entity files remain the source of truth; the snapshot is only a cache,
// and any read failure falls back to a full rebuild.
const SNAPSHOT_FILE = path.join(DATA_DIR, "store-snapshot.json.gz");
const DELTA_LOG_FILE = path.join(DATA_DIR, "store-delta.log");
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_DISABLED = process.env.MEM0RAY_SNAPSHOT_DISABLE === "1";
const DELTA_COMPACT_BYTES = Number(process.env.MEM0RAY_DELTA_COMPACT_BYTES) || 8 * 1024 * 1024;

let cache = null; // { indexMtimeMs, entities: Map<id, entity>, index }

// Ids the parsers have written during the in-flight sync. The store patches
// only these into the warm cache instead of invalidating and re-reading every
// entity file (at 80k+ files that full rebuild took seconds and fired on each
// 30s background sync — the felt Bridge stall).
const _touched = new Set();

function recordTouched(id) {
  if (id) _touched.add(id);
}

function touchedCount() {
  return _touched.size;
}

function drainTouched() {
  const ids = [..._touched];
  _touched.clear();
  return ids;
}

function getIndexMtimeMs() {
  try {
    return fs.statSync(INDEX_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function load() {
  const mtime = getIndexMtimeMs();
  if (cache && cache.indexMtimeMs === mtime) {
    return cache;
  }

  const t0 = Date.now();
  const entities = new Map();
  if (fs.existsSync(ENTITIES_DIR)) {
    for (const file of fs.readdirSync(ENTITIES_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const entity = JSON.parse(fs.readFileSync(path.join(ENTITIES_DIR, file), "utf-8"));
        if (entity && entity.id) entities.set(entity.id, entity);
      } catch {
        /* skip corrupted entity files */
      }
    }
  }

  let index = { sessions: [] };
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    /* missing or corrupted index — serve empty */
  }

  // Anchor to the mtime AFTER the (multi-second) build, not the one captured at
  // entry. If the index was rewritten mid-build — e.g. a second memoray process
  // sharing this data dir, or an in-process sync — anchoring to the stale entry
  // mtime would immediately re-stale the fresh cache and thrash into another
  // full rebuild on the very next request. The at-most-30s staleness this
  // absorbs self-heals on the next sync (applyDelta) or index change.
  cache = { indexMtimeMs: getIndexMtimeMs(), entities, index };
  console.log(`[Store] Full rebuild: ${entities.size} entities in ${Date.now() - t0}ms`);
  // A full rebuild is the fresh, authoritative base — persist it and reset the
  // delta log so the next boot hydrates from one file instead of 80k.
  writeSnapshot();
  return cache;
}

// Patch just the touched ids into the warm cache (upsert, or delete if the
// file vanished), then re-anchor to the current index mtime so a subsequent
// load() treats the cache as fresh instead of full-rebuilding. No-op when the
// cache has not been built yet — the next lazy load() reads everything from
// disk, which the parsers have already written.
function applyDelta(ids) {
  if (!cache) return false;
  for (const id of ids) {
    const file = path.join(ENTITIES_DIR, `${id}.json`);
    try {
      if (fs.existsSync(file)) {
        const entity = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (entity && entity.id) cache.entities.set(entity.id, entity);
      } else {
        cache.entities.delete(id);
      }
    } catch {
      /* skip corrupted entity file — leave prior value in place */
    }
  }
  try {
    cache.index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    /* keep prior index on read failure */
  }
  cache.indexMtimeMs = getIndexMtimeMs();
  return true;
}

// ─── Phase 2: persistent snapshot + append-only delta log ──────────────────

function hasSnapshot() {
  return !SNAPSHOT_DISABLED && fs.existsSync(SNAPSHOT_FILE);
}

function deltaLogSize() {
  try {
    return fs.statSync(DELTA_LOG_FILE).size;
  } catch {
    return 0;
  }
}

// Rewrite the gzipped base from the current cache and truncate the delta log.
// Atomic (tmp + rename) so a crash mid-write can never leave a torn base.
function writeSnapshot() {
  if (SNAPSHOT_DISABLED || !cache) return false;
  const t0 = Date.now();
  try {
    const payload = {
      v: SNAPSHOT_VERSION,
      indexMtimeMs: cache.indexMtimeMs,
      count: cache.entities.size,
      entities: [...cache.entities.values()]
    };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, gz);
    fs.renameSync(tmp, SNAPSHOT_FILE);
    // Base now contains everything — the delta log starts empty again.
    try {
      fs.writeFileSync(DELTA_LOG_FILE, "");
    } catch {
      /* non-fatal: a stale log is replayed idempotently on next boot */
    }
    console.log(
      `[Store] Snapshot written: ${payload.count} entities, ` +
        `${(gz.length / 1048576).toFixed(1)}MB in ${Date.now() - t0}ms`
    );
    return true;
  } catch (e) {
    console.error("[Store] Snapshot write failed:", e.message);
    return false;
  }
}

// Append the touched entities (one JSON per line) to the delta log. Cheap —
// only the handful of entities a sync changed, not the whole store. A vanished
// entity is recorded as a tombstone so a delete survives a restart.
function appendDelta(ids) {
  if (SNAPSHOT_DISABLED || !cache || !ids.length) return;
  try {
    let buf = "";
    for (const id of ids) {
      const entity = cache.entities.get(id);
      buf += (entity ? JSON.stringify(entity) : JSON.stringify({ id, _deleted: 1 })) + "\n";
    }
    fs.appendFileSync(DELTA_LOG_FILE, buf);
  } catch (e) {
    console.error("[Store] Delta-log append failed:", e.message);
  }
}

// Compact when the log has grown past the threshold: rewrite the base from the
// warm cache and reset the log. Bounds boot replay cost and log-file growth.
function maybeCompactSnapshot() {
  if (SNAPSHOT_DISABLED) return;
  if (deltaLogSize() > DELTA_COMPACT_BYTES) writeSnapshot();
}

// Boot entry: hydrate the cache from the base snapshot + delta log (one gzip
// read + a small replay) instead of the 80k-file cold read. Returns the cache,
// or null when no snapshot exists yet (first run) — the caller then lets the
// normal lazy load() build and persist the first base. Any corruption falls
// back to a full rebuild.
function hydrate() {
  if (!hasSnapshot()) return null;
  const t0 = Date.now();
  try {
    const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT_FILE)).toString("utf-8"));
    if (!snap || snap.v !== SNAPSHOT_VERSION || !Array.isArray(snap.entities)) {
      throw new Error("unrecognized snapshot format");
    }
    const entities = new Map();
    for (const e of snap.entities) {
      if (e && e.id) entities.set(e.id, e);
    }
    let replayed = 0;
    if (fs.existsSync(DELTA_LOG_FILE)) {
      const lines = fs.readFileSync(DELTA_LOG_FILE, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (!rec || !rec.id) continue;
          if (rec._deleted) entities.delete(rec.id);
          else entities.set(rec.id, rec);
          replayed++;
        } catch {
          /* skip a torn/partial final line from a crash mid-append */
        }
      }
    }
    let index = { sessions: [] };
    try {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    } catch {
      /* missing index — serve empty; boot sync repopulates */
    }
    // Anchor to the live index mtime; the boot performSync re-parses anything
    // changed while the process was down and applyDelta-heals it in.
    cache = { indexMtimeMs: getIndexMtimeMs(), entities, index };
    console.log(
      `[Store] Hydrated ${entities.size} entities from snapshot ` +
        `(+${replayed} delta) in ${Date.now() - t0}ms`
    );
    return cache;
  } catch (e) {
    console.error("[Store] Snapshot hydrate failed, falling back to full rebuild:", e.message);
    invalidate();
    return load();
  }
}

function invalidate() {
  cache = null;
}

// Set of normalized lower-case file paths the lineage has actually touched.
// Used by /api/files/open to refuse arbitrary paths.
function knownFilePaths() {
  const { entities } = load();
  const known = new Set();
  for (const e of entities.values()) {
    if (e.metadata && typeof e.metadata.filePath === "string" && e.metadata.filePath) {
      known.add(path.normalize(e.metadata.filePath).toLowerCase());
    }
  }
  return known;
}

module.exports = {
  load,
  invalidate,
  applyDelta,
  recordTouched,
  touchedCount,
  drainTouched,
  hydrate,
  hasSnapshot,
  writeSnapshot,
  appendDelta,
  maybeCompactSnapshot,
  deltaLogSize,
  knownFilePaths,
  DATA_DIR,
  ENTITIES_DIR,
  INDEX_FILE
};
