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
const { dataDir } = require("./config");

const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, "entities");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

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
  knownFilePaths,
  DATA_DIR,
  ENTITIES_DIR,
  INDEX_FILE
};
