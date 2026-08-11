// EP-A agent runtime — the canonical tool-use loop (CLI-first; the UI is a wrapper on runAgent).
//
// Drives the tuned tool-use policy (served as GGUF by LM Studio) in a plan-act loop:
//   render transcript -> model emits next {name,input} call -> execute (role-gated) -> append result
//   -> repeat until `finish`, a step cap, or a stall.
//
// Serving details baked in from the EP-A eval findings:
//   • endpoint defaults to LOCALHOST (never the forbidden LAN host); pass baseUrl to override,
//   • SPLIT system/user roles (not the training folded turn — folded serves empty/rambling),
//   • assistant PREFILL {"name":" so the clone-only policy can't "fail to start" (greedy stall).
// Transcript is rendered in the SAME labelled-node shape the model trained on ([User Input],
// [Tool Call <name>], [Tool Result]) so the served distribution matches training.
import path from "node:path";
import { repairTruncatedJson, lastBalancedJson } from "../longview/lib/llm.mjs";
import { runTool, toolNamesForRole } from "./tools.mjs";

const PREFILL = '{"name":"';

function systemPrompt(role, root) {
  const tools = toolNamesForRole(role).join(", ");
  return (
    "You are a coding + analysis agent operating over a code repository and a knowledge store. " +
    `Role: ${role}. Working directory: ${root} — use paths RELATIVE to it (e.g. "scripts/gates"), ` +
    "not absolute paths from other machines. " +
    `Available tools: ${tools}. ` +
    "Given the task and the transcript so far, decide the single next tool call. " +
    'Respond with ONLY a JSON object {"name": <tool>, "input": {...}} — no prose. ' +
    'When the task is done, call {"name":"finish","input":{"answer": <short answer>}}.'
  );
}

async function chatPrefill({ baseUrl, model, system, user, maxTokens = 200, timeoutMs = 120000 }) {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
      { role: "assistant", content: PREFILL },
    ],
    temperature: 0, max_tokens: maxTokens, stream: false,
  };
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`llm ${res.status} @ ${baseUrl}`);
  const data = await res.json();
  return PREFILL + (data?.choices?.[0]?.message?.content ?? ""); // re-attach the seed
}

function parseCall(text) {
  for (const cand of [text, lastBalancedJson(text), repairTruncatedJson(text)]) {
    if (!cand) continue;
    try {
      const o = typeof cand === "string" ? JSON.parse(cand) : cand;
      if (o && typeof o === "object" && o.name) return o;
    } catch { /* next */ }
  }
  return null;
}

const renderCall = (c) => `[Tool Call ${c.name}] ${JSON.stringify(c.input || {})}`;

/**
 * Run the agent loop. Options:
 *   task      — the goal (string)                         [required]
 *   model     — LM Studio modelKey (default the tuned agent)
 *   role      — "analyst" (read-only) | "developer"       [default analyst]
 *   root      — workspace root the tools are sandboxed to [default cwd]
 *   allowExec — permit shell (developer only)             [default false]
 *   maxSteps  — loop cap                                  [default 12]
 *   baseUrl   — OpenAI-compatible endpoint                [default localhost:1234/v1]
 *   onStep    — callback({ step, call, result }) for streaming UIs
 * Returns { finished, answer, steps, transcript }.
 */
export async function runAgent(opts) {
  const {
    task, model = "gemma-4-e4b-agent", role = "analyst",
    root = process.cwd(), allowExec = false, maxSteps = 12,
    baseUrl = "http://localhost:1234/v1", onStep = null,
  } = opts;
  if (!task) throw new Error("runAgent: task required");

  const ctx = { root: path.resolve(root), role, allowExec };
  const system = systemPrompt(role, ctx.root);
  // GROUND the model: seed the transcript with the real cwd listing so it navigates from reality
  // instead of hallucinating absolute paths it saw in training (clone-only models have no cwd sense).
  const rootListing = runTool({ name: "list_dir", input: { path: "." } }, ctx).result;
  const lines = [
    `[User Input] ${task}`,
    `[Tool Result] working directory ${ctx.root} contains:\n${rootListing}`,
  ];
  const steps = [];
  const seen = new Map(); // repeat-guard: identical call signature -> count
  let finished = false, answer = null;

  for (let step = 1; step <= maxSteps && !finished; step++) {
    let raw;
    try {
      raw = await chatPrefill({ baseUrl, model, system, user: lines.join("\n") });
    } catch (e) {
      steps.push({ step, error: e.message });
      break;
    }
    const call = parseCall(raw);
    if (!call) { // couldn't parse — record and stop rather than spin
      steps.push({ step, error: "unparseable model output", raw: raw.slice(0, 200) });
      break;
    }
    // repeat-guard: a clone-only policy can loop on the same failing call. After 2 identical calls,
    // stop rather than burn steps.
    const sig = `${call.name}:${JSON.stringify(call.input || {})}`;
    seen.set(sig, (seen.get(sig) || 0) + 1);
    if (seen.get(sig) > 2) {
      steps.push({ step, error: "repeat-loop: same call 3x", call: { name: call.name, input: call.input } });
      break;
    }
    const { result, canon, finished: fin } = runTool(call, ctx);
    lines.push(renderCall(call), `[Tool Result] ${result}`);
    const rec = { step, call: { name: canon || call.name, input: call.input || {} }, result };
    steps.push(rec);
    if (onStep) onStep(rec);
    if (fin) { finished = true; answer = result.replace(/^__FINISH__\s*/, ""); }
  }

  return { finished, answer, steps, transcript: lines.join("\n") };
}
