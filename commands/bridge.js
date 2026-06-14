// Phase B-Bridge — `node space bridge <subcommand>`.
//
// The CLI surface of the Bridge cockpit: the same golden paths the page wires
// to buttons, available headless so a script, a CI job, or a local
// Lemonade-driven agent can drive them without a browser. Delegates through
// the shared server libs (runtime_proxy.js#runtimeRequest, memoray_proxy.js,
// integration_audit.js) so every surface agrees on settings + endpoints.
//
// Subcommands:
//   status              one "where am I": memory online? workspace, files, runs, conformance
//   plan "<req>"        POST /manifests/plan — print the manifest id + node summary
//   run <manifest_id>   POST /manifests/{id}/run — print the run id + status
//   ingest              POST /rag/ingest — print the ingest run id (docs -> triples)
//   open                print the #/_prime_silo/bridge URL

import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";
import { runtimeRequest } from "../server/lib/runtime_proxy.js";
import { memorayRequest, resolveMemoraySettings } from "../server/lib/memoray_proxy.js";
import { runIntegrationAudit } from "../server/lib/integration_audit.js";

export const help = {
  name: "bridge",
  summary: "Drive the Bridge cockpit golden paths from the terminal.",
  usage: [
    "node space bridge status",
    "node space bridge plan \"<requirement>\" [--workspace W] [--strategy auto|oneshot|incremental|swarm]",
    "node space bridge run <manifest_id> [--workspace W]",
    "node space bridge ingest [--workspace W]",
    "node space bridge open"
  ],
  description:
    "Headless access to the Bridge — the one cockpit that unifies memory, documents, code, flows and runs. `plan`/`run` push the swarm golden path; `ingest` pushes the documents->triples path; `status` is a one-shot mesh snapshot. Same runtime/memoray endpoints the page uses.",
  arguments: [
    { name: "<subcommand>", description: "status | plan | run | ingest | open" }
  ],
  options: [
    { name: "--workspace", description: "Workspace to scope plan/run/ingest (default 'default')." },
    { name: "--strategy", description: "Planner strategy for plan (auto|oneshot|incremental|swarm)." }
  ],
  examples: [
    "node space bridge status",
    "node space bridge plan \"score trades for credit risk\" --workspace pypes_demo",
    "node space bridge run mf_1a2b3c --workspace pypes_demo",
    "node space bridge ingest --workspace c5_test"
  ]
};

const ROUTE = "#/_prime_silo/bridge";

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i += 1; }
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function reportRuntimeDown(result) {
  console.error(`Benny runtime unreachable (${result.url}). ${result.hint || "Boot it with scripts/dev.ps1."}`);
}

async function cmdStatus(ctx) {
  // Memory (memoray) leg.
  const settings = await resolveMemoraySettings(ctx);
  if (!settings.enabled) {
    console.log("memory: disabled (MEMORAY_ENABLED=false)");
  } else {
    const mem = await memorayRequest("/ecosystem/manifest", ctx);
    if (mem.ok) {
      const m = mem.body || {};
      const claude = m.claude?.sessions || 0;
      const anti = m.antigravity?.sessions || 0;
      console.log(`memory: online — ${claude + anti} sessions (claude ${claude}, antigravity ${anti}), ${m.totalNodes || 0} nodes`);
    } else {
      console.log("memory: offline");
    }
  }

  // Runtime leg (runs + conformance).
  const runs = await runtimeRequest("/manifests/runs?limit=5");
  if (runs.ok && Array.isArray(runs.body)) {
    const last = runs.body[0];
    console.log(`runs: ${runs.body.length}+ recorded${last ? ` — last ${last.run_id || last.id} (${last.status || "?"})` : ""}`);
  } else {
    console.log("runs: runtime unreachable");
  }

  const report = await runIntegrationAudit(ctx);
  console.log(`conformance: ${report.status.toUpperCase()} (${report.integrations.map((r) => `${r.id}=${r.status}`).join(", ")})`);
  console.log(`open: ${ROUTE}`);
  return 0;
}

async function cmdPlan(ctx, requirement, flags) {
  if (!requirement) {
    console.error("Usage: node space bridge plan \"<requirement>\" [--workspace W] [--strategy S]");
    return 1;
  }
  const body = { requirement, workspace: flags.workspace || "default" };
  if (flags.strategy) body.strategy = flags.strategy;
  const result = await runtimeRequest("/manifests/plan", { method: "POST", body });
  if (!result.ok) { reportRuntimeDown(result); return 1; }
  const m = result.body || {};
  const nodes = Array.isArray(m.nodes) ? m.nodes.length : (Array.isArray(m.steps) ? m.steps.length : 0);
  console.log(`planned: ${m.id || "(no id)"}`);
  console.log(`requirement: ${m.requirement || requirement}`);
  console.log(`nodes: ${nodes}`);
  console.log(`run it: node space bridge run ${m.id || "<id>"}${flags.workspace ? ` --workspace ${flags.workspace}` : ""}`);
  return 0;
}

async function cmdRun(ctx, manifestId, flags) {
  if (!manifestId) {
    console.error("Usage: node space bridge run <manifest_id> [--workspace W]");
    return 1;
  }
  const result = await runtimeRequest(`/manifests/${encodeURIComponent(manifestId)}/run`, {
    method: "POST",
    body: { workspace: flags.workspace || "default" }
  });
  if (!result.ok) { reportRuntimeDown(result); return 1; }
  const r = result.body || {};
  const runId = r.run_id || r.id || "(no run id)";
  console.log(`run: ${runId}`);
  console.log(`status: ${r.status || "started"}`);
  console.log(`observe: ${ROUTE}?mode=runs&id=${encodeURIComponent(runId)}`);
  return 0;
}

async function cmdIngest(ctx, flags) {
  const result = await runtimeRequest("/rag/ingest", {
    method: "POST",
    body: { workspace: flags.workspace || "default" }
  });
  if (!result.ok) { reportRuntimeDown(result); return 1; }
  const r = result.body || {};
  console.log(`ingest: ${r.run_id || r.task_id || r.id || "started"}`);
  console.log(`workspace: ${flags.workspace || "default"}`);
  console.log(`see triples: ${ROUTE}?mode=documents`);
  return 0;
}

export async function execute(context) {
  const { positional, flags } = parseFlags(context.args);
  const subcommand = positional[0];
  const runtimeParams = await createRuntimeParams(context.projectRoot);
  const ctx = { runtimeParams, projectRoot: context.projectRoot };

  switch (subcommand) {
    case "status": return cmdStatus(ctx);
    case "plan": return cmdPlan(ctx, positional.slice(1).join(" ").trim(), flags);
    case "run": return cmdRun(ctx, positional[1], flags);
    case "ingest": return cmdIngest(ctx, flags);
    case "open":
      console.log(ROUTE);
      return 0;
    default:
      console.error(`Unknown subcommand: ${subcommand || "(none)"}`);
      console.error("Usage: node space bridge <status|plan|run|ingest|open>");
      return 1;
  }
}
