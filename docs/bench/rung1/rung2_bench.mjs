// Rung 2 — widen Rung 1 across a real spread of cards. Same REAL window_fragment path, same frozen
// non-circular scoring (lib/fragment_score.mjs), but over a SAMPLE of sids (docs/bench/rung1/
// sample-rung2.json) instead of one — to test whether the E4B-beats-12B result HOLDS beyond n=1.
//
// One model is loaded on LM Studio; this runs the whole sample for it in a single invocation (a
// driver loads/unloads each model between the two invocations to respect eGPU VRAM).
//
// Usage:  node rung2_bench.mjs <model-id>
// Writes: docs/bench/rung1/results/<safe-model>__rung2.json   (git-ignored — carries session text)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const LV = path.join(REPO, "scripts", "longview", "lib");
const imp = (f) => import(pathToFileURL(path.join(LV, f)).href);

const { config } = await imp("config.mjs");
const { walkSessionWindows } = await imp("walk.mjs");
const { chat, repairTruncatedJson } = await imp("llm.mjs");
const { scoreFragment, parseFragment } = await import(
  pathToFileURL(path.join(__dirname, "lib", "fragment_score.mjs")).href
);

const MODEL = process.argv[2];
if (!MODEL) {
  console.error("usage: node rung2_bench.mjs <model-id>");
  process.exit(2);
}
const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "sample-rung2.json"), "utf8")
);
const SYSTEM = fs.readFileSync(
  path.join(REPO, "scripts", "longview", "prompts", "window_fragment.md"), "utf8"
);
const WINDOW_CHARS = Number(process.env.LONGVIEW_WINDOW_CHARS || 12000);

async function benchOneSid(sid) {
  const { windows, stepCount } = walkSessionWindows({ id: sid }, { inputChars: WINDOW_CHARS });
  if (!windows.length) throw new Error(`no windows for sid ${sid}`);
  const perWindow = [];
  const started = Date.now();
  for (const w of windows) {
    const res = await chat({
      system: SYSTEM, user: w.text, maxTokens: config.FRAGMENT_MAX_TOKENS, json: true, temperature: 0.2,
    });
    const frag = parseFragment(res.content, repairTruncatedJson);
    const score = scoreFragment(frag);
    perWindow.push({
      index: w.index, ms: res.ms,
      prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
      usage_estimated: res.usage_estimated, score, fragment: frag,
    });
  }
  const wall_ms = Date.now() - started;
  const n = perWindow.length;
  const mean = (f) => perWindow.reduce((a, x) => a + f(x), 0) / n;
  return {
    sid, windows: n, step_count: stepCount,
    wall_seconds: +(wall_ms / 1000).toFixed(4),
    prompt_tokens: perWindow.reduce((a, x) => a + x.prompt_tokens, 0),
    completion_tokens: perWindow.reduce((a, x) => a + x.completion_tokens, 0),
    quality_score: +mean((x) => x.score.quality).toFixed(4),
    valid_json: +mean((x) => x.score.valid_json).toFixed(4),
    keys_present: +mean((x) => x.score.keys_present).toFixed(4),
    within_bounds: +mean((x) => x.score.within_bounds).toFixed(4),
    coverage: +mean((x) => x.score.coverage).toFixed(4),
    per_window: perWindow,
  };
}

async function main() {
  config.LONGVIEW_MODEL = MODEL;
  console.log(`[rung2] model=${MODEL} endpoint=${config.LLM_BASE_URL} sids=${SAMPLE.sids.length}`);
  const perSid = [];
  for (const sid of SAMPLE.sids) {
    const r = await benchOneSid(sid);
    perSid.push(r);
    console.log(`[rung2]  ${sid}: ${r.windows}win ${r.wall_seconds}s q=${r.quality_score} cov=${r.coverage}`);
  }
  const n = perSid.length;
  const meanCard = (f) => +(perSid.reduce((a, x) => a + f(x), 0) / n).toFixed(4);
  const summary = {
    model: MODEL, sample: "sample-rung2.json", n_cards: n,
    window_chars: WINDOW_CHARS,
    total_windows: perSid.reduce((a, x) => a + x.windows, 0),
    // Per-CARD means — the unit the ladder ranks on (a card is one LONGVIEW artifact).
    wall_seconds: meanCard((x) => x.wall_seconds),      // mean wall per card
    total_wall_seconds: +perSid.reduce((a, x) => a + x.wall_seconds, 0).toFixed(4),
    quality_score: meanCard((x) => x.quality_score),
    valid_json: meanCard((x) => x.valid_json),
    keys_present: meanCard((x) => x.keys_present),
    within_bounds: meanCard((x) => x.within_bounds),
    coverage: meanCard((x) => x.coverage),
    prompt_tokens: perSid.reduce((a, x) => a + x.prompt_tokens, 0),
    completion_tokens: perSid.reduce((a, x) => a + x.completion_tokens, 0),
    per_sid: perSid,
  };
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const safe = MODEL.replace(/[^a-z0-9]+/gi, "_");
  const outPath = path.join(outDir, `${safe}__rung2.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(
    `[rung2] DONE ${MODEL}: ${n} cards, mean ${summary.wall_seconds}s/card, total ` +
      `${summary.total_wall_seconds}s, mean q=${summary.quality_score} cov=${summary.coverage} -> ` +
      path.relative(REPO, outPath)
  );
}

main().catch((e) => { console.error(`[rung2] FAILED: ${e.message}`); process.exit(1); });
