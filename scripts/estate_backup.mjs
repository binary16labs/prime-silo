#!/usr/bin/env node
// estate_backup — content-addressed backup of RAW session and tool data to a
// shared workspace, with the quarantine boundary enforced at the copy edge.
//
// DESIGN CONSTRAINTS (each one is a control, not a preference):
//
//  1. QUARANTINE IS ENFORCED HERE. 14 sids hold CV/job-application content that is
//     structurally excluded from training and from every deliverable. A shared,
//     cloud-synced folder is exactly where that material must never land. So the
//     copy edge filters on quarantine, records that it did, and a negative control
//     (`--selftest`) proves the filter refuses a known quarantined sid.
//     Quarantined items are COUNTED in the manifest, never named or copied.
//
//  2. THE SHARE IS DISTRIBUTION, NOT THE SYSTEM OF RECORD. OneDrive is a sync
//     service: a delete or corruption propagates to every replica. F: remains the
//     immutable tier. Cascade is F: -> D: -> share.
//
//  3. CONTENT-ADDRESSED, HASH ONCE. Every file is keyed by sha256, so the hub's
//     119 sessions and the satellite's 179 dedupe to one blob per content instead
//     of duplicating across machines (EP-N N0).
//
//  4. METADATA FOR EVERYTHING, CONTENT FOR WHAT IS ALLOWED. The manifest lists
//     every item with its hash, size, origin machine and quarantine verdict — so
//     coverage is auditable even where the payload is deliberately absent.
//
// Usage:
//   node scripts/estate_backup.mjs --plan            # what would be copied (no writes)
//   node scripts/estate_backup.mjs --apply
//   node scripts/estate_backup.mjs --verify          # re-hash the share, report drift
//   node scripts/estate_backup.mjs --selftest        # negative control on the filter

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i > 0 && argv[i + 1] ? argv[i + 1] : d; };

const WS = opt("--workspace", process.env.LONGVIEW_WORKSPACE || "sessions_v1");
const HOME = (process.env.BENNY_HOME || "D:/benny-home/benny").replace(/\\/g, "/");
const SHARE = (opt("--share", process.env.ESTATE_SHARE ||
  path.join(os.homedir(), "OneDrive", "estate-backup"))).replace(/\\/g, "/");
const MACHINE = process.env.ESTATE_MACHINE || os.hostname();
const wsDir = `${HOME}/workspaces/${WS}`;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

// ── the quarantine boundary ───────────────────────────────────────────────
function quarantinedSids() {
  const q = readJSON(`${wsDir}/longview/quarantine.json`, { sids: [] });
  return new Set((q.sids || []).map(String));
}

/** True if this path belongs to a quarantined session. Matches on the sid appearing
 *  anywhere in the path — deliberately broad: a false exclusion costs a backup entry,
 *  a false inclusion leaks CV content into a shared folder. */
export function isQuarantined(filePath, quarantined) {
  const p = String(filePath).replace(/\\/g, "/").toLowerCase();
  for (const sid of quarantined) {
    const s = String(sid).toLowerCase();
    if (s.length >= 8 && p.includes(s.slice(0, 32))) return true;
    if (s.length >= 8 && p.includes(s.slice(0, 8))) return true;
  }
  return false;
}

// ── sources: RAW sessions + tool data ─────────────────────────────────────
function sources() {
  const memoray = (process.env.MEMORAY_DATA_DIR || path.join(os.homedir(), ".mem0ray", "data"))
    .replace(/\\/g, "/");
  return [
    { id: "memoray", origin: MACHINE, kind: "raw sessions (hub)", root: memoray },
    { id: "asus_ingest", origin: "ASUS", kind: "raw sessions (satellite pull)", root: "D:/asus_ingest" },
    { id: "longview_state", origin: MACHINE, kind: "tool data: cards, ledger, inventory",
      root: `${wsDir}/longview`, only: ["cards", "inventory.json", "ledger.jsonl", "quarantine.json", "labels.json", "lineage"] }
  ];
}

function* walk(root, only = null) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (only && !only.some((o) => e.name === o)) {
      if (path.resolve(root) === path.resolve(root) && only.length) continue;
    }
    if (e.isDirectory()) yield* walk(p, null);
    else yield p;
  }
}

function plan() {
  const quarantined = quarantinedSids();
  const items = [];
  const stats = { scanned: 0, eligible: 0, quarantined_excluded: 0, bytes: 0, deduped: 0 };
  const seenHash = new Set();
  for (const s of sources()) {
    if (!fs.existsSync(s.root)) { items.push({ source: s.id, missing: true }); continue; }
    for (const f of walk(s.root, s.only)) {
      stats.scanned++;
      let buf;
      try { buf = fs.readFileSync(f); } catch { continue; }
      const rel = path.relative(s.root, f).replace(/\\/g, "/");
      const q = isQuarantined(f, quarantined);
      const h = sha256(buf);
      const dup = seenHash.has(h);
      if (!dup) seenHash.add(h);
      if (q) { stats.quarantined_excluded++; }
      else { stats.eligible++; if (!dup) stats.bytes += buf.length; else stats.deduped++; }
      items.push({
        source: s.id, origin: s.origin, rel, sha256: h, bytes: buf.length,
        mtime: (() => { try { return new Date(fs.statSync(f).mtimeMs).toISOString(); } catch { return null; } })(),
        // METADATA IS RECORDED FOR EVERYTHING; CONTENT ONLY FOR ALLOWED ITEMS.
        quarantined: q, content_copied: !q, deduped: dup
      });
    }
  }
  return { items, stats, quarantined_count: quarantined.size };
}

// ── apply ─────────────────────────────────────────────────────────────────
function apply(p) {
  const blobs = path.join(SHARE, "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  let written = 0, skipped = 0;
  for (const it of p.items) {
    if (it.missing || it.quarantined) continue;          // the boundary
    const dest = path.join(blobs, it.sha256.slice(0, 2), it.sha256);
    if (fs.existsSync(dest)) { skipped++; continue; }     // content-addressed dedupe
    const src = sourcePath(it);
    if (!src) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    written++;
  }
  const manifest = {
    schema: "prime-silo/estate-backup/1.0",
    created_at: new Date().toISOString(),
    machine: MACHINE, workspace: WS, share: SHARE,
    cascade: "F: (immutable) -> D: (runner) -> share (distribution)",
    note: "The share is a DISTRIBUTION layer, not the system of record: it is sync-backed, " +
          "so deletions propagate. F: remains the immutable tier.",
    privacy: {
      quarantined_sids: p.quarantined_count,
      quarantined_items_excluded: p.stats.quarantined_excluded,
      policy: "quarantined sessions are counted, never named and never copied"
    },
    stats: { ...p.stats, blobs_written: written, blobs_already_present: skipped },
    items: p.items.map((i) => i.missing ? i : ({ ...i, rel: i.quarantined ? "(withheld)" : i.rel }))
  };
  fs.writeFileSync(path.join(SHARE, `manifest-${MACHINE}-${WS}.json`),
    JSON.stringify(manifest, null, 1), "utf8");
  return manifest;
}

function sourcePath(it) {
  const s = sources().find((x) => x.id === it.source);
  if (!s) return null;
  const p = path.join(s.root, it.rel);
  return fs.existsSync(p) ? p : null;
}

// ── verify: re-hash the share, report drift ───────────────────────────────
function verify() {
  const manifests = (() => {
    try { return fs.readdirSync(SHARE).filter((f) => f.startsWith("manifest-") && f.endsWith(".json")); }
    catch { return []; }
  })();
  const out = { share: SHARE, manifests: manifests.length, checked: 0, intact: 0, drift: [], missing: [] };
  for (const m of manifests) {
    const man = readJSON(path.join(SHARE, m));
    if (!man) continue;
    for (const it of man.items || []) {
      if (it.missing || it.quarantined) continue;
      const blob = path.join(SHARE, "blobs", it.sha256.slice(0, 2), it.sha256);
      out.checked++;
      if (!fs.existsSync(blob)) { out.missing.push(it.sha256.slice(0, 12)); continue; }
      const actual = sha256(fs.readFileSync(blob));
      if (actual === it.sha256) out.intact++;
      else out.drift.push({ expected: it.sha256.slice(0, 12), actual: actual.slice(0, 12) });
    }
  }
  out.verdict = out.checked === 0 ? "EMPTY"
    : out.drift.length ? "CORRUPT" : out.missing.length ? "DRIFT" : "INTACT";
  return out;
}

// ── negative control ──────────────────────────────────────────────────────
function selftest() {
  const q = quarantinedSids();
  if (!q.size) return { ok: false, why: "no quarantined sids configured — filter is untested" };
  const sid = [...q][0];
  const probe = `/some/path/${sid}/session.json`;
  const blocked = isQuarantined(probe, q);
  const control = isQuarantined("/some/path/0000000000000000/session.json", q);
  return {
    ok: blocked && !control,
    quarantined_sids: q.size,
    seeded_path_blocked: blocked,
    unrelated_path_allowed: !control,
    why: blocked ? (control ? "filter blocks everything — too broad" : "filter blocks quarantined, allows others")
                 : "FILTER FAILED TO BLOCK A KNOWN QUARANTINED SID"
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (flag("--selftest")) {
  const r = selftest();
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 2);
}
if (flag("--verify")) {
  const r = verify();
  console.log(`share ${r.share}\n  manifests ${r.manifests} · checked ${r.checked} · intact ${r.intact}` +
              `\n  drift ${r.drift.length} · missing ${r.missing.length}\n  verdict ${r.verdict}`);
  process.exit(r.verdict === "CORRUPT" ? 2 : 0);
}
const p = plan();
if (flag("--apply")) {
  const st = selftest();
  if (!st.ok) { console.error("refusing to copy: quarantine filter self-test failed —", st.why); process.exit(2); }
  const man = apply(p);
  console.log(`estate backup -> ${SHARE}`);
  console.log(`  scanned ${man.stats.scanned} · eligible ${man.stats.eligible} · ` +
              `quarantine-excluded ${man.stats.quarantined_excluded}`);
  console.log(`  blobs written ${man.stats.blobs_written} · already present ${man.stats.blobs_already_present} ` +
              `· deduped ${man.stats.deduped}`);
  console.log(`  manifest manifest-${MACHINE}-${WS}.json`);
} else {
  console.log(`PLAN (no writes) — share ${SHARE}`);
  console.log(`  scanned ${p.stats.scanned} files`);
  console.log(`  eligible to copy      ${p.stats.eligible}  (${(p.stats.bytes / 1e6).toFixed(1)} MB unique)`);
  console.log(`  quarantine-excluded   ${p.stats.quarantined_excluded}  (from ${p.quarantined_count} sids — counted, never named)`);
  console.log(`  content-dedupe hits   ${p.stats.deduped}`);
  console.log(`\n  apply with: node scripts/estate_backup.mjs --apply`);
}
