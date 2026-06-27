// In-memory entity cache.
//
// Routes used to re-read every entity JSON from disk on each request — at
// ~3k entities that is thousands of file reads per dashboard refresh. This
// store loads them once and invalidates when `index.json`'s mtime changes
// (the parsers save the index exactly once, at the end of a sync run, so
// the mtime is a reliable "data changed" signal).
//
// `invalidate()` is also called explicitly after /api/sync.

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./config');

const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, 'entities');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

let cache = null; // { indexMtimeMs, entities: Map<id, entity>, index }

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

    const entities = new Map();
    if (fs.existsSync(ENTITIES_DIR)) {
        for (const file of fs.readdirSync(ENTITIES_DIR)) {
            if (!file.endsWith('.json')) continue;
            try {
                const entity = JSON.parse(fs.readFileSync(path.join(ENTITIES_DIR, file), 'utf-8'));
                if (entity && entity.id) entities.set(entity.id, entity);
            } catch { /* skip corrupted entity files */ }
        }
    }

    let index = { sessions: [] };
    try {
        index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    } catch { /* missing or corrupted index — serve empty */ }

    cache = { indexMtimeMs: mtime, entities, index };
    return cache;
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
        if (e.metadata && typeof e.metadata.filePath === 'string' && e.metadata.filePath) {
            known.add(path.normalize(e.metadata.filePath).toLowerCase());
        }
    }
    return known;
}

module.exports = { load, invalidate, knownFilePaths, DATA_DIR, ENTITIES_DIR, INDEX_FILE };
