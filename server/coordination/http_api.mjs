// Coordination HTTP API (B1 / EP-B) — the B0 ledger served live over /api/coord/*.
//
// The repo router matches only flat single-segment paths (/^\/api\/([a-z0-9_-]+)$/) and is not in
// this task's allowlist, so this module does its OWN nested-path matching and is mounted by app.js
// AHEAD of the generic handler: `tryHandle` returns true when it owns the request (so app.js stops),
// false otherwise (so the normal router runs). It reuses server/coordination/lib/ledger.mjs verbatim
// (validator + fold + append lock) — the server is the single appender when up — and re-broadcasts
// every accepted append on the coordination bus. Design: SPEC-coordination-ledger.md; B1 contract.
import {
  readEvents,
  foldState,
  validateEvent,
  appendEvent,
  loadAgents,
  initCoordination,
  ulid,
} from "./lib/ledger.mjs";

const PREFIX = "/api/coord";

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null); // signal a malformed body
      }
    });
    req.on("error", () => resolve(null));
  });
}

export function createCoordinationApi({ coordDir, bus, prefix = PREFIX }) {
  initCoordination(coordDir); // idempotent: ensure dirs + agents.json exist before serving

  async function handle(req, res, rest, url) {
    // GET /tasks — folded current state (the ledger is truth; leases are advisory).
    if (req.method === "GET" && rest === "/tasks") {
      const { events } = readEvents(coordDir);
      const folded = foldState(events);
      const tasks = [...folded.entries()].map(([task_id, state]) => ({ task_id, ...state }));
      return sendJson(res, 200, tasks);
    }

    // GET /tasks/:id/events — the append-only history for one task.
    const hist = rest.match(/^\/tasks\/([^/]+)\/events$/);
    if (req.method === "GET" && hist) {
      const id = decodeURIComponent(hist[1]);
      const { events } = readEvents(coordDir);
      return sendJson(res, 200, events.filter((e) => e.task_id === id));
    }

    // POST /events — validated append. Invalid → 422 with the validator's reason, no write.
    if (req.method === "POST" && rest === "/events") {
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object") return sendJson(res, 400, { error: "malformed JSON body" });
      // fill server-owned fields if the caller omitted them; `prev` is always the appender's.
      const evt = { id: body.id || ulid(), ts: body.ts || new Date().toISOString(), ...body };
      delete evt.prev;
      const v = validateEvent(evt, loadAgents(coordDir));
      if (!v.ok) return sendJson(res, 422, { error: v.reason }); // rejected — the ledger is untouched
      const line = appendEvent(coordDir, evt); // server is the single appender; sets prev + chains
      const stored = JSON.parse(line);
      bus.publish("coord", stored); // re-broadcast to every live subscriber (R: Bridge/agents see it)
      return sendJson(res, 201, { ok: true, event: stored });
    }

    // GET /knowledge?topic= — shared knowledge notes, optionally filtered by topic.
    if (req.method === "GET" && rest === "/knowledge") {
      const topic = url.searchParams.get("topic");
      const { events } = readEvents(coordDir);
      const notes = events.filter(
        (e) => e.type === "knowledge_added" && (topic == null || e.payload?.topic === topic)
      );
      return sendJson(res, 200, notes);
    }

    // GET /stream — subscribe to the live coordination event feed (SSE).
    if (req.method === "GET" && rest === "/stream") {
      bus.subscribe(res);
      return; // response stays open, owned by the bus
    }

    return sendJson(res, 404, { error: `unknown coordination route: ${req.method} ${rest}` });
  }

  return {
    // Returns true if this request belongs to /api/coord/* (handled here), false to fall through.
    async tryHandle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p !== prefix && !p.startsWith(prefix + "/")) return false;
      const rest = p.slice(prefix.length) || "/";
      await handle(req, res, rest, url);
      return true;
    },
  };
}
