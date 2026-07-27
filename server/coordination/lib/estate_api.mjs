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

export function createEstateApi({ kelLog = null, estateFile = null, bus, prefix = PREFIX } = {}) {
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
