// tokenizer.js — pluggable token counter for the Mem0Ray token audit.
//
// Two tiers, auto-selected so the audit is subscriber-friendly by default:
//
//   offline (default, no API key, zero spend)
//       Uses @anthropic-ai/tokenizer — a real Claude BPE tokenizer that runs
//       entirely locally. This is the legacy (Claude 2-era) tokenizer, so it is
//       an APPROXIMATION for current models (Opus/Sonnet 4.x use a newer
//       tokenizer), but it is a genuine Claude tokenizer and is dramatically
//       more accurate than the v1 `Math.ceil(len/4)` heuristic. Good enough to
//       validate the direction and rough magnitude of the token-save claim
//       without any account, key, or network.
//
//   exact (opt-in, needs ANTHROPIC_API_KEY, still free)
//       Uses POST /v1/messages/count_tokens for the exact, model-specific count.
//       Use this for the authoritative headline number.
//
// Selection:
//   - TOKENIZER=offline | api  forces a mode.
//   - otherwise: api if ANTHROPIC_API_KEY is set, else offline.

export async function makeCounter() {
  const forced = (process.env.TOKENIZER || "").toLowerCase();
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const useApi = forced === "api" || (forced !== "offline" && hasKey);

  if (useApi) {
    if (!hasKey) throw new Error("TOKENIZER=api but ANTHROPIC_API_KEY is not set.");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const model = process.env.MODEL || "claude-opus-4-8";
    const cache = new Map();
    return {
      method: `exact (count_tokens, ${model})`,
      exact: true,
      model,
      async count(text) {
        if (cache.has(text)) return cache.get(text);
        const r = await client.messages.countTokens({
          model,
          messages: [{ role: "user", content: text }]
        });
        cache.set(text, r.input_tokens);
        return r.input_tokens;
      }
    };
  }

  // offline
  const mod = await import("@anthropic-ai/tokenizer");
  const ct = mod.countTokens || mod.default?.countTokens;
  if (typeof ct !== "function") throw new Error("offline tokenizer unavailable");
  return {
    method: "offline-approx (@anthropic-ai/tokenizer, legacy Claude BPE)",
    exact: false,
    model: null,
    async count(text) {
      return ct(text);
    }
  };
}
