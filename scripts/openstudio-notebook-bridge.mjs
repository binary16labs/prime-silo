#!/usr/bin/env node
// Open-Studio bridge (Phase 2b): open-notebook sources -> Benny RAG.
//
// Benny's POST /rag/ingest ingests FILES that already live in the workspace's
// data_in/ directory (it does not accept raw text in the body). So this bridge
// is two steps:
//   A) pull each open-notebook source's full text and write it as a .md file
//      into the Benny workspace data_in/ directory
//   B) (unless --no-ingest) POST the ingest trigger so Benny chunks the files
//      into ChromaDB and, with deep_synthesis, extracts triples into Neo4j.
//
// No external dependencies — uses Node's global fetch (Node 18+).
//
// Usage:
//   node openstudio-notebook-bridge.mjs --data-in "<BENNY_HOME>/workspaces/default/data_in"
//   node openstudio-notebook-bridge.mjs --data-in "<...>" --no-ingest      # export only
//   node openstudio-notebook-bridge.mjs --notebook notebook:abc123         # one notebook
//
// Env (flags override): OPEN_NOTEBOOK_URL, BENNY_DATA_IN, BENNY_INGEST_URL,
//   BENNY_API_KEY, BENNY_WORKSPACE.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

if (flag("help") || flag("h")) {
  console.log("open-notebook -> Benny RAG bridge. See header of this file for usage.");
  process.exit(0);
}

const ON_BASE = (
  opt("notebook-url", process.env.OPEN_NOTEBOOK_URL) || "http://localhost:5055"
).replace(/\/+$/, "");
const DATA_IN = opt("data-in", process.env.BENNY_DATA_IN) || "";
const INGEST_URL =
  opt("ingest-url", process.env.BENNY_INGEST_URL) || "http://localhost:3000/api/runtime/rag/ingest";
const API_KEY = opt("api-key", process.env.BENNY_API_KEY) || "benny-mesh-2026-auth";
const WORKSPACE = opt("workspace", process.env.BENNY_WORKSPACE) || "default";
const ONLY_NOTEBOOK = opt("notebook", "");
const NO_INGEST = flag("no-ingest");

if (!DATA_IN) {
  console.error(
    "ERROR: provide the Benny workspace data_in directory via --data-in or BENNY_DATA_IN."
  );
  console.error(
    '  e.g. --data-in "C:\\\\Users\\\\you\\\\.benny\\\\workspaces\\\\default\\\\data_in"'
  );
  process.exit(2);
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

function safeName(s, fallback) {
  const base = String(s || "")
    .trim()
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return (base || fallback || "source").replace(/^_+|_+$/g, "") || "source";
}

// Resolve a source's full text: prefer the inline field, fall back to the
// per-source detail endpoint, then the raw download endpoint.
async function resolveSourceText(src) {
  if (typeof src.full_text === "string" && src.full_text.trim()) return src.full_text;
  try {
    const detail = await getJSON(`${ON_BASE}/api/sources/${encodeURIComponent(src.id)}`);
    if (typeof detail.full_text === "string" && detail.full_text.trim()) return detail.full_text;
  } catch {
    /* try download */
  }
  const dl = await getText(`${ON_BASE}/api/sources/${encodeURIComponent(src.id)}/download`);
  return dl && dl.trim() ? dl : null;
}

async function main() {
  fs.mkdirSync(DATA_IN, { recursive: true });

  let notebooks;
  try {
    notebooks = await getJSON(`${ON_BASE}/api/notebooks`);
  } catch (e) {
    console.error(`[bridge] cannot reach open-notebook at ${ON_BASE} (${e.message}).`);
    console.error(
      "[bridge] start it first:  docker compose -f C:\\Users\\nsdha\\docker-compose.yml up -d"
    );
    process.exit(3);
  }
  if (!Array.isArray(notebooks)) notebooks = [];
  if (ONLY_NOTEBOOK) notebooks = notebooks.filter((n) => n.id === ONLY_NOTEBOOK);

  let written = 0,
    skipped = 0;
  const usedNames = new Set();

  for (const nb of notebooks) {
    if (!nb || !nb.id) continue;
    let sources = await getJSON(`${ON_BASE}/api/sources?notebook_id=${encodeURIComponent(nb.id)}`);
    if (!Array.isArray(sources)) sources = [];
    console.log(`[bridge] notebook "${nb.name || nb.id}" — ${sources.length} source(s)`);

    for (const src of sources) {
      if (!src || !src.id) continue;
      const text = await resolveSourceText(src);
      if (!text) {
        console.warn(
          `[bridge]   skip "${src.title || src.id}" (no retrievable text — may still be processing)`
        );
        skipped++;
        continue;
      }
      // Unique, filesystem-safe filename, scoped by notebook for readability.
      let name = `${safeName(nb.name, "notebook")}__${safeName(src.title, src.id)}`;
      let file = `${name}.md`;
      let n = 1;
      while (usedNames.has(file.toLowerCase())) {
        file = `${name}_${n++}.md`;
      }
      usedNames.add(file.toLowerCase());

      const header =
        `# ${src.title || "Untitled source"}\n\n` +
        `> notebook: ${nb.name || nb.id} | source: ${src.id}\n\n`;
      fs.writeFileSync(path.join(DATA_IN, file), header + text, "utf8");
      console.log(`[bridge]   wrote ${file} (${text.length} chars)`);
      written++;
    }
  }

  console.log(`[bridge] export complete: ${written} written, ${skipped} skipped -> ${DATA_IN}`);

  if (NO_INGEST) {
    console.log("[bridge] --no-ingest set; not triggering Benny. Files are staged in data_in/.");
    return;
  }
  if (written === 0) {
    console.log("[bridge] nothing to ingest; done.");
    return;
  }

  console.log(`[bridge] triggering Benny ingest (${INGEST_URL}, workspace=${WORKSPACE})...`);
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Benny-API-Key": API_KEY },
    body: JSON.stringify({ workspace: WORKSPACE, deep_synthesis: true, force_reingest: true })
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`[bridge] ingest failed: ${res.status} ${res.statusText}\n${bodyText}`);
    process.exit(1);
  }
  console.log(`[bridge] ingest response: ${bodyText}`);
}

main().catch((e) => {
  console.error("[bridge] FAILED:", e.message);
  process.exit(1);
});
