#!/usr/bin/env node
/**
 * Offload Async Runner (ADR-004, async lane)
 *
 * Drains the workspace offload inbox: for each queued aamp.offload_task/1
 * manifest it POSTs to the Benny runtime's /api/offload/submit?wait=1, prints the
 * COMPACT DIGEST (never the raw artifact), and moves the processed manifest to
 * offload/processed/. The full result lives in offload/outbox/ for human promotion.
 *
 *   node scripts/offload-runner.mjs                 # drain default workspace once
 *   node scripts/offload-runner.mjs --workspace ws  # drain a specific workspace
 *   node scripts/offload-runner.mjs --watch         # keep draining every 5s
 *
 * This is the "less synchronous" lane: the planner enqueues and walks away; the
 * runner does the work and only a digest comes back.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function loadEnv() {
  const envPath = path.join(projectRoot, ".env");
  const fileConfig = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) {
        const i = t.indexOf("=");
        if (i > 0)
          fileConfig[t.slice(0, i).trim()] = t
            .slice(i + 1)
            .trim()
            .replace(/^['"]|['"]$/g, "");
      }
    }
  }
  let bennyHome = process.env.BENNY_HOME || fileConfig.BENNY_HOME || ".benny_home";
  if (!path.isAbsolute(bennyHome)) bennyHome = path.resolve(projectRoot, bennyHome);
  return {
    BENNY_HOME: bennyHome,
    API_HOST: process.env.BENNY_API_HOST || fileConfig.BENNY_API_HOST || "127.0.0.1",
    API_PORT: process.env.BENNY_API_PORT || fileConfig.BENNY_API_PORT || "8005",
    API_KEY: resolveBennyApiKey(bennyHome, fileConfig)
  };
}

// Q0: single resolution path — env BENNY_API_KEY -> per-install keystore
// ($BENNY_HOME/state/hmac-key) -> fail fast. No shipped default remains.
function resolveBennyApiKey(bennyHome, fileConfig) {
  const envKey = process.env.BENNY_API_KEY || fileConfig.BENNY_API_KEY;
  if (envKey) return envKey;
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
}

const env = loadEnv();
const args = process.argv.slice(2);
const workspace = (() => {
  const i = args.indexOf("--workspace");
  return i >= 0 ? args[i + 1] : "default";
})();
const watch = args.includes("--watch");
const apiBase = `http://${env.API_HOST}:${env.API_PORT}`;

function inboxDir() {
  return path.join(env.BENNY_HOME, "workspaces", workspace, "offload", "inbox");
}
function processedDir() {
  const d = path.join(env.BENNY_HOME, "workspaces", workspace, "offload", "processed");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function submit(task) {
  const res = await fetch(`${apiBase}/api/offload/submit?wait=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Benny-API-Key": env.API_KEY },
    body: JSON.stringify(task)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function drainOnce() {
  const dir = inboxDir();
  if (!fs.existsSync(dir)) {
    console.log(`(no inbox yet for workspace '${workspace}')`);
    return 0;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".task.json"));
  if (files.length === 0) {
    console.log(`Inbox empty for workspace '${workspace}'.`);
    return 0;
  }
  let processed = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      console.error(`  [skip] ${file}: invalid JSON (${e.message})`);
      continue;
    }
    process.stdout.write(`  -> ${task.id} ... `);
    try {
      const { ok, status, data } = await submit(task);
      if (!ok) {
        console.log(`REJECTED (${status}): ${JSON.stringify(data.detail || data)}`);
        continue;
      }
      const d = data.digest || {};
      console.log(
        `${d.status || "done"} [${d.tier}]${d.judge_score != null ? ` judge=${d.judge_score}` : ""}`
      );
      // move processed manifest out of the inbox
      fs.renameSync(full, path.join(processedDir(), file));
      processed++;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }
  return processed;
}

async function main() {
  // preflight
  try {
    const h = await fetch(`${apiBase}/api/offload/health`);
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch (e) {
    console.error(
      `ERROR: Benny offload API unreachable at ${apiBase} (${e.message}). Is the runtime up?`
    );
    process.exit(1);
  }
  console.log(`Offload runner — workspace '${workspace}' @ ${apiBase}`);
  if (watch) {
    for (;;) {
      await drainOnce();
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    const n = await drainOnce();
    console.log(`Done. Processed ${n} task(s). Digests above; full results in offload/outbox/.`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
