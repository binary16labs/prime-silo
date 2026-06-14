// Phase B-Bridge — benny-pilot skill helper.
//
// Benny (the onscreen agent) calls these from the Bridge cockpit. They let
// Benny answer grounded in *what's on the stage right now* — the page
// publishes its live state on window.__bennyBridgeContext, and the data comes
// from the same shell proxies the page uses (/api/memoray, /api/runtime). All
// same-origin GETs; no configuration here.
//
// Every result that points at a place carries a Bridge deep link so Benny can
// hand the human a one-click jump back to the exact mode/selection.

const MEMORAY = "/api/memoray";
const RUNTIME = "/api/runtime";
const ROUTE = "#/_prime_silo/bridge";

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`, { credentials: "same-origin" });
  if (!response.ok) {
    let detail = `Request failed (${response.status}).`;
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

/** A Bridge deep link for a mode + optional selected id. */
export function bridgeLink(mode, id) {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (id) params.set("id", id);
  const qs = params.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

/** The live Bridge state the page published — {mode, selection, workspace, lastRun, conformance, route}. */
export function readContext() {
  return (typeof window !== "undefined" && window.__bennyBridgeContext) || null;
}

/** The unified mesh activity feed (sessions, artifacts, git commits), newest first. */
export async function lifelog(limit = 20) {
  const rows = await getJson(MEMORAY, "/lifelog");
  return (Array.isArray(rows) ? rows : []).slice(0, limit);
}

/** Recent agent sessions, optionally filtered by agent. Each carries a Bridge deep link. */
export async function recentSessions({ agent, limit = 10 } = {}) {
  const rows = await getJson(MEMORAY, "/sessions");
  let sessions = Array.isArray(rows) ? rows : [];
  if (agent) {
    const wanted = String(agent).toLowerCase();
    sessions = sessions.filter((s) => String(s.agent || "").toLowerCase() === wanted);
  }
  return sessions.slice(0, limit).map((s) => ({
    id: s.id,
    title: s.content || "Untitled",
    agent: s.agent,
    project: s.metadata?.project || null,
    timestamp: s.timestamp,
    link: bridgeLink("memory", s.id)
  }));
}

/** Omnibar search across sessions, files, actions. Sessions carry a Bridge deep link. */
export async function search(query) {
  if (!query || query.length < 2) return { sessions: [], files: [], actions: [] };
  const body = await getJson(MEMORAY, `/beta/search?q=${encodeURIComponent(query)}`);
  return {
    sessions: (body.sessions || []).map((s) => ({ ...s, link: bridgeLink("memory", s.id) })),
    files: body.files || [],
    actions: body.actions || []
  };
}

/** Recent manifest runs (observability). Each carries a Bridge deep link into Runs. */
export async function runs(limit = 15) {
  const rows = await getJson(RUNTIME, `/manifests/runs?limit=${encodeURIComponent(limit)}`);
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    runId: r.run_id || r.id,
    status: r.status,
    requirement: r.requirement || "",
    link: bridgeLink("runs", r.run_id || r.id)
  }));
}

/** Code graph {nodes, edges} for a workspace (the Code 3D mode's data). */
export async function codeGraph(workspace = "default") {
  return getJson(RUNTIME, `/graph/code?workspace=${encodeURIComponent(workspace)}`);
}

/** Recursively scan the entire workspace directory including files. */
export async function workspaceFileList(workspace = "prime_silo_self") {
  const body = await getJson(RUNTIME, `/files/recursive-scan?workspace=${encodeURIComponent(workspace)}`);
  return body?.files || [];
}

/** Get text content preview or metadata for a file in the workspace. */
export async function workspaceFileRead(path, workspace = "prime_silo_self") {
  return getJson(RUNTIME, `/files/preview?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`);
}

export default {
  bridgeLink,
  readContext,
  lifelog,
  recentSessions,
  search,
  runs,
  codeGraph,
  workspaceFileList,
  workspaceFileRead
};

