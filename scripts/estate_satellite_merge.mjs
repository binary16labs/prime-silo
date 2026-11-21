#!/usr/bin/env node
// satellite-merge — one clean, de-duplicated copy of a satellite's sessions on the hub,
// plus the estate-wide session → machine provenance map.
//
// WHY THIS EXISTS (2026-11-21). A satellite's sessions reach the hub in more than one copy:
// the live close-out push (`F:\backups\live\<host>`) and older dated snapshots
// (`F:\backups\sessions-2026-07-27-asus`, the ONLY copy of sessions the satellite has since
// deleted after Claude Code's 30-day cleanup). Pointing memo-ray at every copy makes duplicate
// sessions, and because every machine uses the same `C:\Users\nsdha\...` paths, a path cannot
// say which machine a session came from. This tool:
//
//   1. picks ONE copy per session (the most complete: biggest transcript, then newest),
//   2. mirrors it to `F:\backups\satellite\<host>\{claude\projects, antigravity\brain}` —
//      the single folder memo-ray reads for that machine (stable paths → stable ids),
//   3. writes `F:\backups\provenance.json`: session key → machine, for every machine,
//      so LONGVIEW can say which machine each card came from.
//
// It only READS the backup copies and only WRITES under `<root>\satellite\` and the
// provenance file. It never deletes. It never opens OneDrive. Ids only, no titles (R31).
//
// Usage:
//   node scripts/estate_satellite_merge.mjs --host optimus --dry-run   # plan only
//   node scripts/estate_satellite_merge.mjs --host optimus             # merge + provenance
//   node scripts/estate_satellite_merge.mjs --provenance-only           # just the map
// Env: ESTATE_BACKUP_ROOT (default F:\backups), ESTATE_HUB_HOST (default t480).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Snapshot labels → machine. A satellite's own Windows name wins (MANIFEST `host=`); the
// folder suffix is the fallback; an unlabelled snapshot is the hub's own (the hub made it).
export const HOST_ALIASES = { asus: "optimus", optimus: "optimus", t480: "t480" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which machine made a dated snapshot folder. Pure. */
export function snapshotHost(folderName, manifestHeader, hubHost, aliases = HOST_ALIASES) {
  const m = /host=([A-Za-z0-9_-]+)/.exec(manifestHeader || "");
  if (m) return aliases[m[1].toLowerCase()] || m[1].toLowerCase();
  const suffix = /^sessions-\d{4}-\d{2}-\d{2}-(.+)$/.exec(folderName);
  if (suffix) return aliases[suffix[1].toLowerCase()] || suffix[1].toLowerCase();
  return hubHost;
}

/** Pick one copy per key: biggest transcript, then newest, then earliest-listed source. Pure. */
export function pickCopies(candidates) {
  const best = new Map();
  for (const c of candidates) {
    const b = best.get(c.key);
    if (
      !b ||
      c.size > b.size ||
      (c.size === b.size && c.mtimeMs > b.mtimeMs) ||
      (c.size === b.size && c.mtimeMs === b.mtimeMs && c.order < b.order)
    )
      best.set(c.key, c);
  }
  return best;
}

const statOr = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};
const ls = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Every `.jsonl` under a Claude projects root, keyed by path relative to it. */
function claudeFiles(projectsRoot) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of ls(dir)) {
      const p = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith(".jsonl") && rel) out.push({ abs: p, rel: r }); // skip root-level history.jsonl
    }
  };
  walk(projectsRoot, "");
  return out;
}

const transcriptOf = (folder) =>
  ["transcript.jsonl", "transcript_full.jsonl"]
    .map((f) => path.join(folder, ".system_generated", "logs", f))
    .map((p) => ({ p, st: statOr(p) }))
    .filter((x) => x.st)
    .sort((a, b) => b.st.size - a.st.size)[0] || null;

/** All session copies the hub holds, per machine, from live pushes and dated snapshots. */
export function discoverSources(root, hubHost) {
  const sources = []; // { host, label, claude: dir|null, brains: [dir] }
  for (const e of ls(path.join(root, "live"))) {
    if (!e.isDirectory()) continue;
    const base = path.join(root, "live", e.name);
    sources.push({
      host: HOST_ALIASES[e.name.toLowerCase()] || e.name.toLowerCase(),
      label: `live/${e.name}`,
      claude: path.join(base, "claude"),
      brains: [path.join(base, "antigravity"), path.join(base, "antigravity-ide")]
    });
  }
  for (const e of ls(root)) {
    if (!e.isDirectory() || !/^sessions-\d{4}-\d{2}-\d{2}/.test(e.name)) continue;
    const base = path.join(root, e.name);
    let header = "";
    try {
      header = fs.readFileSync(path.join(base, "MANIFEST.txt"), "utf8").split(/\r?\n/)[0];
    } catch {
      /* no manifest */
    }
    sources.push({
      host: snapshotHost(e.name, header, hubHost),
      label: e.name,
      claude: path.join(base, "claude", "projects"),
      brains: [
        path.join(base, "antigravity", "antigravity-brain"),
        path.join(base, "antigravity", "antigravity-ide-brain"),
        path.join(base, "antigravity-ide-brain"),
        path.join(base, "antigravity-brain")
      ]
    });
  }
  // live pushes first: on an exact tie the live copy is preferred
  return sources.map((s, order) => ({ ...s, order }));
}

/** Candidate copies for one machine (or all, when host is null). */
export function candidatesFor(sources, host) {
  const claude = [];
  const anti = [];
  for (const s of sources) {
    if (host && s.host !== host) continue;
    for (const f of claudeFiles(s.claude)) {
      const st = statOr(f.abs);
      if (st)
        claude.push({
          key: f.rel.replace(/\\/g, "/"),
          sid: path.basename(f.rel, ".jsonl"),
          host: s.host,
          abs: f.abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          order: s.order,
          from: s.label
        });
    }
    for (const b of s.brains)
      for (const e of ls(b)) {
        if (!e.isDirectory() || !UUID.test(e.name)) continue;
        const t = transcriptOf(path.join(b, e.name));
        anti.push({
          key: e.name.toLowerCase(),
          sid: e.name.toLowerCase(),
          host: s.host,
          abs: path.join(b, e.name),
          size: t ? t.st.size : 0,
          mtimeMs: t ? t.st.mtimeMs : 0,
          order: s.order,
          from: s.label
        });
      }
  }
  return { claude, anti };
}

/** Copy a file only when the destination differs (size or mtime); keep the source mtime. */
function copyIfChanged(src, dest, dry) {
  const a = statOr(src);
  const b = statOr(dest);
  if (b && a && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000) return false;
  if (dry) return true;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.utimesSync(dest, a.atime, a.mtime);
  return true;
}
function copyTree(src, dest, dry) {
  let n = 0;
  for (const e of ls(src)) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) n += copyTree(s, d, dry);
    else if (e.isFile() && copyIfChanged(s, d, dry)) n++;
  }
  return n;
}

/** session key → machine, across every machine. Keys seen on two machines are reported. */
export function buildProvenance(sources) {
  const { claude, anti } = candidatesFor(sources, null);
  const keys = {};
  const conflicts = new Set();
  const counts = {};
  for (const c of [...claude, ...anti]) {
    const k = c.sid; // claude: session/subagent id; antigravity: conversation uuid
    if (keys[k] && keys[k] !== c.host) conflicts.add(k);
    else keys[k] = c.host;
  }
  for (const k of conflicts) delete keys[k]; // never guess
  for (const h of Object.values(keys)) counts[h] = (counts[h] || 0) + 1;
  return { keys, counts, conflicts: conflicts.size };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d = null) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const dry = argv.includes("--dry-run");
  const root = process.env.ESTATE_BACKUP_ROOT || "F:\\backups";
  const hubHost = (process.env.ESTATE_HUB_HOST || "t480").toLowerCase();
  const host = (opt("--host") || "").toLowerCase();
  if (!statOr(root)) {
    console.error(`backup root not reachable: ${root}`);
    process.exit(2);
  }
  const sources = discoverSources(root, hubHost);
  const report = { at: new Date().toISOString(), root, dry_run: dry, sources: sources.map((s) => ({ label: s.label, host: s.host })) };

  if (host && !argv.includes("--provenance-only")) {
    if (host === hubHost) {
      console.error(`--host ${host} is the hub: its own sessions are read in place, not merged.`);
      process.exit(2);
    }
    const out = path.join(root, "satellite", host);
    const { claude, anti } = candidatesFor(sources, host);
    const pc = pickCopies(claude);
    const pa = pickCopies(anti);
    let copied = 0;
    const from = {};
    for (const c of pc.values()) {
      if (copyIfChanged(c.abs, path.join(out, "claude", "projects", c.key), dry)) copied++;
      from[c.from] = (from[c.from] || 0) + 1;
    }
    for (const a of pa.values()) {
      copied += copyTree(a.abs, path.join(out, "antigravity", "brain", a.key), dry);
      from[a.from] = (from[a.from] || 0) + 1;
    }
    report.merge = {
      host,
      out,
      claude: { copies_seen: claude.length, sessions: pc.size },
      antigravity: { copies_seen: anti.length, conversations: pa.size },
      chosen_from: from,
      files_copied: copied
    };
    if (!dry) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(
        path.join(out, "MERGE.json"),
        JSON.stringify(
          {
            ...report,
            chosen: Object.fromEntries(
              [...pc.values(), ...pa.values()].map((c) => [c.key, { from: c.from, size: c.size }])
            )
          },
          null,
          1
        )
      );
    }
  }

  const prov = buildProvenance(sources);
  report.provenance = { counts: prov.counts, conflicts: prov.conflicts };
  if (!dry)
    fs.writeFileSync(
      path.join(root, "provenance.json"),
      JSON.stringify({ generated: report.at, hub: hubHost, ...prov }, null, 1)
    );
  console.log(JSON.stringify(report, null, 1));
}

const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if ((process.argv[1] || "").replace(/\\/g, "/").toLowerCase() === self) main();
