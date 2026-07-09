// LONGVIEW configuration (ADR-005). Same .env conventions as offload-runner.mjs.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(__dirname, "..", "..", "..");
const require = createRequire(import.meta.url);

function loadDotEnv() {
  const envPath = path.join(projectRoot, ".env");
  const cfg = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) {
        const i = t.indexOf("=");
        if (i > 0)
          cfg[t.slice(0, i).trim()] = t
            .slice(i + 1)
            .trim()
            .replace(/^['"]|['"]$/g, "");
      }
    }
  }
  return cfg;
}

const dotenv = loadDotEnv();
const env = (k, fallback) => process.env[k] || dotenv[k] || fallback;

// Resolved env value (process.env → .env), "" when unset. Exported so callers
// (runManifest's manifest-vs-env precedence) see .env-only overrides too, not
// just exported process.env vars.
export const envValue = (key) => env(key, "");

// Resolve $BENNY_HOME exactly like the running runtime does (env override →
// desktop config → per-user default), via the canonical Node mirror of
// benny/portable/home.py. Phase D ingests through the runtime's API, so the
// workspace MUST live under the runtime's home, not a repo-relative one.
let bennyHome;
try {
  const { resolveHome } = require(
    path.join(projectRoot, "packaging", "desktop", "home_resolver.js")
  );
  bennyHome = resolveHome({ env: { ...dotenv, ...process.env } }).bennyHome;
} catch {
  bennyHome = env("BENNY_HOME", ".benny_home");
}
if (!path.isAbsolute(bennyHome)) bennyHome = path.resolve(projectRoot, bennyHome);

export const config = {
  BENNY_HOME: bennyHome,
  WORKSPACE: env("LONGVIEW_WORKSPACE", "longview"),

  // memo-ray entity store (the ADR-005 seam). Fallback chain so the runner
  // works both from a dev checkout (sibling standalone memo-ray) and from the
  // packaged app (vendored memoray builds its store under ~/.mem0ray).
  MEMORAY_DATA_DIR:
    env("MEMORAY_DATA_DIR", "") ||
    [
      path.resolve(projectRoot, "..", "memo-ray", "agent-os-dashboard", "server", "data"),
      path.join(os.homedir(), ".mem0ray", "data"),
      path.resolve(projectRoot, "memoray", "server", "data")
    ].find((p) => fs.existsSync(path.join(p, "index.json"))) ||
    path.resolve(projectRoot, "..", "memo-ray", "agent-os-dashboard", "server", "data"),
  MEMORAY_SERVER_DIR: env(
    "MEMORAY_SERVER_DIR",
    path.resolve(projectRoot, "..", "memo-ray", "agent-os-dashboard", "server")
  ),
  MEMORAY_SERVER_URL: env("MEMORAY_SERVER_URL", "http://127.0.0.1:3030"),
  // Claude Code session logs for the direct-parser fallback. Defaults to the
  // standard location so the fallback is never blind (memo-ray's own
  // CLAUDE_LOG_DIRS can be undefined); overridable via MEM0RAY_CLAUDE_DIRS.
  CLAUDE_DIRS: env("MEM0RAY_CLAUDE_DIRS", path.join(os.homedir(), ".claude", "projects")),

  // Local model host (same one benny/core/models.py resolves to).
  LEMONADE_BASE_URL: env("LEMONADE_BASE_URL", "http://127.0.0.1:13305/api/v1"),
  // OpenAI-compatible base URL the node runner posts completions to. Priority:
  // explicit LONGVIEW_LLM_BASE_URL → the active lmstudio pool (first endpoint of
  // BENNY_LMSTUDIO_ENDPOINTS) → lemonade default. Keeps map/weave/reduce/opus on
  // the SAME provider profile as ingest (benny/core/models.py) instead of a
  // hardwired host, so a repoint (or an eval sweep) moves every phase together.
  LLM_BASE_URL:
    env("LONGVIEW_LLM_BASE_URL", "") ||
    env("BENNY_LMSTUDIO_ENDPOINTS", "").split(",")[0].trim().replace(/\/+$/, "") ||
    env("LEMONADE_BASE_URL", "http://127.0.0.1:13305/api/v1"),
  // Map/synthesis model. Priority: LONGVIEW_MODEL → BENNY_DEFAULT_MODEL profile →
  // manifest default (applied in runManifest) → literal. Dynamic so provider/model
  // profiles and eval sweeps swap it without editing the manifest.
  LONGVIEW_MODEL: env("LONGVIEW_MODEL", "") || env("BENNY_DEFAULT_MODEL", "") || "qwen3.5-9b-FLM",
  // response_format.type for JSON-extraction calls. LM Studio rejects
  // "json_object" (accepts only "json_schema"|"text") and the fragment parser
  // (lastBalancedJson/repairTruncatedJson) already recovers JSON from free text
  // and <think> preambles — so default to the portable "text". Set
  // LONGVIEW_JSON_MODE=json_object for providers (lemonade) that require it.
  JSON_MODE: env("LONGVIEW_JSON_MODE", "text"),

  // Reasoning models (gemma-4-12b) burn ~78% of each call on a reasoning preamble
  // that adds nothing to a structured-extraction task. LM Studio honors
  // `reasoning_effort:"none"` per request (verified 2026-07-09: reasoning_tokens
  // 640→0, JSON still valid, ~4× faster). Empty = omit the field (safe for
  // providers/models that would reject it — LM Studio ignores unknown values).
  REASONING_EFFORT: env("LONGVIEW_REASONING_EFFORT", ""),

  // Benny runtime API (Phase D ingestion, workspace paths).
  BENNY_API_BASE: `http://${env("BENNY_API_HOST", "127.0.0.1")}:${env("BENNY_API_PORT", "8005")}`,
  // Q0: single resolution path — env BENNY_API_KEY -> per-install keystore
  // ($BENNY_HOME/state/hmac-key) -> fail fast. Lazy getter so LONGVIEW phases
  // that never call the Benny API (map, reduce, opus, pdf) cannot be killed at
  // import time by a missing key; only API-using phases (ingest) trigger it.
  get BENNY_API_KEY() {
    const explicit = env("BENNY_API_KEY", "");
    if (explicit) return explicit;
    try {
      const value = fs.readFileSync(path.join(bennyHome, "state", "hmac-key"), "utf8").trim();
      if (value) return value;
    } catch {
      // fall through to fail-fast
    }
    throw new Error(
      "BENNY_API_KEY is not set and no per-install key was found at " +
        "<BENNY_HOME>/state/hmac-key. Set the BENNY_API_KEY environment variable, " +
        "or run `benny init` to generate a per-install keystore."
    );
  },

  // Budgets — evidence pack size bounds per-card latency on a 9B model.
  // NOTE: lemonade serves qwen3.5-9b-FLM with ctx_size 4096 on this box;
  // 7500 chars (~2.1k tokens) + system prompt + 1.2k output stays inside it.
  // Raise LONGVIEW_EVIDENCE_BUDGET only after raising the FLM ctx_size.
  EVIDENCE_BUDGET_CHARS: Number(env("LONGVIEW_EVIDENCE_BUDGET", 7500)),
  CARD_MAX_TOKENS: Number(env("LONGVIEW_CARD_MAX_TOKENS", 1200)),
  // Graph-walk extraction: chunk the FULL session timeline into windows this many
  // chars wide (fits qwen3.5's 4096-ctx with room for the small fragment output),
  // extract a tiny fragment per window (bounded output — never near the ~415-token
  // self-limit), and assemble the card losslessly in code. INTENT is one small call.
  WINDOW_INPUT_CHARS: Number(env("LONGVIEW_WINDOW_CHARS", 7000)),
  FRAGMENT_MAX_TOKENS: Number(env("LONGVIEW_FRAGMENT_MAX_TOKENS", 500)),
  INTENT_MAX_TOKENS: Number(env("LONGVIEW_INTENT_MAX_TOKENS", 300)),
  // Post-graph session review pass.
  REVIEW_INPUT_CHARS: Number(env("LONGVIEW_REVIEW_CHARS", 4000)),
  REVIEW_MAX_TOKENS: Number(env("LONGVIEW_REVIEW_MAX_TOKENS", 900)),
  REDUCE_MAX_TOKENS: Number(env("LONGVIEW_REDUCE_MAX_TOKENS", 1800)),
  // Hard cap on any composed reduce input (chars). 4096-token ctx ⇒ input must
  // stay ≈ ≤2200 tokens once the ~1800-token output budget is reserved. Raise
  // together with the FLM ctx_size for higher-fidelity synthesis at scale.
  REDUCE_INPUT_BUDGET: Number(env("LONGVIEW_REDUCE_INPUT", 8500)),

  // Phase D graph ingestion. deep_synthesis is what turns card docs into
  // Document/Concept nodes in Neo4j — without it /rag/ingest only writes
  // vectors (found live: 55 cards in Chroma, empty graph). Synthesis is
  // LLM-per-document, so batches are small and the timeout generous.
  DEEP_SYNTHESIS: env("LONGVIEW_DEEP_SYNTHESIS", "true") !== "false",
  INGEST_MODEL:
    env("LONGVIEW_INGEST_MODEL", "") || env("BENNY_DEFAULT_MODEL", "") || "lemonade/qwen3.5-9b-FLM",
  // Two hard-won constraints shape these numbers:
  // 1. A batch must never outlive its timeout, or timed-out polls fire the
  //    next batch onto a still-running server task — five stacked synthesis
  //    tasks knocked the embedding provider over (2026-07-02 overnight run).
  // 2. The runtime runs FULL clustering+correlation after EVERY deep-synthesis
  //    batch (~30-40 min on a ~1k-node graph) — so batch=1 pays that cost per
  //    document. One big batch amortizes clustering to a single pass.
  // Hence: large batch, larger timeout (3 min/doc synthesis + one clustering).
  INGEST_BATCH: Number(env("LONGVIEW_INGEST_BATCH", 40)),
  INGEST_TIMEOUT_MS: Number(env("LONGVIEW_INGEST_TIMEOUT_MS", 14400000)),
  // A8 (2026-07-06): the 4h ceiling is legitimate for a HEALTHY batch (per-doc
  // synthesis + one amortized clustering pass), but a task whose own record
  // stops advancing is not healthy — fail after 30 min of task-level silence
  // instead of burning the rest of the window (the overnight swap-thrash loop
  // spent 2x4h re-chewing one batch). 0 disables.
  INGEST_STALL_MS: Number(env("LONGVIEW_INGEST_STALL_MS", 1800000)),
  LLM_TIMEOUT_MS: Number(env("LONGVIEW_LLM_TIMEOUT_MS", 900000)),
  // Sessions with less extractable text than this are recorded as thin, not mapped.
  THIN_SESSION_CHARS: Number(env("LONGVIEW_THIN_CHARS", 200)),
  // Delta mode: re-run REDUCE automatically once this many new cards accumulate.
  DELTA_REDUCE_THRESHOLD: Number(env("LONGVIEW_DELTA_THRESHOLD", 5))
};

export function workspaceDir(...parts) {
  return path.join(config.BENNY_HOME, "workspaces", config.WORKSPACE, ...parts);
}

// LONGVIEW's own state lives under <workspace>/longview/.
export function stateDir(...parts) {
  return workspaceDir("longview", ...parts);
}

export function ensureWorkspace() {
  for (const d of [
    workspaceDir("data_in"),
    workspaceDir("data_out"),
    stateDir("evidence"),
    stateDir("cards"),
    stateDir("rollups"),
    workspaceDir("data_out", "dossiers"),
    workspaceDir("data_out", "skills"),
    workspaceDir("data_out", "book")
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
