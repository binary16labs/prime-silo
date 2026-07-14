// Minimal static server for the LONGVIEW dashboard (serves this dir on :8788).
// Read-only, localhost — exists only so the dashboard's fetch('dashboard.json')
// works with a real same-origin http server. No impact on the map run.
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

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
