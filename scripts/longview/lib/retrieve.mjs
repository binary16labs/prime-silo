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
  try {
    const data = await bennyGet(
      `/api/graph/catalog?workspace=${encodeURIComponent(config.WORKSPACE)}`
    );
    const rows = Array.isArray(data) ? data : data.concepts || data.catalog || data.items || [];
    return rows
      .map((c) => (typeof c === "string" ? c : c.name || c.concept || ""))
      .filter(Boolean)
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
export async function evidenceFor(query, { topK = 5, budget = 4500 } = {}) {
  const chunks = await ragQuery(query, topK);
  let out = "";
  for (const c of chunks) {
    const piece = `\n[${c.source}]\n${c.text.slice(0, 900)}\n`;
    if (out.length + piece.length > budget) break;
    out += piece;
  }
  const firstWords = query.split(/\s+/).slice(0, 3).join(" ");
  const neighbors = await graphNeighbors(firstWords, 8);
  if (neighbors.length && out.length < budget - 200) {
    out += `\n[graph: related concepts] ${neighbors.join(", ")}\n`;
  }
  return out || "(no retrieved evidence — write only from the chapter brief, conservatively)";
}
