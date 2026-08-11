#!/usr/bin/env node
// EP-A agent CLI — the canonical entry to the runtime loop. The Bridge/onscreen UI is a wrapper on
// this (spawn it, or import runAgent from runtime.mjs and reuse the SAME loop) — never a second harness.
//
// Usage:
//   node scripts/agent/cli.mjs "your task" [--role analyst|developer] [--exec] [--model <id>]
//                                          [--root <dir>] [--steps N] [--json]
// Examples:
//   node scripts/agent/cli.mjs "find where LONGVIEW resolves the map model" --role analyst
//   node scripts/agent/cli.mjs "list the gate scripts and read c0.mjs" --root .
import { runAgent } from "./runtime.mjs";

function parseArgs(argv) {
  const a = { role: "analyst", allowExec: false, maxSteps: 12, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--role") a.role = argv[++i];
    else if (t === "--exec") a.allowExec = true;
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--root") a.root = argv[++i];
    else if (t === "--steps") a.maxSteps = Number(argv[++i]) || 12;
    else if (t === "--base-url") a.baseUrl = argv[++i];
    else if (t === "--json") a.json = true;
    else rest.push(t);
  }
  a.task = rest.join(" ");
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('usage: node scripts/agent/cli.mjs "task" [--role analyst|developer] [--exec] [--model id] [--root dir] [--steps N] [--json]');
    process.exit(2);
  }
  const emit = args.json ? null : (r) => {
    const arg = JSON.stringify(r.call.input);
    console.log(`\n  ▸ step ${r.step}: ${r.call.name} ${arg.length > 120 ? arg.slice(0, 120) + "…" : arg}`);
    console.log("    " + String(r.result).split("\n").slice(0, 8).join("\n    "));
  };
  if (!args.json) console.log(`\n■ task: ${args.task}\n■ role: ${args.role}${args.allowExec ? " (exec)" : ""}  model: ${args.model || "gemma-4-e4b-agent"}`);

  const out = await runAgent({ ...args, onStep: emit });

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\n${"─".repeat(50)}`);
    console.log(out.finished ? `✓ finished in ${out.steps.length} steps` : `⚠ stopped after ${out.steps.length} steps (no finish)`);
    if (out.answer) console.log(`\nanswer: ${out.answer}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("agent error:", e.message); process.exit(1); });
