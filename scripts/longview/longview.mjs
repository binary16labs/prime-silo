#!/usr/bin/env node
/**
 * LONGVIEW — long-horizon session synthesis on the local model (ADR-005).
 *
 *   node scripts/longview/longview.mjs run [manifest.json] [--phase X] [--delta]
 *     — manifest mode (default: runtime/manifests/templates/longview_synthesis.json);
 *       also reachable as `benny longview run`. Individual phases:
 *   node scripts/longview/longview.mjs inventory [--no-sync] [--agents a,b]
 *   node scripts/longview/longview.mjs extract   [--limit N] [--force]
 *   node scripts/longview/longview.mjs map       [--limit N] [--force]
 *   node scripts/longview/longview.mjs model     [--no-graph]
 *   node scripts/longview/longview.mjs reduce    [--skip-book] [--only report,prd,...]
 *   node scripts/longview/longview.mjs all       [--limit N] [--no-graph] [--skip-book]
 *   node scripts/longview/longview.mjs delta     [--refresh] [--no-graph]
 *   node scripts/longview/longview.mjs status | report
 *
 * Backlog mode: `all` — resume-safe at card granularity; kill and rerun freely.
 * Delta mode:   `delta` — only sessions new/changed since their card.
 * Heartbeat:    <workspace>/longview/status.json; honest numbers: ledger.jsonl.
 */
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runOpus } from "./lib/opus.mjs";
import { evidenceFor, graphCatalog } from "./lib/retrieve.mjs";
import { mdToHtml, htmlToPdf } from "./lib/book_pdf.mjs";
import { config, ensureWorkspace, workspaceDir, stateDir, projectRoot } from "./lib/config.mjs";
import { syncStore, listSessions } from "./lib/store.mjs";
import { buildEvidencePack } from "./lib/evidence.mjs";
import { chat, lastBalancedJson } from "./lib/llm.mjs";
import { validateCard } from "./lib/gate.mjs";
import { appendLedger, readLedger, mapVerdicts, writeStatus, readStatus } from "./lib/ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name) => fs.readFileSync(path.join(__dirname, "prompts", `${name}.md`), "utf8");

const args = process.argv.slice(2);
const command = args[0] || "status";
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log("\n[longview] finishing current item, then stopping (Ctrl+C again to force)…");
});

// Single-instance lock — the EXE tray, Bridge button, and CLI can all launch
// the runner; only one may mutate a workspace at a time. Stale locks (dead
// pid) are reclaimed. status/report stay lock-free.
const lockPath = () => stateDir("runner.lock");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    if (held.pid && held.pid !== process.pid && pidAlive(held.pid)) {
      console.error(
        `[longview] already running (pid ${held.pid}, ${held.command || "?"} since ${held.started_at}). ` +
          `Use 'status' to watch it, or stop that run first.`
      );
      process.exit(3);
    }
  } catch {
    /* no lock or unreadable — take it */
  }
  fs.writeFileSync(
    lockPath(),
    JSON.stringify(
      { pid: process.pid, command, args: args.slice(1), started_at: new Date().toISOString() },
      null,
      2
    )
  );
  const release = () => {
    try {
      const held = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
      if (held.pid === process.pid) fs.unlinkSync(lockPath());
    } catch {
      /* already gone */
    }
  };
  process.on("exit", release);
}

const sid8 = (id) => String(id).slice(0, 8);
const inventoryPath = () => stateDir("inventory.json");
const cardPath = (id) => stateDir("cards", `${id}.json`);
const evidencePath = (id) => stateDir("evidence", `${id}.md`);
const evidenceMetaPath = (id) => stateDir("evidence", `${id}.meta.json`);

// ---------------------------------------------------------------- inventory
async function runInventory() {
  if (!flag("no-sync")) {
    process.stdout.write("[inventory] memo-ray sync… ");
    try {
      const { via } = await syncStore();
      console.log(`ok (${via})`);
    } catch (e) {
      console.log(`FAILED (${e.message}) — proceeding with the store as-is`);
    }
  }
  const agents = (opt("agents", "antigravity,claude") || "")
    .toLowerCase()
    .split(",")
    .filter(Boolean);
  const sessions = listSessions({ agents });
  const inventory = sessions.map((s) => ({
    id: s.id,
    agent: s.agent,
    title: (s.content || "").slice(0, 120),
    project: s.metadata?.project || null,
    timestamp: s.timestamp || 0,
    events: (s.children_ids || []).length
  }));
  fs.writeFileSync(inventoryPath(), JSON.stringify(inventory, null, 2));
  const byAgent = {};
  for (const s of inventory) byAgent[s.agent] = (byAgent[s.agent] || 0) + 1;
  writeStatus({ phase: "inventory", backlog_total: inventory.length, by_agent: byAgent });
  console.log(`[inventory] ${inventory.length} sessions`, byAgent);
  return inventory;
}

const loadInventory = () => JSON.parse(fs.readFileSync(inventoryPath(), "utf8"));

// ------------------------------------------------------------------ extract
function runExtract() {
  const inventory = loadInventory();
  const limit = Number(opt("limit", 0)) || Infinity;
  const sessionById = new Map(listSessions().map((s) => [s.id, s]));
  let done = 0,
    skipped = 0;
  for (const item of inventory) {
    if (done >= limit || interrupted) break;
    if (fs.existsSync(evidencePath(item.id)) && !flag("force")) {
      skipped++;
      continue;
    }
    const session = sessionById.get(item.id);
    if (!session) continue;
    const ev = buildEvidencePack(session);
    fs.writeFileSync(evidencePath(item.id), ev.pack);
    fs.writeFileSync(
      evidenceMetaPath(item.id),
      JSON.stringify(
        {
          signal_chars: ev.signalChars,
          artifact_names: ev.artifactNames,
          project: ev.project,
          first_ts: ev.firstTs,
          last_ts: ev.lastTs
        },
        null,
        2
      )
    );
    done++;
    if (done % 20 === 0) console.log(`[extract] ${done} packs…`);
  }
  console.log(`[extract] built ${done}, kept ${skipped} existing`);
}

// ---------------------------------------------------------------------- map
async function runMap({ deltaMode = false, limitOverride = null } = {}) {
  const inventory = loadInventory();
  const limit = limitOverride ?? (Number(opt("limit", 0)) || Infinity);
  const verdicts = mapVerdicts();
  const system = prompt("session_card");

  const queue = inventory.filter((item) => {
    if (!fs.existsSync(evidencePath(item.id))) return false;
    const v = verdicts.get(item.id);
    if (flag("force")) return true;
    if (!v) return true;
    if (v.status === "ok" && fs.existsSync(cardPath(item.id))) {
      // Delta: a session that gained activity after its card was made is stale.
      return deltaMode && item.timestamp > Date.parse(v.ts || 0);
    }
    if (v.status === "skipped_thin") return false;
    return true; // previous failure → retry
  });

  console.log(
    `[map] queue ${Math.min(queue.length, limit)} of ${inventory.length} sessions (model ${config.LONGVIEW_MODEL})`
  );
  let ok = 0,
    failed = 0,
    thin = 0,
    processed = 0;

  for (const item of queue) {
    if (processed >= limit || interrupted) break;
    processed++;
    const meta = JSON.parse(fs.readFileSync(evidenceMetaPath(item.id), "utf8"));
    if (meta.signal_chars < config.THIN_SESSION_CHARS) {
      appendLedger({
        phase: "map",
        session_id: item.id,
        status: "skipped_thin",
        signal_chars: meta.signal_chars
      });
      thin++;
      continue;
    }
    const pack = fs.readFileSync(evidencePath(item.id), "utf8");
    const started = Date.now();
    let card = null,
      gateErrors = [],
      retries = 0,
      tokens = { prompt: 0, completion: 0, estimated: false };

    for (let attempt = 0; attempt < 2 && !card; attempt++) {
      retries = attempt;
      try {
        const feedback =
          attempt > 0
            ? `\n\nYour previous answer failed validation: ${gateErrors.join("; ")}. Return corrected JSON only.`
            : "";
        const res = await chat({
          system,
          user: pack + feedback,
          maxTokens: config.CARD_MAX_TOKENS,
          json: true
        });
        tokens = {
          prompt: tokens.prompt + res.prompt_tokens,
          completion: tokens.completion + res.completion_tokens,
          estimated: res.usage_estimated
        };
        const parsed = lastBalancedJson(res.content);
        gateErrors = validateCard(parsed, { sessionId: item.id, agent: item.agent });
        if (gateErrors.length === 0) card = parsed;
      } catch (e) {
        gateErrors = [`llm error: ${e.message}`];
      }
    }

    const ms = Date.now() - started;
    if (card) {
      fs.writeFileSync(cardPath(item.id), JSON.stringify(card, null, 2));
      appendLedger({
        phase: "map",
        session_id: item.id,
        status: "ok",
        ms,
        retries,
        prompt_tokens: tokens.prompt,
        completion_tokens: tokens.completion,
        usage_estimated: tokens.estimated,
        project: card.project
      });
      ok++;
      console.log(
        `[map] ok  ${sid8(item.id)} ${card.project.padEnd(20).slice(0, 20)} ${(ms / 1000).toFixed(0)}s`
      );
    } else {
      appendLedger({
        phase: "map",
        session_id: item.id,
        status: "failed",
        ms,
        retries,
        gate_errors: gateErrors
      });
      failed++;
      console.log(
        `[map] FAIL ${sid8(item.id)} ${(ms / 1000).toFixed(0)}s — ${gateErrors.join("; ").slice(0, 120)}`
      );
    }

    const allVerdicts = mapVerdicts();
    const doneCount = [...allVerdicts.values()].filter((v) => v.status === "ok").length;
    const okLedger = readLedger().filter((e) => e.phase === "map" && e.status === "ok" && e.ms);
    const avgMs = okLedger.length ? okLedger.reduce((a, e) => a + e.ms, 0) / okLedger.length : 0;
    const remaining = inventory.length - allVerdicts.size;
    writeStatus({
      phase: "map",
      backlog_total: inventory.length,
      cards_ok: doneCount,
      map_failed: [...allVerdicts.values()].filter((v) => v.status === "failed").length,
      map_thin: [...allVerdicts.values()].filter((v) => v.status === "skipped_thin").length,
      current_session: sid8(item.id),
      cards_per_hour: avgMs ? +(3600000 / avgMs).toFixed(1) : null,
      eta_hours_remaining: avgMs ? +((remaining * avgMs) / 3600000).toFixed(1) : null
    });
  }
  console.log(
    `[map] done: ok=${ok} failed=${failed} thin=${thin}${interrupted ? " (interrupted — resume with the same command)" : ""}`
  );
}

// -------------------------------------------------------------------- model
function loadCards() {
  const dir = stateDir("cards");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function renderCardMd(card) {
  const list = (k, label) =>
    card[k] && card[k].length ? `**${label}:**\n${card[k].map((x) => `- ${x}`).join("\n")}` : "";
  // Three H2 sections, not ten: deep synthesis extracts per H2 section (capped
  // at 10/doc), so section count IS the per-document LLM cost. Ten sections
  // cost ~10 min/doc and caused the 30-min batch timeouts; three cost ~3 min.
  const overview = [
    card.intent,
    list("applications", "Applications"),
    list("capabilities", "Capabilities")
  ]
    .filter(Boolean)
    .join("\n\n");
  const happened = [
    list("decisions", "Decisions"),
    list("outcomes", "Outcomes"),
    list("failures", "Failures")
  ]
    .filter(Boolean)
    .join("\n\n");
  const threads = [
    list("skills_observed", "Skills observed"),
    list("operator_traits", "Operator traits"),
    list("open_threads", "Open threads"),
    list("proposed_next", "Proposed next")
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    `# Session card: ${card.project} (${card.period})`,
    `Session ${card.session_id} · agent ${card.agent}`,
    `\n## Overview\n${overview || "(none)"}`,
    `\n## What happened\n${happened || "(none)"}`,
    `\n## Threads and signals\n${threads || "(none)"}`
  ].join("\n");
}

// Fire-and-poll ingest. A deep-synthesis ingest holds the HTTP response open
// for many minutes; Node's undici kills idle connections at ~5 min regardless
// of AbortSignal (seen live: "fetch failed" while the server kept working and
// the graph kept filling). So: POST with a client-generated run_id, tolerate
// the connection dying, and poll the runtime's task record until it settles.
// This also serializes batches — the next POST waits for this task to finish.
async function ingestBatch(batch, { deepSynthesis = config.DEEP_SYNTHESIS } = {}) {
  const runId = crypto.randomUUID();
  const post = fetch(`${config.BENNY_API_BASE}/api/rag/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Benny-API-Key": config.BENNY_API_KEY },
    body: JSON.stringify({
      workspace: config.WORKSPACE,
      files: batch,
      run_id: runId,
      deep_synthesis: deepSynthesis,
      model: config.INGEST_MODEL
    })
  }).catch(() => null); // connection death ≠ ingest death — the task record decides

  const started = Date.now();
  const deadline = started + config.INGEST_TIMEOUT_MS;
  let seen = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    let task = null;
    try {
      const res = await fetch(`${config.BENNY_API_BASE}/api/tasks`, {
        headers: { "X-Benny-API-Key": config.BENNY_API_KEY },
        signal: AbortSignal.timeout(15000)
      });
      const tasks = await res.json();
      task = Array.isArray(tasks) ? tasks.find((t) => t.task_id === runId) : null;
    } catch {
      continue; // transient — keep polling
    }
    if (!task) {
      // The handler registers the task before any work, so a task that never
      // appears means the POST was rejected — surface its status if the
      // response is available, without hanging on a still-open connection.
      if (!seen && Date.now() - started > 60000) {
        const r = await Promise.race([
          post,
          new Promise((res) => setTimeout(() => res(undefined), 5000))
        ]);
        return {
          ok: false,
          runId,
          error: r ? `submit rejected (${r.status})` : "no task registered after 60s"
        };
      }
      continue;
    }
    seen = true;
    if (task.status === "completed" || task.status === "completed_with_errors") {
      return { ok: true, runId, partial: task.status === "completed_with_errors" };
    }
    if (task.status === "failed") return { ok: false, runId, error: task.message || "task failed" };
    if (interrupted)
      return { ok: false, runId, error: "interrupted while waiting (server task continues)" };
  }
  return {
    ok: false,
    runId,
    error: `timeout after ${config.INGEST_TIMEOUT_MS}ms (server task may still be running)`
  };
}

async function runModel() {
  const cards = loadCards();
  if (cards.length === 0) {
    console.log("[model] no cards yet — run map first");
    return;
  }

  // Rollups — deterministic aggregation, recomputed from scratch every time.
  const projects = {},
    capabilities = {},
    timeline = {},
    operator = { traits: {}, skills: {} },
    openThreads = [],
    proposedNext = [],
    sids = {};
  for (const c of cards) {
    sids[sid8(c.session_id)] = c.session_id;
    const p = (projects[c.project] ||= {
      sessions: [],
      months: new Set(),
      applications: new Set(),
      capabilities: new Set(),
      outcomes: 0,
      open_threads: [],
      proposed_next: []
    });
    p.sessions.push(sid8(c.session_id));
    p.months.add(c.period);
    for (const a of c.applications || []) p.applications.add(a);
    for (const k of c.capabilities || []) {
      p.capabilities.add(k);
      (capabilities[k] ||= new Set()).add(c.project);
    }
    p.outcomes += (c.outcomes || []).length;
    for (const t of c.open_threads || []) {
      p.open_threads.push(t);
      openThreads.push({ project: c.project, sid: sid8(c.session_id), thread: t });
    }
    for (const n of c.proposed_next || []) {
      p.proposed_next.push(n);
      proposedNext.push({ project: c.project, sid: sid8(c.session_id), next: n });
    }
    const m = (timeline[c.period] ||= { projects: new Set(), sessions: 0 });
    m.projects.add(c.project);
    m.sessions++;
    for (const t of c.operator_traits || []) (operator.traits[t] ||= []).push(sid8(c.session_id));
    for (const s of c.skills_observed || []) (operator.skills[s] ||= []).push(sid8(c.session_id));
  }
  const dehydrate = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Set ? [...v] : v)));
  fs.writeFileSync(
    stateDir("rollups", "projects.json"),
    JSON.stringify(dehydrate(projects), null, 2)
  );
  fs.writeFileSync(
    stateDir("rollups", "capabilities.json"),
    JSON.stringify(dehydrate(capabilities), null, 2)
  );
  fs.writeFileSync(
    stateDir("rollups", "timeline.json"),
    JSON.stringify(dehydrate(timeline), null, 2)
  );
  fs.writeFileSync(stateDir("rollups", "operator.json"), JSON.stringify(operator, null, 2));
  fs.writeFileSync(
    stateDir("rollups", "threads.json"),
    JSON.stringify({ open_threads: openThreads, proposed_next: proposedNext }, null, 2)
  );
  fs.writeFileSync(stateDir("rollups", "sids.json"), JSON.stringify(sids, null, 2));
  console.log(
    `[model] rollups: ${Object.keys(projects).length} projects, ${Object.keys(capabilities).length} capabilities, ${Object.keys(timeline).length} months`
  );

  // Cards → workspace data_in as markdown, then into the knowledge graph.
  // Ingestion state is tracked explicitly (a render is not an ingest — the
  // pilot hit exactly that: rendered files, failed ingest, nothing to retry).
  for (const c of cards) {
    const p = workspaceDir("data_in", `longview_card_${sid8(c.session_id)}.md`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, renderCardMd(c));
  }
  const ingestedPath = stateDir("rollups", "ingested.json");
  let ingested = [];
  try {
    ingested = JSON.parse(fs.readFileSync(ingestedPath, "utf8"));
  } catch {
    /* first run */
  }
  const ingestedSet = new Set(ingested);
  const pending = cards
    .map((c) => `longview_card_${sid8(c.session_id)}.md`)
    .filter((n) => !ingestedSet.has(n));
  console.log(`[model] ${pending.length} card docs pending graph ingestion`);

  if (!flag("no-graph") && pending.length) {
    const step = config.DEEP_SYNTHESIS ? config.INGEST_BATCH : 25;
    console.log(
      `[model] deep_synthesis=${config.DEEP_SYNTHESIS} (${config.DEEP_SYNTHESIS ? "cards become graph Documents/Concepts — LLM per doc, slow" : "vectors only — the graph stays EMPTY"})`
    );
    for (let i = 0; i < pending.length; i += step) {
      const batch = pending.slice(i, i + step);
      process.stdout.write(
        `[model] /rag/ingest batch ${Math.floor(i / step) + 1} (${batch.length} files)… `
      );
      const verdict = await ingestBatch(batch);
      console.log(verdict.ok ? `ok (run ${verdict.runId})` : `FAILED (${verdict.error})`);
      appendLedger({
        phase: "model",
        action: "ingest",
        files: batch.length,
        deep_synthesis: config.DEEP_SYNTHESIS,
        ok: verdict.ok,
        run_id: verdict.runId,
        ...(verdict.error ? { error: verdict.error } : {})
      });
      if (verdict.ok) {
        for (const n of batch) ingestedSet.add(n);
        fs.writeFileSync(ingestedPath, JSON.stringify([...ingestedSet], null, 2));
      }
      if (interrupted) break;
    }
  }
  writeStatus({ phase: "model", cards_ok: cards.length, projects: Object.keys(projects).length });
}

// ------------------------------------------------------------------- reduce
async function reduceCall(name, system, user, outPath) {
  const started = Date.now();
  // Per-part slices control composition; this cap guarantees the total fits
  // the model's context window regardless of corpus size (see config note).
  user = user.slice(0, config.REDUCE_INPUT_BUDGET);
  // A wedged model answers 200 with an empty body; written as-is that became a
  // 0-byte prime-silo dossier that fed every downstream deliverable including
  // the book (2026-07-03 run). Retry once; never replace a real file with
  // nothing, and ledger the failure honestly.
  let res = await chat({ system, user, maxTokens: config.REDUCE_MAX_TOKENS, temperature: 0.4 });
  if (res.content.trim().length < 80) {
    res = await chat({ system, user, maxTokens: config.REDUCE_MAX_TOKENS, temperature: 0.4 });
  }
  const ok = res.content.trim().length >= 80;
  if (ok) fs.writeFileSync(outPath, res.content);
  appendLedger({
    phase: "reduce",
    artifact: name,
    ms: Date.now() - started,
    ok,
    prompt_tokens: res.prompt_tokens,
    completion_tokens: res.completion_tokens,
    usage_estimated: res.usage_estimated
  });
  console.log(
    ok
      ? `[reduce] ${name} → ${path.relative(config.BENNY_HOME, outPath)} (${((Date.now() - started) / 1000).toFixed(0)}s)`
      : `[reduce] ${name} FAILED — empty response twice (kept any existing file)`
  );
  if (ok) return res.content;
  return fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
}

const cardDigest = (c) =>
  JSON.stringify({
    sid: sid8(c.session_id),
    period: c.period,
    intent: c.intent,
    capabilities: c.capabilities,
    decisions: c.decisions,
    outcomes: c.outcomes,
    failures: c.failures,
    open_threads: c.open_threads,
    proposed_next: c.proposed_next
  });

async function runReduce({ onlyOverride = null, skipBookOverride = null } = {}) {
  const cards = loadCards();
  if (!cards.length) return console.log("[reduce] no cards — run map first");
  const only = onlyOverride ?? (opt("only", "") || "").split(",").filter(Boolean);
  const skipBook = skipBookOverride ?? flag("skip-book");
  const want = (n) => only.length === 0 || only.includes(n);
  const rollup = (n) => fs.readFileSync(stateDir("rollups", `${n}.json`), "utf8");
  const outDir = (...p) => workspaceDir("data_out", ...p);
  writeStatus({ phase: "reduce" });

  // 1. Project dossiers — one bounded call per project. Card project names
  // vary in case ("benny"/"Benny", "prime-silo"/"Prime-Silo"); the Windows fs
  // is case-insensitive, so their dossier files collide and the last write
  // wins. Merge case-variants under the first-seen spelling instead.
  const byProject = {};
  const canonical = new Map();
  for (const c of cards) {
    const lower = String(c.project).toLowerCase();
    if (!canonical.has(lower)) canonical.set(lower, c.project);
    (byProject[canonical.get(lower)] ||= []).push(c);
  }
  const dossiers = {};
  if (want("dossiers")) {
    for (const [project, pcards] of Object.entries(byProject)) {
      if (interrupted) break;
      pcards.sort((a, b) => (a.period || "").localeCompare(b.period || ""));
      const user = `Project: ${project}\nSession cards (chronological, one JSON per line):\n${pcards
        .map(cardDigest)
        .join("\n")
        .slice(0, 24000)}`;
      const safe = project.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60);
      dossiers[project] = await reduceCall(
        `dossier:${project}`,
        prompt("project_dossier"),
        user,
        outDir("dossiers", `${safe}.md`)
      );
    }
  } else {
    for (const f of fs.readdirSync(outDir("dossiers"))) {
      if (f.endsWith(".md"))
        dossiers[f.replace(/\.md$/, "")] = fs.readFileSync(outDir("dossiers", f), "utf8");
    }
  }

  const dossierSummaries = Object.entries(dossiers)
    .map(([p, d]) => `--- ${p} ---\n${d.slice(0, 2200)}`)
    .join("\n\n")
    .slice(0, 26000);

  // 2. Cross-project themes — the greater-than-the-sum pass.
  let themes = "";
  // Discovery notes (weave phase) — when they exist, every synthesis input
  // stands on them too: the loop's findings compound into the deliverables.
  let discoveryDigest = "";
  try {
    const dDir = outDir("discovery");
    discoveryDigest = fs
      .readdirSync(dDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => fs.readFileSync(path.join(dDir, f), "utf8").slice(0, 1200))
      .join("\n\n---\n\n")
      .slice(0, 8000);
  } catch {
    /* no weave yet */
  }

  if (want("themes") && !interrupted) {
    themes = await reduceCall(
      "themes",
      prompt("themes"),
      `${dossierSummaries}\n\n## Timeline rollup\n${rollup("timeline")}\n\n## Operator rollup\n${rollup("operator").slice(0, 6000)}${discoveryDigest ? `\n\n## Discovery notes (cross-reference findings)\n${discoveryDigest}` : ""}`,
      outDir("THEMES.md")
    );
  } else if (fs.existsSync(outDir("THEMES.md"))) {
    themes = fs.readFileSync(outDir("THEMES.md"), "utf8");
  }

  // 3-5. Deliverables.
  if (want("report") && !interrupted) {
    await reduceCall(
      "report",
      prompt("report"),
      `## Themes\n${themes.slice(0, 8000)}\n\n## Dossiers\n${dossierSummaries.slice(0, 16000)}\n\n## Capability rollup\n${rollup("capabilities").slice(0, 4000)}`,
      outDir("PORTFOLIO-REPORT.md")
    );
  }
  if (want("prd") && !interrupted) {
    await reduceCall(
      "prd",
      prompt("prd"),
      `## Themes\n${themes.slice(0, 8000)}\n\n## Open threads & proposed next\n${rollup("threads").slice(0, 14000)}\n\n## Dossier summaries\n${dossierSummaries.slice(0, 8000)}`,
      outDir("PRD-WHAT-COMES-NEXT.md")
    );
  }
  if (want("skill") && !interrupted) {
    await reduceCall(
      "skill",
      prompt("skill"),
      `## Operator evidence (trait/skill → session ids)\n${rollup("operator").slice(0, 12000)}\n\n## Themes (operating style)\n${themes.slice(0, 6000)}`,
      outDir("skills", "working-with-this-operator.SKILL.md")
    );
  }

  // 6. Book — outline (JSON), then bounded chapter calls.
  if (want("book") && !skipBook && !interrupted) {
    const outlineRaw = await reduceCall(
      "book:outline",
      prompt("book_outline"),
      `## Themes\n${themes.slice(0, 6000)}\n\n## Dossier summaries\n${dossierSummaries.slice(0, 14000)}\n\n## Timeline\n${rollup("timeline")}`,
      outDir("book", "outline.json")
    );
    const outline = lastBalancedJson(outlineRaw);
    if (outline?.chapters?.length) {
      const parts = [`# ${outline.title}\n\n_${outline.subtitle || ""}_\n\n${outline.arc || ""}\n`];
      for (const ch of outline.chapters) {
        if (interrupted) break;
        const relevant = Object.entries(dossiers)
          .filter(([p]) =>
            (ch.projects || []).some((x) => p.toLowerCase().includes(String(x).toLowerCase()))
          )
          .map(([, d]) => d.slice(0, 5000))
          .join("\n\n");
        const text = await reduceCall(
          `book:ch${ch.n}`,
          prompt("book_chapter"),
          `## Outline\n${JSON.stringify(outline).slice(0, 3000)}\n\n## This chapter\n${JSON.stringify(ch)}\n\n## Source dossiers\n${relevant || dossierSummaries.slice(0, 10000)}`,
          outDir("book", `chapter-${String(ch.n).padStart(2, "0")}.md`)
        );
        parts.push(text);
      }
      fs.writeFileSync(outDir("book", "BOOK.md"), parts.join("\n\n---\n\n"));
      console.log(`[reduce] book assembled (${outline.chapters.length} chapters)`);
    } else {
      console.log(
        "[reduce] book outline did not parse — chapters skipped (rerun with --only book)"
      );
    }
  }

  // 7. TOGAF SAD — prepared for a human-launched swarm run (ADR-001).
  if (want("togaf")) {
    fs.writeFileSync(
      outDir("TOGAF-RUN.md"),
      [
        "# TOGAF SAD over the LONGVIEW graph",
        "",
        "The knowledge graph in this workspace now contains the session-card corpus.",
        "Run the existing 6-task SAD swarm against it (human-launched per ADR-001):",
        "",
        "```powershell",
        "cd " + path.join("runtime"),
        `python benny_cli.py run manifests/templates/togaf_sad_report_swarm.json --json ^`,
        `  --var workspace=${config.WORKSPACE} ^`,
        `  --var topic="The binary16 application estate (LONGVIEW synthesis)" ^`,
        `  --var model=lemonade/${config.LONGVIEW_MODEL} ^`,
        `  --var output_file=data_out/TOGAF_SAD_binary16.md`,
        "```",
        "",
        "The swarm's baseline_extraction step queries this workspace's graph, so the",
        "SAD baseline is the synthesized estate, not a single repo. Run appears in",
        "Mission Control / activity feed like any other runtime run."
      ].join("\n")
    );
    console.log("[reduce] togaf → data_out/TOGAF-RUN.md (human-launched)");
  }
  writeStatus({ phase: "reduce_done", deliverables_at: workspaceDir("data_out") });
}

// --------------------------------------------------------------------- code
// AST/code-graph feed (ADR-005 horizontal mechanism, code half): junction the
// repo into the workspace src/, then run the existing declarative enrichment
// manifest (Tree-Sitter scan → code graph → CORRELATES_WITH links to the
// knowledge concepts). Reuses benny enrich end to end.
async function runCode() {
  const srcRoot = workspaceDir("src");
  const target = path.join(srcRoot, "prime-silo");
  fs.mkdirSync(srcRoot, { recursive: true });
  if (!fs.existsSync(target)) {
    // Junction (no admin needed on Windows), so the scan sees the live repo.
    const r = spawnSync("cmd", ["/c", "mklink", "/J", target, projectRoot], { encoding: "utf8" });
    if (!fs.existsSync(target)) {
      console.log(`[code] junction failed (${(r.stderr || "").trim()}) — skipping code graph`);
      appendLedger({ phase: "code", ok: false, error: "junction failed" });
      return;
    }
    console.log(`[code] junction: ${target} → ${projectRoot}`);
  }
  writeStatus({ phase: "code" });
  const started = Date.now();
  console.log("[code] benny enrich (Tree-Sitter scan → code graph → correlate)…");
  const r = spawnSync(
    "python",
    ["benny_cli.py", "enrich", "--workspace", config.WORKSPACE, "--src", "src/prime-silo", "--run"],
    {
      cwd: path.join(projectRoot, "runtime"),
      encoding: "utf8",
      timeout: 3600000,
      // The enrich CLI prints progress glyphs (braille spinners) that crash
      // Python's cp1252 console encoder on Windows — force UTF-8 stdio.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    }
  );
  const ok = r.status === 0;
  const tail = ((r.stdout || "") + (r.stderr || ""))
    .split("\n")
    .filter(Boolean)
    .slice(-4)
    .join(" | ");
  console.log(
    `[code] ${ok ? "ok" : "FAILED"} (${((Date.now() - started) / 1000 / 60).toFixed(1)} min) ${tail.slice(0, 300)}`
  );
  appendLedger({ phase: "code", ok, ms: Date.now() - started, tail: tail.slice(0, 500) });
}

// -------------------------------------------------------------------- weave
// Discovery loops (the request: "loops of discovery… cross reference and
// discovery through the graph and the text"). Each loop: ask the model what
// is under-explored → answer each question from retrieval (chunks + graph
// concepts) → write a cited discovery note → ingest the note back, so the
// next loop (and every deliverable) stands on a richer corpus.
async function runWeave({ loops = null, questionsPerLoop = null } = {}) {
  const nLoops = loops ?? Number(opt("loops", 2));
  const nQuestions = questionsPerLoop ?? Number(opt("questions", 4));
  const discoveryDir = workspaceDir("data_out", "discovery");
  fs.mkdirSync(discoveryDir, { recursive: true });
  const outDir = workspaceDir("data_out");
  const themes = fs.existsSync(path.join(outDir, "THEMES.md"))
    ? fs.readFileSync(path.join(outDir, "THEMES.md"), "utf8")
    : "";

  for (let loop = 1; loop <= nLoops; loop++) {
    if (interrupted) break;
    const existingNotes = fs
      .readdirSync(discoveryDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => "- " + f.replace(/\.md$/, "").replace(/_/g, " "));
    const concepts = await graphCatalog(25);
    writeStatus({ phase: "weave", weave_loop: loop, weave_loops_total: nLoops });
    console.log(`[weave] loop ${loop}/${nLoops}: generating ${nQuestions} discovery questions…`);
    // Two attempts — local JSON mode sometimes wraps in prose or truncates.
    let qs = [];
    for (let attempt = 0; attempt < 2 && qs.length === 0; attempt++) {
      const started = Date.now();
      const res = await chat({
        system: prompt("discovery_questions"),
        user: [
          `Generate exactly ${nQuestions} questions.`,
          `## Current themes\n${themes.slice(0, 4000)}`,
          concepts.length ? `## Top graph concepts\n${concepts.join(", ")}` : "",
          existingNotes.length
            ? `## Notes already written\n${existingNotes.join("\n").slice(0, 1500)}`
            : "",
          attempt > 0 ? "Your previous answer was not valid JSON. Return ONLY the JSON object." : ""
        ]
          .filter(Boolean)
          .join("\n\n"),
        maxTokens: 900,
        json: true,
        temperature: attempt === 0 ? 0.6 : 0.3
      });
      qs = lastBalancedJson(res.content)?.questions || [];
      appendLedger({
        phase: "weave",
        artifact: `loop${loop}:questions`,
        ms: Date.now() - started,
        attempt,
        count: qs.length
      });
      if (!qs.length)
        console.log(
          `[weave] loop ${loop} attempt ${attempt + 1}: no questions parsed — head: ${res.content.slice(0, 100).replace(/\s+/g, " ")}`
        );
    }
    if (!qs.length) {
      console.log(`[weave] loop ${loop}: questions failed twice — stopping weave`);
      break;
    }

    const noteFiles = [];
    for (const [i, q] of qs.entries()) {
      if (interrupted) break;
      const noteName = `loop${loop}_q${i + 1}.md`;
      const notePath = path.join(discoveryDir, noteName);
      if (fs.existsSync(notePath)) continue;
      const t0 = Date.now();
      const evidence = await evidenceFor(q.question, { topK: 6, budget: 4200 });
      const note = await chat({
        system: prompt("discovery_note"),
        user: `## Question\n${q.question}\n\n## Why it matters\n${q.why || ""}\n\n## Retrieved evidence\n${evidence}`,
        maxTokens: 1100,
        temperature: 0.4
      });
      fs.writeFileSync(notePath, note.content.trim());
      noteFiles.push(noteName);
      appendLedger({
        phase: "weave",
        artifact: `loop${loop}:note${i + 1}`,
        ms: Date.now() - t0,
        prompt_tokens: note.prompt_tokens,
        completion_tokens: note.completion_tokens
      });
      console.log(`[weave] loop ${loop} note ${i + 1}/${qs.length}: ${q.question.slice(0, 70)}…`);
    }

    // Feed the notes back into the corpus so the NEXT loop (and opus retrieval)
    // can stand on them. Vectors are what retrieval needs; graph synthesis of
    // notes rides the same ingestBatch discipline.
    for (const name of noteFiles) {
      const stagedName = `longview_note_${name}`;
      fs.copyFileSync(path.join(discoveryDir, name), workspaceDir("data_in", stagedName));
      // Vectors only: notes exist for retrieval, and a deep-synthesis ingest
      // pays the full ~40-min clustering pass PER NOTE at this graph size.
      const verdict = await ingestBatch([stagedName], { deepSynthesis: false });
      appendLedger({
        phase: "weave",
        action: "ingest",
        file: stagedName,
        ok: verdict.ok,
        run_id: verdict.runId
      });
      console.log(
        `[weave] ingest ${stagedName}: ${verdict.ok ? "ok" : "FAILED (" + verdict.error + ")"}`
      );
      if (interrupted) break;
    }
  }
  writeStatus({ phase: "weave_done" });
}

// ---------------------------------------------------------------------- pdf
function runPdfPhase() {
  const bookMd = workspaceDir("data_out", "opus", "THE-AI-VAMPIRE.md");
  if (!fs.existsSync(bookMd)) {
    console.log(
      "[pdf] no assembled book at data_out/opus/THE-AI-VAMPIRE.md — run the opus phase first"
    );
    return;
  }
  const md = fs.readFileSync(bookMd, "utf8");
  const htmlPath = workspaceDir("data_out", "opus", "THE-AI-VAMPIRE.html");
  fs.writeFileSync(htmlPath, mdToHtml(md, { title: "The AI Vampire" }));
  const pdfPath = workspaceDir("data_out", "opus", "THE-AI-VAMPIRE.pdf");
  const r = htmlToPdf(htmlPath, pdfPath);
  appendLedger({ phase: "pdf", ok: r.ok, bytes: r.bytes, error: r.error });
  console.log(
    r.ok
      ? `[pdf] ${pdfPath} (${(r.bytes / 1024 / 1024).toFixed(1)} MB via ${r.browser})`
      : `[pdf] FAILED — ${r.error} (HTML is at ${htmlPath})`
  );
  writeStatus({ phase: "pdf_done", pdf: r.ok ? pdfPath : null });
}

// ------------------------------------------------------------ status/report
function runStatus() {
  const s = readStatus();
  if (!s) return console.log("no status yet — run inventory first");
  console.log(JSON.stringify(s, null, 2));
}

function runReport() {
  const ledger = readLedger();
  const maps = [...mapVerdicts().values()];
  const ok = maps.filter((e) => e.status === "ok");
  const failed = maps.filter((e) => e.status === "failed");
  const thin = maps.filter((e) => e.status === "skipped_thin");
  const msArr = ok
    .map((e) => e.ms)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const median = msArr.length ? msArr[Math.floor(msArr.length / 2)] : 0;
  const mean = msArr.length ? msArr.reduce((a, b) => a + b, 0) / msArr.length : 0;
  const tok = (k) => ok.reduce((a, e) => a + (e[k] || 0), 0);
  const estimated = ok.some((e) => e.usage_estimated);
  let total = 0;
  try {
    total = loadInventory().length;
  } catch {
    /* no inventory */
  }
  const remaining = Math.max(0, total - maps.length);
  const reduces = ledger.filter((e) => e.phase === "reduce");
  console.log(
    [
      "LONGVIEW ledger report (every number below comes from the ledger)",
      `  inventory total : ${total || "unknown"}`,
      `  cards ok        : ${ok.length}`,
      `  map failed      : ${failed.length}`,
      `  skipped thin    : ${thin.length}`,
      `  remaining       : ${remaining}`,
      `  per-card median : ${(median / 1000).toFixed(1)}s   mean: ${(mean / 1000).toFixed(1)}s`,
      `  throughput      : ${mean ? (3600000 / mean).toFixed(1) : "?"} cards/hour`,
      `  est. remaining  : ${mean ? ((remaining * mean) / 3600000).toFixed(1) : "?"} hours`,
      `  tokens (map)    : prompt ${tok("prompt_tokens")}, completion ${tok("completion_tokens")}${estimated ? " (some ESTIMATED — server omitted usage)" : ""}`,
      `  reduce artifacts: ${reduces.length}`,
      failed.length ? `  failed sids     : ${failed.map((e) => sid8(e.session_id)).join(", ")}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  );
}

// -------------------------------------------------------------------- delta
async function runDelta() {
  await runInventory();
  runExtractForce(); // extract only missing/changed packs
  const before = [...mapVerdicts().values()].filter((v) => v.status === "ok").length;
  await runMap({ deltaMode: true });
  const after = [...mapVerdicts().values()].filter((v) => v.status === "ok").length;
  const newCards = after - before;
  await runModel();
  if (flag("refresh") || newCards >= config.DELTA_REDUCE_THRESHOLD) {
    console.log(`[delta] ${newCards} new cards → re-running reduce`);
    await runReduce();
  } else {
    console.log(
      `[delta] ${newCards} new cards (< ${config.DELTA_REDUCE_THRESHOLD}) — reduce skipped; use --refresh to force`
    );
  }
}

// Delta extract: rebuild packs for sessions newer than their existing pack.
function runExtractForce() {
  const inventory = loadInventory();
  const sessionById = new Map(listSessions().map((s) => [s.id, s]));
  let done = 0;
  for (const item of inventory) {
    if (interrupted) break;
    const p = evidencePath(item.id);
    if (fs.existsSync(p) && fs.statSync(p).mtimeMs >= (item.timestamp || 0)) continue;
    const session = sessionById.get(item.id);
    if (!session) continue;
    const ev = buildEvidencePack(session);
    fs.writeFileSync(p, ev.pack);
    fs.writeFileSync(
      evidenceMetaPath(item.id),
      JSON.stringify(
        {
          signal_chars: ev.signalChars,
          artifact_names: ev.artifactNames,
          project: ev.project,
          first_ts: ev.firstTs,
          last_ts: ev.lastTs
        },
        null,
        2
      )
    );
    done++;
  }
  console.log(`[extract:delta] rebuilt ${done} packs`);
}

// ----------------------------------------------------------------- manifest
// Declarative mode: the manifest (runtime/manifests/templates/
// longview_synthesis.json) is the definition of record — variables map onto
// config, plan.phases decide what runs. Per ADR-005 §4 the phases are the
// manifest's tasks; the per-session fan-out stays inside the map phase.
function loadManifest() {
  const defaultPath = path.join(
    projectRoot,
    "runtime",
    "manifests",
    "templates",
    "longview_synthesis.json"
  );
  const p = opt("manifest", args[1] && !args[1].startsWith("--") ? args[1] : defaultPath);
  // Packaged installs ship scripts/ but not runtime/ (the runtime is a fetched
  // asset) — fall back to the built-in defaults, which mirror the template.
  let manifest;
  if (fs.existsSync(p)) {
    manifest = JSON.parse(fs.readFileSync(p, "utf8"));
  } else {
    console.log(`[run] manifest not found at ${p} — using built-in defaults (all phases)`);
    manifest = {
      id: "longview_synthesis(builtin-defaults)",
      workspace: config.WORKSPACE,
      variables: {},
      plan: {
        phases: ["inventory", "extract", "map", "model", "reduce"].map((id) => ({
          id,
          enabled: true
        }))
      }
    };
  }
  const v = manifest.variables || {};
  if (manifest.workspace) config.WORKSPACE = manifest.workspace;
  if (v.model) config.LONGVIEW_MODEL = v.model;
  if (v.ingest_model) config.INGEST_MODEL = v.ingest_model;
  if (v.evidence_budget_chars) config.EVIDENCE_BUDGET_CHARS = Number(v.evidence_budget_chars);
  if (v.reduce_input_chars) config.REDUCE_INPUT_BUDGET = Number(v.reduce_input_chars);
  if (v.card_max_tokens) config.CARD_MAX_TOKENS = Number(v.card_max_tokens);
  if (v.reduce_max_tokens) config.REDUCE_MAX_TOKENS = Number(v.reduce_max_tokens);
  if (v.thin_session_chars) config.THIN_SESSION_CHARS = Number(v.thin_session_chars);
  if (v.delta_reduce_threshold) config.DELTA_REDUCE_THRESHOLD = Number(v.delta_reduce_threshold);
  if (v.ingest_batch_size) config.INGEST_BATCH = Number(v.ingest_batch_size);
  if (typeof v.deep_synthesis === "boolean") config.DEEP_SYNTHESIS = v.deep_synthesis;
  return { path: p, manifest };
}

async function runManifest() {
  const { path: manifestPath, manifest } = loadManifest();
  ensureWorkspace(); // the manifest may have switched the workspace
  acquireLock();
  console.log(
    `[run] manifest ${manifest.id} (${path.basename(manifestPath)}) → workspace '${config.WORKSPACE}', model ${config.LONGVIEW_MODEL}`
  );
  if (flag("delta")) {
    await runDelta();
    return;
  }
  const onlyPhase = opt("phase", null);
  const phases = (manifest.plan?.phases || []).filter((ph) =>
    onlyPhase ? ph.id === onlyPhase : ph.enabled !== false
  );
  if (onlyPhase && phases.length === 0) {
    console.error(`[run] phase '${onlyPhase}' not found in manifest`);
    process.exit(2);
  }
  for (const ph of phases) {
    if (interrupted) break;
    console.log(`[run] phase: ${ph.id}`);
    // Phase isolation: a throwing phase is ledgered and skipped, never fatal —
    // the opus outline throw on the 2026-07-03 run killed the process and took
    // the pdf phase (and the whole book) down with it.
    try {
      if (ph.id === "inventory") await runInventory();
      else if (ph.id === "extract") runExtract();
      else if (ph.id === "map") await runMap({ limitOverride: Number(ph.limit) || Infinity });
      else if (ph.id === "model") await runModel();
      else if (ph.id === "code") await runCode();
      else if (ph.id === "weave")
        await runWeave({
          loops: Number(ph.loops) || null,
          questionsPerLoop: Number(ph.questions) || null
        });
      else if (ph.id === "reduce")
        await runReduce({
          onlyOverride: Array.isArray(ph.only) && ph.only.length ? ph.only : null,
          skipBookOverride: ph.skip_book === true ? true : null
        });
      else if (ph.id === "opus") await runOpus({ interrupted: () => interrupted });
      else if (ph.id === "pdf") runPdfPhase();
      else console.log(`[run] unknown phase '${ph.id}' — skipped`);
    } catch (e) {
      const error = String((e && e.message) || e);
      appendLedger({ phase: ph.id, action: "phase_error", ok: false, error });
      console.log(`[run] phase ${ph.id} FAILED — ${error} (continuing with remaining phases)`);
    }
  }
}

// --------------------------------------------------------------------- main
// "run" locks inside runManifest — after the manifest has set the workspace,
// so the lock lands in the workspace it actually guards.
const MUTATING_COMMANDS = new Set([
  "all",
  "delta",
  "inventory",
  "extract",
  "map",
  "model",
  "code",
  "weave",
  "reduce",
  "opus",
  "pdf"
]);

async function main() {
  ensureWorkspace();
  if (MUTATING_COMMANDS.has(command)) acquireLock();
  switch (command) {
    case "run":
      await runManifest();
      break;
    case "inventory":
      await runInventory();
      break;
    case "extract":
      runExtract();
      break;
    case "map":
      await runMap();
      break;
    case "model":
      await runModel();
      break;
    case "code":
      await runCode();
      break;
    case "weave":
      await runWeave();
      break;
    case "reduce":
      await runReduce();
      break;
    case "opus":
      await runOpus({ interrupted: () => interrupted });
      break;
    case "pdf":
      runPdfPhase();
      break;
    case "all":
      await runInventory();
      runExtract();
      await runMap();
      if (!interrupted) await runModel();
      if (!interrupted) await runReduce();
      break;
    case "delta":
      await runDelta();
      break;
    case "status":
      runStatus();
      break;
    case "report":
      runReport();
      break;
    default:
      console.error(`unknown command '${command}' — see header of this file`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
