// Estate HTTP API (EP-N / N2) — the N0 estate model served live over /api/estate/*,
// mounted by app.js AHEAD of the generic handler (like B1's coordination API) so its
// nested paths win, returning true when it owns the request and false to fall through.
// Reuses the N0 projection (buildEstate over the estate KEL log) and the B1 bus for SSE.
// Design: architecture/SOLUTION-estate.md §3.4.
import fs from "node:fs";
import { readKelEvents } from "./kel.mjs";
import { buildEstate } from "./estate.mjs";

const PREFIX = "/api/estate";
const EMPTY = { machines: {}, drives: {}, sessions: {}, snapshots: {} };

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

// Always-fresh: fold the estate KEL log on read (cheap; the log is small). Falls back to a
// prebuilt estate.jsonl, then to an empty model — the API never throws for a missing source.
function loadEstate({ kelLog, estateFile }) {
  try {
    if (kelLog && fs.existsSync(kelLog)) {
      const r = readKelEvents(kelLog);
      if (r.ok) return buildEstate(r.events);
    }
    if (estateFile && fs.existsSync(estateFile)) return JSON.parse(fs.readFileSync(estateFile, "utf8"));
  } catch {
    /* fall through to empty — a governance surface must render, not 500 */
  }
  return { ...EMPTY };
}

function summarize(est) {
  return {
    machines: Object.keys(est.machines || {}).length,
    drives: Object.keys(est.drives || {}).length,
    sessions: Object.keys(est.sessions || {}).length,
    quarantined: Object.values(est.sessions || {}).filter((s) => s.quarantined).length
  };
}

// --- N3 tie-ins (pure, exported for direct unit tests) --------------------------

// Fold delivery/board/BOARD.md into a lane summary: per-column counts + the topmost
// READY items (what to work next). Column headers are "## READY|CLAIMED|VERIFY|DONE".
export function boardLanes(boardText = "") {
  const lanes = { READY: [], CLAIMED: [], VERIFY: [], DONE: [] };
  let section = null;
  for (const line of boardText.split(/\r?\n/)) {
    const h = line.match(/^##\s+(READY|CLAIMED|VERIFY|DONE)\b/);
    if (h) { section = h[1]; continue; }
    if (h === null && /^##\s/.test(line)) { section = null; continue; } // left the tracked columns
    if (!section) continue;
    const m = line.match(/^-\s+([A-Z]\d+|M2-\d+)\s+—\s+([^·]+?)\s+·/);
    if (m) lanes[section].push({ id: m[1], title: m[2].trim() });
  }
  return {
    ready: { count: lanes.READY.length, top: lanes.READY.slice(0, 3) },
    claimed: { count: lanes.CLAIMED.length, items: lanes.CLAIMED },
    verify: { count: lanes.VERIFY.length },
    done: { count: lanes.DONE.length }
  };
}

// Drill-down payload for one machine. PRIVACY (R31): a quarantined session contributes
// ONLY to the count + a flag — never its sid, project, or any identifying content.
export function drillMachine(estate = {}, machine) {
  const sessions = [];
  let quarantined = 0;
  const timeline = [];
  for (const [hash, s] of Object.entries(estate.sessions || {})) {
    const onMachine = (s.drives || []).some((d) => String(d).split(":")[0] === machine);
    if (!onMachine) continue;
    if (s.quarantined) { quarantined++; continue; } // flag + count only; nothing identifying leaves
    sessions.push({ content_hash: hash, project: s.project ?? null });
    timeline.push({ kind: "session", ref: hash, project: s.project ?? null });
  }
  return { machine, sessions, quarantined, total: sessions.length + quarantined, timeline };
}

// LONGVIEW pipeline progress for the Dial — the REAL fractions from progress.json, or a
// null shape when there is no active run. Never fabricates a fraction.
export function longviewProgress(progressFile) {
  try {
    if (progressFile && fs.existsSync(progressFile)) {
      const p = JSON.parse(fs.readFileSync(progressFile, "utf8"));
      return { present: true, ...p };
    }
  } catch {
    /* unreadable/corrupt progress → treat as absent, never guess */
  }
  return { present: false, stages: null };
}

export function createEstateApi({
  kelLog = null,
  estateFile = null,
  boardFile = null,
  longviewProgressFile = null,
  bus,
  prefix = PREFIX
} = {}) {
  function handle(req, res, rest) {
    // GET /api/estate — the whole estate model (machines, drives, sessions, snapshots) + a summary.
    if (req.method === "GET" && (rest === "/" || rest === "")) {
      const est = loadEstate({ kelLog, estateFile });
      return sendJson(res, 200, { ...est, summary: summarize(est) });
    }

    // GET /api/estate/stream — subscribe to live estate events over SSE (reuse the B1 bus).
    if (req.method === "GET" && rest === "/stream") {
      if (!bus) return sendJson(res, 503, { error: "no event bus configured" });
      bus.subscribe(res);
      return; // response stays open, owned by the bus
    }

    // GET /api/estate/board — the delivery board folded into a lane summary (N3 tie-in).
    if (req.method === "GET" && rest === "/board") {
      const text = boardFile && fs.existsSync(boardFile) ? fs.readFileSync(boardFile, "utf8") : "";
      return sendJson(res, 200, boardLanes(text));
    }

    // GET /api/estate/longview — real LONGVIEW pipeline progress for the Dial (or a null shape).
    if (req.method === "GET" && rest === "/longview") {
      return sendJson(res, 200, longviewProgress(longviewProgressFile));
    }

    // GET /api/estate/drill/:machine — drill-down payload; quarantine never leaks (R31).
    const drill = rest.match(/^\/drill\/([^/]+)$/);
    if (req.method === "GET" && drill) {
      const est = loadEstate({ kelLog, estateFile });
      return sendJson(res, 200, drillMachine(est, decodeURIComponent(drill[1])));
    }

    return sendJson(res, 404, { error: `unknown estate route: ${req.method} ${rest}` });
  }

  return {
    // true → this request is /api/estate/* (handled here, app.js stops); false → fall through.
    tryHandle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p !== prefix && !p.startsWith(prefix + "/")) return false;
      const rest = p.slice(prefix.length) || "/";
      handle(req, res, rest);
      return true;
    }
  };
}
