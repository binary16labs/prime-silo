// Shared, FROZEN scoring for the window_fragment map primitive — used by both rung1_bench.mjs and
// rung2_bench.mjs so the two rungs score identically (no drift). NON-CIRCULAR: every sub-score is a
// property the window_fragment prompt itself demands (schema validity, coverage, within-0-4 bounds).
// It NEVER compares against the 12B's stored gold card — the gold WAS produced by the 12B, so a
// gold-match metric would rig the test for the baseline.

// The 12-field fragment contract from scripts/longview/prompts/window_fragment.md.
// `project` is a string; the rest are arrays of 0-4 short strings.
export const ARRAY_FIELDS = [
  "decisions", "outcomes", "failures", "capabilities", "applications", "artifacts",
  "concepts", "skills_observed", "operator_traits", "open_threads", "proposed_next", "evidence",
];
export const ALL_FIELDS = ["project", ...ARRAY_FIELDS];

// Parse the model reply into a fragment object, tolerating the same early-stop truncation the
// production assembler tolerates. `repair` is llm.mjs's repairTruncatedJson, injected to avoid a
// second import of the LLM module here.
export function parseFragment(text, repair) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return repair ? repair(text) : null;
  }
}

export function scoreFragment(frag) {
  if (!frag || typeof frag !== "object" || Array.isArray(frag)) {
    return { valid_json: 0, keys_present: 0, within_bounds: 0, coverage: 0, quality: 0 };
  }
  const valid_json = 1;
  const present = ALL_FIELDS.filter((k) => k in frag).length;
  const keys_present = present / ALL_FIELDS.length;
  let boundOk = 0, boundTot = 0;
  boundTot += 1; boundOk += typeof (frag.project ?? "") === "string" ? 1 : 0;
  for (const k of ARRAY_FIELDS) {
    boundTot += 1;
    const v = frag[k];
    if (Array.isArray(v) && v.length <= 4 && v.every((s) => typeof s === "string")) boundOk += 1;
  }
  const within_bounds = boundOk / boundTot;
  const covered = ARRAY_FIELDS.filter(
    (k) => Array.isArray(frag[k]) && frag[k].some((s) => typeof s === "string" && s.trim())
  ).length;
  const coverage = covered / ARRAY_FIELDS.length;
  const quality = (valid_json + keys_present + within_bounds + coverage) / 4;
  return { valid_json, keys_present, within_bounds, coverage, quality };
}
