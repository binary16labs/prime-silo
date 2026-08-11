// Workflow registry API (EP-A/W) — /api/workflows/*, the single surface behind the unified console.
// Reads scripts/workflows/registry.mjs (the SAME module the CLI uses) so the console and the terminal
// can never disagree about "what is the latest TOGAF SAD / book / ladder run".
//
// Read-only by construction: it discovers artifacts on disk and reports them. It never writes, never
// launches a run (launching stays with the CLI/estate control API, which is contract-governed).
//
//   GET /api/workflows            -> every type + its latest (the console's home)
//   GET /api/workflows/:id        -> one type with the full version list
//   GET /api/workflows/dashboards -> the known dashboards this console consolidates
import path from "node:path";
import fs from "node:fs";

const PREFIX = "/api/workflows";

// The estate's existing consoles. The unified console links out rather than replacing them — each
// still owns its depth (lineage drill-down, estate governance, flywheel). Listing them IS the review:
// this is the sprawl a single entry point is meant to tame.
const DASHBOARDS = [
  ["dashboard.html", "Mission Control", "pipeline lineage rail, graph stats, enrich panes"],
  ["lineage.html", "Lineage & governance", "OpenLineage DAG, artifact explorer, execution register"],
  ["control.html", "Run control", "launch/monitor LONGVIEW phases"],
  ["build.html", "Build", "build/verification view"],
  ["estate.html", "Estate", "multi-machine sessions + backups (EP-N)"],
  ["flywheel.html", "Flywheel", "self-learning loop state (EP-L)"],
  ["memory.html", "Memory & teleport", "search + quarantine sessions (privacy)"],
  ["kindle.html", "Kindle reader", "ES5 book reader"],
  ["togaf_epic_preview.html", "TOGAF preview", "SAD preview"],
];

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

export function createWorkflowsApi({ projectRoot, prefix = PREFIX } = {}) {
  const repoRoot = projectRoot || process.cwd();

  async function handle(req, res, rest) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "read-only surface: GET only" });

    // Import lazily so a registry edit doesn't require a server restart to be picked up on next boot,
    // and so a discovery error can be reported as JSON rather than crashing the mount.
    let discoverWorkflows;
    try {
      ({ discoverWorkflows } = await import(new URL("../../scripts/workflows/registry.mjs", import.meta.url).href));
    } catch (e) {
      return sendJson(res, 500, { error: `registry unavailable: ${e.message}` });
    }

    if (rest === "/dashboards") {
      const dir = path.join(repoRoot, "scratch", "longview_run", "dashboard");
      return sendJson(res, 200, {
        root: dir,
        serve: "bash scratch/longview_run/dashboard/dash.sh  → http://localhost:8788",
        dashboards: DASHBOARDS.map(([file, label, purpose]) => ({
          file, label, purpose,
          url: `http://localhost:8788/${file === "dashboard.html" ? "" : file}`,
          present: fs.existsSync(path.join(dir, file)),
        })),
      });
    }

    let reg;
    try { reg = discoverWorkflows({ repoRoot }); }
    catch (e) { return sendJson(res, 500, { error: `discovery failed: ${e.message}` }); }

    if (rest === "/" || rest === "") return sendJson(res, 200, reg);

    const id = decodeURIComponent(rest.replace(/^\//, ""));
    const type = reg.types.find((t) => t.id === id);
    if (!type) return sendJson(res, 404, { error: `unknown workflow type: ${id}`, known: reg.types.map((t) => t.id) });
    return sendJson(res, 200, { workspace: reg.workspace, generated: reg.generated, ...type });
  }

  return {
    async tryHandle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p !== prefix && !p.startsWith(prefix + "/")) return false;
      await handle(req, res, p.slice(prefix.length) || "/");
      return true;
    },
  };
}
