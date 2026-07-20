const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Load central configuration contract
const { config, dataDir } = require("../lib/config");
const store = require("../lib/entity_store");

// open-notebook stores everything in SurrealDB, reachable only through its
// FastAPI REST API — so unlike the Claude/Antigravity/opencode parsers (which
// read files), this one is an HTTP client. We map:
//   Notebook -> Session (lineage root)
//   Source   -> Artifact (ingested document/material)
//   Note     -> Thought (AI-authored) or Message (human-authored)
//
// Override the base URL with MEM0RAY_OPEN_NOTEBOOK_URL for non-standard installs.
const API_BASE = (
  process.env.MEM0RAY_OPEN_NOTEBOOK_URL ||
  config.OPEN_NOTEBOOK_API_URL ||
  "http://localhost:5055"
).replace(/\/+$/, "");

const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, "entities");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ENTITIES_DIR)) fs.mkdirSync(ENTITIES_DIR, { recursive: true });

function loadIndex() {
  if (fs.existsSync(INDEX_FILE)) return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  return {
    claude_last_sync_timestamp: 0,
    antigravity_last_sync_timestamp: 0,
    opencode_last_sync_timestamp: 0,
    open_notebook_last_sync_timestamp: 0,
    sessions: [],
    artifacts: []
  };
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function saveEntity(entity, overwrite = false) {
  const file = path.join(ENTITIES_DIR, `${entity.id}.json`);
  if (!overwrite && fs.existsSync(file)) return;
  fs.writeFileSync(file, JSON.stringify(entity, null, 2));
  store.recordTouched(entity.id);
}

function hash(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function updateParentChild(parentId, childId) {
  if (parentId === childId) return;
  const parentFile = path.join(ENTITIES_DIR, `${parentId}.json`);
  if (!fs.existsSync(parentFile)) return;
  const parent = JSON.parse(fs.readFileSync(parentFile, "utf-8"));
  if (!parent.children_ids) parent.children_ids = [];
  if (!parent.children_ids.includes(childId)) {
    parent.children_ids.push(childId);
    saveEntity(parent, true);
  }
}

function toTs(value) {
  const t = Date.parse(value || "");
  return Number.isNaN(t) ? Date.now() : t;
}

// Fetch JSON with a bounded timeout so a slow/down service never hangs a sync.
async function getJSON(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function syncOpenNotebook() {
  console.log("[OpenNotebook Sync] Starting...");
  const index = loadIndex();
  const newSyncTime = Date.now();
  const startTouched = store.touchedCount();
  let totalNodes = 0;

  const notebooks = await getJSON(`${API_BASE}/api/notebooks`);
  if (!Array.isArray(notebooks)) {
    // Service down or unreachable — skip quietly, leave existing entities
    // intact. Nothing was written, so the index (and warm cache) stay put.
    console.log("[OpenNotebook Sync] API unreachable, skipping.");
    return;
  }

  for (const nb of notebooks) {
    if (!nb || !nb.id) continue;
    const sessionUUID = hash("opennotebook:" + nb.id);

    saveEntity(
      {
        id: sessionUUID,
        type: "Session",
        agent: "OpenNotebook",
        timestamp: toTs(nb.updated || nb.created),
        content: nb.name || `Notebook ${nb.id}`,
        metadata: {
          project: nb.name || "OpenNotebook",
          taskType: "Notebook",
          tokens: 0,
          description: nb.description || null,
          sourceCount: nb.source_count || 0,
          noteCount: nb.note_count || 0,
          archived: !!nb.archived,
          notebookId: nb.id,
          entrypoint: "open-notebook",
          isActive: false
        },
        parent_id: null,
        children_ids: []
      },
      true
    );

    if (!index.sessions.includes(sessionUUID)) index.sessions.push(sessionUUID);

    // Sources -> Artifacts
    const sources = await getJSON(
      `${API_BASE}/api/sources?notebook_id=${encodeURIComponent(nb.id)}`
    );
    for (const src of Array.isArray(sources) ? sources : []) {
      if (!src || !src.id) continue;
      const sid = hash("opennotebook:source:" + src.id);
      const topics = Array.isArray(src.topics) ? src.topics.filter(Boolean).join(", ") : "";
      const excerpt = typeof src.full_text === "string" ? src.full_text.slice(0, 1200) : "";
      const body = [src.title || "(untitled source)", topics && `Topics: ${topics}`, excerpt]
        .filter(Boolean)
        .join("\n\n");
      saveEntity(
        {
          id: sid,
          type: "Artifact",
          agent: "OpenNotebook",
          timestamp: toTs(src.updated || src.created),
          content: body.slice(0, 2000),
          metadata: {
            fileName: src.title || "source",
            sourceId: src.id,
            embedded: !!src.embedded,
            embeddedChunks: src.embedded_chunks || 0,
            status: src.status || null,
            kind: "source"
          },
          parent_id: sessionUUID,
          children_ids: []
        },
        true
      );
      updateParentChild(sessionUUID, sid);
      totalNodes++;
    }

    // Notes -> Thought (AI) or Message (human)
    const notes = await getJSON(`${API_BASE}/api/notes?notebook_id=${encodeURIComponent(nb.id)}`);
    for (const note of Array.isArray(notes) ? notes : []) {
      if (!note || !note.id) continue;
      const nid = hash("opennotebook:note:" + note.id);
      const isAi = (note.note_type || "").toLowerCase() === "ai";
      const body = [note.title, note.content].filter(Boolean).join("\n\n");
      saveEntity(
        {
          id: nid,
          type: isAi ? "Thought" : "Message",
          agent: "OpenNotebook",
          timestamp: toTs(note.updated || note.created),
          content: (body || "(empty note)").slice(0, 2000),
          metadata: {
            noteId: note.id,
            noteType: note.note_type || null,
            kind: "note",
            model: isAi ? "open-notebook-ai" : "user"
          },
          parent_id: sessionUUID,
          children_ids: []
        },
        true
      );
      updateParentChild(sessionUUID, nid);
      totalNodes++;
    }
  }

  if (store.touchedCount() > startTouched) {
    index.open_notebook_last_sync_timestamp = newSyncTime;
    saveIndex(index);
  }
  console.log(
    `[OpenNotebook Sync] Complete. ${notebooks.length} notebook(s), ${totalNodes} source/note nodes.`
  );
}

module.exports = { syncOpenNotebook };
