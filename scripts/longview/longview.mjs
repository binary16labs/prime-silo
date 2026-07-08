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
import { evidenceFor, graphCatalog, graphNeighbors } from "./lib/retrieve.mjs";
import { mdToHtml, htmlToPdf } from "./lib/book_pdf.mjs";
import { config, ensureWorkspace, workspaceDir, stateDir, projectRoot, envValue } from "./lib/config.mjs";
import { taskStalled, reconcileIngested, isStallVerdict } from "./lib/ingest_state.mjs";
import { syncStore, listSessions } from "./lib/store.mjs";
import { buildEvidencePack } from "./lib/evidence.mjs";
import { walkSessionWindows } from "./lib/walk.mjs";
import { chat, lastBalancedJson, repairTruncatedJson } from "./lib/llm.mjs";
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

// Graph-walk extraction helpers (ADR-005). Each window yields a tiny fragment;
// the card is assembled from all fragments in code (lossless) so the model never
// has to emit a large 12-field object (which it truncates at ~415 tokens).
// Fragment cache is keyed by window size: changing LONGVIEW_WINDOW_CHARS (e.g.
// after raising the FLM ctx_size) re-windows a session, so old fragments must
// not be mixed with the new layout.
const windowFragPath = (id, n) =>
  stateDir("windows", id, `w${config.WINDOW_INPUT_CHARS}_${n}.json`);
const FRAG_LISTS = [
  "decisions",
  "outcomes",
  "failures",
  "capabilities",
  "applications",
  "artifacts",
  "concepts",
  "skills_observed",
  "operator_traits",
  "open_threads",
  "proposed_next",
  "evidence"
];

function uniqCap(arr, cap) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = String(x == null ? "" : x).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function mergeFragments(fragments) {
  const m = {};
  for (const key of FRAG_LISTS) m[key] = [];
  let project = "";
  for (const f of fragments) {
    if (!f || typeof f !== "object") continue;
    if (!project && typeof f.project === "string" && f.project.trim()) project = f.project.trim();
    for (const key of FRAG_LISTS) {
      const v = f[key];
      if (Array.isArray(v)) for (const x of v) if (typeof x === "string") m[key].push(x);
    }
  }
  return { project, ...m };
}

// Deterministic, lossless assembly of the 12-field card from window fragments,
// plus ONE tiny LLM call for the human-readable intent line.
async function assembleCard(item, fragments) {
  const m = mergeFragments(fragments);
  const project = m.project || item.metadata?.project || item.project || "unknown";
  const period = new Date(item.timestamp || Date.now()).toISOString().slice(0, 7); // YYYY-MM
  const decisions = uniqCap(m.decisions, 6);
  const outcomes = uniqCap(m.outcomes, 6);
  const failures = uniqCap(m.failures, 6);
  const capabilities = uniqCap(m.capabilities, 6);
  const applications = uniqCap([...m.applications, project], 6);
  let evidence = uniqCap([...m.evidence, ...m.artifacts], 6);
  if (!evidence.length) evidence = [project];

  let intent = "";
  const intentTokens = { prompt: 0, completion: 0 };
  // The intent sentence is a nice-to-have (card body summary) and falls back to a
  // deterministic template below. On slow reasoning models it doubles per-session
  // latency, so LONGVIEW_INTENT_MAX_TOKENS=0 skips the call entirely.
  if (config.INTENT_MAX_TOKENS > 0) try {
    const highlights = [
      `project: ${project}`,
      decisions.length ? `decisions: ${decisions.join("; ")}` : "",
      outcomes.length ? `outcomes: ${outcomes.join("; ")}` : "",
      failures.length ? `failures: ${failures.join("; ")}` : ""
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
    const res = await chat({
      system:
        "You summarise one working session's intent in 1-3 plain-language sentences (what the operator was trying to achieve). Output the sentences only — no JSON, no preamble.",
      user: highlights,
      maxTokens: config.INTENT_MAX_TOKENS,
      json: false,
      temperature: 0.3
    });
    intent = (res.content || "").replace(/\s+/g, " ").trim();
    intentTokens.prompt = res.prompt_tokens;
    intentTokens.completion = res.completion_tokens;
  } catch {
    /* fall back below */
  }
  if (intent.length < 20) {
    intent = `Work on ${project}: ${outcomes[0] || decisions[0] || "session activity"}`.slice(
      0,
      300
    );
    if (intent.length < 20) intent = `Working session on ${project} (${period}).`;
  }

  const card = {
    project,
    period,
    intent,
    applications,
    capabilities,
    decisions,
    outcomes,
    failures,
    skills_observed: uniqCap(m.skills_observed, 6),
    operator_traits: uniqCap(m.operator_traits, 6),
    open_threads: uniqCap(m.open_threads, 6),
    proposed_next: uniqCap(m.proposed_next, 6),
    evidence,
    concepts: uniqCap(m.concepts, 12)
  };
  return { card, intentTokens };
}

// ---------------------------------------------------------------------- map
async function runMap({ deltaMode = false, limitOverride = null } = {}) {
  const inventory = loadInventory();
  const limit = limitOverride ?? (Number(opt("limit", 0)) || Infinity);
  const verdicts = mapVerdicts();
  const fragmentSystem = prompt("window_fragment");

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
    const started = Date.now();
    let card = null,
      gateErrors = [],
      retries = 0,
      tokens = { prompt: 0, completion: 0, estimated: false };

    try {
      // Walk the FULL session timeline in short windows; extract a tiny fragment
      // per window (cached under windows/<sid>/<n>.json — resume-safe, so a restart
      // never re-runs completed windows even for 1000+ step sessions), then assemble
      // the card losslessly in code so the model never emits a large (truncating) object.
      const { windows, stepCount } = walkSessionWindows(item, {
        inputChars: config.WINDOW_INPUT_CHARS
      });
      // Benny Record provenance: which timeline steps each window covered.
      fs.mkdirSync(stateDir("windows", item.id), { recursive: true });
      fs.writeFileSync(
        stateDir("windows", item.id, "manifest.json"),
        JSON.stringify({
          session_id: item.id,
          agent: item.agent,
          step_count: stepCount,
          window_chars: config.WINDOW_INPUT_CHARS,
          windows: windows.map((w) => ({
            index: w.index,
            steps: [w.steps[0] ?? 0, w.steps[w.steps.length - 1] ?? 0],
            chars: w.text.length
          }))
        })
      );
      const fragments = [];
      for (const w of windows) {
        if (interrupted) break;
        const fp = windowFragPath(item.id, w.index);
        if (fs.existsSync(fp)) {
          fragments.push(JSON.parse(fs.readFileSync(fp, "utf8")));
          continue;
        }
        let frag = {};
        try {
          const res = await chat({
            system: fragmentSystem,
            user: w.text,
            maxTokens: config.FRAGMENT_MAX_TOKENS,
            json: true
          });
          tokens.prompt += res.prompt_tokens;
          tokens.completion += res.completion_tokens;
          tokens.estimated = res.usage_estimated;
          frag = lastBalancedJson(res.content) || repairTruncatedJson(res.content) || {};
        } catch (e) {
          frag = { _error: String(e.message) };
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(frag));
        fragments.push(frag);
      }
      const { card: assembled, intentTokens } = await assembleCard(item, fragments);
      tokens.prompt += intentTokens.prompt;
      tokens.completion += intentTokens.completion;
      gateErrors = validateCard(assembled, { sessionId: item.id, agent: item.agent });
      if (gateErrors.length === 0) card = assembled;
    } catch (e) {
      gateErrors = [`walk error: ${e.message}`];
    }

    const ms = Date.now() - started;
    if (card) {
      fs.writeFileSync(cardPath(item.id), JSON.stringify(card, null, 2));
      fs.writeFileSync(
        stateDir("cards", `${item.id}.meta.json`),
        JSON.stringify({
          session_id: item.id,
          window_chars: config.WINDOW_INPUT_CHARS,
          tokens,
          ms,
          model: config.LONGVIEW_MODEL,
          ts: new Date().toISOString()
        })
      );
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
  // Deterministic order (enterprise reproducibility): never depend on fs
  // enumeration order — sort by (period, session_id) so every downstream
  // deliverable sees the corpus identically on every run.
  const dir = stateDir("cards");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort(
      (a, b) =>
        (a.period || "").localeCompare(b.period || "") ||
        String(a.session_id).localeCompare(String(b.session_id))
    );
}

// Deterministic chronological spine (no LLM): cards → data_out/TIMELINE.md,
// grouped by month with (sid) citations. Feeds the dossier/theme calls and the
// opus outline so the book follows the actual arc of the journey.
function buildTimelineMd(cards) {
  const byMonth = new Map();
  for (const c of cards) {
    const m = c.period || "unknown";
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(c);
  }
  const months = [...byMonth.keys()].sort();
  const lines = ["# Timeline — the journey month by month", ""];
  for (const m of months) {
    lines.push(`## ${m}`);
    for (const c of byMonth.get(m)) {
      const top = (c.outcomes || [])[0] || (c.decisions || [])[0] || "";
      lines.push(
        `- **${c.project}** — ${String(c.intent || "").slice(0, 160)}${top ? ` Key: ${String(top).slice(0, 120)}.` : ""} (sid: ${sid8(c.session_id)})`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
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
  // 4th section: the walk-extracted concepts + evidence, so deep synthesis
  // anchors its triples on the already-distilled entities instead of
  // re-deriving them from prose (a second lossy LLM pass). Still 4 H2s —
  // inside the 10-section/doc synthesis cap.
  const grounding = [list("concepts", "Concepts"), list("evidence", "Evidence")]
    .filter(Boolean)
    .join("\n\n");
  return [
    `# Session card: ${card.project} (${card.period})`,
    `Session ${card.session_id} · agent ${card.agent}`,
    `\n## Overview\n${overview || "(none)"}`,
    `\n## What happened\n${happened || "(none)"}`,
    `\n## Threads and signals\n${threads || "(none)"}`,
    `\n## Concepts and evidence\n${grounding || "(none)"}`
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
    // A8: a task whose own record stops advancing is wedged, whatever the
    // batch deadline says — fail fast with the evidence.
    if (taskStalled(task, Date.now(), config.INGEST_STALL_MS)) {
      return {
        ok: false,
        runId,
        error: `stalled: no task progress for ${Math.round(config.INGEST_STALL_MS / 60000)} min (task updated_at ${task.updated_at})`
      };
    }
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
  // A8.1 (startup reconcile): a run killed mid-batch — or one that failed
  // before the reconcile logic existed — never marked its completed files, so
  // a FRESH process recomputed "pending" from a stale/absent ingested.json and
  // re-ingested finished cards (observed 2026-07-06: relaunch saw 164 pending
  // instead of 124 and re-ran the 40-card batch 1). Wiki evidence is ground
  // truth regardless of which process produced it — reconcile BEFORE deciding
  // what is pending, not only after an in-run failure.
  if (config.DEEP_SYNTHESIS) {
    const allNames = cards.map((c) => `longview_card_${sid8(c.session_id)}.md`);
    const recovered = reconcileIngested(allNames, workspaceDir(".benny", "wiki"), fs, ingestedSet);
    if (recovered.length) {
      fs.writeFileSync(ingestedPath, JSON.stringify([...ingestedSet], null, 2));
      console.log(
        `[model] startup reconcile: ${recovered.length} cards already synthesized (wiki evidence) — skipping`
      );
      appendLedger({ phase: "model", action: "ingest_reconcile_startup", files: recovered.length });
    }
  }
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
      } else if (config.DEEP_SYNTHESIS) {
        // A8: the server writes .benny/wiki/<name>.md per synthesized doc —
        // ground truth for what a dead batch actually finished. Without this,
        // a batch that died at file 39/40 re-ingested all 40 on retry.
        const recovered = reconcileIngested(batch, workspaceDir(".benny", "wiki"), fs, ingestedSet);
        if (recovered.length) {
          fs.writeFileSync(ingestedPath, JSON.stringify([...ingestedSet], null, 2));
          console.log(
            `[model] reconciled ${recovered.length}/${batch.length} files already synthesized (wiki evidence) — retry will skip them`
          );
          appendLedger({
            phase: "model",
            action: "ingest_reconcile",
            files: recovered.length,
            run_id: verdict.runId
          });
        }
      }
      if (isStallVerdict(verdict)) {
        // A8.2: a stalled server task is still ALIVE in unknown state —
        // firing the next batch at it stacks synthesis tasks on a sick
        // server (2026-07-02 embedder overload). Stop the phase honestly;
        // the operator restarts the runtime to clear the hung task, then
        // reruns — startup reconcile (A8.1) resumes at the right card.
        appendLedger({
          phase: "model",
          action: "phase_error",
          error:
            "ingest stalled — stopping model phase (restart the benny runtime to clear the hung server task, then rerun; resume is automatic)"
        });
        console.error(
          "[model] STOPPED: server ingest task stalled. Restart the benny runtime (clears the hung synthesis task), then rerun `longview run` — startup reconcile resumes at the first unfinished card."
        );
        break;
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
  if (ok) {
    fs.writeFileSync(outPath, res.content);
    // Benny Record provenance: what fed this deliverable + what it cost.
    fs.writeFileSync(
      outPath + ".meta.json",
      JSON.stringify({
        artifact: name,
        input_chars: user.length,
        input_head: user.slice(0, 400),
        prompt_tokens: res.prompt_tokens,
        completion_tokens: res.completion_tokens,
        model: config.LONGVIEW_MODEL,
        ts: new Date().toISOString()
      })
    );
  }
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

  // Chronological spine — deterministic, byte-identical for the same cards.
  const timelineMd = buildTimelineMd(cards);
  fs.writeFileSync(outDir("TIMELINE.md"), timelineMd);

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

  // Review notes (post-graph collation pass) — when they exist, themes stand on
  // the cross-session "greater than the sum" material too. Sorted read: determinism.
  let reviewDigest = "";
  try {
    const rDir = outDir("reviews");
    reviewDigest = fs
      .readdirSync(rDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => fs.readFileSync(path.join(rDir, f), "utf8").slice(0, 1000))
      .join("\n\n---\n\n")
      .slice(0, 8000);
  } catch {
    /* no review phase yet */
  }

  if (want("themes") && !interrupted) {
    themes = await reduceCall(
      "themes",
      prompt("themes"),
      `${dossierSummaries}\n\n## Timeline (chronological spine)\n${timelineMd.slice(0, 6000)}\n\n## Operator rollup\n${rollup("operator").slice(0, 6000)}${discoveryDigest ? `\n\n## Discovery notes (cross-reference findings)\n${discoveryDigest}` : ""}${reviewDigest ? `\n\n## Session reviews (post-graph collation)\n${reviewDigest}` : ""}`,
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
    let outline = lastBalancedJson(outlineRaw);
    // Early-stop truncation loses the closing braces and lastBalancedJson
    // then returns an inner object — salvage the complete chapters instead
    // (yesterday's outline.json on disk ended exactly this way).
    if (!outline?.chapters?.length) outline = repairTruncatedJson(outlineRaw);
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
        `  --var model=${config.LONGVIEW_MODEL} ^`,
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

// Graph enrichment (ADR-005 horizontal mechanism, knowledge half): after the
// corpus is ingested + woven, connect the per-document concept islands into a
// cross-session web — persist embeddings, canonical-merge near-duplicate concepts
// (so a recurring idea becomes one node sized by merge_count), add cross-document
// similarity links, promote typed relations, and re-cluster into named themes.
// Reuses `benny enrich-graph` end to end (fast: reuses persisted embeddings).
async function runEnrichGraph() {
  writeStatus({ phase: "enrich" });
  const started = Date.now();
  console.log("[enrich] benny enrich-graph (merge → cross-doc links → rel_class → themes)…");
  const r = spawnSync(
    "python",
    [
      "benny_cli.py",
      "enrich-graph",
      "--workspace",
      config.WORKSPACE,
      "--apply",
      "--model",
      config.INGEST_MODEL
    ],
    {
      cwd: path.join(projectRoot, "runtime"),
      encoding: "utf8",
      timeout: 3600000,
      // Same cp1252 braille-glyph guard as runCode.
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
    `[enrich] ${ok ? "ok" : "FAILED"} (${((Date.now() - started) / 1000 / 60).toFixed(1)} min) ${tail.slice(0, 300)}`
  );
  appendLedger({ phase: "enrich", ok, ms: Date.now() - started, tail: tail.slice(0, 500) });
}

// -------------------------------------------------------------------- review
// Post-graph session review (the "greater than the sum" pass, ADR-005). Runs
// after enrich, so the concept graph + cross-document links + themes exist. For
// each session card it pulls the session's concepts and their graph neighbours
// (concepts from OTHER sessions that connect to it) and writes a graph-grounded
// review note collating the session's contribution in the context of the corpus.
async function runReview({ limitOverride = null } = {}) {
  const reviewsDir = workspaceDir("data_out", "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });
  const system = prompt("session_review");
  const cardsDir = stateDir("cards");
  let cardFiles = [];
  try {
    cardFiles = fs
      .readdirSync(cardsDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .sort();
  } catch {
    cardFiles = [];
  }
  const limit = limitOverride ?? (Number(opt("limit", 0)) || Infinity);
  let done = 0,
    skipped = 0,
    processed = 0;

  for (const cf of cardFiles) {
    if (processed >= limit || interrupted) break;
    const sid = cf.replace(/\.json$/, "");
    const notePath = path.join(reviewsDir, `${sid}.md`);
    if (!flag("force") && fs.existsSync(notePath)) {
      skipped++;
      continue;
    }
    let card;
    try {
      card = JSON.parse(fs.readFileSync(path.join(cardsDir, cf), "utf8"));
    } catch {
      continue;
    }
    processed++;
    const anchors = uniqCap([...(card.concepts || []), ...(card.capabilities || [])], 6);
    const related = [];
    for (const a of anchors.slice(0, 4)) {
      if (interrupted) break;
      for (const n of await graphNeighbors(a, 6)) if (!anchors.includes(n)) related.push(n);
    }
    const relatedUniq = uniqCap(related, 20);
    const user = [
      `## Session card`,
      `project: ${card.project}`,
      `intent: ${card.intent}`,
      card.decisions?.length ? `decisions: ${card.decisions.join("; ")}` : "",
      card.outcomes?.length ? `outcomes: ${card.outcomes.join("; ")}` : "",
      card.failures?.length ? `failures: ${card.failures.join("; ")}` : "",
      `\n## This session's concepts`,
      anchors.join(", ") || "(none)",
      `\n## Related concepts from other sessions (graph)`,
      relatedUniq.join(", ") || "(none found)"
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, config.REVIEW_INPUT_CHARS);

    const started = Date.now();
    let note = "";
    try {
      const res = await chat({
        system,
        user,
        maxTokens: config.REVIEW_MAX_TOKENS,
        json: false,
        temperature: 0.35
      });
      note = (res.content || "").trim();
    } catch (e) {
      note = "";
    }
    if (note.length > 40) {
      fs.writeFileSync(notePath, `# Review: ${card.project} — ${sid8(sid)}\n\n${note}\n`);
      appendLedger({
        phase: "review",
        session_id: sid,
        status: "ok",
        ms: Date.now() - started,
        anchors,
        related_concepts: relatedUniq.slice(0, 12)
      });
      done++;
      console.log(`[review] ok  ${sid8(sid)} ${card.project}`);
    } else {
      appendLedger({
        phase: "review",
        session_id: sid,
        status: "failed",
        ms: Date.now() - started
      });
      console.log(`[review] FAIL ${sid8(sid)}`);
    }
    writeStatus({ phase: "review", reviews_done: done });
  }
  console.log(`[review] done: ok=${done} skipped=${skipped}`);

  // Make the review notes retrievable: stage into data_in and ingest as vectors
  // (no deep synthesis — the collation prose doesn't need re-conceptualising).
  // opus sections and weave loops then surface them via evidenceFor()/ragQuery.
  try {
    const ingestedPath = stateDir("rollups", "reviews_ingested.json");
    let ingested = [];
    try {
      ingested = JSON.parse(fs.readFileSync(ingestedPath, "utf8"));
    } catch {
      /* first run */
    }
    const ingestedSet = new Set(ingested);
    const pending = [];
    for (const f of fs
      .readdirSync(reviewsDir)
      .filter((x) => x.endsWith(".md"))
      .sort()) {
      const name = `longview_review_${sid8(f.replace(/\.md$/, ""))}.md`;
      if (ingestedSet.has(name)) continue;
      fs.writeFileSync(
        workspaceDir("data_in", name),
        fs.readFileSync(path.join(reviewsDir, f), "utf8")
      );
      pending.push(name);
    }
    if (pending.length && !interrupted) {
      console.log(`[review] ingesting ${pending.length} review notes (vectors)…`);
      const verdict = await ingestBatch(pending, { deepSynthesis: false });
      if (verdict.ok) {
        for (const n of pending) ingestedSet.add(n);
        fs.writeFileSync(ingestedPath, JSON.stringify([...ingestedSet], null, 2));
      }
      appendLedger({
        phase: "review",
        action: "ingest_reviews",
        ok: verdict.ok,
        files: pending.length
      });
    }
  } catch (e) {
    appendLedger({
      phase: "review",
      action: "ingest_reviews",
      ok: false,
      error: String(e.message)
    });
  }
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
  // Precedence: an explicitly-set LONGVIEW_WORKSPACE env wins over the manifest
  // default. Found live: `LONGVIEW_WORKSPACE=longview_v2 … run` silently ran
  // against 'longview' because the manifest hardcodes its workspace — an
  // operator's explicit target must never be overridden by a template default.
  if (manifest.workspace && !process.env.LONGVIEW_WORKSPACE) {
    config.WORKSPACE = manifest.workspace;
  }
  // Same precedence for the model: an explicit LONGVIEW_MODEL / BENNY_DEFAULT_MODEL
  // profile (or the ingest equivalents) wins over the manifest's preconfigured
  // default, so provider/model profiles and eval sweeps drive the run dynamically
  // without editing the template. Manifest value applies only when no profile is set.
  if (v.model && !envValue("LONGVIEW_MODEL") && !envValue("BENNY_DEFAULT_MODEL")) {
    config.LONGVIEW_MODEL = v.model;
  }
  if (v.ingest_model && !envValue("LONGVIEW_INGEST_MODEL") && !envValue("BENNY_DEFAULT_MODEL")) {
    config.INGEST_MODEL = v.ingest_model;
  }
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
  // Enterprise reproducibility: pin this run to an exact configuration. Every
  // deliverable (incl. the book) is then attributable to a commit + model + ctx
  // + budgets via the ledger.
  try {
    let gitCommit = "unknown";
    try {
      gitCommit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: projectRoot,
        encoding: "utf8"
      }).stdout.trim();
    } catch {
      /* not a checkout */
    }
    let ctx = null;
    try {
      const ro = JSON.parse(
        fs.readFileSync(
          path.join(process.env.USERPROFILE || "", ".cache", "lemonade", "recipe_options.json"),
          "utf8"
        )
      );
      ctx = ro[config.LONGVIEW_MODEL]?.ctx_size ?? null;
    } catch {
      /* lemonade config not readable */
    }
    appendLedger({
      phase: "run",
      action: "run_config",
      git_commit: gitCommit,
      model: config.LONGVIEW_MODEL,
      ingest_model: config.INGEST_MODEL,
      ctx_size: ctx,
      window_chars: config.WINDOW_INPUT_CHARS,
      fragment_max_tokens: config.FRAGMENT_MAX_TOKENS,
      evidence_budget: config.EVIDENCE_BUDGET_CHARS,
      reduce_input: config.REDUCE_INPUT_BUDGET,
      workspace: config.WORKSPACE,
      phases: phases.map((p) => p.id)
    });
  } catch {
    /* the snapshot is best-effort — never blocks the run */
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
      else if (ph.id === "enrich") await runEnrichGraph();
      else if (ph.id === "review") await runReview({ limitOverride: Number(ph.limit) || null });
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
    case "enrich":
      await runEnrichGraph();
      break;
    case "review":
      await runReview();
      break;
    case "record": {
      // Benny Record: ordered action timeline + lineage breadcrumbs for a scope
      // (run | card:<sid8> | section:<id> | dossier:<name> | book).
      const { recordFor, lineageFor } = await import("./lib/record.mjs");
      const scope = args[1] && !args[1].startsWith("--") ? args[1] : "run";
      const rec = recordFor(scope);
      const lin = lineageFor(scope);
      if (flag("json")) {
        console.log(JSON.stringify({ record: rec, lineage: lin }, null, 2));
      } else {
        console.log(`[record] ${scope} — ${rec.actions.length} actions`);
        for (const a of rec.actions.slice(-40)) {
          console.log(`  ${a.ts || ""} ${a.caption}${a.tokens ? ` [${a.tokens} tok]` : ""}`);
        }
        console.log(`[lineage] ${lin.nodes.length} nodes:`);
        for (const n of lin.nodes.slice(0, 40)) {
          console.log(
            `  ${"  ".repeat(n.depth)}${n.type}: ${n.label}${n.meta?.log_path ? ` → ${n.meta.log_path}` : ""}`
          );
        }
      }
      break;
    }
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
