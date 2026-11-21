#!/usr/bin/env node
// session close-out — make sure every agent session is CAPTURED, on every machine.
//
// WHY THIS EXISTS (found 2026-11-21). Session capture was a side effect of other jobs:
// memo-ray synced when someone ran LONGVIEW, backups ran when someone remembered, and
// Claude Code silently deletes transcripts after 30 days. A session that was never synced
// before that window closed was gone, and nobody could tell which ones. Capture has to be
// a step every session passes through, with a receipt, so "was this captured?" is a lookup.
//
// WHAT ONE CLOSE-OUT DOES (per session):
//   1. sync    memo-ray ingests the transcript (server /api/sync, else the parsers direct).
//   2. verify  memo-ray holds the session up to the transcript's last write
//              (entity.metadata.lastModifiedAt >= transcript mtime). Not "the file exists".
//   3. backup  copy the transcript to the hub backup (F:\backups\live\<host>\ on the hub,
//              else the hub's SMB inbox); if neither is reachable it is queued, not lost.
//   4. receipt one JSON line per session: ids, sizes, times, outcome. NEVER session text
//              (R31): the receipt is safe to sync to the other brain via home_code.
//
// HOW IT RUNS:
//   * Claude Code SessionEnd / PreCompact hook: reads the hook JSON on stdin, hands the
//     work to a detached child and returns at once (a hook must never block or fail exit).
//   * --sweep: every transcript changed since its last receipt, for agents with no hooks
//     (Antigravity/Gemini, Opencode) and sessions that never end (one ran 3 Sep -> 21 Nov).
//     Run it nightly and at agent start.
//
// Usage:
//   node scripts/estate_session_closeout.mjs --hook            # stdin = Claude hook JSON
//   node scripts/estate_session_closeout.mjs --transcript <path.jsonl>
//   node scripts/estate_session_closeout.mjs --sweep [--dry-run] [--json]
//   node scripts/estate_session_closeout.mjs --status          # last receipt per session
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const HOST = (process.env.ESTATE_HOST || os.hostname()).toLowerCase();
const HOME = os.homedir();
const STATE = path.join(HOME, ".mem0ray", "closeout");
const RECEIPTS = path.join(STATE, "receipts.jsonl");
const QUEUE = path.join(STATE, "pending-backup.jsonl");
// The hub keeps the live backup on its fixed F: drive; satellites push to its inbox share.
const HUB_LOCAL = process.env.ESTATE_BACKUP_ROOT || "F:\\backups";
// Over Tailscale: the T480's LAN profile is Public (inbound SMB blocked), its Tailscale
// interface is Private. The old WiFi address 192.168.68.125 is gone (2026-11-21).
const HUB_SHARE = process.env.ESTATE_BACKUP_SHARE || "\\\\100.99.229.31\\backups-inbox";

// Where each agent keeps its transcripts. A missing root is skipped.
export function transcriptRoots(home = HOME) {
  return [
    { agent: "claude", root: path.join(home, ".claude", "projects"), ext: ".jsonl" },
    { agent: "antigravity", root: path.join(home, ".gemini", "antigravity", "brain"), ext: null },
    { agent: "antigravity-ide", root: path.join(home, ".gemini", "antigravity-ide", "brain"), ext: null }
  ];
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function readReceipts() {
  const last = new Map();
  if (!exists(RECEIPTS)) return last;
  for (const line of fs.readFileSync(RECEIPTS, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      last.set(r.transcript, r);
    } catch {
      /* torn line: ignore */
    }
  }
  return last;
}

function writeReceipt(r) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(RECEIPTS, JSON.stringify(r) + "\n");
}

// Claude transcripts (and their subagent transcripts) changed since their last receipt.
export function dueTranscripts(roots, receipts) {
  const due = [];
  for (const { agent, root, ext } of roots) {
    if (!exists(root)) continue;
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (ext ? e.name.endsWith(ext) : /\.(jsonl|json|md|pb)$/.test(e.name)) {
          const st = fs.statSync(p);
          const prev = receipts.get(p);
          if (!prev || !prev.ok || prev.mtime < st.mtimeMs) due.push({ agent, transcript: p, mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    walk(root, 0);
  }
  return due;
}

async function syncMemoray() {
  const { syncStore } = await import("./longview/lib/store.mjs");
  return syncStore();
}

// memo-ray entity for a Claude transcript (metadata.filePath), or null.
async function memorayEntityFor(transcript) {
  const { readIndex, readEntity } = await import("./longview/lib/store.mjs");
  const want = path.resolve(transcript).toLowerCase();
  for (const id of readIndex().sessions || []) {
    const e = readEntity(id);
    const fp = e?.metadata?.filePath;
    if (fp && path.resolve(fp).toLowerCase() === want) return e;
  }
  return null;
}

function backupTarget() {
  if (exists(HUB_LOCAL)) return path.join(HUB_LOCAL, "live", HOST);
  if (exists(HUB_SHARE)) return path.join(HUB_SHARE, "live", HOST);
  return null;
}

function backupFile(transcript, agent) {
  const base = backupTarget();
  if (!base) return { ok: false, where: null, why: "hub backup not reachable" };
  // Mirror the path under the agent root so two projects' files never collide.
  const root = transcriptRoots().find((r) => transcript.startsWith(r.root));
  const rel = root ? path.relative(root.root, transcript) : path.basename(transcript);
  const dest = path.join(base, agent, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(transcript, dest);
  const ok = fs.statSync(dest).size === fs.statSync(transcript).size;
  return { ok, where: base.startsWith("\\\\") ? "hub-share" : "hub-local", why: ok ? null : "size mismatch after copy" };
}

// `mtime`/`size` are measured BEFORE the memo-ray sync: the question is "did the sync
// capture everything written up to the moment close-out began?" A live session keeps
// writing; comparing against a post-sync stat would always fail it.
async function closeOne({ agent, transcript, mtime, size }, { synced }) {
  const st = mtime ? { mtimeMs: mtime, size } : fs.statSync(transcript);
  const r = {
    ts: new Date().toISOString(),
    host: HOST,
    agent,
    transcript,
    session: path.basename(transcript).replace(/\.[^.]+$/, ""),
    mtime: st.mtimeMs,
    size: st.size,
    synced,
    captured: null,
    backed_up: false,
    ok: false,
    notes: []
  };
  if (agent === "claude") {
    const e = await memorayEntityFor(transcript);
    if (!e) {
      // Subagent transcripts are folded into their parent session by memo-ray.
      r.captured = /[\\/]subagents[\\/]/.test(transcript) ? "parent" : false;
      if (r.captured === false) r.notes.push("memo-ray has no session for this transcript");
    } else {
      // lastModifiedAt is written by the current claudeParser. An older memo-ray (optimus,
      // 2026-11-21: 12 false "older" receipts) doesn't write it, but there the session's
      // own timestamp IS the transcript mtime at parse time — usable as the fallback.
      // Never use timestamp when timestampSource is set: then it is the FIRST event time.
      const lm = Number(e.metadata?.lastModifiedAt) || 0;
      const fallback = !lm && !e.metadata?.timestampSource ? Number(e.timestamp) || 0 : 0;
      const last = lm || fallback;
      r.captured = last + 1000 >= st.mtimeMs;
      r.memoray_last = last;
      if (fallback) r.memoray_last_from = "session_timestamp (older memo-ray)";
      if (!r.captured) r.notes.push("memo-ray copy is older than the transcript");
    }
  } else {
    r.captured = "backup-only"; // no memo-ray parser check for this agent yet
  }
  try {
    const b = backupFile(transcript, agent);
    r.backed_up = b.ok;
    r.backup = b.where;
    if (!b.ok) {
      r.notes.push(b.why);
      fs.mkdirSync(STATE, { recursive: true });
      fs.appendFileSync(QUEUE, JSON.stringify({ ts: r.ts, agent, transcript }) + "\n");
    }
  } catch (e) {
    r.notes.push(`backup failed: ${e.message}`);
  }
  r.ok = r.captured !== false && r.backed_up;
  writeReceipt(r);
  return r;
}

async function main() {
  if (flag("--status")) {
    const rows = [...readReceipts().values()];
    const bad = rows.filter((r) => !r.ok);
    console.log(`${rows.length} transcripts have receipts; ${bad.length} not fully captured`);
    for (const r of bad.slice(0, 20)) console.log(`  ✗ ${r.agent} ${r.session.slice(0, 8)} — ${r.notes.join("; ")}`);
    return;
  }

  // Hook mode: never block Claude Code's exit. Re-launch ourselves detached and return.
  if (flag("--hook")) {
    let input = "";
    try {
      input = fs.readFileSync(0, "utf8");
    } catch {
      /* no stdin */
    }
    let h = {};
    fs.mkdirSync(STATE, { recursive: true });
    try {
      h = JSON.parse((input || "{}").replace(/^﻿/, "").trim() || "{}");
    } catch (e) {
      fs.appendFileSync(path.join(STATE, "hook.log"), `${new Date().toISOString()} hook input not JSON: ${e.message}\n`);
    }
    if (!h.transcript_path || !exists(h.transcript_path)) {
      fs.appendFileSync(path.join(STATE, "hook.log"), `${new Date().toISOString()} hook without a readable transcript_path (${h.hook_event_name || "?"})\n`);
    } else {
      const log = fs.openSync(path.join(STATE, "hook.log"), "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--transcript", h.transcript_path, "--event", String(h.hook_event_name || "hook")], {
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
        cwd: path.resolve(HERE, "..")
      });
      child.unref();
    }
    return;
  }

  let items;
  if (opt("--transcript")) {
    const t = path.resolve(opt("--transcript"));
    const st = fs.statSync(t);
    items = [{ agent: "claude", transcript: t, mtime: st.mtimeMs, size: st.size }];
  } else if (flag("--sweep")) {
    items = dueTranscripts(transcriptRoots(), readReceipts());
  } else {
    console.log("usage: --hook | --transcript <file> | --sweep [--dry-run] | --status");
    process.exitCode = 2;
    return;
  }
  if (flag("--dry-run")) {
    const by = {};
    for (const i of items) by[i.agent] = (by[i.agent] || 0) + 1;
    console.log(`[closeout] ${items.length} transcript(s) due`, by);
    return;
  }
  let synced = false;
  try {
    const { via } = await syncMemoray();
    synced = via;
  } catch (e) {
    console.log(`[closeout] memo-ray sync failed (${e.message}); verifying against the store as-is`);
  }
  const results = [];
  for (const it of items) results.push(await closeOne(it, { synced }));
  const ok = results.filter((r) => r.ok).length;
  if (flag("--json")) console.log(JSON.stringify({ host: HOST, due: items.length, ok, results: results.map(({ transcript, ...r }) => r) }, null, 1));
  else {
    console.log(`[closeout] ${HOST}: ${ok}/${results.length} captured + backed up (memo-ray sync: ${synced || "failed"})`);
    for (const r of results.filter((x) => !x.ok).slice(0, 20)) console.log(`  ✗ ${r.agent} ${r.session.slice(0, 8)} — ${r.notes.join("; ")}`);
  }
  if (ok < results.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[closeout] ${e.message}`);
    process.exitCode = 1;
  });
}
