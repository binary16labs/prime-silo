// Lemonade client. Same host benny/core/models.py routes to; OpenAI-compatible.
// Verbose output is absorbed here — callers get parsed content + honest usage.
import { config } from "./config.mjs";

// TRANSIENT ≠ TERMINAL. A single TCP blip used to kill a whole phase: on 2026-08-02 the
// V2 book build died with "fetch failed" during section planning, ~15 min in, on a host
// that probed perfectly healthy moments later. One retry would have saved the run.
//
// What is retried, and what is deliberately NOT:
//   RETRY   transport faults (fetch failed / ECONNRESET / ECONNREFUSED / EPIPE / socket
//           hang up) and 429 / 5xx — the request never reached a model, or the server
//           asked us to come back.
//   NEVER   4xx. That includes the LM Studio ENGINE WEDGE, which surfaces as a 400
//           ("Engine protocol predict request failed"). The doctrine is halt-and-reload,
//           not retry — hammering a wedged eGPU is how the 2026-07-09 loop happened.
//   NEVER   timeouts (AbortError). Exceeding LLM_TIMEOUT_MS means the window is too big
//           for the budget; a retry just pays the same cost twice and re-times out.
//
// Retries are strictly SEQUENTIAL with a backoff — never overlap requests on this host,
// one concurrent call is what wedges RDNA4/ROCm.
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);

/** STATUS BEATS TEXT — always. An HTTP response means the request REACHED the server, so
 *  the status code alone decides; the body must never be consulted. Learned from this
 *  function's own negative control: the LM Studio engine wedge returns 400 with the body
 *  "Engine protocol predict request failed: fetch failed", and a message-matching
 *  classifier duly retried it 3 times — hammering a wedged eGPU, the one thing the
 *  halt-don't-retry doctrine exists to prevent. Text matching is for status-LESS errors
 *  only, where no response ever arrived. */
function isRetryable(err) {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return false; // timeout: not transient
  if (typeof err?.httpStatus === "number")
    return err.httpStatus === 429 || (err.httpStatus >= 500 && err.httpStatus < 600);
  const code = err?.cause?.code || err?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return /fetch failed|socket hang up|network|ECONNRESET|terminated/i.test(String(err?.message || ""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chat(opts) {
  const attempts = Math.max(1, Number(process.env.LONGVIEW_LLM_RETRIES ?? 3));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chatOnce(opts);
    } catch (e) {
      if (!isRetryable(e) || i === attempts - 1) throw e;
      lastErr = e;
      const backoff = 2000 * 2 ** i; // 2s, 4s, 8s — sequential, never concurrent
      console.log(`[llm] transient (${e.message.slice(0, 80)}) — retry ${i + 1}/${attempts - 1} in ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function chatOnce({ system, user, maxTokens, json = false, temperature = 0.2 }) {
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
    // gemma-4-12b ignores enable_thinking; LM Studio honors reasoning_effort:"none"
    // to skip the ~78%-of-tokens reasoning preamble on extraction calls. Env-gated
    // (LONGVIEW_REASONING_EFFORT) so it's omitted for providers that would reject it.
    ...(config.REASONING_EFFORT ? { reasoning_effort: config.REASONING_EFFORT } : {}),
    // JSON-extraction calls: response_format is provider-sensitive (LM Studio
    // 400s on json_object). config.JSON_MODE picks a compatible type; the caller's
    // parser recovers the object from the text regardless. "off" omits it entirely.
    ...(json && config.JSON_MODE !== "off" ? { response_format: { type: config.JSON_MODE } } : {})
  };
  const res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`llm ${res.status} @ ${config.LLM_BASE_URL}: ${text.slice(0, 300)}`);
    err.httpStatus = res.status; // lets the retry wrapper distinguish 5xx/429 from a wedge (400)
    throw err;
  }
  const data = await res.json();
  // LM Studio's reasoning parser can divert the ENTIRE reply into
  // reasoning_content leaving content empty (observed 2026-07-14 after a host
  // restart — weave wrote 0-byte notes). reasoning_effort:"none" is the real
  // fix; this fallback keeps a run degraded-but-alive if the pin is missing.
  const msg = data.choices?.[0]?.message ?? {};
  const content = msg.content || msg.reasoning_content || "";
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
