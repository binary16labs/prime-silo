#!/usr/bin/env node
// Gate T1 — the trainer runs fully from a local clone of the Benny home.
//
// Confirms (all reads local, no network call back to the desktop):
//   1. The home resolver (Node AND Python) points at the clone via PRIME_SILO_HOME,
//      benny/ + customware/ derive from it, and no override points outside the home
//      (the stale-absolute-path / drive-letter risk the T1 contract flags).
//   2. A known key reads back from each store:
//        - LONGVIEW cards  → workspaces/longview/data_in/longview_card_*.md
//        - memo-ray        → $MEMORAY_DATA_DIR (index.json sessions + one entity)
//        - S16 doc+vector  → workspaces/longview/chromadb (chroma.sqlite3 doc +
//                             its on-disk HNSW vector segment data_level0.bin)
//
// "S16" is the plan's name for the doc+vector RAG store; in the home that is the
// Chroma store. The KG (Neo4j) is not one of the three contract checks, so this
// gate does not boot a graph server — it reads the file-based stores directly.
//
// verify: node scripts/gates/t1.mjs   (exit 0 = green)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = (process.env.T1_PY || "python").trim();
const { resolveHome } = require(path.join(ROOT, "packaging", "desktop", "home_resolver.js"));

function fail(reason, detail = "") {
  console.log(`[t1] reason=${reason}${detail ? " — " + detail : ""}`);
  console.log("[t1] GATE RED");
  process.exit(1);
}
function ok(label, extra = "") {
  console.log(`[t1] ${label}: PASS${extra ? " — " + extra : ""}`);
}
function py(code) {
  return execFileSync(PY, ["-c", code], { encoding: "utf8", timeout: 90000 })
    .trim()
    .split(/\r?\n/)
    .pop();
}
const isLocalFsPath = (p) => /^[A-Za-z]:[\\/]/.test(p) && !/^\\\\/.test(p);

// ── Scenario: the home resolver points at the clone ────────────────────────────
const home = resolveHome();
// The clone is pointed at explicitly via PRIME_SILO_HOME env (source "env") or the
// persisted prime-silo-config.json homeDir (source "config") — both are valid; only
// the unconfigured per-user "default" means the home was never repointed at the clone.
if (home.source !== "env" && home.source !== "config")
  fail("home_not_configured", `root source=${home.source} (expected env or config pointing at the clone)`);
if (!fs.existsSync(home.bennyHome)) fail("benny_missing", home.bennyHome);
if (!fs.existsSync(home.customwarePath)) fail("customware_missing", home.customwarePath);
if (!isLocalFsPath(home.root)) fail("home_not_local", `root is not a local drive path: ${home.root}`);
const outsideWarn = (home.warnings || []).filter((w) => /outside the declared home/i.test(w));
if (outsideWarn.length) fail("stale_abs_path", outsideWarn.join(" | "));
ok("home-resolver (node)", `root=${home.root} source=${home.source}; benny/ + customware/ exist`);

// Inject the resolved root into the env the Python subprocess inherits. Node can
// read prime-silo-config.json (source "config") but the Microsoft-Store Python
// VIRTUALIZES %APPDATA% and can't see that file — env vars are not virtualized,
// so passing PRIME_SILO_HOME explicitly makes the Python resolver agree whether
// the clone was pointed at via the env var or the config file.
process.env.PRIME_SILO_HOME = home.root;

// Python resolver must agree (the two are kept in sync by design).
let pyRoot;
try {
  pyRoot = py(
    `import sys,os\nsys.path.insert(0, r'${path.join(ROOT, "runtime")}')\n` +
      `from benny.portable.home import resolve_home\nprint(resolve_home().root)`
  );
} catch (e) {
  fail("python_resolver_failed", (e.stderr || e.message || "").toString().split(/\r?\n/).slice(-3).join(" "));
}
if (path.resolve(pyRoot) !== path.resolve(home.root))
  fail("resolver_mismatch", `node=${home.root} python=${pyRoot}`);
ok("home-resolver (python)", `agrees → ${pyRoot}`);

// ── Store locations, derived from the resolved home ────────────────────────────
const ws = path.join(home.bennyHome, "workspaces", "longview");
const cardsDir = path.join(ws, "data_in");
const chromaDir = path.join(ws, "chromadb");
const chromaDb = path.join(chromaDir, "chroma.sqlite3");
const memDir = (process.env.MEMORAY_DATA_DIR || "").trim() || path.join(os.homedir(), ".mem0ray", "data");

for (const [name, p] of [["benny", home.bennyHome], ["memo-ray", memDir]])
  if (!isLocalFsPath(p)) fail("remote_store", `${name} store is not a local path (no-network rule): ${p}`);

// ── Store: LONGVIEW cards ──────────────────────────────────────────────────────
const cards = fs.existsSync(cardsDir)
  ? fs.readdirSync(cardsDir).filter((f) => /^longview_card_.*\.md$/.test(f))
  : [];
if (cards.length === 0) fail("no_cards", cardsDir);
const cardText = fs.readFileSync(path.join(cardsDir, cards[0]), "utf8");
if (!/Session card|Session\s+[0-9a-f]{8}/i.test(cardText)) fail("card_unreadable", cards[0]);
ok("store: LONGVIEW cards", `${cards.length} cards; read ${cards[0]} (${cardText.length} chars)`);

// ── Store: memo-ray (one session + one entity) ────────────────────────────────
const idxPath = path.join(memDir, "index.json");
if (!fs.existsSync(idxPath)) fail("no_mem0ray_index", idxPath);
let idx;
try {
  idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
} catch (e) {
  fail("mem0ray_index_unreadable", e.message);
}
const sessionKeys = Object.keys(idx.sessions || {});
if (sessionKeys.length === 0) fail("no_mem0ray_sessions", "index.json has empty sessions");
const entDir = path.join(memDir, "entities");
const entFiles = fs.existsSync(entDir) ? fs.readdirSync(entDir).filter((f) => f.endsWith(".json")) : [];
if (entFiles.length === 0) fail("no_mem0ray_entities", entDir);
const ent = JSON.parse(fs.readFileSync(path.join(entDir, entFiles[0]), "utf8"));
if (!ent.id) fail("mem0ray_entity_unreadable", entFiles[0]);
ok("store: memo-ray", `${sessionKeys.length} sessions, ${entFiles.length} entities; read ${ent.id.slice(0, 12)} (${ent.type})`);

// ── Store: S16 doc+vector (Chroma) — doc from sqlite + on-disk vector segment ──
if (!fs.existsSync(chromaDb)) fail("no_vector_store", chromaDb);
let vec;
try {
  const raw = py(
    `import sqlite3,os,json\n` +
      `db=r'''${chromaDb}'''\n` +
      `c=sqlite3.connect(db);cur=c.cursor()\n` +
      `n=cur.execute('select count(*) from embeddings').fetchone()[0]\n` +
      `row=cur.execute("select id,string_value from embedding_metadata where key='chroma:document' and string_value is not null limit 1").fetchone()\n` +
      `c.close()\n` +
      `seg=None;sz=0\n` +
      `for r,d,f in os.walk(os.path.dirname(db)):\n` +
      `  if 'data_level0.bin' in f: seg=os.path.join(r,'data_level0.bin');sz=os.path.getsize(seg);break\n` +
      `print(json.dumps({'embeddings':n,'doc_id':(row[0] if row else None),'doc_head':((row[1] or '')[:80] if row else None),'vec_segment':bool(seg),'vec_bytes':sz}))`
  );
  vec = JSON.parse(raw);
} catch (e) {
  fail("vector_store_unreadable", (e.stderr || e.message || "").toString().split(/\r?\n/).slice(-3).join(" "));
}
if (!vec || vec.embeddings < 1) fail("vector_store_empty", JSON.stringify(vec));
if (!vec.doc_head) fail("vector_doc_missing", "no chroma:document row");
if (!vec.vec_segment || vec.vec_bytes < 1) fail("vector_segment_missing", "no on-disk data_level0.bin");
ok("store: S16 doc+vector (chroma)", `${vec.embeddings} vectors; doc id=${vec.doc_id} "${vec.doc_head.replace(/\s+/g, " ").trim()}"; vector segment ${(vec.vec_bytes / 1024).toFixed(0)} KB local`);

console.log(
  "[t1] evidence " +
    JSON.stringify({
      root: home.root,
      benny: home.bennyHome,
      customware: home.customwarePath,
      mem0ray: memDir,
      cards: cards.length,
      sessions: sessionKeys.length,
      entities: entFiles.length,
      vectors: vec.embeddings,
      vector_bytes: vec.vec_bytes,
    })
);
console.log("[t1] GATE GREEN");
