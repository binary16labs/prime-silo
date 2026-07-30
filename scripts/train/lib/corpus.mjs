// T2 corpus readers — pull the already-structured sources off the local T1 clone.
// No LLM, no network: deterministic extraction from cards / ADRs / memo-ray traces.
import fs from "node:fs";
import path from "node:path";

// --- LONGVIEW cards (benny/workspaces/longview/data_in/longview_card_*.md) ------
export function readCards(bennyHome, { workspace = "longview" } = {}) {
  const dir = path.join(bennyHome, "workspaces", workspace, "data_in");
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^longview_card_.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
  return files.map((f) =>
    parseCard(f.replace(/\.md$/, ""), fs.readFileSync(path.join(dir, f), "utf8"))
  );
}

// Split a card into {id, sid, title, sections:{Intent, Applications, ...}}.
export function parseCard(id, text) {
  const titleM = text.match(/^#\s*Session card:\s*(.+)$/m);
  const sidM = text.match(/^Session\s+([0-9a-f]{8,})/m);
  const sections = {};
  const parts = text.split(/^##\s+/m);
  for (const p of parts.slice(1)) {
    const nl = p.indexOf("\n");
    const name = p.slice(0, nl).trim();
    sections[name] = p.slice(nl + 1).trim();
  }
  return {
    id,
    sid: sidM ? sidM[1] : null,
    title: titleM ? titleM[1].trim() : id,
    sections,
    raw: text
  };
}

// --- ADRs (architecture/ADR-*.md) ----------------------------------------------
export function readADRs(repoRoot) {
  const dir = path.join(repoRoot, "architecture");
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^ADR-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const titleM = text.match(/^#\s*(.+)$/m);
    const sections = {};
    for (const p of text.split(/^##\s+/m).slice(1)) {
      const nl = p.indexOf("\n");
      sections[p.slice(0, nl).trim()] = p.slice(nl + 1).trim();
    }
    return {
      id: f.replace(/\.md$/, ""),
      title: titleM ? titleM[1].trim() : f,
      sections,
      raw: text
    };
  });
}

// --- memo-ray traces (~/.mem0ray/data/entities/*.json) --------------------------
// 80k+ entities can't all be read per build, so load a deterministic, capped slice
// (sorted by filename) into an id->entity map. Stream B reconstructs trajectories
// from whatever context is present in the loaded slice. The cap is documented in
// the dataset card and is env-tunable (T2_TRACE_MAX_ENTITIES).
export function readTraceEntities(
  memDir,
  { maxEntities = Number(process.env.T2_TRACE_MAX_ENTITIES) || 6000 } = {}
) {
  const dir = path.join(memDir, "entities");
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(0, maxEntities);
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (e && e.id) map.set(e.id, e);
    } catch {
      /* skip unreadable entity */
    }
  }
  return map;
}

// An entity's filename IS its id, so any ancestor can be resolved on-demand from
// disk — this reconstructs a Tool Call's full trajectory context without loading
// all 80k entities. Cached; missing/unreadable ids resolve to null.
export function makeEntityLoader(memDir) {
  const dir = path.join(memDir, "entities");
  const cache = new Map();
  return (id) => {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    let e = null;
    try {
      e = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    } catch {
      e = null;
    }
    cache.set(id, e);
    return e;
  };
}
