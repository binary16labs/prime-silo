// Phase M1 — `node space memory <subcommand>`.
//
// The CLI surface of the Memo-Ray integration — the same memory capability
// the shell page and the onscreen-agent skill expose, available from the
// terminal and to headless/Lemonade-driven maintainers. Delegates to the
// shared server libs (server/lib/memoray_proxy.js, server/lib/integration_audit.js)
// so every surface agrees on settings resolution and audit logic.
//
// Subcommands:
//   status            reachable? totals + last sync + resolved endpoint
//   sync              trigger a delta-sync of agent logs
//   sessions [--agent claude|antigravity] [--limit N]
//   search "<query>"  omnibar search from the terminal
//   audit             run the integration conformance audit; exit 1 on drift

import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";
import { memorayRequest, resolveMemoraySettings } from "../server/lib/memoray_proxy.js";
import { runIntegrationAudit } from "../server/lib/integration_audit.js";

export const help = {
  name: "memory",
  summary: "Inspect and maintain the Memo-Ray memory graph.",
  usage: [
    "node space memory status",
    "node space memory sync",
    "node space memory sessions [--agent claude|antigravity] [--limit N]",
    "node space memory search <query>",
    "node space memory audit"
  ],
  description:
    "CLI access to the Memo-Ray memory graph (the third graph of the cognitive mesh). Reads through the same settings the shell proxy uses (MEMORAY_ENABLED / MEMORAY_BASE_URL, then the wizard manifest). `audit` runs the integration conformance check and exits non-zero on drift — the headless/CI entry point.",
  arguments: [
    { name: "<subcommand>", description: "status | sync | sessions | search | audit" }
  ],
  options: [
    { name: "--agent", description: "Filter sessions by agent (claude|antigravity)." },
    { name: "--limit", description: "Limit the number of sessions printed (default 20)." }
  ],
  examples: [
    "node space memory status",
    "node space memory sessions --agent claude --limit 10",
    "node space memory search \"lineage graph\"",
    "node space memory audit"
  ]
};

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function reportUnreachable(result) {
  console.error(result.error === "memoray_disabled"
    ? "Memo-Ray is disabled (MEMORAY_ENABLED=false). Enable it with `node space set MEMORAY_ENABLED=true`."
    : `Memo-Ray is offline. ${result.hint || "Boot it with scripts/memoray.ps1."}`);
}

async function cmdStatus(ctx) {
  const settings = await resolveMemoraySettings(ctx);
  console.log(`endpoint: ${settings.baseUrl} (enabled=${settings.enabled}, source: url=${settings.sources.baseUrl}/enabled=${settings.sources.enabled})`);
  if (!settings.enabled) {
    console.log("status: disabled");
    return 0;
  }
  const result = await memorayRequest("/ecosystem/manifest", ctx);
  if (!result.ok) {
    console.log("status: offline");
    reportUnreachable(result);
    return 1;
  }
  const m = result.body || {};
  const claude = m.claude?.sessions || 0;
  const anti = m.antigravity?.sessions || 0;
  console.log("status: online");
  console.log(`nodes: ${m.totalNodes || 0}`);
  console.log(`sessions: ${claude + anti} (claude ${claude}, antigravity ${anti})`);
  console.log(`last sync: ${m.lastSync ? new Date(m.lastSync).toISOString() : "never"}`);
  return 0;
}

async function cmdSync(ctx) {
  const result = await memorayRequest("/sync", ctx);
  if (!result.ok) {
    reportUnreachable(result);
    return 1;
  }
  console.log(result.body?.message || "Sync complete.");
  return 0;
}

async function cmdSessions(ctx, flags) {
  const result = await memorayRequest("/sessions", ctx);
  if (!result.ok) {
    reportUnreachable(result);
    return 1;
  }
  let sessions = Array.isArray(result.body) ? result.body : [];
  if (flags.agent) {
    const wanted = String(flags.agent).toLowerCase();
    sessions = sessions.filter((s) => String(s.agent || "").toLowerCase() === wanted);
  }
  const limit = Number(flags.limit) || 20;
  sessions = sessions.slice(0, limit);
  if (sessions.length === 0) {
    console.log("No sessions.");
    return 0;
  }
  for (const s of sessions) {
    const when = s.timestamp ? new Date(s.timestamp).toISOString().slice(0, 16).replace("T", " ") : "—";
    const project = s.metadata?.project || "—";
    console.log(`${when}  ${(s.agent || "?").padEnd(11)}  ${(s.content || "Untitled").slice(0, 60)}  [${project}]`);
    console.log(`           id: ${s.id}`);
  }
  return 0;
}

async function cmdSearch(ctx, query) {
  if (!query || query.length < 2) {
    console.error("Usage: node space memory search <query> (min 2 chars)");
    return 1;
  }
  const result = await memorayRequest(`/beta/search?q=${encodeURIComponent(query)}`, ctx);
  if (!result.ok) {
    reportUnreachable(result);
    return 1;
  }
  const body = result.body || {};
  const sessions = body.sessions || [];
  const files = body.files || [];
  const actions = body.actions || [];
  console.log(`sessions (${sessions.length}):`);
  for (const s of sessions.slice(0, 10)) console.log(`  ${s.title || "Untitled"}  — ${s.id}`);
  console.log(`files (${files.length}):`);
  for (const f of files.slice(0, 10)) console.log(`  ${f.fileName || f.filePath}`);
  console.log(`actions (${actions.length}):`);
  for (const a of actions.slice(0, 10)) console.log(`  [${a.toolName || a.type}] ${(a.contentSnippet || "").slice(0, 60)}`);
  return 0;
}

async function cmdAudit(ctx) {
  const report = await runIntegrationAudit(ctx);
  for (const integration of report.integrations) {
    console.log(`${integration.id}: ${integration.status.toUpperCase()} (pass ${integration.summary.pass} / drift ${integration.summary.drift} / skipped ${integration.summary.skipped})`);
    for (const finding of integration.findings) {
      if (finding.status !== "pass") {
        const owner = finding.owner?.path
          ? `  -> ${finding.owner.repo}/${finding.owner.path}`
          : "";
        console.log(`  [${finding.status === "drift" ? "DRIFT" : "skip"}] ${finding.check} ${finding.subject}: ${finding.detail}${owner}`);
      }
    }
  }
  console.log(`overall: ${report.status.toUpperCase()}`);
  return report.status === "drift" ? 1 : 0;
}

export async function execute(context) {
  const { positional, flags } = parseFlags(context.args);
  const subcommand = positional[0];

  const runtimeParams = await createRuntimeParams(context.projectRoot);
  const ctx = { runtimeParams, projectRoot: context.projectRoot };

  switch (subcommand) {
    case "status":
      return cmdStatus(ctx);
    case "sync":
      return cmdSync(ctx);
    case "sessions":
      return cmdSessions(ctx, flags);
    case "search":
      return cmdSearch(ctx, positional.slice(1).join(" ").trim());
    case "audit":
      return cmdAudit(ctx);
    default:
      console.error(`Unknown subcommand: ${subcommand || "(none)"}`);
      console.error("Usage: node space memory <status|sync|sessions|search|audit>");
      return 1;
  }
}
