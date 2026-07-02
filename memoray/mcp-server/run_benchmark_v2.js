// run_benchmark_v2.js
//
// Honest token-audit harness for the Mem0Ray token-save claim.
//
// What changed vs run_benchmark.js (v1) and WHY:
//   1. Real tokenizer. v1 used Math.ceil(str.length / 4) — a character heuristic,
//      not Claude's tokenizer. v2 calls Anthropic's POST /v1/messages/count_tokens
//      (free, exact, model-specific) for every payload.
//   2. No injected constants. v1 added arbitrary overhead to the "no-MCP" arm
//      (+500/+1500/+2000/+3000/+4000) and only +100 to the MCP arm — those
//      fudge factors manufactured most of the "savings". v2 counts ONLY the real
//      retrieved payload each arm puts into context. The prompt/instruction is
//      identical across arms, so it cancels and is excluded.
//   3. Honest output. v1 hardcoded output tokens (150/450/... vs 30/50/...).
//      v2 makes NO model call, so it measures input tokens only and reports
//      output as null. The claim under test ("Token Tax" = re-ingesting raw
//      history) is an INPUT-token claim; that is what we measure.
//   4. Honest reporting. Per-scenario deltas are reported as-is, including the
//      cases where MCP does NOT help (e.g. full-timeline reconstruction). Each
//      scenario carries a `baseline` flag marking whether the no-MCP arm is a
//      fair baseline or a worst-case strawman (full recursive disk load).
//   5. Multi-target. Where a scenario depends on a session/project, it runs
//      across several and aggregates, instead of a single N=1 run.
//
// Requires: ANTHROPIC_API_KEY in the environment, and @anthropic-ai/sdk installed.
// Spend: count_tokens is free. No messages.create calls are made.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeCounter } from "./tokenizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "agent-os-dashboard", "server", "data");
const ENTITIES_DIR = path.join(DATA_DIR, "entities");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

const NUM_TARGETS = Number(process.env.NUM_TARGETS || 3); // sessions to sample for per-session scenarios

// Pluggable counter: offline (no key) by default, exact count_tokens API when
// ANTHROPIC_API_KEY is set. Assigned in main().
let counter;
const countTokens = (text) => counter.count(text);

// --- raw "no-MCP" file reads (faithful to what an agent does without the tool) ---
async function readIndex() {
  return fs.readFile(INDEX_PATH, "utf-8");
}
async function readEntity(id) {
  try {
    return await fs.readFile(path.join(ENTITIES_DIR, `${id}.json`), "utf-8");
  } catch {
    return "";
  }
}
async function readEntityTree(rootId) {
  // BFS over children_ids — this is the FULL raw history an agent would load
  // if it had to reconstruct a timeline from disk with no tool.
  const rootData = await readEntity(rootId);
  let payload = rootData;
  let count = 0;
  let root;
  try {
    root = JSON.parse(rootData);
  } catch {
    root = {};
  }
  const queue = [...(root.children_ids || [])];
  while (queue.length) {
    const childId = queue.shift();
    const childData = await readEntity(childId);
    if (!childData) continue;
    payload += childData;
    count++;
    try {
      const child = JSON.parse(childData);
      if (child.children_ids) queue.push(...child.children_ids);
    } catch {
      /* skip unparseable */
    }
  }
  return { payload, count };
}

async function sortedSessionIds() {
  const index = JSON.parse(await readIndex());
  const ids = index.sessions || [];
  const sessions = [];
  for (const id of ids) {
    const data = await readEntity(id);
    if (!data) continue;
    try {
      const s = JSON.parse(data);
      sessions.push({ id: s.id || s.sessionId || id, ts: s.timestamp || 0 });
    } catch {
      /* skip */
    }
  }
  sessions.sort((a, b) => b.ts - a.ts);
  return sessions.map((s) => s.id);
}

const mcpText = (resp) => resp?.content?.[0]?.text ?? "";

// Build one comparable scenario record from two already-counted payloads.
function record(id, name, baseline, note, noMcpTokens, mcpTokens, extra = {}) {
  const delta = noMcpTokens - mcpTokens;
  const pct = noMcpTokens > 0 ? (delta / noMcpTokens) * 100 : 0;
  return {
    testId: id,
    name,
    baseline, // "fair" | "worst-case" — is the no-MCP arm a reasonable agent behaviour?
    note,
    noMcp: { inputTokens: noMcpTokens, outputTokens: null },
    mcp: { inputTokens: mcpTokens, outputTokens: null },
    savings: { inputTokens: delta, inputPercent: Number(pct.toFixed(2)) },
    mcpWins: delta > 0,
    ...extra
  };
}

async function main() {
  counter = await makeCounter();

  const transport = new StdioClientTransport({ command: "node", args: ["index.js"] });
  const client = new Client({ name: "benchmark-v2", version: "2.0.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log(`Honest token audit — counter: ${counter.method}`);

  const sessionIds = await sortedSessionIds();
  const targets = sessionIds.slice(0, NUM_TARGETS);
  const indexData = await readIndex();
  const scenarios = [];

  // Scenario 1 — Get latest session. FAIR baseline: read index + one entity.
  for (const targetId of targets) {
    const entity = await readEntity(targetId);
    const noMcp = await countTokens(indexData + entity);
    const mcp = await countTokens(
      mcpText(
        await client.callTool({
          name: "get_recent_sessions",
          arguments: { limit: 1 }
        })
      )
    );
    scenarios.push(
      record(
        1,
        "Get Latest Session",
        "fair",
        "Reasonable agent reads the index + one session entity; MCP returns one structured summary.",
        noMcp,
        mcp,
        { target: targetId }
      )
    );
  }

  // Scenario 2 — Reconstruct full timeline. FAIR-but-equal: both arms need the
  // whole history, so MCP should NOT save much. Reported honestly either way.
  for (const targetId of targets) {
    const { payload } = await readEntityTree(targetId);
    const noMcp = await countTokens(indexData + payload);
    const mcp = await countTokens(
      mcpText(
        await client.callTool({
          name: "get_session_timeline",
          arguments: { sessionId: targetId }
        })
      )
    );
    scenarios.push(
      record(
        2,
        "Reconstruct Session Timeline",
        "fair",
        "Both arms need the entire timeline. This is the control case where the MCP layer cannot compress — watch for ~0 or negative savings.",
        noMcp,
        mcp,
        { target: targetId }
      )
    );
  }

  // Scenario 3 — Query sessions by project. WORST-CASE baseline: the no-MCP arm
  // scans every entity (a real agent with grep would not). Flagged as such.
  {
    const index = JSON.parse(indexData);
    let payload = indexData;
    for (const id of index.sessions || []) payload += await readEntity(id);
    const noMcp = await countTokens(payload);
    const mcp = await countTokens(
      mcpText(
        await client.callTool({
          name: "get_project_activity",
          arguments: { projectPath: "benny", limit: 5 }
        })
      )
    );
    scenarios.push(
      record(
        3,
        "Query Sessions by Project",
        "worst-case",
        "No-MCP arm loads every session entity to filter by project — a strawman; a real agent would grep. Treat the headline number with caution.",
        noMcp,
        mcp
      )
    );
  }

  // Scenario 4 — Sliding window (last 50 events). FAIR: window is a genuine
  // value-add — the tool returns a bounded slice the agent would otherwise
  // have to load whole and trim.
  for (const targetId of targets) {
    const { payload } = await readEntityTree(targetId);
    const noMcp = await countTokens(indexData + payload);
    const mcp = await countTokens(
      mcpText(
        await client.callTool({
          name: "get_session_timeline_window",
          arguments: { sessionId: targetId, limit: 50, offset: 0 }
        })
      )
    );
    scenarios.push(
      record(
        4,
        "Sliding Window Timeline (last 50)",
        "fair",
        "No-MCP arm must load the full tree to slice the tail; MCP returns exactly the window.",
        noMcp,
        mcp,
        { target: targetId }
      )
    );
  }

  // --- aggregate by scenario name (mean across targets) ---
  const byName = {};
  for (const s of scenarios) {
    (byName[s.name] ||= []).push(s);
  }
  const summary = Object.entries(byName).map(([name, rows]) => {
    const mean = (key, sub) => rows.reduce((a, r) => a + r[sub][key], 0) / rows.length;
    const noMcp = Math.round(mean("inputTokens", "noMcp"));
    const mcp = Math.round(mean("inputTokens", "mcp"));
    const delta = noMcp - mcp;
    return {
      name,
      baseline: rows[0].baseline,
      runs: rows.length,
      noMcpInputTokens: noMcp,
      mcpInputTokens: mcp,
      savingsInputTokens: delta,
      savingsPercent: noMcp > 0 ? Number(((delta / noMcp) * 100).toFixed(2)) : 0,
      mcpWins: delta > 0
    };
  });

  // Headline: only aggregate over scenarios with a FAIR baseline. Strawman
  // scenarios are reported but excluded from the claim so it can't be inflated.
  const fair = summary.filter((s) => s.baseline === "fair");
  const headline = {
    counter: counter.method,
    fairScenarioCount: fair.length,
    totalNoMcpInputTokens: fair.reduce((a, s) => a + s.noMcpInputTokens, 0),
    totalMcpInputTokens: fair.reduce((a, s) => a + s.mcpInputTokens, 0)
  };
  headline.savingsInputTokens = headline.totalNoMcpInputTokens - headline.totalMcpInputTokens;
  headline.savingsPercent =
    headline.totalNoMcpInputTokens > 0
      ? Number(((headline.savingsInputTokens / headline.totalNoMcpInputTokens) * 100).toFixed(2))
      : 0;

  const out = {
    schema: "mem0ray.token-audit/v2",
    generatedAt: new Date().toISOString(),
    methodology: {
      counter: counter.method,
      exact: counter.exact,
      offlineCaveat: counter.exact
        ? null
        : "Counts from a legacy Claude BPE tokenizer running locally (no key/spend). Approximate for current models; re-run with ANTHROPIC_API_KEY for exact count_tokens numbers.",
      outputTokens:
        "not measured — no model call is made; this audit measures input/context tokens only",
      headlineExcludes:
        "worst-case (strawman) baselines are reported but excluded from the headline savings",
      injectedConstants: "none — v1 additive overhead removed"
    },
    headline,
    summary,
    scenarios
  };

  const json = JSON.stringify(out, null, 2);
  // 1. Canonical JSON (machine-readable, for CI / external consumers).
  const outPath = path.join(__dirname, "..", "dist", "token_audit_v2.json");
  await fs.writeFile(outPath, json);
  // 2. window-global shim — the /review page loads this (works on file:// and
  //    GitHub Pages, mirroring the existing mcp_benchmark_results.js pattern).
  //    Written to scratch/ (build source) and dist/ (for local preview).
  const shim = `window.tokenAuditData = ${json};`;
  const scratchDir = path.join(__dirname, "..", "scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.writeFile(path.join(scratchDir, "token_audit_v2.js"), shim);
  await fs.writeFile(path.join(__dirname, "..", "dist", "token_audit_v2.js"), shim);
  console.log(
    `\nHeadline (fair scenarios only): ${headline.savingsPercent}% input-token reduction`
  );
  for (const s of summary) {
    console.log(
      `  [${s.baseline.padEnd(10)}] ${s.name}: ${s.savingsPercent}% ${s.mcpWins ? "" : "(MCP does NOT win)"}`
    );
  }
  console.log(`\nWritten: ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
