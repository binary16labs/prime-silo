// Rung 1 — LONGVIEW map-primitive bench (window_fragment extraction), REAL path.
//
// The ladder (P4 = rung 0 authoring; this = rung 1). Question the owner posed:
// is a SMALLER model faster for LONGVIEW *and still good enough*? The real baseline
// is the model LONGVIEW actually runs — google/gemma-4-12b (build_v2.sh:
// LONGVIEW_MODEL=lmstudio/google/gemma-4-12b) — NOT a stand-in. Candidate:
// google/gemma-4-e4b.
//
// FIDELITY (the P4 lesson: a hand-rolled prompt gave a misleading result and the real
// instrument flipped it). This drives the SAME code both models see in production:
//   • input   walkSessionWindows()->readTimeline() over the local ~/.mem0ray store,
//   • prompt  scripts/longview/prompts/window_fragment.md verbatim,
//   • call    scripts/longview/lib/llm.mjs chat() — same endpoint, temp, hardening.
// Only the model id changes between subjects.
//
// NON-CIRCULAR QUALITY. The stored gold fragment (w12000_N.json) was produced BY the
// 12B, so "match the gold" would rig the test for the baseline. Instead we score the
// fragment on model-neutral properties the prompt itself demands: schema validity,
// field coverage, and staying within the 0-4-entries bound. Speed/tokens are measured.
//
// Usage:  node rung1_bench.mjs <model-id>   (run once per subject; a driver loads/
//         unloads each model on LM Studio between invocations to respect eGPU VRAM).
// Writes: docs/bench/rung1/results/<safe-model>.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const LV = path.join(REPO, "scripts", "longview", "lib");
const imp = (f) => import(pathToFileURL(path.join(LV, f)).href); // Windows ESM needs file:// URLs

// The bench IS the production path: same libs, same config object (mutable).
const { config } = await imp("config.mjs");
const { walkSessionWindows } = await imp("walk.mjs");
const { chat, repairTruncatedJson } = await imp("llm.mjs");

const SID = process.env.RUNG1_SID || "01fddf5a91be2956e8dfc6f21b54cc55";
const MODEL = process.argv[2];
if (!MODEL) {
  console.error("usage: node rung1_bench.mjs <model-id>  (e.g. google/gemma-4-12b)");
  process.exit(2);
}

// Match production windowing (build_v2.sh: LONGVIEW_WINDOW_CHARS=12000). The bench
// points config at LM Studio + the local store via env before import; assert it took.
const SYSTEM = fs.readFileSync(
  path.join(REPO, "scripts", "longview", "prompts", "window_fragment.md"),
  "utf8"
);
const WINDOW_CHARS = Number(process.env.LONGVIEW_WINDOW_CHARS || 12000);

// The 12-field fragment contract from window_fragment.md. `project` is a string; the
// rest are arrays of 0-4 short strings.
const ARRAY_FIELDS = [
  "decisions", "outcomes", "failures", "capabilities", "applications", "artifacts",
  "concepts", "skills_observed", "operator_traits", "open_threads", "proposed_next", "evidence",
];
const ALL_FIELDS = ["project", ...ARRAY_FIELDS];

function parseFragment(text) {
  // Same recovery the production assembler tolerates: direct parse, else repair.
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return repairTruncatedJson(text);
  }
}

// Non-circular per-window quality. Every sub-score is a property the window_fragment
// prompt itself demands — none of them compares against the 12B's stored output.
function scoreFragment(frag) {
  if (!frag || typeof frag !== "object" || Array.isArray(frag)) {
    return { valid_json: 0, keys_present: 0, within_bounds: 0, coverage: 0, quality: 0 };
  }
  const valid_json = 1;
  // keys_present — did the model return the whole contract?
  const present = ALL_FIELDS.filter((k) => k in frag).length;
  const keys_present = present / ALL_FIELDS.length;
  // within_bounds — every array field is an array of <=4 strings; project is a string.
  // A field that overflows the 0-4 bound or is the wrong type is a schema violation.
  let boundOk = 0, boundTot = 0;
  const projOk = typeof (frag.project ?? "") === "string" ? 1 : 0;
  boundTot += 1; boundOk += projOk;
  for (const k of ARRAY_FIELDS) {
    boundTot += 1;
    const v = frag[k];
    if (Array.isArray(v) && v.length <= 4 && v.every((s) => typeof s === "string")) boundOk += 1;
  }
  const within_bounds = boundOk / boundTot;
  // coverage — fraction of array fields that carry >=1 grounded, non-empty entry
  // (richness: an all-[] fragment is valid but says nothing).
  const covered = ARRAY_FIELDS.filter(
    (k) => Array.isArray(frag[k]) && frag[k].some((s) => typeof s === "string" && s.trim())
  ).length;
  const coverage = covered / ARRAY_FIELDS.length;
  // Composite: schema first (validity+bounds+keys), then richness. Equal-weighted mean.
  const quality = (valid_json + keys_present + within_bounds + coverage) / 4;
  return { valid_json, keys_present, within_bounds, coverage, quality };
}

async function main() {
  // Drive the real path at THIS model. config is the live object llm.mjs reads.
  config.LONGVIEW_MODEL = MODEL;
  console.log(`[rung1] model=${MODEL}`);
  console.log(`[rung1] endpoint=${config.LLM_BASE_URL}`);
  console.log(`[rung1] store=${config.MEMORAY_DATA_DIR}`);
  console.log(`[rung1] sid=${SID} window_chars=${WINDOW_CHARS}`);

  const { windows, stepCount } = walkSessionWindows({ id: SID }, { inputChars: WINDOW_CHARS });
  console.log(`[rung1] reconstructed ${windows.length} window(s) over ${stepCount} steps`);
  if (!windows.length) throw new Error(`no windows for sid ${SID} — is ~/.mem0ray populated?`);

  const perWindow = [];
  const started = Date.now();
  for (const w of windows) {
    const res = await chat({
      system: SYSTEM,
      user: w.text,
      maxTokens: config.FRAGMENT_MAX_TOKENS,
      json: true,
      temperature: 0.2,
    });
    const frag = parseFragment(res.content);
    const score = scoreFragment(frag);
    perWindow.push({
      index: w.index,
      ms: res.ms,
      prompt_tokens: res.prompt_tokens,
      completion_tokens: res.completion_tokens,
      usage_estimated: res.usage_estimated,
      score,
      fragment: frag,
    });
    console.log(
      `[rung1]  window ${w.index}: ${res.ms}ms  q=${score.quality.toFixed(3)}  ` +
        `cov=${score.coverage.toFixed(2)}  tok=${res.prompt_tokens}+${res.completion_tokens}`
    );
  }
  const wall_ms = Date.now() - started;
  const n = perWindow.length;
  const mean = (f) => perWindow.reduce((a, x) => a + f(x), 0) / n;
  const summary = {
    model: MODEL,
    sid: SID,
    window_chars: WINDOW_CHARS,
    windows: n,
    step_count: stepCount,
    wall_seconds: +(wall_ms / 1000).toFixed(4),
    prompt_tokens: perWindow.reduce((a, x) => a + x.prompt_tokens, 0),
    completion_tokens: perWindow.reduce((a, x) => a + x.completion_tokens, 0),
    usage_estimated: perWindow.some((x) => x.usage_estimated),
    quality_score: +mean((x) => x.score.quality).toFixed(4),
    valid_json: +mean((x) => x.score.valid_json).toFixed(4),
    keys_present: +mean((x) => x.score.keys_present).toFixed(4),
    within_bounds: +mean((x) => x.score.within_bounds).toFixed(4),
    coverage: +mean((x) => x.score.coverage).toFixed(4),
    per_window: perWindow,
  };

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const safe = MODEL.replace(/[^a-z0-9]+/gi, "_");
  const outPath = path.join(outDir, `${safe}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(
    `[rung1] DONE ${MODEL}: ${summary.wall_seconds}s  q=${summary.quality_score}  ` +
      `cov=${summary.coverage}  -> ${path.relative(REPO, outPath)}`
  );
}

main().catch((e) => {
  console.error(`[rung1] FAILED: ${e.message}`);
  process.exit(1);
});
