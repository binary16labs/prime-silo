// Phase M1 — memory-recall skill helper.
//
// Thin browser-side helpers the onscreen agent calls to query the Memo-Ray
// memory graph through the shell proxy (/api/memoray). Same origin, so a
// plain fetch suffices — no configuration here; the proxy owns the endpoint.
//
// Every result carries a deep link into the visual memory page so the agent
// can hand the human a clickable jump to the lineage graph.

const API_PREFIX = "/api/memoray";

async function getJson(path) {
  const response = await fetch(`${API_PREFIX}${path}`, { credentials: "same-origin" });
  if (!response.ok) {
    let detail = `Memo-Ray request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (body?.error === "memoray_unreachable") detail = "Memo-Ray is offline — ask the user to boot it with scripts/memoray.ps1.";
      else if (body?.error === "memoray_disabled") detail = "Memo-Ray is disabled — it can be enabled in the configuration wizard.";
      else if (body?.detail) detail = body.detail;
    } catch { /* keep default */ }
    throw new Error(detail);
  }
  return response.json();
}

/** Deep link into the visual memory page for a session. */
export function sessionLink(sessionId) {
  return `#/_prime_silo/memory?session_id=${encodeURIComponent(sessionId)}`;
}

/** Recent sessions (newest first), optionally filtered by agent. */
export async function recentSessions({ agent, limit = 10 } = {}) {
  const sessions = await getJson("/sessions");
  let rows = Array.isArray(sessions) ? sessions : [];
  if (agent) {
    const wanted = String(agent).toLowerCase();
    rows = rows.filter((s) => String(s.agent || "").toLowerCase() === wanted);
  }
  return rows.slice(0, limit).map((s) => ({
    id: s.id,
    title: s.content || "Untitled",
    agent: s.agent,
    project: s.metadata?.project || null,
    timestamp: s.timestamp,
    link: sessionLink(s.id)
  }));
}

/** Omnibar search across sessions, files, and actions. */
export async function search(query) {
  if (!query || query.length < 2) return { sessions: [], files: [], actions: [] };
  const body = await getJson(`/beta/search?q=${encodeURIComponent(query)}`);
  return {
    sessions: (body.sessions || []).map((s) => ({ ...s, link: sessionLink(s.id) })),
    files: body.files || [],
    actions: body.actions || []
  };
}

/** Ecosystem totals (nodes, per-agent session counts, last sync). */
export async function overview() {
  return getJson("/ecosystem/manifest");
}

/** Full lineage graph {nodes, links} for one session. */
export async function sessionGraph(sessionId) {
  return getJson(`/graph/${encodeURIComponent(sessionId)}`);
}

/** Which sessions touched a file — derived from the beta search index. */
export async function filesTouched(query) {
  const body = await getJson(`/beta/search?q=${encodeURIComponent(query)}`);
  return body.files || [];
}
