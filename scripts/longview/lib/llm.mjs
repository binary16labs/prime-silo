// Lemonade client. Same host benny/core/models.py routes to; OpenAI-compatible.
// Verbose output is absorbed here — callers get parsed content + honest usage.
import { config } from "./config.mjs";

export async function chat({ system, user, maxTokens, json = false, temperature = 0.2 }) {
  const started = Date.now();
  // Strip ONLY the leading provider segment (lmstudio/…, lemonade/…) — it selects
  // the endpoint, already resolved into config.LLM_BASE_URL. The rest is the id the
  // endpoint keys on and may itself contain a slash (LM Studio serves org/model
  // ids like "google/gemma-4-12b"), so a naive split("/").pop() would break them.
  const modelId = String(config.LONGVIEW_MODEL).replace(
    /^(lmstudio|lemonade|ollama|fastflowlm)\//,
    ""
  );
  const body = {
    model: modelId,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user }
    ],
    max_tokens: maxTokens,
    temperature,
    // qwen3.5-9b-FLM emits clean output, but keep the ADR-004 hardening anyway.
    enable_thinking: false,
    // JSON-extraction calls: response_format is provider-sensitive (LM Studio
    // 400s on json_object). config.JSON_MODE picks a compatible type; the caller's
    // parser recovers the object from the text regardless. "off" omits it entirely.
    ...(json && config.JSON_MODE !== "off"
      ? { response_format: { type: config.JSON_MODE } }
      : {})
  };
  const res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llm ${res.status} @ ${config.LLM_BASE_URL}: ${text.slice(0, 300)}`);
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

// Best-effort repair of JSON cut off by an early stop (seen live: qwen3.5 in
// JSON mode ends generation mid-object at ~300 tokens regardless of budget).
// Cut back to the last point where a value had just completed (a '}' or ']'),
// verify string/nesting state up to the cut, close the open containers, parse.
// Tried from the longest cut backwards so we keep as much as possible.
export function repairTruncatedJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const body = text.slice(start);
  const cuts = [];
  for (let i = 0; i < body.length; i++) if (body[i] === "}" || body[i] === "]") cuts.push(i);
  for (let c = cuts.length - 1; c >= 0; c--) {
    const slice = body.slice(0, cuts[c] + 1);
    const stack = [];
    let inString = false,
      escaped = false,
      broken = false;
    for (const ch of slice) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack.pop() !== ch) {
          broken = true;
          break;
        }
      }
    }
    if (broken || inString) continue;
    try {
      return JSON.parse(slice + stack.reverse().join(""));
    } catch {
      /* try an earlier cut */
    }
  }
  return null;
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
