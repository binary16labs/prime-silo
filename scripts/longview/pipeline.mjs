#!/usr/bin/env node
/**
 * LONGVIEW release pipeline — the repeatable per-release process (ADR-005).
 *
 * One command ties the whole chain the regulators asked for into a single,
 * resume-safe, tag-stamped run:
 *
 *   1. LONGVIEW synthesis on the PROVEN agent  (inventory→extract→map→model→graph)
 *   2. update the code graph                    (code   — Tree-Sitter → CODE_REL)
 *   3. update the correlation                   (enrich — merge → CORRELATES_WITH → themes)
 *   4. run the latest SAD                       (sad    — canonical TOGAF EPIC v3)
 *   5. the AI Vampire book                      (reduce → opus → pdf)
 *
 * Every phase already exists as a first-class `longview` subcommand and is
 * individually resume-safe (kill and rerun freely). This orchestrator does NOT
 * reimplement any phase — it sequences them in dependency order, pins the run to
 * the latest release TAG, verifies the resolved model is the one you intend
 * ("the proven agent") before committing hours of GPU, and writes a per-release
 * run record so each release's synthesis/SAD/book is auditable.
 *
 * The agent is ENV-PINNED: the pipeline resolves LONGVIEW_MODEL exactly as the
 * phases do (scripts/longview/lib/config.mjs) and refuses to start until you
 * confirm the resolved id — pin the proven agent once in .env (LONGVIEW_MODEL)
 * and every phase in this run uses it.
 *
 *   node scripts/longview/pipeline.mjs               # full run, latest tag, interactive confirm
 *   node scripts/longview/pipeline.mjs --dry-run     # print the plan + resolved config, run nothing
 *   node scripts/longview/pipeline.mjs --yes         # non-interactive (CI); agent already vetted
 *   node scripts/longview/pipeline.mjs --tag v1.21.3 # stamp a specific release
 *   node scripts/longview/pipeline.mjs --from code   # resume from a phase (earlier phases skipped)
 *   node scripts/longview/pipeline.mjs --only sad    # run a single phase
 *   node scripts/longview/pipeline.mjs --no-book     # synthesis + code + enrich + SAD, skip the book
 *
 * Options:
 *   --tag <tag>          release tag to stamp (default: latest `git describe --tags`)
 *   --only a,b,c         run only these phases (comma list)
 *   --from <phase>       start at this phase, skip everything before it
 *   --skip a,b           skip these phases
 *   --no-book            skip the AI Vampire book (reduce/opus/pdf)
 *   --no-sad             skip the SAD phase
 *   --limit N            forward --limit N to the map phase (smoke tests only)
 *   --resume             forward --resume to the SAD phase
 *   --privacy <mode>     content-level privacy gate before model/graph: enforce (default, auto-quarantine) | gate (halt for review) | report
 *   --auto-resume        self-heal transient wedges: waits at preflight for missing infra (LM host,
 *                        benny/Neo4j, and the EMBEDDER when the plan has model/enrich), and if a phase
 *                        later fails while a needed service is DOWN, waits for it and retries (resume-safe).
 *                        A failure while everything it needs is healthy still stops (real error).
 *                        Embedder config: BENNY_EMBED_MODEL + BENNY_EMBED_BASE_URL (defaults to the gen host).
 *   --max-retries N      max auto-resume retries per phase (default 20)
 *   --recovery-wait-min M  max minutes to wait for infra recovery per wedge (default 90)
 *   --continue-on-error  keep going after a phase fails (default: stop at first failure)
 *   --dry-run            print the resolved plan and config, execute nothing
 *   --yes                skip the interactive proven-agent confirmation (CI / vetted)
 *   --force              proceed even if the LM host preflight probe fails
 *   -h, --help
 */
import { spawnSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { config, projectRoot, stateDir, workspaceDir, ensureWorkspace } from "./lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(__dirname, "longview.mjs");

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (has("help") || args.includes("-h")) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.slice(src.indexOf("/**"), src.indexOf("*/") + 2));
  process.exit(0);
}

// Canonical phase order. Each entry maps 1:1 to a `longview <id>` subcommand.
// `group` lets the coarse switches (--no-book / --no-sad) drop a whole stage.
// The order encodes the dependencies: the graph must exist (synthesis) before
// the code graph is correlated into it (code→enrich), and the enriched graph
// must exist before the SAD grounds on it and the book reduces over it.
const PHASES = [
  { id: "inventory", group: "synthesis", label: "inventory sessions" },
  { id: "extract", group: "synthesis", label: "extract fragments" },
  { id: "map", group: "synthesis", label: "map cards (PROVEN agent)" },
  { id: "privacy", group: "privacy", label: "privacy gate (content-level CV/PII pre-validation)" },
  { id: "model", group: "synthesis", label: "ingest cards → graph" },
  { id: "graph", group: "synthesis", label: "deterministic knowledge graph" },
  { id: "code", group: "codegraph", label: "code graph (Tree-Sitter)" },
  { id: "enrich", group: "correlation", label: "correlation (CORRELATES_WITH + themes)" },
  { id: "sad", group: "sad", label: "TOGAF EPIC v7 SAD (regulated: BCBS239 + SS1/23)" },
  { id: "reduce", group: "book", label: "dossiers/themes/report" },
  { id: "opus", group: "book", label: "AI Vampire book V2 (per-section retrieval)" },
  { id: "pdf", group: "book", label: "AI Vampire book → PDF" }
];

// -------------------------------------------------------------- plan selection
function selectPhases() {
  let phases = PHASES.slice();
  const only = opt("only");
  if (only) {
    const set = new Set(only.split(",").map((s) => s.trim()));
    return phases.filter((p) => set.has(p.id));
  }
  if (has("no-book")) phases = phases.filter((p) => p.group !== "book");
  if (has("no-sad")) phases = phases.filter((p) => p.group !== "sad");
  const skip = opt("skip");
  if (skip) {
    const set = new Set(skip.split(",").map((s) => s.trim()));
    phases = phases.filter((p) => !set.has(p.id));
  }
  const from = opt("from");
  if (from) {
    const i = phases.findIndex((p) => p.id === from);
    if (i < 0) {
      console.error(
        `--from '${from}' is not a phase in the plan (${phases.map((p) => p.id).join(", ")})`
      );
      process.exit(2);
    }
    phases = phases.slice(i);
  }
  return phases;
}

// per-phase extra args forwarded to the underlying `longview` subcommand
function phaseArgs(id) {
  if (id === "map" && opt("limit")) return ["--limit", opt("limit")];
  if (id === "sad" && has("resume")) return ["--resume"];
  // Privacy gate mode: --enforce (default: auto-quarantine CV/PII), --gate (halt
  // for human review), or --report. Set via pipeline `--privacy <mode>`.
  if (id === "privacy") return [`--${opt("privacy") || "enforce"}`];
  return [];
}

// ------------------------------------------------------------------- git / tag
function git(...a) {
  const r = spawnSync("git", a, { cwd: projectRoot, encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

function resolveRelease() {
  const explicit = opt("tag");
  const isRepo = git("rev-parse", "--is-inside-work-tree") === "true";
  if (!isRepo)
    return { tag: explicit || "untagged", commit: null, head: null, dirty: null, isRepo: false };
  const tag = explicit || git("describe", "--tags", "--abbrev=0") || "untagged";
  const tagCommit = tag !== "untagged" ? git("rev-list", "-n", "1", tag) : null;
  const head = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain") !== "";
  const atTag = tagCommit && head && tagCommit === head;
  return { tag, commit: tagCommit, head, dirty, atTag, isRepo: true };
}

// --------------------------------------------------------------- reachability
async function probe(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Probe the embedding model the model/enrich phases depend on. An actual
// /embeddings call is the only reliable check — LM Studio may list a model it
// hasn't loaded, and a missing embedder is the silent "Embedding provider
// unreachable" that empties an ingest. ok:true when unconfigured (never gate).
async function probeEmbed(agent, ms = 6000) {
  if (!agent.embed_model) return { ok: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${agent.embed_base.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: agent.embed_model, input: "probe" }),
      signal: ctrl.signal
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Infra health for preflight + --auto-resume classification. A phase that dies
// while a needed service is DOWN is a transient wedge (LM box drops, embedder
// not loaded, ingest stalls) — wait and retry (every phase is resume-safe). A
// phase that dies while everything it needs is UP is a real error — don't loop.
async function probeInfra(agent) {
  const lm = await probe(`${agent.endpoint.replace(/\/+$/, "")}/models`);
  const benny = await probe(`${agent.benny_api}/api/health`);
  const embed = await probeEmbed(agent);
  return { lm: lm.ok, benny: benny.ok, embed: embed.ok };
}

// Ready = generation host + benny up, plus the embedder IFF this run needs it
// (model/enrich). A graph-only or sad-only run is not gated on embeddings.
const needsEmbed = (id) => id === "model" || id === "enrich";
const infraReady = (h, needEmbed) => h.lm && h.benny && (!needEmbed || h.embed);

// Poll until infra is ready (embedder included when needed), or give up.
async function waitForRecovery(agent, maxWaitMs, needEmbed, pollMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const h = await probeInfra(agent);
    if (infraReady(h, needEmbed)) {
      process.stdout.write("\n");
      return true;
    }
    process.stdout.write(
      `\r[wait] LM=${h.lm ? "up" : "DOWN"} benny=${h.benny ? "up" : "DOWN"}${needEmbed ? ` embed=${h.embed ? "up" : "DOWN"}` : ""} · ${Math.round((deadline - Date.now()) / 60000)}m left   `
    );
    await sleep(pollMs);
  }
  process.stdout.write("\n");
  return false;
}

function confirm(question) {
  if (has("yes")) return Promise.resolve(true);
  if (!process.stdin.isTTY) {
    // Never silently run hours of synthesis on an unconfirmed model in a
    // non-interactive shell — force the operator to vet the agent with --yes.
    console.error(
      "\nstdin is not a TTY and --yes was not passed. Re-run with --yes once you have\n" +
        "confirmed the resolved model above IS the proven agent (env-pinned via LONGVIEW_MODEL)."
    );
    process.exit(3);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

// -------------------------------------------------------------------- run one
// Run one phase, TEEing its output to both the live console and a per-workflow
// log file (regulator lineage — each phase has its own captured log). onData is
// called on every chunk so the caller can refresh the live heartbeat, so a long
// phase (sad ~4h) still reads as alive. Async so the tee streams instead of
// buffering. logFile is the per-phase capture path.
function runPhase(phase, logFile, onData) {
  const extra = phaseArgs(phase.id);
  const started = Date.now();
  console.log(`\n\x1b[1m━━ ${phase.id} — ${phase.label} ━━\x1b[0m ${extra.join(" ")}`);
  // The book is built in AI Vampire V2 mode (LONGVIEW_OPUS_V2=1): per-section
  // wider retrieval + novelty bias toward un-cited sources. opus.mjs reads it
  // from the environment. The child longview.mjs loads .env itself.
  const phaseEnv = phase.id === "opus" ? { ...process.env, LONGVIEW_OPUS_V2: "1" } : process.env;
  let out = null;
  try {
    out = fs.createWriteStream(logFile, { flags: "a" });
    out.write(`\n===== ${phase.id} @ ${new Date().toISOString()} (${extra.join(" ")}) =====\n`);
  } catch {
    /* per-phase log is best-effort; the run still proceeds */
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, phase.id, ...extra], {
      cwd: projectRoot,
      env: phaseEnv
    });
    const tee = (stream) => (chunk) => {
      stream.write(chunk);
      if (out) out.write(chunk);
      onData?.();
    };
    child.stdout.on("data", tee(process.stdout));
    child.stderr.on("data", tee(process.stderr));
    child.on("close", (code) => {
      if (out) out.end();
      resolve({
        id: phase.id,
        ok: code === 0,
        exit: code,
        ms: Date.now() - started,
        log_file: logFile
      });
    });
    child.on("error", (e) => {
      if (out) out.end();
      resolve({
        id: phase.id,
        ok: false,
        exit: null,
        ms: Date.now() - started,
        error: String(e),
        log_file: logFile
      });
    });
  });
}

// ------------------------------------------------------------------------ main
async function main() {
  ensureWorkspace();
  const release = resolveRelease();
  const plan = selectPhases();
  const startedAt = new Date();

  const agent = {
    model: config.LONGVIEW_MODEL,
    ingest_model: config.INGEST_MODEL,
    endpoint: config.LLM_BASE_URL,
    embed_model: config.EMBED_MODEL,
    embed_base: config.EMBED_BASE,
    workspace: config.WORKSPACE,
    benny_api: config.BENNY_API_BASE
  };

  // auto-resume knobs (also used by the embedder-aware preflight below).
  const autoResume = has("auto-resume");
  const maxRetries = Number(opt("max-retries", "20"));
  const recoveryWaitMs = Number(opt("recovery-wait-min", "90")) * 60000;
  const planNeedsEmbed = plan.some((p) => needsEmbed(p.id));

  console.log("\x1b[1m╔══ LONGVIEW release pipeline ══╗\x1b[0m");
  console.log(
    `  release tag  : ${release.tag}${release.commit ? `  (${release.commit.slice(0, 10)})` : ""}`
  );
  if (release.isRepo) {
    console.log(
      `  HEAD         : ${release.head ? release.head.slice(0, 10) : "?"}${release.atTag ? "  = tag ✓" : "  ⚠ HEAD is not at the tag"}`
    );
    if (release.dirty)
      console.log(
        "  working tree : \x1b[33m⚠ dirty — code graph & SAD scan the live tree, not the tag\x1b[0m"
      );
  } else {
    console.log(
      "  git          : \x1b[33m⚠ not a git repo — release will be stamped '" +
        release.tag +
        "'\x1b[0m"
    );
  }
  console.log(`  proven agent : \x1b[36m${agent.model}\x1b[0m   (env-pinned: LONGVIEW_MODEL)`);
  console.log(`  ingest model : ${agent.ingest_model}`);
  console.log(`  LM endpoint  : ${agent.endpoint}`);
  console.log(
    `  embedder     : ${agent.embed_model || "(unset)"}${planNeedsEmbed ? "  [needed: model/enrich]" : "  [not needed by this plan]"}`
  );
  console.log(`  workspace    : ${agent.workspace}`);
  console.log(`  benny API    : ${agent.benny_api}`);
  console.log(`  plan         : ${plan.map((p) => p.id).join(" → ")}`);

  if (has("dry-run")) {
    console.log(
      "\n\x1b[1m--dry-run:\x1b[0m plan resolved, nothing executed. Deliverables would land under:"
    );
    console.log(`  ${workspaceDir("data_out")}`);
    process.exit(0);
  }

  // Preflight reachability — LM host (serves the agent), benny/Neo4j (model/
  // graph/enrich/sad), and the embedder (model/enrich; a missing one silently
  // no-ops an ingest). With --auto-resume the pipeline WAITS for whatever the
  // plan needs instead of failing — load the embedder / start a host whenever
  // and the run proceeds on its own. Without it, a missing dependency stops now.
  const infra = await probeInfra(agent);
  console.log(
    `\n  LM host      : ${infra.lm ? "\x1b[32mreachable ✓\x1b[0m" : "\x1b[31mUNREACHABLE\x1b[0m"}`
  );
  console.log(
    `  benny/Neo4j  : ${infra.benny ? "\x1b[32mreachable ✓\x1b[0m" : "\x1b[33munreachable\x1b[0m"}`
  );
  console.log(
    `  embedder     : ${!planNeedsEmbed ? "\x1b[2mnot needed by this plan\x1b[0m" : infra.embed ? "\x1b[32mserved ✓\x1b[0m" : `\x1b[31mNOT SERVED (${agent.embed_model}) — model/enrich need it\x1b[0m`}`
  );
  if (!infraReady(infra, planNeedsEmbed)) {
    const missing = [
      !infra.lm && "LM host",
      !infra.benny && "benny/Neo4j",
      planNeedsEmbed && !infra.embed && `embedder (${agent.embed_model})`
    ]
      .filter(Boolean)
      .join(", ");
    if (autoResume) {
      console.log(
        `\n[wait] not ready — missing: ${missing}. Waiting up to ${recoveryWaitMs / 60000}m; start/load it and the run continues automatically…`
      );
      if (!(await waitForRecovery(agent, recoveryWaitMs, planNeedsEmbed))) {
        console.error(`\n[wait] still not ready after ${recoveryWaitMs / 60000}m — stopping.`);
        process.exit(4);
      }
      console.log("[wait] infra ready — proceeding.");
    } else if (!has("force")) {
      console.error(
        `\nInfra not ready — missing: ${missing}.\nStart/load it, or re-run with --auto-resume to wait for it, or --force to override.`
      );
      process.exit(4);
    }
  }

  const go = await confirm(
    `\nProceed with \x1b[36m${agent.model}\x1b[0m as the proven agent for release ${release.tag}?`
  );
  if (!go) {
    console.log(
      "Aborted — no phase run. Pin the proven agent in .env (LONGVIEW_MODEL) and re-run."
    );
    process.exit(0);
  }

  // Per-release run record — the audit trail the regulators want: which agent,
  // which release, which phases, how long, what came out.
  const recordDir = stateDir("pipeline");
  fs.mkdirSync(recordDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const recordPath = path.join(recordDir, `${release.tag}__${stamp}.json`);
  const record = {
    tag: release.tag,
    commit: release.commit,
    head: release.head,
    agent,
    startedAt: startedAt.toISOString(),
    plan: plan.map((p) => p.id),
    phases: []
  };
  const persist = () => fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  persist();

  // ── Regulator lineage & telemetry ──────────────────────────────────────
  // Three artifacts, all under <workspace>/longview/pipeline/:
  //   live.json                 — heartbeat the dashboard reads (current phase,
  //                               pid, elapsed, updated_at → "running (sad)").
  //   <run>/telemetry.jsonl     — append-only per-workflow lineage trace: a
  //                               phase_start/phase_end event per phase with the
  //                               agent, commit, timing, exit and its log path.
  //   <run>/logs/NN-<phase>.log — the full captured log FOR EACH workflow phase.
  const runDir = path.join(recordDir, `${release.tag}__${stamp}`);
  const logsDir = path.join(runDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const livePath = path.join(recordDir, "live.json");
  const telemetryPath = path.join(runDir, "telemetry.jsonl");
  const rel = (p) => path.relative(recordDir, p).replace(/\\/g, "/");

  const live = {
    tag: release.tag,
    commit: release.commit,
    pid: process.pid,
    agent,
    plan: plan.map((p) => p.id),
    started_at: startedAt.toISOString(),
    status: "running",
    current_phase: null,
    phase_index: 0,
    phases: [],
    run_dir: rel(runDir),
    updated_at: startedAt.toISOString()
  };
  const writeLive = (patch = {}) => {
    Object.assign(live, patch, { updated_at: new Date().toISOString() });
    try {
      fs.writeFileSync(livePath, JSON.stringify(live, null, 2));
    } catch {
      /* heartbeat is best-effort */
    }
  };
  const appendTelemetry = (rec) => {
    try {
      fs.appendFileSync(
        telemetryPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          tag: release.tag,
          commit: release.commit,
          pid: process.pid,
          agent_model: agent.model,
          workspace: agent.workspace,
          ...rec
        }) + "\n"
      );
    } catch {
      /* telemetry is best-effort */
    }
  };
  // Throttle the heartbeat's updated_at to ~every 5s during a chatty phase.
  let lastBeat = 0;
  const heartbeat = () => {
    const now = Date.now();
    if (now - lastBeat > 5000) {
      lastBeat = now;
      writeLive();
    }
  };
  writeLive();
  appendTelemetry({ event: "run_start", plan: live.plan });

  let failed = null;
  outer: for (const [i, phase] of plan.entries()) {
    let attempt = 0;
    const phaseEmbed = needsEmbed(phase.id);
    const logFile = path.join(logsDir, `${String(i + 1).padStart(2, "0")}-${phase.id}.log`);
    // A phase runs until it succeeds, or fails in a way auto-resume can't heal.
    while (true) {
      writeLive({
        current_phase: phase.id,
        phase_index: i + 1,
        phase_attempt: attempt + 1,
        phase_started_at: new Date().toISOString()
      });
      appendTelemetry({
        event: "phase_start",
        phase: phase.id,
        index: i + 1,
        attempt: attempt + 1,
        log_file: rel(logFile)
      });
      const res = await runPhase(phase, logFile, heartbeat);
      record.phases.push(res);
      persist();
      appendTelemetry({
        event: "phase_end",
        phase: phase.id,
        index: i + 1,
        attempt: attempt + 1,
        ok: res.ok,
        exit: res.exit,
        ms: res.ms,
        log_file: rel(logFile)
      });
      live.phases.push({
        id: phase.id,
        ok: res.ok,
        ms: res.ms,
        exit: res.exit,
        log_file: rel(logFile)
      });
      writeLive({ current_phase: res.ok ? null : phase.id });
      console.log(
        res.ok
          ? `\x1b[32m✓ ${phase.id} (${(res.ms / 60000).toFixed(1)} min)\x1b[0m`
          : `\x1b[31m✗ ${phase.id} exit=${res.exit} (${(res.ms / 60000).toFixed(1)} min)\x1b[0m`
      );
      if (res.ok) break; // phase complete → next phase
      if (has("continue-on-error")) break; // press on to the next phase despite failure
      if (!autoResume) {
        failed = phase.id;
        break outer;
      }
      // --auto-resume: classify the failure by the infra THIS phase needs.
      const h = await probeInfra(agent);
      if (infraReady(h, phaseEmbed)) {
        console.error(
          `\n[auto-resume] ${phase.id} failed while everything it needs is healthy — a real failure, not a transient wedge. Stopping (auto-resume never loops on a real error).`
        );
        failed = phase.id;
        break outer;
      }
      attempt++;
      if (attempt > maxRetries) {
        console.error(`\n[auto-resume] ${phase.id}: exceeded ${maxRetries} retries — giving up.`);
        failed = phase.id;
        break outer;
      }
      console.warn(
        `\n[auto-resume] ${phase.id} wedged — missing: ${[!h.lm && "LM host", !h.benny && "benny", phaseEmbed && !h.embed && "embedder"].filter(Boolean).join(", ")} — attempt ${attempt}/${maxRetries}, waiting up to ${recoveryWaitMs / 60000}m…`
      );
      (record.auto_resume ||= []).push({
        phase: phase.id,
        attempt,
        at: new Date().toISOString(),
        lm_up: h.lm,
        benny_up: h.benny,
        embed_up: h.embed
      });
      persist();
      if (!(await waitForRecovery(agent, recoveryWaitMs, phaseEmbed))) {
        console.error(
          `\n[auto-resume] infra did not recover within ${recoveryWaitMs / 60000}m — stopping. Resume later: node scripts/longview/pipeline.mjs --auto-resume --from ${phase.id} --tag ${release.tag}`
        );
        failed = phase.id;
        break outer;
      }
      console.log(`\n[auto-resume] infra recovered — retrying ${phase.id} (resumes from disk)…`);
    }
  }

  record.finishedAt = new Date().toISOString();
  record.outcome = failed ? `failed at ${failed}` : "ok";
  record.deliverables = {
    data_out: workspaceDir("data_out"),
    sad_pdf: workspaceDir("data_out", "TOGAF_EPIC_V7_SAD_binary16.pdf"),
    book_dir: workspaceDir("data_out", config.OPUS_DIR)
  };
  persist();
  writeLive({
    status: failed ? `failed at ${failed}` : "complete",
    current_phase: null,
    finished_at: record.finishedAt
  });
  appendTelemetry({ event: "run_end", outcome: record.outcome });

  console.log("\n\x1b[1m╚══ summary ══╝\x1b[0m");
  for (const p of record.phases)
    console.log(
      `  ${p.ok ? "✓" : "✗"} ${p.id.padEnd(10)} ${(p.ms / 60000).toFixed(1)} min${p.ok ? "" : `  exit=${p.exit}`}`
    );
  console.log(`  run record   : ${recordPath}`);
  console.log(`  deliverables : ${record.deliverables.data_out}`);
  if (plan.some((p) => p.group === "sad"))
    console.log(`    · SAD      : ${record.deliverables.sad_pdf}`);
  if (plan.some((p) => p.group === "book"))
    console.log(`    · AI Vampire book: ${record.deliverables.book_dir}`);

  if (failed) {
    console.error(
      `\n\x1b[31mStopped at '${failed}'.\x1b[0m Fix the cause, then resume: node scripts/longview/pipeline.mjs --from ${failed} --tag ${release.tag}`
    );
    process.exit(1);
  }
  console.log(`\n\x1b[32mRelease ${release.tag} pipeline complete.\x1b[0m`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
