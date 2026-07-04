// Read-only client for the memo-ray entity store (ADR-005 §3).
// Mirrors memo-ray/mcp-server/data-reader.js but reads the store directly
// so the pipeline works whether or not the memo-ray server is running.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { config } from "./config.mjs";

const entitiesDir = () => path.join(config.MEMORAY_DATA_DIR, "entities");
const indexPath = () => path.join(config.MEMORAY_DATA_DIR, "index.json");

export function readIndex() {
  return JSON.parse(fs.readFileSync(indexPath(), "utf8"));
}

export function readEntity(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(entitiesDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function listSessions({ agents = null, since = 0 } = {}) {
  const index = readIndex();
  const out = [];
  for (const id of index.sessions || []) {
    const s = readEntity(id);
    if (!s) continue;
    if (agents && !agents.includes((s.agent || "").toLowerCase())) continue;
    if (since && (s.timestamp || 0) < since) continue;
    out.push(s);
  }
  out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return out;
}

// Breadth-first walk of children_ids — same traversal as memo-ray's timeline.
export function readTimeline(sessionId, maxNodes = 5000) {
  const root = readEntity(sessionId);
  if (!root) return [];
  const timeline = [root];
  const seen = new Set([sessionId]);
  const queue = [...(root.children_ids || [])];
  while (queue.length > 0 && timeline.length < maxNodes) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const e = readEntity(id);
    if (!e) continue;
    timeline.push(e);
    if (e.children_ids) queue.push(...e.children_ids);
  }
  timeline.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return timeline;
}

// Phase A: refresh the store. Prefer the running memo-ray server (it owns the
// watermarks and its 30s loop may be mid-flight); fall back to invoking the
// parsers in-process — they are dependency-free CJS.
export async function syncStore() {
  try {
    const res = await fetch(`${config.MEMORAY_SERVER_URL}/api/sync`, {
      signal: AbortSignal.timeout(120000)
    });
    if (res.ok) return { via: "server" };
  } catch {
    /* server not running — fall through */
  }
  const script =
    "const c=require('./parsers/claudeParser');const a=require('./parsers/antigravityParser');" +
    "(async()=>{await c.syncClaude();await a.syncAntigravity();})().catch(e=>{console.error(e);process.exit(1);});";
  const r = spawnSync(process.execPath, ["-e", script], {
    cwd: config.MEMORAY_SERVER_DIR,
    encoding: "utf8",
    timeout: 600000,
    // memo-ray's own CLAUDE_LOG_DIRS can be undefined (found live: 7 stale Claude
    // sessions, recent ones missing). Hand the parser the resolved Claude dir so
    // the direct-parser fallback discovers every ~/.claude/projects session.
    env: { ...process.env, MEM0RAY_CLAUDE_DIRS: config.CLAUDE_DIRS }
  });
  if (r.status !== 0) {
    throw new Error(`memo-ray direct sync failed: ${r.stderr || r.stdout || r.status}`);
  }
  return { via: "direct" };
}
