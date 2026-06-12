/* ═══════════════════════════════════════════════════════════════
   PRIME-SILO site — app.js
   Vanilla JS, no build step. Particle warp fields, deconstruction
   overlays, manifest-driven config wizard, live dashboard.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ────────────────────────────────────────────────────────────────
   1. WARP PARTICLE FIELD (hero + wizard background)
   Starfield with z-perspective; warp() accelerates particles into
   streaks for step transitions.
   ──────────────────────────────────────────────────────────────── */

function createWarpField(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const COUNT = opts.count || 220;
  const BASE_SPEED = opts.speed || 0.6;
  let speed = BASE_SPEED;
  let targetSpeed = BASE_SPEED;
  let w = 0, h = 0, cx = 0, cy = 0;
  let stars = [];
  let raf = null;
  let visible = true;

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = canvas.width = Math.max(1, Math.floor(r.width * devicePixelRatio));
    h = canvas.height = Math.max(1, Math.floor(r.height * devicePixelRatio));
    cx = w / 2; cy = h / 2;
  }

  function spawn(initial) {
    return {
      x: (Math.random() - 0.5) * w,
      y: (Math.random() - 0.5) * h,
      z: initial ? Math.random() * w : w,
      pz: 0,
      hue: Math.random() < 0.5 ? 188 : (Math.random() < 0.5 ? 262 : 320)
    };
  }

  function init() {
    resize();
    stars = Array.from({ length: COUNT }, () => spawn(true));
    stars.forEach(s => { s.pz = s.z; });
  }

  function frame() {
    if (!visible) { raf = requestAnimationFrame(frame); return; }
    speed += (targetSpeed - speed) * 0.06;
    ctx.fillStyle = opts.trail ? "rgba(5,6,13,0.32)" : "rgba(5,6,13,0.6)";
    ctx.fillRect(0, 0, w, h);

    for (const s of stars) {
      s.pz = s.z;
      s.z -= speed * devicePixelRatio * 4;
      if (s.z < 1) {
        Object.assign(s, spawn(false));
        s.pz = s.z;
        continue;
      }
      const sx = (s.x / s.z) * w * 0.5 + cx;
      const sy = (s.y / s.z) * h * 0.5 + cy;
      const px = (s.x / s.pz) * w * 0.5 + cx;
      const py = (s.y / s.pz) * h * 0.5 + cy;
      const size = Math.max(0.4, (1 - s.z / w) * 2.6 * devicePixelRatio);
      const alpha = Math.min(1, (1 - s.z / w) * 1.4);
      ctx.strokeStyle = `hsla(${s.hue}, 95%, 70%, ${alpha})`;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }

  // Pause when off-screen — keeps the page light.
  const io = new IntersectionObserver(
    (entries) => { visible = entries[0].isIntersecting; },
    { threshold: 0 }
  );
  io.observe(canvas);

  window.addEventListener("resize", resize);
  init();
  frame();

  return {
    warp(durationMs = 700, factor = 14) {
      targetSpeed = BASE_SPEED * factor;
      setTimeout(() => { targetSpeed = BASE_SPEED; }, durationMs);
    },
    destroy() { cancelAnimationFrame(raf); io.disconnect(); }
  };
}

const heroField = createWarpField(document.getElementById("warpCanvas"), { count: 240, speed: 0.55, trail: true });
const wizardField = createWarpField(document.getElementById("wizardWarp"), { count: 130, speed: 0.3, trail: true });

/* ────────────────────────────────────────────────────────────────
   2. FEATURE DATA + GRID + DECONSTRUCTION OVERLAY
   ──────────────────────────────────────────────────────────────── */

const FEATURES = [
  {
    id: "manifest-explorer", icon: "🗺", zone: "det", zoneLabel: "deterministic",
    title: "Manifest Explorer",
    desc: "Read-only DAG view of every registered swarm manifest. Pick one, watch it render as waves of tasks with edges. No agent scope — humans only.",
    foot: "#/_prime_silo/manifest_explorer",
    layers: [
      ["Browser", "manifest_explorer/ page mounts dag.canvas in manifest mode"],
      ["API", "runtimeFetch with no scope → GET /api/manifests"],
      ["Storage", "Signed SwarmManifest JSON under $BENNY_HOME"]
    ],
    cmd: "# open in the shell\nhttp://localhost:3000/#/_prime_silo/manifest_explorer",
    paths: [["GET", "/api/manifests"], ["widget", "dag.canvas (manifest mode)"]]
  },
  {
    id: "agent-chat", icon: "🤖", zone: "rev", zoneLabel: "review",
    title: "Onscreen Agent",
    desc: "Browser-resident agent with cloud or local models. Localhost endpoints auto-detected: heavy operator prompt stripped, Qwen3 thinking disabled — no more empty-response loops.",
    foot: "cloud · lemonade · ollama",
    layers: [
      ["Browser", "onscreen_agent panel — SSE streaming, retry ladder, skills"],
      ["Transport", "isLocalModelEndpoint() patches messages + enable_thinking:false"],
      ["Model", "OpenRouter cloud or localhost:8000 lemonade/Ollama"]
    ],
    cmd: "# point settings at a local model\nendpoint: http://localhost:8000/api/v1/chat/completions\nmodel:    qwen3.5-9b-FLM",
    paths: [["module", "_core/onscreen_agent/api.js"], ["fix", "minimal prompt for local endpoints"]]
  },
  {
    id: "views", icon: "📌", zone: "rev", zoneLabel: "review",
    title: "Draft Views & Pinning",
    desc: "Agents compose layouts into the sandbox. A human pins: the runtime HMAC-signs, embeds the signature inline, and the pinned view becomes a replayable, tamper-evident artefact.",
    foot: ".aamp.view · HMAC-SHA256",
    layers: [
      ["Browser", "saveView / pinView / loadPinnedView helpers"],
      ["API", "POST /api/views/pin → sign → embed → write outside sandbox"],
      ["Storage", "workspaces/<ws>/views/*.aamp.view — self-describing"]
    ],
    cmd: "// pin a draft (human-only — agents get 403)\nawait pinView(\"default\", \"compose.aamp.view\",\n  { pinnedBy: \"operator@you\" });",
    paths: [["POST", "/api/views/pin"], ["GET", "/api/views/load/<ws>/<file>"], ["event", "VIEW_PINNED"]]
  },
  {
    id: "checkpoints", icon: "⏪", zone: "rev", zoneLabel: "review · new",
    title: "Session Checkpoints",
    desc: "Stamp a named restore point — history, loaded skills, staged data, run refs. Branch off it freely for creative sandboxing, fork it, return to the safe point exactly as it was.",
    foot: "aamp.checkpoint/1 · Phase H1",
    layers: [
      ["Browser", "saveCheckpoint / forkCheckpoint / applyCheckpointRestore"],
      ["API", "agent_sandbox/checkpoints/* (drafts) + /checkpoints/pin (human)"],
      ["Storage", "agent_sandbox/checkpoints/ drafts · checkpoints/ pinned+signed"]
    ],
    cmd: "// save a restore point mid-session\nawait saveCheckpoint(\"sandbox\", \"default\",\n  \"before-what-if\", sessionState);",
    paths: [["POST", "/api/agent_sandbox/checkpoints/save"], ["POST", "/api/checkpoints/pin"], ["limit", "2 MB history cap → 413"]]
  },
  {
    id: "pypes", icon: "⚗", zone: "sub", zoneLabel: "substrate",
    title: "Pypes Engine",
    desc: "Declarative bronze→silver→gold transformation DAGs with cell-level CLP lineage, checkpointed reruns, drill-down to any row, and explainable financial-risk reports.",
    foot: "benny pypes run | drilldown | rerun",
    layers: [
      ["CLI", "benny pypes inspect / run / drilldown / rerun --from"],
      ["Engine", "manifest-driven DAG, CLP lineage per cell"],
      ["Storage", "stage outputs + run audit under the workspace"]
    ],
    cmd: "benny pypes run manifests/templates/financial_risk_pipeline.json \\\n  --workspace pypes_demo\nbenny pypes drilldown <run_id> gold_exposure --workspace pypes_demo",
    paths: [["CLI", "benny pypes plan — LLM-author drafts"], ["CLI", "benny pypes bench pandas=… polars=…"], ["CLI", "benny pypes chat <run_id>"]]
  },
  {
    id: "dual-graph", icon: "🕸", zone: "sub", zoneLabel: "substrate",
    title: "Dual Graph",
    desc: "One Neo4j, two graphs. Knowledge graph from ingested documents; code graph from Tree-Sitter AST. The enrichment pipeline links them with CORRELATES_WITH edges.",
    foot: "kg3d.synoptic_web · codegraph.canvas",
    layers: [
      ["Browser", "kg3d.synoptic_web + codegraph.canvas widgets (2D/3D)"],
      ["API", "graph routes + enrichment manifest pipeline"],
      ["Storage", "Neo4j — Concept/Document + File/Class/Function"]
    ],
    cmd: "benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json \\\n  --workspace c5_test --src src/dangpy --run",
    paths: [["nodes", "Concept · Document · File · Class · Function"], ["edges", "REL · DEFINES · DEPENDS_ON · CORRELATES_WITH"]]
  },
  {
    id: "swarm", icon: "🐝", zone: "sub", zoneLabel: "substrate",
    title: "Swarm Executor",
    desc: "Requirement → LLM-planned manifest → signed → wave-by-wave LangGraph execution with run history, reasoning traces, and a frame inspector for every step.",
    foot: "benny plan → benny run",
    layers: [
      ["CLI", "benny plan \"<requirement>\" --save → benny run <manifest>"],
      ["Engine", "LangGraph swarm — waves, retries, HITL pause nodes"],
      ["Audit", "run.reasoning_trace + run.frame_inspector widgets"]
    ],
    cmd: "benny plan \"summarise risk exposure by desk\" --workspace demo --save\nbenny run manifests/demo_plan.json --json\nbenny runs ls --limit 10",
    paths: [["widget", "run.reasoning_trace"], ["widget", "run.lineage_timeline"], ["widget", "run.drilldown_table"]]
  },
  {
    id: "agentamp", icon: "🎛", zone: "rev", zoneLabel: "cockpit",
    title: "AgentAmp Cockpit",
    desc: "Winamp-style skinnable operator cockpit. Signed .aamp skin packs, WebGL plugin sandbox, deterministic spectrum/VU pipeline, playlist run-history, portable user state.",
    foot: ".aamp packs · Phases 1–6",
    layers: [
      ["Browser", "skin engine + AgentVis WebGL plugin sandbox"],
      ["CLI", "scaffold-skin → pack → sign → install"],
      ["Storage", "HMAC-signed .aamp bundles under $BENNY_HOME"]
    ],
    cmd: "benny agentamp scaffold-skin neon-ops\nbenny agentamp pack drafts/neon-ops --out neon-ops.aamp\nbenny agentamp sign neon-ops.aamp\nbenny agentamp install neon-ops.aamp",
    paths: [["CLI", "benny agentamp export-cockpit"], ["CLI", "benny agentamp enqueue <manifest>"]]
  },
  {
    id: "governance", icon: "🛡", zone: "det", zoneLabel: "deterministic",
    title: "Governance & Lineage",
    desc: "AgentScopeMiddleware is the single enforcer: scoped agents write only inside the sandbox; pinning is human-only by policy. Every mutation emits an audit event.",
    foot: "X-Benny-Agent-Scope",
    layers: [
      ["Header", "X-Benny-Agent-Scope: sandbox | read_only"],
      ["Middleware", "403s any scoped write outside /api/agent_sandbox/"],
      ["Audit", "VIEW_PINNED · CHECKPOINT_SAVED · CHECKPOINT_PINNED · agent_authorship"]
    ],
    cmd: "# the boundary in one request\ncurl -X POST :8005/api/views/pin \\\n  -H \"X-Benny-Agent-Scope: sandbox\"  # → 403, by design",
    paths: [["module", "runtime/benny/api/agent_scope.py"], ["principle", "agents draft, humans pin"]]
  }
];

const featureGrid = document.getElementById("featureGrid");
FEATURES.forEach((f) => {
  const card = document.createElement("button");
  card.className = "feature-card reveal";
  card.dataset.feature = f.id;
  card.innerHTML = `
    <span class="fc-zone z-${f.zone}">${f.zoneLabel}</span>
    <div class="fc-icon">${f.icon}</div>
    <div class="fc-title">${f.title}</div>
    <p class="fc-desc">${f.desc}</p>
    <div class="fc-foot"><span>${f.foot}</span><span class="fc-open">deconstruct →</span></div>`;
  card.addEventListener("click", () => openDecon(f));
  card.addEventListener("mousemove", (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
  featureGrid.appendChild(card);
});

/* deconstruction overlay */
const deconOverlay = document.getElementById("deconOverlay");
const deconStack = document.getElementById("deconStack");

function openDecon(f) {
  document.getElementById("deconIcon").textContent = f.icon;
  document.getElementById("deconTitle").textContent = f.title;
  document.getElementById("deconTag").textContent = f.desc;
  document.getElementById("deconCmd").textContent = f.cmd;
  document.getElementById("deconPaths").innerHTML = f.paths
    .map(([k, v]) => `<li><b>${k}</b> ${v}</li>`).join("");
  deconStack.innerHTML = f.layers
    .map(([name, detail], i) =>
      `<div class="decon-layer" style="--i:${i}"><b>${name}</b><span>${detail}</span></div>`)
    .join("");
  deconOverlay.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeDecon() {
  deconOverlay.hidden = true;
  document.body.style.overflow = "";
}
document.getElementById("deconClose").addEventListener("click", closeDecon);
document.getElementById("deconBackdrop").addEventListener("click", closeDecon);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDecon(); });

/* ────────────────────────────────────────────────────────────────
   3. ARCHITECTURE — explode + trace
   ──────────────────────────────────────────────────────────────── */

const archStack = document.getElementById("archStack");
const explodeBtn = document.getElementById("explodeBtn");
const archPulse = document.getElementById("archPulse");
const archLayers = [...archStack.querySelectorAll(".arch-layer")];

explodeBtn.addEventListener("click", () => {
  const exploded = archStack.classList.toggle("is-exploded");
  explodeBtn.textContent = exploded ? "⟁ Reassemble" : "⟁ Deconstruct";
});

document.getElementById("traceBtn").addEventListener("click", () => {
  if (!archStack.classList.contains("is-exploded")) {
    archStack.classList.add("is-exploded");
    explodeBtn.textContent = "⟁ Reassemble";
  }
  archPulse.classList.remove("is-tracing");
  void archPulse.offsetWidth; // restart animation
  archPulse.classList.add("is-tracing");
  // light layers in sequence
  archLayers.forEach((layer, i) => {
    setTimeout(() => {
      layer.classList.add("is-lit");
      setTimeout(() => layer.classList.remove("is-lit"), 700);
    }, 250 + i * 480);
  });
});

// Auto-explode the first time it scrolls into view.
new IntersectionObserver((entries, io) => {
  if (entries[0].isIntersecting) {
    setTimeout(() => {
      archStack.classList.add("is-exploded");
      explodeBtn.textContent = "⟁ Reassemble";
    }, 450);
    io.disconnect();
  }
}, { threshold: 0.35 }).observe(archStack);

/* ────────────────────────────────────────────────────────────────
   4. OPERATING MANUAL — accordion
   ──────────────────────────────────────────────────────────────── */

const MANUAL = [
  {
    n: "01", title: "Prerequisites & install",
    body: `
<table><tr><th>What</th><th>Minimum</th></tr>
<tr><td>Python</td><td>3.11</td></tr><tr><td>Node.js</td><td>18</td></tr>
<tr><td>Git</td><td>any modern</td></tr><tr><td>Docker</td><td>optional — Neo4j / lineage services</td></tr></table>
<pre><code>git clone https://github.com/binary16labs/prime-silo.git
cd prime-silo
cd runtime  &amp;&amp; pip install -e .  &amp;&amp; cd ..
cd server   &amp;&amp; npm install        &amp;&amp; cd ..</code></pre>`
  },
  {
    n: "02", title: "Configure — one .env, four values",
    body: `
<p>The runtime signs every manifest, pinned view, and pinned checkpoint with <code>BENNY_HMAC_KEY</code>. Generate one and drop it in <code>.env</code> at the repo root:</p>
<pre><code>python -c "import secrets; print(secrets.token_hex(32))"</code></pre>
<p>Or skip the manual work entirely:</p>
<a class="man-wizlink" href="#wizard">⚡ Use the Configuration Wizard — it generates .env + a config manifest →</a>`
  },
  {
    n: "03", title: "Boot the stack",
    body: `
<p>One script starts both processes — the FastAPI runtime on <code>:8005</code> and the shell on <code>:3000</code>:</p>
<pre><code># Windows
.\\scripts\\dev.ps1

# macOS / Linux
./scripts/dev.sh</code></pre>
<p>What's running:</p>
<table><tr><th>Process</th><th>Port</th><th>Role</th></tr>
<tr><td><code>python -m benny.api.server</code></td><td>8005</td><td>Runtime — executes manifests, enforces scope, owns the HMAC key</td></tr>
<tr><td><code>node server/dev_server.js</code></td><td>3000</td><td>Shell — serves UI, proxies <code>/api/runtime/*</code></td></tr></table>`
  },
  {
    n: "04", title: "Verify it's alive",
    body: `
<pre><code>curl http://localhost:8005/api/agent_sandbox/health
# → {"status":"ok","subdirs":["views","notes","drafts","skills"]}

curl http://localhost:8005/api/widgets
# → registered widget contract list</code></pre>
<p>Then open <code>http://localhost:3000</code> in the browser. The <a href="#dashboard">live dashboard below</a> runs the same checks continuously.</p>`
  },
  {
    n: "05", title: "Talk to the agent (cloud or local)",
    body: `
<p>Open the chat panel and set the model in agent settings.</p>
<h4>Cloud (OpenRouter)</h4>
<pre><code>endpoint: https://openrouter.ai/api/v1/chat/completions
model:    anthropic/claude-sonnet-4.6</code></pre>
<h4>Local (Lemonade / Ollama)</h4>
<pre><code>endpoint: http://localhost:8000/api/v1/chat/completions
model:    qwen3.5-9b-FLM</code></pre>
<p>Localhost endpoints are auto-detected: the 499-line operator prompt is swapped for a minimal one and Qwen3 thinking mode is disabled — small local models answer instead of returning empty streams.</p>`
  },
  {
    n: "06", title: "Explore manifests & runs",
    body: `
<p>Navigate to <code>#/_prime_silo/manifest_explorer</code> — the deterministic-zone page. Pick a manifest from the dropdown; it renders as a DAG with task/edge/wave counts. Create new manifests from the CLI:</p>
<pre><code>benny plan "ingest Q3 trades and compute desk exposure" --workspace demo --save
benny run manifests/&lt;generated&gt;.json --json
benny runs ls --limit 10</code></pre>`
  },
  {
    n: "07", title: "Draft views — agents draft, humans pin",
    body: `
<p>The agent composes review-zone layouts and saves them into its sandbox. You promote the good ones:</p>
<pre><code>// agent (scoped) — draft
await client.saveView("default", "exposure.aamp.view", layout);

// human (unscoped) — pin: sign + move outside the sandbox
await pinView("default", "exposure.aamp.view", { pinnedBy: "you@desk" });

// anyone — replay with load-time integrity check
const { view, valid } = await loadPinnedView("default", "exposure.aamp.view");</code></pre>
<p><code>valid:false</code> means the file was tampered with or the key rotated. The shell refuses to render an invalid layout.</p>`
  },
  {
    n: "08", title: "Session checkpoints — sandbox safely",
    body: `
<p>Before a risky what-if, stamp a restore point. The checkpoint captures history, loaded skills, staged data references, and run anchors:</p>
<pre><code>import { saveCheckpoint, loadCheckpoint, forkCheckpoint }
  from "/mod/_prime_silo/session_checkpoint/index.js";

await saveCheckpoint("sandbox", "default", "before-what-if", sessionState);
// …go wild…
const cp = await loadCheckpoint("sandbox", "default", "before-what-if");
// or branch instead of restoring:
const fork = await forkCheckpoint("sandbox", "default", "before-what-if");
// → "before-what-if_fork_1"</code></pre>
<p>Drafts live in the agent sandbox. Pinning (human-only) HMAC-signs the file — same guarantee as a pinned view.</p>`
  },
  {
    n: "09", title: "Pypes — tabular pipelines with lineage",
    body: `
<pre><code>benny pypes inspect manifests/templates/financial_risk_pipeline.json
benny pypes run     manifests/templates/financial_risk_pipeline.json --workspace pypes_demo
benny pypes drilldown &lt;run_id&gt; gold_exposure --workspace pypes_demo
benny pypes rerun   &lt;run_id&gt; --from silver_trades --workspace pypes_demo</code></pre>
<p>Sandbox layer (advisory, never mutates audit data): <code>pypes plan</code> LLM-authors draft manifests, <code>pypes agent-report</code> writes a risk-analyst narrative, <code>pypes bench</code> races pandas vs polars, <code>pypes chat</code> opens a grounded REPL on a run.</p>`
  },
  {
    n: "10", title: "Run the test suites",
    body: `
<pre><code># runtime (pytest)
cd runtime &amp;&amp; python -m pytest tests/api -q

# browser modules (node, no framework)
node tests/session_checkpoint_test.mjs
node tests/runtime_client_saved_views_test.mjs
node tests/manifest_explorer_test.mjs</code></pre>
<p>Release gates: G-COV ≥85% · G-SR1 path auditor · G-LAT &lt;300ms plan · G-ERR 0 flakes · G-SIG manifest integrity · G-OFF offline compliance.</p>`
  },
  {
    n: "11", title: "Troubleshooting",
    body: `
<table><tr><th>Symptom</th><th>Cause → fix</th></tr>
<tr><td>Agent loops "previous response was empty"</td><td>Local model choking on the full operator prompt. Fixed automatically for localhost endpoints; confirm your endpoint hostname is <code>localhost</code>/<code>127.0.0.1</code>.</td></tr>
<tr><td><code>valid:false</code> on a pinned view/checkpoint</td><td>File edited after pinning, or <code>BENNY_HMAC_KEY</code> changed. Re-pin from the draft with the current key.</td></tr>
<tr><td>403 on a write from the agent</td><td>Working as designed — scoped writes only land under <code>/api/agent_sandbox/</code>. Pinning is human-only.</td></tr>
<tr><td>413 saving a checkpoint</td><td>History over the 2 MB cap. Compact the conversation, then retry.</td></tr>
<tr><td>Port already in use</td><td>Change ports in the wizard, regenerate <code>.env</code>, restart <code>dev.ps1</code>.</td></tr>
<tr><td>Runtime won't start — HMAC error</td><td><code>BENNY_HMAC_KEY</code> missing from <code>.env</code>. The launcher refuses to boot without it.</td></tr></table>`
  }
];

const manualEl = document.getElementById("manualAccordion");
MANUAL.forEach((m, i) => {
  const item = document.createElement("div");
  item.className = "man-item reveal";
  item.innerHTML = `
    <button class="man-head">
      <span class="man-num">${m.n}</span>${m.title}
      <span class="man-chev">▼</span>
    </button>
    <div class="man-body"><div class="man-body-inner">${m.body}</div></div>`;
  const head = item.querySelector(".man-head");
  const body = item.querySelector(".man-body");
  head.addEventListener("click", () => {
    const open = item.classList.toggle("is-open");
    body.style.maxHeight = open ? body.scrollHeight + "px" : "0";
  });
  if (i === 0) {
    item.classList.add("is-open");
    requestAnimationFrame(() => { body.style.maxHeight = body.scrollHeight + "px"; });
  }
  manualEl.appendChild(item);
});

/* ────────────────────────────────────────────────────────────────
   5. CONFIG WIZARD
   ──────────────────────────────────────────────────────────────── */

const wizState = loadWizState() || {
  hmacKey: "", bennyHome: ".benny_home",
  modelMode: "local",
  modelEndpoint: "http://localhost:8000/api/v1/chat/completions",
  modelName: "qwen3.5-9b-FLM",
  modelKeyVar: "OPENROUTER_API_KEY",
  runtimePort: 8005, shellPort: 3000, workspace: "default",
  docker: { neo4j: true, marquez: false, phoenix: false, n8n: false }
};

function loadWizState() {
  try { return JSON.parse(localStorage.getItem("primeSiloWizard")); }
  catch { return null; }
}
function persistWizState() {
  try { localStorage.setItem("primeSiloWizard", JSON.stringify(wizState)); } catch {}
}

const STEP_PROCS = [
  ["runtime", "shell", "docker"],  // 0 welcome — all
  ["runtime"],                       // 1 environment
  ["shell"],                         // 2 model
  ["runtime", "shell", "docker"],  // 3 services
  []                                  // 4 generate
];

let wizStep = 0;
const TOTAL_STEPS = 5;
const railSteps = [...document.querySelectorAll(".rail-step")];
const stepPanels = [...document.querySelectorAll(".wizard-step")];
const railFill = document.getElementById("railFill");
const wizPrev = document.getElementById("wizPrev");
const wizNext = document.getElementById("wizNext");

function gotoStep(n, skipWarp) {
  n = Math.max(0, Math.min(TOTAL_STEPS - 1, n));
  if (n === wizStep && !skipWarp) return;
  if (!skipWarp) wizardField.warp(650, 18);
  wizStep = n;
  stepPanels.forEach(p => p.classList.toggle("is-active", +p.dataset.step === n));
  railSteps.forEach((r, i) => {
    r.classList.toggle("is-active", i === n);
    r.classList.toggle("is-done", i < n);
  });
  railFill.style.height = `${(n / (TOTAL_STEPS - 1)) * 100}%`;
  wizPrev.disabled = n === 0;
  wizNext.textContent = n === TOTAL_STEPS - 1 ? "Done ✓" : "Continue →";
  lightProcs(STEP_PROCS[n]);
  if (n === TOTAL_STEPS - 1) renderOutput();
  updateSidePreview();
}

function lightProcs(ids) {
  document.querySelectorAll(".side-proc").forEach(el => {
    el.classList.toggle("is-lit", ids.includes(el.dataset.proc));
  });
  document.querySelectorAll(".proc-node").forEach(el => {
    el.style.borderColor = ids.includes(el.dataset.proc) ? "rgba(56,232,255,0.5)" : "";
  });
}

wizPrev.addEventListener("click", () => gotoStep(wizStep - 1));
wizNext.addEventListener("click", () => {
  if (wizStep === TOTAL_STEPS - 1) {
    document.getElementById("dashboard").scrollIntoView({ behavior: "smooth" });
    return;
  }
  if (wizStep === 1 && !validHmac(el("cfgHmacKey").value)) {
    el("cfgHmacKey").focus();
    el("cfgHmacKey").style.borderColor = "var(--red)";
    setTimeout(() => { el("cfgHmacKey").style.borderColor = ""; }, 1400);
    return;
  }
  gotoStep(wizStep + 1);
});
railSteps.forEach(r => r.addEventListener("click", () => gotoStep(+r.dataset.step)));

function el(id) { return document.getElementById(id); }
function validHmac(v) { return /^[0-9a-fA-F]{64}$/.test(v.trim()); }

/* field bindings */
function bindField(id, key, transform) {
  const input = el(id);
  input.value = wizState[key];
  input.addEventListener("input", () => {
    wizState[key] = transform ? transform(input.value) : input.value;
    persistWizState();
    updateSidePreview();
  });
}
bindField("cfgHmacKey", "hmacKey");
bindField("cfgBennyHome", "bennyHome");
bindField("cfgModelEndpoint", "modelEndpoint");
bindField("cfgModelName", "modelName");
bindField("cfgModelKeyVar", "modelKeyVar");
bindField("cfgRuntimePort", "runtimePort", v => parseInt(v, 10) || 8005);
bindField("cfgShellPort", "shellPort", v => parseInt(v, 10) || 3000);
bindField("cfgWorkspace", "workspace");

el("cfgRuntimePort").addEventListener("input", () => { el("spRuntimePort").textContent = wizState.runtimePort; });
el("cfgShellPort").addEventListener("input", () => { el("spShellPort").textContent = wizState.shellPort; });

/* HMAC generation — local only, crypto.getRandomValues */
el("genKeyBtn").addEventListener("click", () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  el("cfgHmacKey").value = hex;
  wizState.hmacKey = hex;
  persistWizState();
  updateSidePreview();
  wizardField.warp(400, 10);
});

/* model mode segment */
const segBtns = [...document.querySelectorAll("#modelModeSeg .seg-btn")];
function applyModelMode(mode) {
  wizState.modelMode = mode;
  segBtns.forEach(b => b.classList.toggle("is-active", b.dataset.mode === mode));
  el("apiKeyField").style.display = mode === "cloud" ? "" : "none";
  if (mode === "cloud" && wizState.modelEndpoint.includes("localhost")) {
    wizState.modelEndpoint = "https://openrouter.ai/api/v1/chat/completions";
    wizState.modelName = "anthropic/claude-sonnet-4.6";
  } else if (mode === "local" && !wizState.modelEndpoint.includes("localhost")) {
    wizState.modelEndpoint = "http://localhost:8000/api/v1/chat/completions";
    wizState.modelName = "qwen3.5-9b-FLM";
  }
  el("cfgModelEndpoint").value = wizState.modelEndpoint;
  el("cfgModelName").value = wizState.modelName;
  el("endpointHint").textContent = mode === "local"
    ? "Local endpoint detected → minimal system prompt + thinking disabled automatically."
    : "Cloud endpoint — full operator prompt, streaming SSE.";
  persistWizState();
  updateSidePreview();
}
segBtns.forEach(b => b.addEventListener("click", () => applyModelMode(b.dataset.mode)));
applyModelMode(wizState.modelMode);

/* docker toggles */
[["svcNeo4j", "neo4j"], ["svcMarquez", "marquez"], ["svcPhoenix", "phoenix"], ["svcN8n", "n8n"]]
  .forEach(([id, key]) => {
    const chk = el(id);
    chk.checked = wizState.docker[key];
    chk.addEventListener("change", () => {
      wizState.docker[key] = chk.checked;
      el("spDocker").textContent =
        Object.entries(wizState.docker).filter(([, v]) => v).map(([k]) => k).join(" · ") || "none";
      persistWizState();
      updateSidePreview();
    });
  });
el("spDocker").textContent =
  Object.entries(wizState.docker).filter(([, v]) => v).map(([k]) => k).join(" · ") || "none";

/* ── manifest + outputs ─────────────────────────────────────── */

function buildManifest() {
  const dockerOn = Object.entries(wizState.docker).filter(([, v]) => v).map(([k]) => k);
  return {
    schema: "aamp.config/1",
    generated_at: new Date().toISOString(),
    generated_by: "prime-silo configuration wizard",
    environment: {
      BENNY_HOME: wizState.bennyHome || ".benny_home",
      BENNY_HMAC_KEY: wizState.hmacKey ? "<set in .env — not duplicated here>" : "<MISSING — generate in wizard step 02>"
    },
    model: {
      mode: wizState.modelMode,
      endpoint: wizState.modelEndpoint,
      model: wizState.modelName,
      ...(wizState.modelMode === "cloud"
        ? { api_key_env_var: wizState.modelKeyVar }
        : { local_optimizations: { minimal_system_prompt: true, enable_thinking: false } })
    },
    services: {
      runtime: { port: wizState.runtimePort, command: "python -m benny.api.server", cwd: "runtime" },
      shell: { port: wizState.shellPort, command: "node server/dev_server.js", cwd: "." },
      docker: dockerOn
    },
    workspace: { default: wizState.workspace },
    processes: [
      {
        id: "runtime",
        command: "python -m benny.api.server",
        cwd: "runtime",
        consumes: ["BENNY_HOME", "BENNY_HMAC_KEY", "services.runtime.port"]
      },
      {
        id: "shell",
        command: "node server/dev_server.js",
        cwd: ".",
        consumes: ["services.shell.port", "model.endpoint", "model.model"]
      },
      ...(dockerOn.length
        ? [{ id: "docker", command: `docker compose up -d ${dockerOn.join(" ")}`, cwd: ".", consumes: ["services.docker"] }]
        : [])
    ]
  };
}

function buildEnv() {
  const lines = [
    "# Generated by the Prime-Silo configuration wizard",
    `# ${new Date().toISOString()}`,
    "",
    "# Signs every manifest, pinned view, and pinned checkpoint.",
    `BENNY_HMAC_KEY=${wizState.hmacKey || "<generate in wizard step 02>"}`,
    "",
    `BENNY_HOME=${wizState.bennyHome || ".benny_home"}`,
    ""
  ];
  if (wizState.modelMode === "local") {
    lines.push("# Local model — CLI commands default to it.", "BENNY_DEFAULT_MODEL=local_lemonade", "");
  } else {
    lines.push(`# Cloud model key — set the real secret in your OS env:`, `# setx ${wizState.modelKeyVar} "sk-..."   (Windows)`, `# export ${wizState.modelKeyVar}="sk-..." (bash)`, "");
  }
  return lines.join("\n");
}

function buildLaunch() {
  const dockerOn = Object.entries(wizState.docker).filter(([, v]) => v).map(([k]) => k);
  const lines = ["# ── Prime-Silo launch sequence ──", ""];
  if (dockerOn.length) {
    lines.push("# 1. Optional services", `docker compose up -d ${dockerOn.join(" ")}`, "");
  }
  lines.push(
    `# ${dockerOn.length ? "2" : "1"}. Boot runtime (:${wizState.runtimePort}) + shell (:${wizState.shellPort})`,
    "# Windows", ".\\scripts\\dev.ps1", "",
    "# macOS / Linux", "./scripts/dev.sh", "",
    `# ${dockerOn.length ? "3" : "2"}. Verify`,
    `curl http://localhost:${wizState.runtimePort}/api/agent_sandbox/health`,
    `curl http://localhost:${wizState.runtimePort}/api/widgets`, "",
    `# ${dockerOn.length ? "4" : "3"}. Open the shell`,
    `http://localhost:${wizState.shellPort}/#/_prime_silo/manifest_explorer`
  );
  return lines.join("\n");
}

let activeOut = "env";
const OUT_FILES = {
  env: { name: ".env", build: buildEnv },
  manifest: { name: "prime-silo.config.json", build: () => JSON.stringify(buildManifest(), null, 2) },
  launch: { name: "launch.txt", build: buildLaunch }
};

function renderOutput() {
  el("outCode").textContent = OUT_FILES[activeOut].build();
}
document.querySelectorAll(".out-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    activeOut = tab.dataset.out;
    document.querySelectorAll(".out-tab").forEach(t => t.classList.toggle("is-active", t === tab));
    renderOutput();
  });
});

el("copyOutBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(OUT_FILES[activeOut].build());
  el("copyOutBtn").textContent = "✓ Copied";
  setTimeout(() => { el("copyOutBtn").textContent = "⧉ Copy"; }, 1400);
});

function download(name, content) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
el("dlOutBtn").addEventListener("click", () => {
  download(OUT_FILES[activeOut].name, OUT_FILES[activeOut].build());
});
el("dlAllBtn").addEventListener("click", () => {
  Object.values(OUT_FILES).forEach((f, i) => setTimeout(() => download(f.name, f.build()), i * 250));
});

function updateSidePreview() {
  el("sidePreview").textContent = JSON.stringify(buildManifest(), null, 1);
}

gotoStep(0, true);

/* ────────────────────────────────────────────────────────────────
   6. LIVE DASHBOARD
   ──────────────────────────────────────────────────────────────── */

function runtimeBase() { return `http://localhost:${wizState.runtimePort || 8005}`; }
function shellBase() { return `http://localhost:${wizState.shellPort || 3000}`; }

const DASH_CHECKS = [
  {
    id: "runtime", title: "Runtime API", sub: () => `GET ${runtimeBase()}/`,
    async probe() {
      const r = await fetch(`${runtimeBase()}/`, { signal: AbortSignal.timeout(3500) });
      const j = await r.json();
      return `online · mesh <b>${j.mesh_version || "?"}</b>`;
    }
  },
  {
    id: "sandbox", title: "Agent Sandbox", sub: () => `GET ${runtimeBase()}/api/agent_sandbox/health`,
    async probe() {
      const r = await fetch(`${runtimeBase()}/api/agent_sandbox/health`, { signal: AbortSignal.timeout(3500) });
      const j = await r.json();
      return `<b>${j.status}</b> · ${(j.subdirs || []).length} subdirs`;
    }
  },
  {
    id: "widgets", title: "Widget Registry", sub: () => `GET ${runtimeBase()}/api/widgets`,
    async probe() {
      const r = await fetch(`${runtimeBase()}/api/widgets`, { signal: AbortSignal.timeout(3500) });
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.widgets || []);
      renderWidgetPills(list);
      return `<b>${list.length}</b> widgets registered`;
    }
  },
  {
    id: "checkpoints", title: "Session Checkpoints", sub: () => `GET …/checkpoints/list/${wizState.workspace || "default"}`,
    async probe() {
      const ws = wizState.workspace || "default";
      const r = await fetch(`${runtimeBase()}/api/agent_sandbox/checkpoints/list/${encodeURIComponent(ws)}`, { signal: AbortSignal.timeout(3500) });
      const j = await r.json();
      return `<b>${Array.isArray(j) ? j.length : 0}</b> draft checkpoint${j.length === 1 ? "" : "s"} in <i>${ws}</i>`;
    }
  },
  {
    id: "shell", title: "Shell Server", sub: () => `${shellBase()} (opaque ping)`,
    async probe() {
      await fetch(shellBase(), { mode: "no-cors", signal: AbortSignal.timeout(3500) });
      return `reachable on <b>:${wizState.shellPort || 3000}</b>`;
    }
  }
];

const dashGrid = document.getElementById("dashGrid");
const dashCards = {};
DASH_CHECKS.forEach(c => {
  const card = document.createElement("div");
  card.className = "dash-card reveal";
  card.innerHTML = `
    <span class="dash-card-ms" data-ms></span>
    <div class="dash-card-head"><span class="status-dot"></span><b>${c.title}</b></div>
    <div class="dash-card-sub">${c.sub()}</div>
    <div class="dash-card-value">waiting for first check…</div>`;
  dashGrid.appendChild(card);
  dashCards[c.id] = card;
});

function renderWidgetPills(list) {
  const wrap = document.getElementById("dashWidgetsWrap");
  const target = document.getElementById("dashWidgetList");
  if (!list.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  target.innerHTML = list
    .map(wd => `<span class="dash-widget-pill">${wd.id || wd.widget_id || wd.name || wd}</span>`)
    .join("");
}

async function runDash() {
  document.getElementById("dashUpdated").textContent = "checking…";
  let anyOn = false;
  await Promise.all(DASH_CHECKS.map(async (c) => {
    const card = dashCards[c.id];
    const dot = card.querySelector(".status-dot");
    const val = card.querySelector(".dash-card-value");
    const ms = card.querySelector("[data-ms]");
    card.querySelector(".dash-card-sub").textContent = c.sub();
    const t0 = performance.now();
    try {
      const text = await c.probe();
      const dt = Math.round(performance.now() - t0);
      card.classList.add("is-on"); card.classList.remove("is-off");
      dot.classList.add("is-on"); dot.classList.remove("is-off");
      val.innerHTML = text;
      ms.textContent = `${dt}ms`;
      if (c.id === "runtime") anyOn = true;
    } catch {
      card.classList.add("is-off"); card.classList.remove("is-on");
      dot.classList.add("is-off"); dot.classList.remove("is-on");
      val.innerHTML = "<b>offline</b> — boot with <code>scripts/dev.ps1</code>";
      ms.textContent = "—";
    }
  }));
  document.getElementById("dashUpdated").textContent =
    `updated ${new Date().toLocaleTimeString()}`;
  // nav status pill
  const navDot = document.getElementById("navStatusDot");
  const navText = document.getElementById("navStatusText");
  navDot.classList.toggle("is-on", anyOn);
  navDot.classList.toggle("is-off", !anyOn);
  navText.textContent = anyOn ? "runtime online" : "runtime offline";
}

document.getElementById("dashRefreshBtn").addEventListener("click", runDash);

let dashTimer = null;
function setAuto(on) {
  clearInterval(dashTimer);
  if (on) dashTimer = setInterval(runDash, 10000);
}
const autoChk = document.getElementById("dashAutoChk");
autoChk.addEventListener("change", () => setAuto(autoChk.checked));
setAuto(true);
runDash();

/* ────────────────────────────────────────────────────────────────
   7. REVEAL ON SCROLL
   ──────────────────────────────────────────────────────────────── */

const revealIO = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add("is-in");
      revealIO.unobserve(e.target);
    }
  });
}, { threshold: 0.08 });
document.querySelectorAll(".reveal").forEach(elm => revealIO.observe(elm));

/* hero CTA warp on click */
document.querySelectorAll(".hero-ctas a").forEach(a => {
  a.addEventListener("click", () => heroField.warp(800, 22));
});
