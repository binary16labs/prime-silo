// Data-plan v3 corpus readers (docs/train/DATA-PLAN-v3.md, Lever 1).
// All read LOCAL files only; every reader is quarantine/leak-gate aware downstream.
import fs from "node:fs";
import path from "node:path";

const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));

// sessions_v1-style workspace: <ws>/cards/*.json (filename = sid) + <ws>/quarantine.json.
// Quarantined sids are dropped STRUCTURALLY here (not just lexically by the leak gate).
export function readJsonCards(wsDir) {
  const cardsDir = path.join(wsDir, "cards");
  if (!fs.existsSync(cardsDir)) return [];
  let quarantined = new Set();
  try {
    const q = readJSON(path.join(wsDir, "quarantine.json"));
    quarantined = new Set((q.sids || q.quarantined || []).map(String));
  } catch {
    /* no quarantine file */
  }
  const out = [];
  for (const f of fs.readdirSync(cardsDir)) {
    if (!f.endsWith(".json")) continue;
    const sid = f.replace(/\.json$/, "");
    if (quarantined.has(sid)) continue;
    try {
      const c = readJSON(path.join(cardsDir, f));
      out.push({ sid, ...c });
    } catch {
      /* unreadable card — skip */
    }
  }
  return out;
}

// Quarantined sids for merging into the leak-gate spec (privacy.mjs loadTerms output).
export function readQuarantinedSids(wsDir) {
  try {
    const q = readJSON(path.join(wsDir, "quarantine.json"));
    return (q.sids || q.quarantined || []).map(String).filter(Boolean);
  } catch {
    return [];
  }
}

// delivery/board/LOG.md -> {ts,id,event,agent,note} per line (skips header/format lines).
export function readLogEntries(rootDir) {
  const p = path.join(rootDir, "delivery", "board", "LOG.md");
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(.+)$/);
    if (m) out.push({ ts: m[1], id: m[2], event: m[3], agent: m[4], note: m[5].trim() });
  }
  return out;
}

// delivery/tasks/*.md (skips _TEMPLATE) -> {id, body}.
export function readContracts(rootDir) {
  const dir = path.join(rootDir, "delivery", "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => ({ id: f.replace(/\.md$/, ""), body: fs.readFileSync(path.join(dir, f), "utf8") }));
}

// Split a markdown body into { "Section title": text } on ## headings.
export function splitSections(body) {
  const sections = {};
  const parts = String(body).split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const title = part.slice(0, nl).trim();
    const text = part.slice(nl + 1).trim();
    if (title && text) sections[title] = text;
  }
  return sections;
}

// architecture/*.md method docs -> {id, title, sections}.
export function readMethodDocs(rootDir) {
  const dir = path.join(rootDir, "architecture");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      const title = (body.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, "");
      return { id: f.replace(/\.md$/, ""), title: title.trim(), sections: splitSections(body) };
    })
    .filter((d) => Object.keys(d.sections).length > 0);
}

// Curated LONGVIEW prose: <ws>/../data_out {dossiers,book,reviews,discovery}/*.md.
export function readProse(dataOutDir) {
  const out = [];
  for (const sub of ["dossiers", "book", "reviews", "discovery"]) {
    const dir = path.join(dataOutDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      const title = (body.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, "");
      const sections = splitSections(body);
      if (Object.keys(sections).length === 0 && body.trim().length > 200)
        sections.Body = body.trim();
      if (Object.keys(sections).length)
        out.push({ id: `${sub}-${f.replace(/\.md$/, "")}`, title: title.trim(), sections });
    }
  }
  return out;
}

// memo-ray Thought entities with their nearest ancestor line as state.
// Bounded sweep; caller filters via thoughtToPairs.
export function readThoughts(memDir, { maxEntities = Number(process.env.T2_THOUGHT_MAX_ENTITIES) || 80555 } = {}) {
  const entDir = path.join(memDir, "entities");
  if (!fs.existsSync(entDir)) return [];
  const files = fs.readdirSync(entDir).slice(0, maxEntities);
  const out = [];
  const cache = new Map();
  const load = (id) => {
    if (cache.has(id)) return cache.get(id);
    let e = null;
    try {
      e = readJSON(path.join(entDir, id));
    } catch {
      /* absent */
    }
    cache.set(id, e);
    return e;
  };
  for (const f of files) {
    const e = load(f);
    if (!e || e.type !== "Thought" || !e.content) continue;
    let state = "";
    if (e.parent_id) {
      const p = load(e.parent_id);
      if (p?.content)
        state = `${p.type}: ${String(p.content).split(/\r?\n/)[0].slice(0, 200)}`;
    }
    out.push({ id: f, sid: e.parent_id || f, agent: e.agent, content: String(e.content), state });
  }
  return out;
}
