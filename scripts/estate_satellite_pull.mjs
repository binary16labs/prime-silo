#!/usr/bin/env node
// satellite-pull — the governed satellite -> hub session pull.
//
// WHY THIS EXISTS. EP-N built the machinery (N4 drift, N5 approve-to-sync, N0 CAS sync,
// N7 live register) as PURE functions with an HTTP surface, and then the ASUS was pulled
// BY HAND over SMB anyway (2026-07-27). A governed path that is harder to use than
// `robocopy` is not a governed path. This is the operator edge: it does the impure work
// (reach the share, read bytes, copy) and delegates every DECISION to the already-verified
// libs, so the manual route and the governed route stop being different code.
//
// CONTROLS (each is a control, not a preference):
//
//  1. REACHABILITY IS PROVEN, NOT ASSUMED. The source must exist AND yield a readable
//     listing before anything is hashed. An unreachable satellite is a clean no-op with a
//     non-zero exit, never a partial pull that looks like a small delta.
//  2. CONTENT-HASHED ON ARRIVAL. Every file is sha256'd at the landing zone and the delta
//     is computed against the hub's own content-hashes (N4 driftDelta), so a re-pull of
//     unchanged sessions moves nothing and the overlap is excluded by construction.
//  3. QUARANTINE BEFORE THE OWNER SEES IT. Quarantined sids are dropped at the copy edge
//     AND again in proposeSync (N5 defense-in-depth). They are counted, never named.
//  4. NOTHING MOVES WITHOUT A SIGNATURE. The default is a PROPOSAL. `--sign <operator>`
//     is the human-signed stop; without it syncSource is never invoked.
//
// Usage:
//   node scripts/estate_satellite_pull.mjs --probe
//   node scripts/estate_satellite_pull.mjs                       # propose (no writes)
//   node scripts/estate_satellite_pull.mjs --fetch \
//        --from '\\ASUS\Users\nsdha\.mem0ray\data'               # copy share -> landing zone
//   node scripts/estate_satellite_pull.mjs --sign "nsdha" --intent "post-ASUS-start pull"

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { driftDelta } from "../server/coordination/lib/estate_drift.mjs";
import { proposeSync, signProposal, applySync } from "../server/coordination/lib/estate_govern.mjs";
import { syncSource } from "../server/coordination/lib/estate_sync.mjs";
import { buildEstate } from "../server/coordination/lib/estate.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { topology } from "../server/coordination/lib/estate_probe.mjs";

const REPO = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const HOME = (process.env.BENNY_HOME || "D:/benny-home/benny").replace(/\\/g, "/");
const WS = opt("--workspace", process.env.LONGVIEW_WORKSPACE || "sessions_v1");
const SATELLITE = opt("--satellite", process.env.ESTATE_SATELLITE || "ASUS");
const LANDING = (opt("--landing", process.env.ESTATE_SATELLITE_LANDING || "D:/asus_ingest")).replace(/\\/g, "/");
const FROM = opt("--from", process.env.ESTATE_SATELLITE_SHARE || null);
const KEL = `${REPO}/coordination/estate/kel.jsonl`.replace(/\\/g, "/");
const STAGING = `${REPO}/coordination/estate/staging`.replace(/\\/g, "/");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

// ── control 3: the quarantine set ─────────────────────────────────────────
function quarantinedSids() {
  const q = readJSON(`${HOME}/workspaces/${WS}/longview/quarantine.json`, { sids: [] });
  return new Set((q.sids || []).map(String));
}

/** A session file's sid is its basename. Quarantine matches on the sid itself and on the
 *  8-char prefix the graph uses — deliberately broad: a false exclusion costs one session,
 *  a false inclusion moves CV content into the training corpus. */
/** THE GRAIN BRIDGE. A raw agent transcript is named by UUID
 *  (`fd57bd15-9142-491a-962d-1a16701a38c9.jsonl`); memo-ray keys the same session by that
 *  UUID with the hyphens stripped (`fd57bd159142491a962d1a16701a38c9`). Verified against
 *  the live quarantine list 2026-08-02: 4 of its 14 sids are hyphen-stripped UUIDv4s —
 *  precisely the 4 ASUS job/CV sessions — and they round-trip back to valid v4 UUIDs
 *  (correct version and variant nibbles). The other 10 are hub hash-sids, matching the
 *  estate's own count of 10 quarantined.
 *
 *  Canonicalising both sides is what makes the quarantine APPLICABLE to this grain.
 *  Without it the two namespaces never intersect and the filter matches nothing while
 *  reporting a reassuring "0 withheld". */
export function canonicalSid(sid) {
  return String(sid).replace(/-/g, "").trim().toLowerCase();
}

/** Coarse shape of the CANONICAL id — the applicability guard compares these, so a
 *  genuinely foreign scheme (a path, a slug, a base64 id) still refuses the sync. */
function idShape(sid) {
  const s = canonicalSid(sid);
  if (/^[0-9a-f]{32}$/.test(s)) return "hex32";
  if (/^[0-9a-f]{40,}$/.test(s)) return "hex-long";
  return `other(${s.length})`;
}

function isQuarantined(sid, q) {
  const s = canonicalSid(sid);
  for (const bad of q) {
    const b = canonicalSid(bad);
    if (s === b) return true;
    // 8-hex prefix: the form the knowledge graph uses for Source names. Deliberately
    // broad — a false exclusion costs one session, a false inclusion leaks CV content.
    if (b.length >= 8 && s.startsWith(b.slice(0, 8))) return true;
  }
  return false;
}

/** POSITIVE CONTROL. "0 withheld" is what a WORKING filter reports when nothing is
 *  quarantined — and exactly what a BROKEN one reports always. So prove the filter bites:
 *  synthesise the filename a quarantined session WOULD have in this grain (sid re-hyphenated
 *  to a UUID) and require that it is blocked, while an unrelated id passes. Mirrors
 *  estate_backup.mjs --selftest, and gates --sign the same way. */
function quarantineSelftest(q) {
  if (!q.size) return { ok: false, why: "no quarantined sids configured — the filter is untested" };
  const probes = [...q].map((sid) => {
    const h = canonicalSid(sid);
    // reconstitute the on-disk UUID form: 8-4-4-4-12
    const uuid = h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : h;
    return { uuid, blocked: isQuarantined(uuid, q) };
  });
  const allBlocked = probes.every((p) => p.blocked);
  const control = isQuarantined("00000000-0000-4000-8000-000000000000", q);
  return {
    ok: allBlocked && !control,
    quarantined_sids: q.size,
    uuid_forms_blocked: probes.filter((p) => p.blocked).length,
    unrelated_uuid_allowed: !control,
    why: !allBlocked ? "A QUARANTINED SID IN UUID FORM WAS NOT BLOCKED"
      : control ? "filter blocks everything — too broad to be meaningful"
      : "quarantined sids blocked in both hex32 and UUID form; unrelated ids pass"
  };
}

// ── control 1: reachability is proven, not assumed ────────────────────────
function probe(root) {
  const at = new Date().toISOString();
  if (!root) return { root, reachable: false, why: "no source configured", at };
  try {
    if (!fs.existsSync(root)) return { root, reachable: false, why: "path does not exist", at };
    const entries = fs.readdirSync(root);       // readable, not merely present
    return { root, reachable: true, entries: entries.length, at };
  } catch (e) {
    return { root, reachable: false, why: `unreadable: ${e.code || e.message}`, at };
  }
}

// ── enumerate: <root>/projects/<project>/<sid>.jsonl ──────────────────────
function* sessionFiles(root) {
  const projects = path.join(root, "projects");
  const base = fs.existsSync(projects) ? projects : root;
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) { if (d.name.endsWith(".jsonl")) yield { project: null, file: path.join(base, d.name) }; continue; }
    let files = [];
    try { files = fs.readdirSync(path.join(base, d.name)); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) yield { project: d.name, file: path.join(base, d.name, f) };
  }
}

/** Read the landing zone into the { sid, contentHash, content, project, quarantined } shape
 *  N4/N0 expect. Hashing happens HERE, at arrival — control 2. */
function readSatellite(root, q) {
  const sessions = [];
  let quarantined = 0;
  for (const { project, file } of sessionFiles(root)) {
    const sid = path.basename(file).replace(/\.jsonl$/, "");
    if (isQuarantined(sid, q)) { quarantined++; continue; }   // counted, never named
    let content;
    try { content = fs.readFileSync(file); } catch { continue; }
    sessions.push({ sid, project, content, contentHash: `sha256:${sha256(content)}`, quarantined: false });
  }
  return { sessions, quarantined };
}

// ── the hub's own content-hashes, folded from the estate KEL ──────────────
function hubHashes() {
  const r = readKelEvents(KEL);
  if (!r.ok) return { hashes: new Set(), ok: false, why: r.reason };
  const estate = buildEstate(r.events);
  return { hashes: new Set(Object.keys(estate.sessions || {})), ok: true, estate };
}

// ── optional network step: share -> landing zone, quarantine-filtered ─────
function fetchFromShare(from, landing, q) {
  const p = probe(from);
  if (!p.reachable) return { ...p, copied: 0, skipped: 0 };
  let copied = 0, skipped = 0, withheld = 0;
  for (const { project, file } of sessionFiles(from)) {
    const sid = path.basename(file).replace(/\.jsonl$/, "");
    if (isQuarantined(sid, q)) { withheld++; continue; }       // never lands on the hub
    const dest = path.join(landing, "projects", project || "_", path.basename(file));
    let src;
    try { src = fs.readFileSync(file); } catch { continue; }
    // content-guarded: identical bytes are not re-copied
    if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === sha256(src)) { skipped++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
    copied++;
  }
  return { ...p, copied, skipped, quarantine_withheld: withheld };
}

// ── main ──────────────────────────────────────────────────────────────────
// GUARDED: this module exports canonicalSid so tests can exercise the grain bridge, and a
// module with top-level side effects RUNS when imported — importing it for one pure
// function fired a whole proposal. Only execute the CLI when invoked directly.
const invokedDirectly = (() => {
  const entry = (process.argv[1] || "").replace(/\\/g, "/").toLowerCase();
  const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
  return entry === self;
})();

if (!invokedDirectly) {
  // imported as a library — expose the pure helpers, run nothing
} else {

const q = quarantinedSids();

if (flag("--selftest")) {
  const r = quarantineSelftest(q);
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 2);
}

if (flag("--probe")) {
  const share = FROM ? probe(FROM) : { root: null, reachable: null, why: "no --from share configured" };
  const land = probe(LANDING);
  const topo = topology(
    [{ name: "T480", role: "hub" }, { name: SATELLITE, role: "satellite" }],
    { T480: true, [SATELLITE]: Boolean(share.reachable || land.reachable) }
  );
  console.log(JSON.stringify({ satellite: SATELLITE, share, landing: land, topology: topo }, null, 1));
  process.exit(land.reachable || share.reachable ? 0 : 3);
}

if (flag("--fetch")) {
  if (!FROM) { console.error("--fetch needs --from <share path> (or ESTATE_SATELLITE_SHARE)"); process.exit(2); }
  const r = fetchFromShare(FROM, LANDING, q);
  if (!r.reachable) { console.error(`satellite ${SATELLITE} UNREACHABLE at ${FROM}: ${r.why}`); process.exit(3); }
  console.log(`fetch ${FROM} -> ${LANDING}`);
  console.log(`  copied ${r.copied} · unchanged ${r.skipped} · quarantine-withheld ${r.quarantine_withheld}`);
}

const land = probe(LANDING);
if (!land.reachable) {
  console.error(`landing zone UNREACHABLE at ${LANDING}: ${land.why}`);
  console.error("nothing hashed, nothing proposed — this is a clean no-op, not a small delta.");
  process.exit(3);
}

const hub = hubHashes();
// FAIL CLOSED ON AN UNREADABLE BASELINE. An unreadable hub KEL yields ZERO known
// content-hashes, which makes driftDelta report the ENTIRE satellite as new — the error
// flatters the delta instead of blocking it. This is not hypothetical: on 2026-08-02 a
// git CRLF conversion broke the chain on 298 of 299 lines and this exact path reported
// "hub holds 0" and a 29-session delta against a hub that already held 293. Refuse.
if (!hub.ok) {
  console.error(`REFUSING: the hub estate KEL is unreadable (${hub.why}) at ${KEL}.`);
  console.error("With no baseline, every satellite session looks new and a sync would re-stage the corpus.");
  console.error("Repair the log first (check line endings — see .gitattributes), then re-run.");
  process.exit(4);
}
const sat = readSatellite(LANDING, q);
const delta = driftDelta(hub.hashes, sat.sessions, q);
const proposal = proposeSync(delta, { satellite: SATELLITE, quarantine: q });

const sig = opt("--sign", null);
if (!sig) {
  console.log(`PROPOSAL ${proposal.id} — satellite ${SATELLITE} (no writes)`);
  console.log(`  hub holds            ${hub.hashes.size} session content-hashes${hub.ok ? "" : ` (KEL unreadable: ${hub.why})`}`);
  console.log(`  satellite scanned    ${delta.total}`);
  console.log(`  already in hub       ${delta.overlap}  (content-hash overlap, excluded)`);
  console.log(`  quarantine withheld  ${sat.quarantined + delta.quarantined.count}  (counted, never named)`);
  console.log(`  ACTIONABLE DELTA     ${proposal.count}`);
  console.log(`\n  ${proposal.privacy.invariant}`);
  // A ZERO OVERLAP AGAINST A NON-EMPTY HUB IS A SMELL, NOT A WIN. It usually means the
  // two sides are different GRAINS (raw agent transcripts vs memo-ray session records),
  // not that every satellite session is genuinely new. Say so rather than let a big
  // delta read as progress.
  if (hub.hashes.size > 0 && delta.overlap === 0 && delta.total > 0) {
    console.log(`\n  ⚠ zero overlap against ${hub.hashes.size} hub hashes. Verify both sides are the`);
    console.log(`    same grain before signing — a grain mismatch inflates the delta to "everything".`);
  }
  console.log(`\n  sign with: node scripts/estate_satellite_pull.mjs --sign "<operator>" --intent "<why>"`);
  process.exit(0);
}

// ── control 3, enforced: the quarantine filter must be PROVEN, not present ─
// Two independent conditions, because either alone can pass while protecting nothing:
//   (a) the canonical id spaces must actually intersect — a foreign scheme means the
//       filter has nothing to compare against;
//   (b) the filter must demonstrably BITE on this grain (the positive control), since
//       "0 withheld" is indistinguishable between a working and a dead filter.
if (q.size > 0) {
  const shapes = new Set([...q].map(idShape));
  const covered = sat.sessions.some((s) => shapes.has(idShape(s.sid)));
  if (!covered) {
    console.error(`REFUSING: the quarantine set (${q.size} sids) canonicalises to a shape that`);
    console.error(`matches NO session on ${SATELLITE} — the filter has nothing to compare against.`);
    console.error(`quarantine: ${[...shapes].join(", ")} · satellite: ${idShape(sat.sessions[0]?.sid || "")}`);
    process.exit(5);
  }
  const st = quarantineSelftest(q);
  if (!st.ok) {
    console.error(`REFUSING: quarantine self-test failed — ${st.why}`);
    console.error("CV/job content could pass through. Nothing synced.");
    process.exit(5);
  }
}

if (proposal.count === 0) {
  console.log(`nothing to sync — the hub already holds every clean session on ${SATELLITE}. No-op.`);
  process.exit(0);
}
const signed = signProposal(proposal, {
  operator: String(sig).slice(0, 64),
  intent: String(opt("--intent", "")).slice(0, 300),
  at: new Date().toISOString()
});
const result = applySync(signed, {
  machine: SATELLITE, driveLabel: "landing", driveRole: "replica", machineRole: "satellite",
  sessions: sat.sessions
}, { syncSource, kelLog: KEL, stagingRoot: STAGING });

console.log(`SYNC ${result.applied ? "APPLIED" : "REFUSED"} — proposal ${signed.id}`);
if (!result.applied) { console.error(`  ${result.reason}`); process.exit(2); }
console.log(`  sessions staged     ${result.syncResult.sessionsNew} new · ${result.syncResult.sessionsSkipped} already recorded`);
console.log(`  blobs               ${result.syncResult.stored} stored · ${result.syncResult.deduped} deduped`);
console.log(`  drive fingerprint   ${result.syncResult.fingerprint.slice(0, 22)}…`);
console.log(`  KEL                 ${KEL}`);
console.log(result.noop ? "  (re-apply of an already-synced proposal — a true no-op)" : "");

} // end: invoked directly
