// Retrieval seams for the weave/opus phases: semantic chunks from the
// workspace vector store, and concept context from the Neo4j graph. All
// best-effort — a down endpoint degrades to "no context", never a crash.
import { config } from "./config.mjs";

async function bennyGet(path) {
  const res = await fetch(`${config.BENNY_API_BASE}${path}`, {
    headers: { "X-Benny-API-Key": config.BENNY_API_KEY },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

export async function ragQuery(query, topK = 5) {
  try {
    const res = await fetch(`${config.BENNY_API_BASE}/api/rag/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Benny-API-Key": config.BENNY_API_KEY },
      body: JSON.stringify({ workspace: config.WORKSPACE, query, top_k: topK }),
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const rows = Array.isArray(data) ? data : data.results || data.documents || [];
    return rows
      .map((r) => ({
        text: r.text || r.content || "",
        source: r.source || r.metadata?.source || ""
      }))
      .filter((r) => r.text);
  } catch {
    return [];
  }
}

// Top concepts in the workspace graph — the weave phase samples these to keep
// discovery anchored to what the graph actually contains.
export async function graphCatalog(limit = 30) {
  // NOT /api/graph/catalog: that endpoint lists graph VIEWS ("Neural Nexus
  // (Merged Global view)"), not concepts — weave fed the question generator
  // that single string as its whole corpus grounding, and the model invented
  // "Project A / Technology X" placeholder questions (2026-07-14). The lean
  // knowledge endpoint has the real Concept nodes; merged hubs first — they
  // are the cross-session ideas discovery questions should probe.
  try {
    const data = await bennyGet(
      `/api/graph/knowledge?workspace=${encodeURIComponent(config.WORKSPACE)}&mode=connected`
    );
    return (data.nodes || [])
      .filter((n) => n.node_type === "Concept" && n.name)
      .sort(
        (a, b) =>
          (b.merge_count || 1) - (a.merge_count || 1) || (b.centrality || 0) - (a.centrality || 0)
      )
      .map((n) => n.name)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function graphNeighbors(concept, limit = 10) {
  try {
    const data = await bennyGet(
      `/api/graph/neighbors/${encodeURIComponent(concept)}?workspace=${encodeURIComponent(config.WORKSPACE)}`
    );
    const rows = Array.isArray(data) ? data : data.neighbors || data.nodes || [];
    return rows
      .map((n) => (typeof n === "string" ? n : n.name || n.concept || ""))
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// Compose a compact evidence block for a generation call: chunks first (the
// substance), then graph context (the cross-references), clipped to budget.
export async function evidenceFor(query, opts = {}) {
  return (await evidenceForWithSources(query, opts)).text;
}

// Provenance-aware variant (Benny Record): returns WHICH sources fed the pack —
// the previously-discarded edge that makes output lineage traceable.
export async function evidenceForWithSources(query, { topK = 5, budget = 4500 } = {}) {
  const chunks = await ragQuery(query, topK);
  const sources = [];
  let out = "";
  for (const c of chunks) {
    const piece = `\n[${c.source}]\n${c.text.slice(0, 900)}\n`;
    if (out.length + piece.length > budget) break;
    out += piece;
    sources.push({ kind: "chunk", source: c.source });
  }
  const firstWords = query.split(/\s+/).slice(0, 3).join(" ");
  const neighbors = await graphNeighbors(firstWords, 8);
  if (neighbors.length && out.length < budget - 200) {
    out += `\n[graph: related concepts] ${neighbors.join(", ")}\n`;
    for (const n of neighbors) sources.push({ kind: "graph", source: n });
  }
  return {
    text: out || "(no retrieved evidence — write only from the chapter brief, conservatively)",
    sources
  };
}
