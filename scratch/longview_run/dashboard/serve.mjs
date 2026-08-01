// Minimal static server for the LONGVIEW dashboard (serves this dir on :8788).
// Read-only, localhost — exists only so the dashboard's fetch('dashboard.json')
// works with a real same-origin http server. No impact on the map run.
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

// ── memory API (loopback ONLY — teleport moves data; never LAN-exposed) ─────
const REPO = "C:/Users/nsdha/OneDrive/binary16/prime-silo";
const WS_ROOT = `${(process.env.BENNY_HOME || "C:/Users/nsdha/AppData/Roaming/space-agent/benny-home/benny").replace(/\\/g, "/")}/workspaces`;
const isLoopback = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

// ── control plane (loopback ONLY — it can launch mutating builds) ──────────
import { handleControl } from "./control.mjs";

function controlApi(req, res, rawUrl) {
  const [url, qs] = rawUrl.split("?");
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (!isLoopback(req)) return json(403, { error: "control plane is loopback-only" });
  try {
    return handleControl(req, res, url, q, json, isLoopback);
  } catch (e) {
    return json(500, { error: String(e && e.message).slice(0, 400) });
  }
}

function runMemory(workspace, cliArgs, cb) {
  const child = spawn("node", [path.join(REPO, "scripts", "longview", "memory.mjs"), ...cliArgs], {
    cwd: REPO,
    env: { ...process.env, LONGVIEW_WORKSPACE: workspace || "sessions_v1" }
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const t = setTimeout(() => child.kill(), 1800000);
  child.on("close", (code) => {
    clearTimeout(t);
    cb(code, out);
  });
  child.on("error", (e) => {
    clearTimeout(t);
    cb(1, String(e));
  });
}

// Artifact lineage + step-through, reusing scripts/longview/record_cli.mjs
// (which reuses lib/record.mjs — the same disk-truth the app's benny_record
// player uses). Read-only; safe on the LAN.
function lineageApi(req, res, url) {
  const q = Object.fromEntries(new URL(url, "http://x").searchParams);
  const scope = q.scope;
  if (!scope) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "scope required (card:sid|section:id|dossier:name|book|run)" }));
  }
  const child = spawn("node", [path.join(REPO, "scripts", "longview", "record_cli.mjs"), "--scope", scope], {
    cwd: REPO,
    env: { ...process.env, LONGVIEW_WORKSPACE: q.workspace || "sessions_v1" }
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", () => {});
  const t = setTimeout(() => child.kill(), 30000);
  child.on("close", () => {
    clearTimeout(t);
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      res.end(JSON.stringify(JSON.parse(out)));
    } catch {
      res.end(JSON.stringify({ error: out.slice(0, 300) || "no output" }));
    }
  });
}

function memoryApi(req, res, url) {
  if (!isLoopback(req)) {
    res.writeHead(403);
    return res.end("memory API is loopback-only");
  }
  const q = Object.fromEntries(new URL(url, "http://x").searchParams);
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && url.startsWith("/api/memory/workspaces")) {
    const list = fs
      .readdirSync(WS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    return json(200, { workspaces: list });
  }
  if (req.method === "GET" && url.startsWith("/api/memory/search")) {
    if (!q.terms) return json(400, { error: "terms required" });
    return runMemory(q.workspace, ["resolve", "--terms", q.terms, "--json"], (code, out) => {
      try {
        json(200, JSON.parse(out.slice(out.indexOf("{"))));
      } catch {
        json(500, { error: out.slice(0, 500) });
      }
    });
  }
  if (req.method === "POST" && (url.startsWith("/api/memory/teleport") || url.startsWith("/api/memory/gate"))) {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return json(400, { error: "bad json" });
      }
      if (!p.terms) return json(400, { error: "terms required" });
      // Target names: workspace-safe charset only — this becomes a directory
      // and a Neo4j property value.
      if (url.includes("teleport") && !/^[\w.-]+$/.test(p.target || ""))
        return json(400, { error: "target must be [A-Za-z0-9_.-]+" });
      const cliArgs = url.includes("gate")
        ? ["gate", "--terms", p.terms]
        : [
            "teleport",
            "--terms", p.terms,
            "--to", p.target,
            ...(p.sids ? ["--sids", p.sids] : []),
            ...(p.dryRun ? ["--dry-run"] : [])
          ];
      runMemory(p.workspace, cliArgs, (code, out) => json(200, { code, output: out.slice(0, 20000) }));
    });
    return;
  }
  json(404, { error: "unknown memory endpoint" });
}

const DIR = path.resolve("C:/Users/nsdha/OneDrive/binary16/prime-silo/scratch/longview_run/dashboard");
const PORT = 8788;
// Bind to all interfaces so other devices on the LAN can reach it. Set
// DASH_HOST=127.0.0.1 to lock it back to localhost-only.
const HOST = process.env.DASH_HOST || "0.0.0.0";
const lanIP = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n && n.family === "IPv4" && !n.internal)?.address;
const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };

http
  .createServer((req, res) => {
    if ((req.url || "").startsWith("/api/control/")) return controlApi(req, res, req.url);
    if ((req.url || "").startsWith("/api/memory/")) return memoryApi(req, res, req.url);
    if ((req.url || "").startsWith("/api/lineage/")) return lineageApi(req, res, req.url);
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/dashboard.html";
    const file = path.resolve(DIR, "." + p);
    if (!file.startsWith(DIR) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    // readFileSync (not a stream): the collector rewrites dashboard.json every
    // 20s and an unhandled stream error on a mid-write read crashed the whole
    // server (2026-07-14). A failed read is a 503 the page retries in 15s.
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(503);
      res.end("busy");
    }
  })
  .listen(PORT, HOST, () =>
    console.log(
      `[dashboard] serving on ${HOST}:${PORT}\n  local:  http://127.0.0.1:${PORT}/` +
        (lanIP && HOST !== "127.0.0.1" ? `\n  LAN:    http://${lanIP}:${PORT}/  ← open this from other devices` : "")
    )
  );
