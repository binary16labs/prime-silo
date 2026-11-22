// Preflight: every model a planned phase will use must be PINNED, not defaulted.
//
// Why (2026-11-22): a re-run from a worktree with no .env printed
//   "proven agent : qwen3.5-9b-FLM (env-pinned: LONGVIEW_MODEL)"
// although nothing was pinned: config fell through to the code default, and
// benny (no BENNY_DEFAULT_MODEL) fell back to "the first catalog entry"
// (ollama/dolphin-llama3:8b). A run like that silently swaps the proven agent —
// the same class of fault as a phase printing ✓ on failure. The label must say
// where the value came from, and an unpinned model stops the run before it starts.

// Phases whose generation model is LONGVIEW_MODEL (the proven agent).
export const AGENT_PHASES = ["map", "reduce", "opus"];
// Phases that shell into benny, which picks its chat model from BENNY_DEFAULT_MODEL.
export const BENNY_PHASES = ["model", "code", "enrich", "sad"];

// planIds: phase ids in the plan. source(key) → "env" | "host profile" | ".env" | null.
// Pure, so the tests drive it with fakes.
export function checkModelPins(planIds, source) {
  const uses = (ids) => planIds.some((id) => ids.includes(id));
  const want = [];
  if (uses(AGENT_PHASES)) want.push(["LONGVIEW_MODEL", "the proven agent (map/reduce/opus)"]);
  if (planIds.includes("model")) want.push(["LONGVIEW_INGEST_MODEL", "the ingest model (model)"]);
  if (uses(BENNY_PHASES)) want.push(["BENNY_DEFAULT_MODEL", "benny's chat model (model/code/enrich/sad)"]);
  const pins = want.map(([key, role]) => ({ key, role, from: source(key) }));
  const problems = pins
    .filter((p) => !p.from)
    .map((p) => `${p.key} is not set — ${p.role} would fall back to a code default`);
  return { ok: problems.length === 0, pins, problems };
}

// "pinned: LONGVIEW_MODEL via .env" | "⚠ NOT PINNED — code default"
export const pinLabel = (key, from) => (from ? `pinned: ${key} via ${from}` : "⚠ NOT PINNED — code default");
