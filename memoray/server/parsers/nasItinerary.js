// NAS itinerary — turns the NAS catalog's event log into Memo-Ray timeline entities.
//
// Pure mapping, no config and no disk, so it is testable on its own; nasItineraryParser.js does
// the reading and writing. The log is the estate's hash-chained KEL (eventlog/nas-<machine>.jsonl,
// written only by scripts/nas_catalog.mjs), so this reads history rather than keeping a second
// copy of it: one writer, and Memo-Ray is a view.
//
// Shape: one Session per machine per day ("NAS itinerary 2026-09-13 · t480"), and under it one
// Artifact per file movement and one Thought per scan summary. A day is the unit a person asks
// about ("what did I move to the NAS on Tuesday?"), and a file movement is the unit they recall.
const crypto = require("crypto");

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const lineHash = (raw) =>
  crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);

// Verify the chain from where the previous sync stopped. `prevHash` is the hash of the last line
// already indexed ("genesis" for a new log). Stops at the first break and says where, so a
// tampered or truncated log is surfaced instead of being silently half-indexed.
function readNewEvents(text, { fromLine = 0, prevHash = "genesis" } = {}) {
  const lines = String(text || "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const events = [];
  let expected = prevHash;
  for (let i = fromLine; i < lines.length; i++) {
    let evt;
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      return {
        events,
        nextLine: i,
        lastHash: expected,
        broken: { line: i + 1, reason: "unparseable" }
      };
    }
    if (evt.prev !== expected)
      return {
        events,
        nextLine: i,
        lastHash: expected,
        broken: { line: i + 1, reason: "chain-break" }
      };
    events.push(evt);
    expected = lineHash(lines[i]);
  }
  return { events, nextLine: lines.length, lastHash: expected, broken: null };
}

const gb = (n) => {
  const v = Number(n || 0);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
};

function describe(evt) {
  const p = evt.payload || {};
  const file = p.nas_path || p.path || "(unknown path)";
  const from = p.origin_machine ? ` from ${p.origin_machine}` : "";
  const why = p.purpose && !String(p.purpose).startsWith("nas:") ? ` — ${p.purpose}` : "";
  switch (evt.type) {
    case "artifact_placed":
      if (p.change === "moved") return `Moved ${p.from_path} → ${file}`;
      if (p.change === "changed") return `Replaced ${file} with new content (${gb(p.size)})`;
      return `Added ${file} (${gb(p.size)})${from}${why}`;
    case "artifact_evicted":
      if (p.change === "removed") return `Removed ${file} (${gb(p.size)})`;
      return null; // the eviction half of a move or change is described by its placement
    case "sweep_recorded":
      return (
        `NAS scan: +${p.added || 0} added, ${p.changed || 0} changed, ${p.moved || 0} moved, ` +
        `${p.removed || 0} removed · ${p.files_total || 0} files, ${gb(p.bytes_total)} on the share`
      );
    default:
      return null; // artifact_acquired is folded into the placement line
  }
}

function itineraryEntities(events) {
  const sessions = new Map();
  const children = [];
  for (const evt of events) {
    const content = describe(evt);
    if (!content) continue;
    const machine = String(evt.machine || "unknown");
    const ts = Date.parse(evt.valid_time || evt.txn_time) || Date.now();
    const day = new Date(ts).toISOString().slice(0, 10);
    const sessionId = md5(`nas-itinerary:${machine}:${day}`);
    if (!sessions.has(sessionId))
      sessions.set(sessionId, {
        id: sessionId,
        type: "Session",
        agent: "NAS",
        timestamp: ts,
        content: `NAS itinerary ${day} · ${machine}`,
        metadata: {
          project: "NAS",
          taskType: "Itinerary",
          tokens: 0,
          machine,
          day,
          entrypoint: "nas-catalog",
          isActive: false
        },
        parent_id: null,
        children_ids: []
      });
    const session = sessions.get(sessionId);
    session.timestamp = Math.max(session.timestamp, ts);
    const p = evt.payload || {};
    const entity = {
      id: md5(`nas-event:${evt.id}`),
      type: evt.type === "sweep_recorded" ? "Thought" : "Artifact",
      agent: "NAS",
      timestamp: ts,
      content,
      metadata: {
        kelEventId: evt.id,
        kelType: evt.type,
        change: p.change || null,
        fileName: p.nas_path ? p.nas_path.split("/").pop() : null,
        filePath: p.path || null,
        nasPath: p.nas_path || null,
        category: p.category || null,
        size: p.size ?? null,
        contentHash: evt.subject?.content_hash || null,
        originMachine: p.origin_machine || null,
        originPath: p.origin_path || null
      },
      parent_id: sessionId,
      children_ids: []
    };
    session.children_ids.push(entity.id);
    children.push(entity);
  }
  return { sessions: [...sessions.values()], children };
}

module.exports = { readNewEvents, itineraryEntities, describe, lineHash };
