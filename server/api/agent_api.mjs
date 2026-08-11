// Agent HTTP API (EP-A) — the tuned tool-use policy served over /api/agent/*, so the Bridge UI is a
// WRAPPER on the same runtime the CLI uses (scripts/agent/runtime.mjs runAgent), never a second harness.
//
// Mounted by app.js AHEAD of the flat generic router (like the coordination + estate APIs) because the
// paths are nested. `tryHandle` returns true when it owns the request.
//
// Safety (fail-closed): the sandbox root is ALWAYS the server's projectRoot — a client cannot point the
// agent elsewhere. Role defaults to "analyst" (read-only navigation). Shell execution (developer role)
// runs ONLY when the operator has set PRIME_SILO_AGENT_EXEC=1; otherwise the bash tool refuses at
// runtime. This mirrors the ADR-001 determinism boundary: the web surface is read-only until the owner
// opts in on the host.
const PREFIX = "/api/agent";
const DEFAULT_MODEL = "gemma-4-e4b-agent";
const DEFAULT_BASE_URL = "http://localhost:1234/v1"; // LOCAL only — never the LAN host

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => { if (!buf) return resolve({}); try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

export function createAgentApi({ projectRoot, prefix = PREFIX, model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL } = {}) {
  const root = projectRoot || process.cwd();
  const execEnabled = process.env.PRIME_SILO_AGENT_EXEC === "1";

  async function handle(req, res, rest) {
    // GET /health — is a model actually being served locally? Lets the UI show availability.
    if (req.method === "GET" && rest === "/health") {
      try {
        const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(4000) });
        const d = await r.json();
        const models = (d?.data || []).map((m) => m.id);
        return sendJson(res, 200, { ok: true, baseUrl, models, exec_enabled: execEnabled, default_model: model });
      } catch {
        return sendJson(res, 200, { ok: false, baseUrl, models: [], exec_enabled: execEnabled, error: "no model server on localhost:1234" });
      }
    }

    // POST /run — run the agent loop, STREAMING each step as SSE (steps are ~seconds each).
    if (req.method === "POST" && rest === "/run") {
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object") return sendJson(res, 400, { error: "malformed JSON body" });
      if (!body.task || typeof body.task !== "string") return sendJson(res, 422, { error: "task (string) required" });

      const role = body.role === "developer" ? "developer" : "analyst";
      const wantsExec = body.exec === true;
      if (wantsExec && !execEnabled) {
        return sendJson(res, 403, { error: "shell execution disabled; set PRIME_SILO_AGENT_EXEC=1 on the host to enable" });
      }
      // Import the SAME runtime the CLI uses (in-process — no second harness).
      const { runAgent } = await import(new URL("../../scripts/agent/runtime.mjs", import.meta.url).href);

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("start", { task: body.task, role, model: body.model || model, exec: wantsExec && execEnabled });

      let aborted = false;
      req.on("close", () => { aborted = true; });
      try {
        const out = await runAgent({
          task: body.task, role, model: body.model || model, baseUrl,
          root, // ALWAYS the server root — client cannot override
          allowExec: wantsExec && execEnabled,
          maxSteps: Math.min(Number(body.steps) || 12, 24),
          onStep: (r) => { if (!aborted) send("step", r); },
        });
        if (!aborted) { send("done", out); res.end(); }
      } catch (e) {
        if (!aborted) { send("error", { error: e.message }); res.end(); }
      }
      return;
    }

    return sendJson(res, 404, { error: `unknown agent route: ${req.method} ${rest}` });
  }

  return {
    async tryHandle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p !== prefix && !p.startsWith(prefix + "/")) return false;
      const rest = p.slice(prefix.length) || "/";
      await handle(req, res, rest);
      return true;
    },
  };
}
