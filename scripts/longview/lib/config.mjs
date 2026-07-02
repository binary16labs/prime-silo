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
        if (i > 0) cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
      }
    }
  }
  return cfg;
}

const dotenv = loadDotEnv();
const env = (k, fallback) => process.env[k] || dotenv[k] || fallback;

// Resolve $BENNY_HOME exactly like the running runtime does (env override →
// desktop config → per-user default), via the canonical Node mirror of
// benny/portable/home.py. Phase D ingests through the runtime's API, so the
// workspace MUST live under the runtime's home, not a repo-relative one.
let bennyHome;
try {
  const { resolveHome } = require(path.join(projectRoot, "packaging", "desktop", "home_resolver.js"));
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

  // Local model host (same one benny/core/models.py resolves to).
  LEMONADE_BASE_URL: env("LEMONADE_BASE_URL", "http://127.0.0.1:13305/api/v1"),
  LONGVIEW_MODEL: env("LONGVIEW_MODEL", "qwen3.5-9b-FLM"),

  // Benny runtime API (Phase D ingestion, workspace paths).
  BENNY_API_BASE: `http://${env("BENNY_API_HOST", "127.0.0.1")}:${env("BENNY_API_PORT", "8005")}`,
  BENNY_API_KEY: env("BENNY_API_KEY", "benny-mesh-2026-auth"),

  // Budgets — evidence pack size bounds per-card latency on a 9B model.
  // NOTE: lemonade serves qwen3.5-9b-FLM with ctx_size 4096 on this box;
  // 7500 chars (~2.1k tokens) + system prompt + 1.2k output stays inside it.
  // Raise LONGVIEW_EVIDENCE_BUDGET only after raising the FLM ctx_size.
  EVIDENCE_BUDGET_CHARS: Number(env("LONGVIEW_EVIDENCE_BUDGET", 7500)),
  CARD_MAX_TOKENS: Number(env("LONGVIEW_CARD_MAX_TOKENS", 1200)),
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
  INGEST_MODEL: env("LONGVIEW_INGEST_MODEL", "lemonade/qwen3.5-9b-FLM"),
  INGEST_BATCH: Number(env("LONGVIEW_INGEST_BATCH", 5)),
  INGEST_TIMEOUT_MS: Number(env("LONGVIEW_INGEST_TIMEOUT_MS", 1800000)),
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
