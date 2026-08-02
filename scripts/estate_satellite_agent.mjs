#!/usr/bin/env node
// estate satellite agent — RUNS ON THE SATELLITE (the ASUS). Announces the machine to the
// hub so "just start prime-silo and it detects" becomes literal.
//
// WHY THIS EXISTS. N7 built the hub half of live discovery: POST /api/estate/register with
// a shared-key check, a LAN gate, an R31 payload guard, and a live N4 drift recompute. It
// was verified and then nothing ever called it. Meanwhile the hub had no way to find the
// ASUS at all — the hostname does not resolve, so a hub-initiated pull cannot even start.
//
// THE DIRECTION IS THE POINT. The satellite initiates. That removes the need for the hub to
// resolve or reach the satellite, which is the thing that was actually broken: a machine
// that is powered on and on the LAN can say so itself.
//
// PRIVACY (R31). Only content-hashes and quarantine flags cross the wire — never a byte of
// session text. The manifest is built by the verified buildManifest(), which drops content
// structurally rather than trusting this script to remember not to send it. Quarantined
// sessions are flagged so the hub excludes them from drift; their content never leaves.
//
// Usage (on the ASUS):
//   node scripts/estate_satellite_agent.mjs --hub http://192.168.68.125:3000 --dry-run
//   node scripts/estate_satellite_agent.mjs --hub http://192.168.68.125:3000
//   node scripts/estate_satellite_agent.mjs --discover            # scan the local /24
//   node scripts/estate_satellite_agent.mjs --hub <url> --watch   # heartbeat every 5 min
//
// The key comes from ESTATE_REGISTER_KEY or <BENNY_HOME>/state/estate-register-key. It is
// never printed, never logged, and never written anywhere by this script.

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { buildManifest } from "../server/coordination/lib/estate_register.mjs";
import { resolveRegisterKey } from "../server/coordination/lib/estate_register_key.mjs";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const MACHINE = opt("--machine", process.env.ESTATE_MACHINE || os.hostname());
const HUB = opt("--hub", process.env.ESTATE_HUB || null);
const PORT = Number(opt("--port", process.env.ESTATE_HUB_PORT || 3000));
const HOME = (process.env.BENNY_HOME || path.join(os.homedir(), ".benny")).replace(/\\/g, "/");
const WS = opt("--workspace", process.env.LONGVIEW_WORKSPACE || "sessions_v1");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

const canonicalSid = (s) => String(s).replace(/-/g, "").trim().toLowerCase();

// ── local sessions ────────────────────────────────────────────────────────
/** Where this machine keeps raw agent transcripts. Same layout the hub's landing zone
 *  mirrors: <root>/projects/<project>/<sid>.jsonl */
function sessionRoots() {
  const roots = [];
  const explicit = opt("--sessions", process.env.ESTATE_SESSIONS_DIR || null);
  if (explicit) roots.push(explicit);
  roots.push(path.join(os.homedir(), ".claude", "projects"));
  roots.push(path.join(os.homedir(), ".mem0ray", "data", "projects"));
  roots.push(path.join(os.homedir(), ".mem0ray", "data"));
  return roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}

function* transcripts(root) {
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (d.isDirectory()) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
      for (const f of files) if (f.endsWith(".jsonl")) yield path.join(root, d.name, f);
    } else if (d.name.endsWith(".jsonl")) yield path.join(root, d.name);
  }
}

function quarantinedSids() {
  const q = readJSON(`${HOME}/workspaces/${WS}/longview/quarantine.json`, { sids: [] });
  return new Set((q.sids || []).map(canonicalSid));
}

/** Hash every local session. CONTENT IS READ BUT NEVER RETAINED — only the digest and the
 *  quarantine verdict survive this function, so there is nothing for the manifest to leak. */
function localSessions() {
  const q = quarantinedSids();
  const out = [];
  const seen = new Set();
  for (const root of sessionRoots()) {
    for (const file of transcripts(root)) {
      const sid = path.basename(file).replace(/\.jsonl$/, "");
      const canon = canonicalSid(sid);
      if (seen.has(canon)) continue;
      seen.add(canon);
      let buf;
      try { buf = fs.readFileSync(file); } catch { continue; }
      const quarantined = q.has(canon) || [...q].some((b) => b.length >= 8 && canon.startsWith(b.slice(0, 8)));
      out.push({ sid, contentHash: `sha256:${sha256(buf)}`, quarantined });
      // buf goes out of scope here — content never reaches the caller
    }
  }
  return { sessions: out, quarantined: out.filter((s) => s.quarantined).length };
}

// ── hub discovery ─────────────────────────────────────────────────────────
async function reachable(url, ms = 1500) {
  try {
    const res = await fetch(`${url}/api/estate/satellites`, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch { return false; }
}

/** Scan the local /24 for a hub. Bounded and opt-in: this is the owner's own LAN, but a
 *  subnet sweep is still a scan, so it never runs unless --discover is passed. */
async function discover() {
  const nets = os.networkInterfaces();
  const bases = new Set();
  for (const list of Object.values(nets))
    for (const ni of list || [])
      if (ni.family === "IPv4" && !ni.internal) bases.add(ni.address.split(".").slice(0, 3).join("."));
  for (const base of bases) {
    process.stderr.write(`[discover] sweeping ${base}.0/24 on port ${PORT}…\n`);
    const candidates = Array.from({ length: 254 }, (_, i) => `http://${base}.${i + 1}:${PORT}`);
    for (let i = 0; i < candidates.length; i += 32) {
      const batch = candidates.slice(i, i + 32);
      const hits = await Promise.all(batch.map(async (u) => ((await reachable(u, 900)) ? u : null)));
      const found = hits.find(Boolean);
      if (found) return found;
    }
  }
  return null;
}

// ── register ──────────────────────────────────────────────────────────────
async function register(hub, key, manifest) {
  const res = await fetch(`${hub}/api/estate/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, manifest }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

// ── main ──────────────────────────────────────────────────────────────────
const { sessions, quarantined } = localSessions();
const manifest = buildManifest(MACHINE, sessions, []); // flags already set per session

// R31 assertion at the outbound edge — cheap, and it fails loudly rather than leaking.
for (const s of manifest.sessions || [])
  if ("content" in s || "text" in s) {
    console.error("ABORT: manifest carried session payload — refusing to send (R31)");
    process.exit(2);
  }

console.log(`satellite ${MACHINE}`);
console.log(`  sessions found      ${manifest.sessions.length}`);
console.log(`  quarantine-flagged  ${quarantined}  (flagged for the hub's exclusion; content never sent)`);
console.log(`  payload             content-hashes + flags only (${JSON.stringify(manifest.sessions[0] || {}).length} bytes/session)`);

if (flag("--dry-run")) {
  console.log("\n--dry-run: nothing sent. Sample entry:");
  console.log("  " + JSON.stringify(manifest.sessions[0] || {}));
  process.exit(0);
}

let hub = HUB;
if (!hub && flag("--discover")) hub = await discover();
if (!hub) {
  console.error("\nno hub: pass --hub http://<hub-ip>:<port> (or --discover to sweep the LAN)");
  process.exit(3);
}
if (!(await reachable(hub))) {
  console.error(`\nhub ${hub} is not reachable — is prime-silo serving there?`);
  process.exit(3);
}

const key = resolveRegisterKey();
if (!key) {
  console.error("\nno registration key. On the HUB run: node scripts/estate_key.mjs --init");
  console.error("then copy the key to this machine as ESTATE_REGISTER_KEY (or into its state dir).");
  process.exit(4);
}

async function announce() {
  const r = await register(hub, key, buildManifest(MACHINE, localSessions().sessions, []));
  if (!r.ok) {
    console.error(`register REFUSED (${r.status}): ${r.body?.reason || "unknown"}`);
    return false;
  }
  const d = r.body.drift || {};
  console.log(`registered with ${hub} — hub sees ${d.cleanCount ?? "?"} new, ${d.overlap ?? "?"} already held, ${d.quarantined?.count ?? 0} quarantined (withheld)`);
  return true;
}

const ok = await announce();
if (!flag("--watch")) process.exit(ok ? 0 : 5);

const every = Number(opt("--interval", 300)) * 1000;
console.log(`heartbeat every ${every / 1000}s — ctrl-c to stop`);
setInterval(() => { announce().catch((e) => console.error("heartbeat failed:", e.message)); }, every);
