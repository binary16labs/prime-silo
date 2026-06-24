// Phase B-Bridge — project-guide skill helper.
//
// Lets Benny ground answers about *this* project in live data, on top of the
// curated brief in SKILL.md. Same-origin GETs through the existing proxies
// (/api/runtime, /api/memoray); no configuration. Pairs with benny-pilot
// (stage-aware) — project-guide is the "what is this whole thing" skill.

const RUNTIME = "/api/runtime";

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${path}`);
  return res.json();
}

/** The in-repo docs a human (or you) can open for the full story. */
export function docLinks() {
  return [
    { title: "User Guide (humans)", path: "docs/USER_GUIDE.md" },
    { title: "Walkthrough", path: "GUIDE.md" },
    { title: "Overview + phases", path: "README.md" },
    { title: "Roadmap", path: "architecture/ROADMAP.md" },
    { title: "Technical debt", path: "architecture/TECH_DEBT.md" },
    { title: "Agent map", path: "CLAUDE.md" }
  ];
}

/** The Bridge modes and what each is for — the product surface in one place. */
export function workflows() {
  return [
    {
      name: "Flows",
      what: "requirement -> Plan (DAG) -> Run (observability)",
      where: "#/_prime_silo/bridge?mode=flows"
    },
    {
      name: "Documents",
      what: "workspace files -> Ingest -> knowledge triples -> Correlate with code",
      where: "#/_prime_silo/bridge?mode=documents"
    },
    {
      name: "Code 3D",
      what: "Tree-Sitter code graph (2D/3D)",
      where: "#/_prime_silo/bridge?mode=code"
    },
    {
      name: "Memory",
      what: "agent-session lineage (Claude + Antigravity)",
      where: "#/_prime_silo/bridge?mode=memory"
    },
    {
      name: "Runs",
      what: "execution timeline + reasoning trace",
      where: "#/_prime_silo/bridge?mode=runs"
    },
    {
      name: "Pulse",
      what: "mesh vitals + lifelog activity feed",
      where: "#/_prime_silo/bridge?mode=pulse"
    }
  ];
}

/** Code graph {nodes, edges} for a workspace — for "how is the code structured" questions. */
export async function codeGraph(workspace = "prime_silo_self") {
  return getJson(RUNTIME, `/graph/code?workspace=${encodeURIComponent(workspace)}`);
}

/** Knowledge/code graph stats for a workspace, when available. */
export async function graphStats(workspace = "prime_silo_self") {
  try {
    return await getJson(RUNTIME, `/graph/stats?workspace=${encodeURIComponent(workspace)}`);
  } catch {
    return null;
  }
}

/** Workspaces that exist (so you can tell the user what's loaded). */
export async function workspaces() {
  try {
    const list = await getJson(RUNTIME, "/workspaces");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Current integration conformance — answer "is the project healthy". */
export async function health() {
  const r = await fetch("/api/integration_audit", { credentials: "same-origin" });
  if (!r.ok) return { status: "unknown" };
  return r.json();
}
