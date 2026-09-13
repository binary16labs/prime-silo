const fs = require("fs");
const path = require("path");

const { config, dataDir } = require("../lib/config");
const store = require("../lib/entity_store");
const { readNewEvents, itineraryEntities } = require("./nasItinerary");

// Where the NAS catalog writes its log. Only the machine that owns the share has it locally; on
// every other machine the directory is absent and this sync is a quiet no-op.
const EVENTLOG_DIR =
  process.env.MEM0RAY_NAS_EVENTLOG_DIR || config.NAS_EVENTLOG_DIR || "F:/estate-store/eventlog";

const ENTITIES_DIR = path.join(dataDir, "entities");
const INDEX_FILE = path.join(dataDir, "index.json");

function loadIndex() {
  if (fs.existsSync(INDEX_FILE)) return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  return { sessions: [], artifacts: [] };
}

function readEntity(id) {
  const file = path.join(ENTITIES_DIR, `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
}

function saveEntity(entity) {
  fs.mkdirSync(ENTITIES_DIR, { recursive: true });
  fs.writeFileSync(path.join(ENTITIES_DIR, `${entity.id}.json`), JSON.stringify(entity, null, 2));
  store.recordTouched(entity.id);
}

async function syncNasItinerary() {
  if (!fs.existsSync(EVENTLOG_DIR)) return;
  const logs = fs.readdirSync(EVENTLOG_DIR).filter((f) => /^nas-.+\.jsonl$/u.test(f));
  if (!logs.length) return;

  const index = loadIndex();
  const cursors = index.nas_itinerary_cursors || {};
  let written = 0;

  for (const name of logs) {
    const file = path.join(EVENTLOG_DIR, name);
    const cursor = cursors[name] || { nextLine: 0, lastHash: "genesis" };
    const read = readNewEvents(fs.readFileSync(file, "utf8"), {
      fromLine: cursor.nextLine,
      prevHash: cursor.lastHash
    });
    if (read.broken)
      console.warn(
        `[NAS Itinerary] ${name} fails verification at line ${read.broken.line} (${read.broken.reason}); indexed up to it and stopped.`
      );
    if (!read.events.length) continue;

    const { sessions, children } = itineraryEntities(read.events);
    for (const s of sessions) {
      // A day's session accumulates across syncs: merge children rather than replace them.
      const existing = readEntity(s.id);
      if (existing) {
        s.children_ids = [...new Set([...(existing.children_ids || []), ...s.children_ids])];
        s.timestamp = Math.max(existing.timestamp || 0, s.timestamp);
      }
      saveEntity(s);
      if (!index.sessions.includes(s.id)) index.sessions.push(s.id);
    }
    for (const c of children) saveEntity(c);
    written += sessions.length + children.length;
    cursors[name] = { nextLine: read.nextLine, lastHash: read.lastHash };
  }

  if (written) {
    index.nas_itinerary_cursors = cursors;
    index.nas_itinerary_last_sync_timestamp = Date.now();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
    console.log(`[NAS Itinerary] Indexed ${written} entities from ${logs.length} log(s).`);
  }
}

module.exports = { syncNasItinerary };
