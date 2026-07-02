// Lemonade client. Same host benny/core/models.py routes to; OpenAI-compatible.
// Verbose output is absorbed here — callers get parsed content + honest usage.
import { config } from "./config.mjs";

export async function chat({ system, user, maxTokens, json = false, temperature = 0.2 }) {
  const started = Date.now();
  const body = {
    model: config.LONGVIEW_MODEL,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user }
    ],
    max_tokens: maxTokens,
    temperature,
    // qwen3.5-9b-FLM emits clean output, but keep the ADR-004 hardening anyway.
    enable_thinking: false,
    ...(json ? { response_format: { type: "json_object" } } : {})
  };
  const res = await fetch(`${config.LEMONADE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`lemonade ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage || null;
  return {
    content,
    ms: Date.now() - started,
    // Honesty: mark estimates as estimates when the server omits usage.
    prompt_tokens: usage?.prompt_tokens ?? Math.ceil((system || "").length / 4 + user.length / 4),
    completion_tokens: usage?.completion_tokens ?? Math.ceil(content.length / 4),
    usage_estimated: !usage
  };
}

// Parse the LAST balanced JSON object in a string (survives leading prose /
// <think> blocks — the run_judge trick from ADR-004 §5).
export function lastBalancedJson(text) {
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "}") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
