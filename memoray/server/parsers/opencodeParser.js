const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Load central configuration contract
const { config, dataDir } = require("../lib/config");
const store = require("../lib/entity_store");

const home = os.homedir();

// opencode stores each session as a tree of JSON files:
//   storage/session/<projectID>/ses_*.json   — session metadata
//   storage/message/<sessionID>/msg_*.json    — messages (role, model, tokens)
//   storage/part/<messageID>/prt_*.json       — message parts (text + tool calls)
// We read this JSON tree (not the mirrored SQLite db) to match the existing
// file-parser pattern used for Claude and Antigravity.
//
// Override with MEM0RAY_OPENCODE_DIRS for testing against fixtures. Fall back to
// the standard XDG location so this works even on installs whose generated
// ~/.mem0ray/mem0ray.config.js predates the OPENCODE_* keys.
const DEFAULT_STORAGE_DIRS = [
  path.join(home, ".local", "share", "opencode", "storage"),
  path.join(home, ".config", "opencode", "storage")
];
const OPENCODE_STORAGE_DIRS = process.env.MEM0RAY_OPENCODE_DIRS
  ? process.env.MEM0RAY_OPENCODE_DIRS.split(";")
      .map((p) => p.trim())
      .filter(Boolean)
  : Array.isArray(config.OPENCODE_STORAGE_DIRS) && config.OPENCODE_STORAGE_DIRS.length
    ? config.OPENCODE_STORAGE_DIRS
    : DEFAULT_STORAGE_DIRS;

const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, "entities");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ENTITIES_DIR)) fs.mkdirSync(ENTITIES_DIR, { recursive: true });

// Tools whose effect is writing a file — surfaced as Artifacts in the lineage.
const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

function loadIndex() {
  if (fs.existsSync(INDEX_FILE)) return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  return {
    claude_last_sync_timestamp: 0,
    antigravity_last_sync_timestamp: 0,
    opencode_last_sync_timestamp: 0,
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
    saveEntity(parent, true); // Force overwrite for parent update
  }
}

// opencode ids (ses_/msg_/prt_) are time-ordered ULID-style strings, so a
// lexical sort of filenames preserves creation order.
function listJsonSorted(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

// Recursively collect ses_*.json files under storage/session/<projectID>/
function findSessionFiles(dir, filesList = []) {
  if (!fs.existsSync(dir)) return filesList;
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        findSessionFiles(full, filesList);
      } else if (name.startsWith("ses_") && name.endsWith(".json")) {
        filesList.push(full);
      }
    }
  } catch {
    /* dir read error, skip */
  }
  return filesList;
}

function dirMtimeMs(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function extractFilePath(input) {
  if (!input || typeof input !== "object") return null;
  let raw =
    input.filePath || input.file_path || input.path || input.target_file || input.absolute_path;
  if (typeof raw !== "string") return null;
  return raw.trim().replace(/^["']|["']$/g, "");
}

// Parse one session's messages/parts into a linear lineage hanging off the
// Session node. Returns { nodesProcessed, tokens }.
function parseSession(storageDir, sessionId, sessionUUID) {
  let lastNodeId = sessionUUID;
  let nodesProcessed = 0;
  let tokens = 0;

  const msgDir = path.join(storageDir, "message", sessionId);
  for (const msgFile of listJsonSorted(msgDir)) {
    let msg;
    try {
      msg = JSON.parse(fs.readFileSync(path.join(msgDir, msgFile), "utf-8"));
    } catch {
      continue;
    }

    const role = msg.role || "assistant";
    const modelLabel =
      role === "user"
        ? "user"
        : [msg.providerID, msg.modelID].filter(Boolean).join(":") || "assistant";
    const msgTs = msg.time?.created || Date.now();

    if (msg.tokens) {
      tokens += (msg.tokens.input || 0) + (msg.tokens.output || 0);
    }

    // A failed assistant turn carries an error but no parts — record it so
    // the lineage shows what went wrong (e.g. local model lacks tool support).
    const parts = listJsonSorted(path.join(storageDir, "part", msg.id));
    if (parts.length === 0 && msg.error) {
      const errId = hash("opencode:" + msg.id + ":error");
      saveEntity({
        id: errId,
        type: "Tool Result",
        agent: "Opencode",
        timestamp: msgTs,
        content: (
          "Error: " +
          (msg.error.name || "") +
          " — " +
          (msg.error.data?.message || "")
        ).substring(0, 2000),
        metadata: { model: modelLabel, isError: true },
        parent_id: lastNodeId,
        children_ids: []
      });
      updateParentChild(lastNodeId, errId);
      lastNodeId = errId;
      nodesProcessed++;
      continue;
    }

    for (const partFile of parts) {
      let part;
      try {
        part = JSON.parse(
          fs.readFileSync(path.join(storageDir, "part", msg.id, partFile), "utf-8")
        );
      } catch {
        continue;
      }

      if (part.type === "text") {
        const text = (part.text || "").trim();
        if (!text) continue;
        const id = hash("opencode:" + part.id);
        saveEntity({
          id,
          type: role === "user" ? "User Input" : "Message",
          agent: "Opencode",
          timestamp: msgTs,
          content: text.substring(0, 2000),
          metadata: { model: modelLabel },
          parent_id: lastNodeId,
          children_ids: []
        });
        updateParentChild(lastNodeId, id);
        lastNodeId = id;
        nodesProcessed++;
      } else if (part.type === "tool") {
        const st = part.state || {};
        const toolName = part.tool || "tool";
        const input = st.input || {};
        const filePath = extractFilePath(input);
        const fileName = filePath ? path.basename(filePath.replace(/\\/g, "/")) : null;
        const isArtifact = EDIT_TOOLS.has(toolName);

        // Tool Call (or Artifact for file-writing tools)
        const callId = hash("opencode:" + part.id + ":call");
        saveEntity({
          id: callId,
          type: isArtifact ? "Artifact" : "Tool Call",
          agent: "Opencode",
          timestamp: msgTs,
          content: JSON.stringify({ tool: toolName, input }, null, 2).substring(0, 2000),
          metadata: { model: modelLabel, toolName, fileName, filePath },
          parent_id: lastNodeId,
          children_ids: []
        });
        updateParentChild(lastNodeId, callId);
        lastNodeId = callId;
        nodesProcessed++;

        // Tool Result — opencode stores the output on the same part.
        const output = st.output;
        const status = st.status;
        const hasResult = (typeof output === "string" && output.length > 0) || status === "error";
        if (hasResult) {
          const resId = hash("opencode:" + part.id + ":result");
          const resContent = typeof output === "string" ? output : JSON.stringify(output || "");
          saveEntity({
            id: resId,
            type: "Tool Result",
            agent: "Opencode",
            timestamp: msgTs,
            content: resContent.substring(0, 2000),
            metadata: {
              model: modelLabel,
              toolName,
              status: status || null,
              isError: status === "error"
            },
            parent_id: lastNodeId,
            children_ids: []
          });
          updateParentChild(lastNodeId, resId);
          lastNodeId = resId;
          nodesProcessed++;
        }
      }
      // other part types (step-start, etc.) are skipped
    }
  }

  return { nodesProcessed, tokens };
}

const SYNC_BUFFER_MS = 5 * 60 * 1000; // 5-minute overlap, mirrors the Claude parser

async function syncOpencode() {
  console.log("[Opencode Sync] Starting...");
  const index = loadIndex();
  const lastSync = index.opencode_last_sync_timestamp || 0;
  const newSyncTime = Date.now();
  const startTouched = store.touchedCount();
  let totalNodes = 0;

  for (const storageDir of OPENCODE_STORAGE_DIRS) {
    const sessionRoot = path.join(storageDir, "session");
    const sessionFiles = findSessionFiles(sessionRoot);

    for (const file of sessionFiles) {
      let ses;
      try {
        ses = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        continue;
      }
      if (!ses.id) continue;

      // Delta gate: re-parse if the session file or its message folder
      // changed since the last sync (the message dir mtime bumps when new
      // messages/parts arrive). Re-parsing is idempotent (child entities
      // are write-once), so the buffer just avoids missing in-flight writes.
      const msgDir = path.join(storageDir, "message", ses.id);
      const lastTouched = Math.max(fs.statSync(file).mtimeMs, dirMtimeMs(msgDir));
      if (lastTouched <= lastSync - SYNC_BUFFER_MS) continue;

      const sessionUUID = hash("opencode:" + ses.id);
      const cwd = ses.directory || null;
      const projectName = cwd ? path.basename(cwd.replace(/\\/g, "/")) : "Unknown";
      const title = ses.title || `opencode ${ses.id}`;

      // Initialize/refresh the Session node so children can attach to it
      saveEntity(
        {
          id: sessionUUID,
          type: "Session",
          agent: "Opencode",
          timestamp: ses.time?.created || fs.statSync(file).mtimeMs,
          content: title,
          metadata: {
            filePath: file,
            project: projectName,
            tokens: 0,
            taskType: "Code",
            cwd,
            opencodeSessionId: ses.id,
            version: ses.version || null,
            entrypoint: "opencode"
          },
          parent_id: null,
          children_ids: []
        },
        true
      );

      if (!index.sessions.includes(sessionUUID)) index.sessions.push(sessionUUID);

      console.log(`[Opencode Sync] Parsing: ${ses.id} (${projectName})`);
      const result = parseSession(storageDir, ses.id, sessionUUID);

      // Re-save the session with the accumulated token total
      const sessionFilePath = path.join(ENTITIES_DIR, `${sessionUUID}.json`);
      try {
        const updated = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
        updated.metadata.tokens = result.tokens;
        updated.metadata.isActive = false; // opencode exposes no live-PID signal
        saveEntity(updated, true);
      } catch {
        /* ignore */
      }

      totalNodes += result.nodesProcessed;
    }
  }

  if (store.touchedCount() > startTouched) {
    index.opencode_last_sync_timestamp = newSyncTime;
    saveIndex(index);
  }
  console.log(`[Opencode Sync] Complete. Parsed ${totalNodes} new/updated nodes.`);
}

module.exports = { syncOpencode };
