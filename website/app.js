/* ==========================================================================
   Theme: Institutional Modernism & Editorial Symmetry
   Architecture: Responsive Scroll Journey & Floating Glass HUDs
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initAudioZen();
  initArchScrollStage();
  initCalculator();
  init3DBlueprint();
  initScrollCockpit();
  initScrollCLI();
  initNeuroDock();
  initBionicReading();
});

/* ==========================================================================
   1. Audio Zen Mode & Tactile Acoustics (432Hz)
   ========================================================================== */
let audioCtx = null;
let isAudioPlaying = false;
let oscNode = null;
let gainNode = null;

function initAudioZen() {
  const audioBtn = document.getElementById('audioZenBtn');
  if (!audioBtn) return;

  audioBtn.addEventListener('click', () => {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
    }

    if (isAudioPlaying) {
      if (gainNode) {
        gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.8);
        setTimeout(() => {
          if (oscNode) { oscNode.stop(); oscNode.disconnect(); oscNode = null; }
          isAudioPlaying = false;
          audioBtn.classList.remove('playing');
          audioBtn.innerHTML = '<span>🔇 Audio Zen: OFF</span>';
        }, 800);
      }
    } else {
      oscNode = audioCtx.createOscillator();
      gainNode = audioCtx.createGain();
      const filterNode = audioCtx.createBiquadFilter();

      // 432Hz binaural healing / focus frequency
      oscNode.type = 'sine';
      oscNode.frequency.setValueAtTime(432, audioCtx.currentTime);

      // Low-pass filter for soft atmospheric warmth (clean server airflow)
      filterNode.type = 'lowpass';
      filterNode.frequency.setValueAtTime(600, audioCtx.currentTime);

      gainNode.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 1.5);

      oscNode.connect(filterNode);
      filterNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscNode.start();
      isAudioPlaying = true;
      audioBtn.classList.add('playing');
      audioBtn.innerHTML = '<span>🔊 Audio Zen: 432Hz ON</span>';
    }
    playClickSound();
  });
}

// Organic acoustic tactile click (stone/wood pebble tap)
function playClickSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = audioCtx || new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.04);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.04);
  } catch (e) {
    // AudioContext blocked or unsupported
  }
}

/* ==========================================================================
   2. Institutional Architecture Showcase (Scroll-Driven Specification RAG)
   ========================================================================== */
const ARCH_DATA = [
  {
    key: 'adr01',
    tabId: 'archTab01',
    badge: '● ADR-001 // DETERMINISM GATE ACTIVE',
    specFile: 'runtime/architecture/ADR-001-prime-silo-shell-fork.md',
    footerSpec: 'L1_GATE // HMAC_SHA256_VERIFIER',
    overlayTitle: '// L1 DETERMINISM BOUNDARY GATE (ADR-001)',
    overlayStats: 'Active Gate: HMAC SHA-256 | Drift: 0.00% | Manifests Verified: 1,420',
    overlayDesc: 'Cryptographic payload verification gate preventing silent background mutations before pipeline execution. Read-only deterministic invariants enforced.',
    activeNodes: [0, 1, 2]
  },
  {
    key: 'adr02',
    tabId: 'archTab02',
    badge: '● ADR-002 // VECTORLESS RAG SPINE',
    specFile: 'runtime/architecture/ADR-002-pageindex-vectorless-spine.md',
    footerSpec: 'L2_SPINE // DOCLING_HIERARCHICAL_TREE',
    overlayTitle: '// L2 VECTORLESS RAG SPINE (ADR-002)',
    overlayStats: 'Spine: Docling Hierarchical | Vector Hallucinations: 0 | Virtualized Nodes: 48',
    overlayDesc: 'Denodo in-place virtualization resolving precise document section trees without vector embedding bloat. Links documentation directly to AST symbols.',
    activeNodes: [3, 4, 7, 10]
  },
  {
    key: 'adr03',
    tabId: 'archTab03',
    badge: '● ADR-003 // CREDENTIAL BINDING',
    specFile: 'architecture/ADR-003-agent-scope-credential-binding.md',
    footerSpec: 'L2_VISION // LEAST_PRIVILEGE_SANDBOX',
    overlayTitle: '// L2 VISION INGESTION & CAPABILITY TOKENS (ADR-003)',
    overlayStats: 'Multi-Modal Schemas: 12 | Token Scope: Read-Only | Key Leakage: 0',
    overlayDesc: 'Multi-modal table and diagram extraction bound to strict least-privilege workspace capability tokens. Zero cross-workspace credential leakage.',
    activeNodes: [5, 6, 7, 11]
  },
  {
    key: 'adr04',
    tabId: 'archTab04',
    badge: '● ADR-004 // BRIDGE COCKPIT & LOCAL LAN OFFLOAD',
    specFile: 'runtime/architecture/ADR-004-local-offload-orchestrator.md',
    footerSpec: 'L3_BRIDGE // 6_LENSES_MCP_NEXUS',
    overlayTitle: '// L3 BRIDGE COCKPIT UI & MCP OFFLOAD (ADR-004)',
    overlayStats: 'UI Lenses Active: 6 | Routing Tier: GREEN | LAN Workers: 2 (Qwen-32B)',
    overlayDesc: 'Frontend UI Control Lenses (Pulse, Memory, Docs, Code, Flows, Runs) interface directly with LAN workers via prime-silo-nexus MCP without cloud token tax.',
    activeNodes: [7, 8, 9, 10, 11, 12, 13, 17, 18, 19]
  },
  {
    key: 'adr05',
    tabId: 'archTab05',
    badge: '● ADR-005 // LONGVIEW SYNTHESIS',
    specFile: 'runtime/architecture/ADR-005-longview-session-synthesis.md',
    footerSpec: 'L4_MEMO_RAY // NEO4J_TRAJECTORY_SYNTHESIS',
    overlayTitle: '// L4 MEMO-RAY GRAPH & LONGVIEW SYNTHESIS (ADR-005)',
    overlayStats: 'Historical Sessions: 111+ | Graph Nodes: 14,820 | Cloud Token Tax: $0.00',
    overlayDesc: 'Continuous background synthesis consolidating multi-agent session trajectories into a unified Neo4j/Memo-Ray knowledge graph without cloud planner bloat.',
    activeNodes: [9, 14, 15, 17]
  },
  {
    key: 'pbr01',
    tabId: 'archTab06',
    badge: '● PBR-001 // 6σ SESSION CHECKPOINTS',
    specFile: 'architecture/REQUIREMENTS-H-session-checkpoints.md',
    footerSpec: 'L4_CHECKPOINT // 6SIGMA_PORTABILITY_GATE',
    overlayTitle: '// L4 SESSION CHECKPOINTS & PORTABILITY (PBR-001)',
    overlayStats: 'Quality Invariant: 6σ (≤3.4 DPMO) | Restore Point: pre-hitl-stamp | SSD Portability: 100%',
    overlayDesc: 'Named cryptographic checkpoints stamped before Human-In-The-Loop authorization gates ensuring 6σ-safe portability across external SSD roots.',
    activeNodes: [8, 12, 13, 16, 20]
  },
  {
    key: 'guide',
    tabId: 'archTab07',
    badge: '● GUIDE // INSTITUTIONAL GOVERNANCE',
    specFile: 'GUIDE.md',
    footerSpec: 'L5_GOVERNANCE // CLP_LINEAGE_LEDGER',
    overlayTitle: '// L5 CANONICAL GOVERNANCE & LINEAGE (GUIDE)',
    overlayStats: 'Protocol: CLP v1.0 | PII Redaction: AUTO (100%) | Audit Status: COMPLIANT',
    overlayDesc: 'Chronological Lineage Protocol ledger recording atomic execution proof for institutional regulatory compliance and automated PII redaction.',
    activeNodes: [1, 4, 7, 14, 17, 20]
  }
];

function initArchScrollStage() {
  const archSection = document.getElementById('arch-showcase');
  const canvas = document.getElementById('archGraphCanvas');
  const statusBadge = document.getElementById('archStatusBadge');
  const footerSpec = document.getElementById('archFooterSpec');
  const overlayTitle = document.getElementById('graphOverlayTitle');
  const overlayStats = document.getElementById('graphOverlayStats');
  const overlayDesc = document.getElementById('graphOverlayDesc');
  const cards = document.querySelectorAll('#arch-showcase .floating-glass-panel');
  if (!archSection || !canvas || !cards.length) return;

  const ctx = canvas.getContext('2d');
  let currentStageIdx = -1;
  let animFrameId = null;

  // Node definitions across 5 institutional levels
  // L1: y=0.14 | L2: y=0.32 | L3: y=0.50 | L4: y=0.68 | L5: y=0.86
  const rawNodes = [
    // Level 1: Boundary Gate
    { id: 0, label: 'Manifest Pipeline', sub: 'aamp.pipeline/1', level: 1, relX: 0.20, relY: 0.14, color: '#9CAF88' },
    { id: 1, label: 'HMAC SHA-256 Gate', sub: 'Crypto Verifier', level: 1, relX: 0.50, relY: 0.14, color: '#C85A32' },
    { id: 2, label: 'Signed Invariant', sub: 'Immutable Seal', level: 1, relX: 0.80, relY: 0.14, color: '#9CAF88' },
    // Level 2: Docling Spine & Vision
    { id: 3, label: 'Docling Parser', sub: 'Tree Extraction', level: 2, relX: 0.18, relY: 0.32, color: '#C5B38E' },
    { id: 4, label: 'Zero-Vector Spine', sub: 'Denodo In-Place', level: 2, relX: 0.40, relY: 0.32, color: '#9CAF88' },
    { id: 5, label: 'Vision Sandbox', sub: 'Diagram Schema', level: 2, relX: 0.62, relY: 0.32, color: '#C5B38E' },
    { id: 6, label: 'Capability Token', sub: 'Least-Privilege', level: 2, relX: 0.84, relY: 0.32, color: '#C85A32' },
    // Level 3: Bridge Cockpit & 6 UI Lenses
    { id: 7, label: 'Bridge Cockpit Engine', sub: 'UI Control Plane', level: 3, relX: 0.14, relY: 0.50, color: '#C85A32', big: true },
    { id: 8, label: 'Lens 01 // Pulse', sub: 'Cluster Telemetry', level: 3, relX: 0.28, relY: 0.50, color: '#9CAF88' },
    { id: 9, label: 'Lens 02 // Memory', sub: 'Memo-Ray Entity', level: 3, relX: 0.42, relY: 0.50, color: '#9CAF88' },
    { id: 10, label: 'Lens 03 // Docs', sub: 'TOGAF SAD RAG', level: 3, relX: 0.56, relY: 0.50, color: '#9CAF88' },
    { id: 11, label: 'Lens 04 // Code', sub: 'Symbol AST Index', level: 3, relX: 0.70, relY: 0.50, color: '#9CAF88' },
    { id: 12, label: 'Lens 05 // Flows', sub: 'aamp Execution', level: 3, relX: 0.84, relY: 0.44, color: '#C5B38E' },
    { id: 13, label: 'Lens 06 // Runs', sub: 'Live Worker Pool', level: 3, relX: 0.84, relY: 0.56, color: '#C5B38E' },
    // Level 4: Memo-Ray Graph & Checkpoints
    { id: 14, label: 'Memo-Ray Trajectory', sub: 'Neo4j Graph Node', level: 4, relX: 0.25, relY: 0.68, color: '#9CAF88', big: true },
    { id: 15, label: 'Longview Synthesis', sub: '111+ Sessions', level: 4, relX: 0.55, relY: 0.68, color: '#C5B38E' },
    { id: 16, label: '6σ Checkpoint', sub: 'pre-hitl-stamp', level: 4, relX: 0.82, relY: 0.68, color: '#C85A32' },
    // Level 5: Local LAN & Governance
    { id: 17, label: 'prime-silo-nexus', sub: 'MCP Offload Exec', level: 5, relX: 0.22, relY: 0.86, color: '#C85A32' },
    { id: 18, label: 'BENNY_LEMONADE Pool', sub: 'LAN Auto-Discovery', level: 5, relX: 0.48, relY: 0.86, color: '#9CAF88' },
    { id: 19, label: 'Qwen-2.5-Coder-32B', sub: 'Local LAN Worker', level: 5, relX: 0.74, relY: 0.86, color: '#9CAF88' },
    { id: 20, label: 'CLP Lineage Ledger', sub: 'Regulatory Audit', level: 5, relX: 0.90, relY: 0.86, color: '#C5B38E' }
  ];

  const edges = [
    [0, 1], [1, 2],
    [2, 3], [2, 5],
    [3, 4], [5, 6],
    [4, 7], [6, 7],
    [7, 8], [7, 9], [7, 10], [7, 11], [7, 12], [7, 13],
    [8, 14], [9, 14], [10, 15], [11, 15], [12, 16], [13, 16],
    [14, 17], [15, 17], [16, 20],
    [17, 18], [18, 19], [19, 20],
    [1, 20], [4, 14], [14, 20]
  ];

  let nodes = [];
  let pulses = [];

  const resizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    nodes = rawNodes.map(n => ({
      ...n,
      x: n.relX * rect.width,
      y: n.relY * rect.height,
      radius: n.big ? 11 : 7,
      active: false,
      glow: 0
    }));
  };

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const spawnPulse = (edgeIdx) => {
    const [srcId, tgtId] = edges[edgeIdx];
    pulses.push({
      src: srcId,
      tgt: tgtId,
      progress: 0,
      speed: 0.012 + Math.random() * 0.015,
      color: Math.random() > 0.5 ? '#9CAF88' : '#C85A32'
    });
  };

  for (let i = 0; i < edges.length; i += 2) {
    spawnPulse(i);
  }

  const animate = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.strokeStyle = 'rgba(197, 179, 142, 0.08)';
    ctx.lineWidth = 1;
    [0.14, 0.32, 0.50, 0.68, 0.86].forEach((ly, i) => {
      const y = ly * rect.height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(rect.width, y);
      ctx.stroke();

      ctx.fillStyle = 'rgba(197, 179, 142, 0.3)';
      ctx.font = '700 9px ui-monospace, SFMono-Regular, Consolas, monospace';
      const labels = [
        'L1 // DETERMINISM BOUNDARY',
        'L2 // VECTORLESS RAG SPINE',
        'L3 // BRIDGE COCKPIT UI CONTROL',
        'L4 // MEMO-RAY GRAPH SYNTHESIS',
        'L5 // LOCAL LAN POOL & LEDGER'
      ];
      ctx.fillText(labels[i], 12, y - 6);
    });

    edges.forEach(([srcId, tgtId]) => {
      const src = nodes[srcId];
      const tgt = nodes[tgtId];
      if (!src || !tgt) return;

      const bothActive = src.active && tgt.active;
      ctx.strokeStyle = bothActive ? 'rgba(156, 175, 136, 0.5)' : 'rgba(197, 179, 142, 0.15)';
      ctx.lineWidth = bothActive ? 2 : 1;
      if (bothActive) {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const src = nodes[p.src];
      const tgt = nodes[p.tgt];
      if (!src || !tgt) { pulses.splice(i, 1); continue; }

      p.progress += p.speed;
      if (p.progress >= 1) {
        if (tgt.active) tgt.glow = 1.0;
        pulses.splice(i, 1);
        const nextEdges = edges.map((e, idx) => e[0] === p.tgt ? idx : -1).filter(idx => idx !== -1);
        if (nextEdges.length > 0) {
          const nextIdx = nextEdges[Math.floor(Math.random() * nextEdges.length)];
          spawnPulse(nextIdx);
        } else {
          spawnPulse(Math.floor(Math.random() * edges.length));
        }
        continue;
      }

      const px = src.x + (tgt.x - src.x) * p.progress;
      const py = src.y + (tgt.y - src.y) * p.progress;

      ctx.beginPath();
      ctx.arc(px, py, (src.active && tgt.active) ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = (src.active && tgt.active) ? p.color : 'rgba(197, 179, 142, 0.4)';
      ctx.fill();

      if (src.active && tgt.active) {
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fillStyle = p.color === '#9CAF88' ? 'rgba(156, 175, 136, 0.2)' : 'rgba(200, 90, 50, 0.2)';
        ctx.fill();
      }
    }

    while (pulses.length < 18) {
      spawnPulse(Math.floor(Math.random() * edges.length));
    }

    nodes.forEach(n => {
      if (n.glow > 0) n.glow -= 0.03;

      if (n.active || n.glow > 0) {
        ctx.beginPath();
        const glowRadius = n.radius + 8 + (n.glow * 6);
        ctx.arc(n.x, n.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = n.color === '#C85A32' ? `rgba(200, 90, 50, ${0.15 + n.glow * 0.25})` : `rgba(156, 175, 136, ${0.18 + n.glow * 0.25})`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.active ? n.color : 'rgba(30, 45, 36, 0.9)';
      ctx.fill();
      ctx.lineWidth = n.active ? 2.5 : 1.5;
      ctx.strokeStyle = n.active ? '#F5F2EB' : 'rgba(197, 179, 142, 0.4)';
      ctx.stroke();

      ctx.fillStyle = n.active ? '#F5F2EB' : 'rgba(245, 242, 235, 0.65)';
      ctx.font = n.active ? '700 11px ui-monospace, SFMono-Regular, Consolas, monospace' : '400 10px ui-monospace, SFMono-Regular, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.x, n.y - n.radius - 6);

      if (n.active || n.big) {
        ctx.fillStyle = n.color;
        ctx.font = '600 9px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.fillText(`[${n.sub}]`, n.x, n.y + n.radius + 12);
      }
    });

    animFrameId = requestAnimationFrame(animate);
  };

  animate();

  const runArchStage = (stageIdx) => {
    const stage = ARCH_DATA[stageIdx];
    if (!stage) return;

    ARCH_DATA.forEach((s, idx) => {
      const tabEl = document.getElementById(s.tabId);
      if (tabEl) {
        if (idx === stageIdx) tabEl.classList.add('active-tab');
        else tabEl.classList.remove('active-tab');
      }
    });

    if (statusBadge) statusBadge.textContent = stage.badge;
    if (footerSpec) footerSpec.textContent = stage.footerSpec;
    if (overlayTitle) overlayTitle.textContent = stage.overlayTitle;
    if (overlayStats) overlayStats.textContent = stage.overlayStats;
    if (overlayDesc) overlayDesc.textContent = stage.overlayDesc;

    nodes.forEach(n => {
      n.active = stage.activeNodes.includes(n.id);
      if (n.active) n.glow = 0.8;
    });
  };

  ARCH_DATA.forEach((s, idx) => {
    const tabEl = document.getElementById(s.tabId);
    if (tabEl) {
      tabEl.addEventListener('click', () => {
        if (cards[idx]) {
          cards[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
  });

  const updateArch = () => {
    const winMiddle = window.innerHeight * 0.52;
    let closestCard = cards[0];
    let minDiff = Infinity;
    let activeIdx = 0;

    cards.forEach((card, idx) => {
      const rect = card.getBoundingClientRect();
      const cardMiddle = rect.top + rect.height * 0.5;
      const diff = Math.abs(cardMiddle - winMiddle);
      if (diff < minDiff) {
        minDiff = diff;
        closestCard = card;
        activeIdx = idx;
      }
    });

    if (activeIdx !== currentStageIdx) {
      currentStageIdx = activeIdx;
      cards.forEach(c => c.classList.remove('active-card'));
      closestCard.classList.add('active-card');
      runArchStage(currentStageIdx);
      playClickSound();
    }
  };

  window.addEventListener('scroll', updateArch, { passive: true });
  updateArch();
}

/* ==========================================================================
   3. Zero Token Tax RAG Calculator (99% Savings via Denodo Pattern)
   ========================================================================== */
function initCalculator() {
  const teamSlider = document.getElementById('teamSize');
  const codeSlider = document.getElementById('codeSize');
  const querySlider = document.getElementById('queryCount');
  if (!teamSlider || !codeSlider || !querySlider) return;

  const teamVal = document.getElementById('teamVal');
  const codeVal = document.getElementById('codeVal');
  const queryVal = document.getElementById('queryVal');
  const legacyRes = document.getElementById('legacyResult');
  const primeRes = document.getElementById('primeResult');
  const savingRes = document.getElementById('savingResult');
  const percentRes = document.getElementById('percentResult');

  const toggleUC1 = document.getElementById('toggleUseCase1');
  const toggleUC2 = document.getElementById('toggleUseCase2');

  const calculate = () => {
    const team = parseInt(teamSlider.value, 10);
    const code = parseInt(codeSlider.value, 10); // in thousands
    const queries = parseInt(querySlider.value, 10);
    const useCase1Active = toggleUC1 ? toggleUC1.checked : true;
    const useCase2Active = toggleUC2 ? toggleUC2.checked : true;

    teamVal.textContent = `${team} devs`;
    codeVal.textContent = `${code}k lines`;
    queryVal.textContent = `${queries}/day`;

    // Legacy context dump burn calculation (~35,000 tokens per query)
    const monthlyQueries = team * queries * 22; // 22 work days
    const legacyTokens = monthlyQueries * 35000;
    const legacyCost = (legacyTokens / 1000000) * 10; // $10 per million tokens avg

    // Dynamic Prime-Silo burn calculation based on empirical audit toggles
    // 1. Navigation context bloat reduction (Use Case A: 92.9% savings on context payload via atomic Neo4j/AST symbol query)
    // Without UC1: baseline query token context is 35,000 tokens. With UC1: context drops to ~4,500 tokens (87% effective query context reduction).
    let baseQueryTokens = useCase1Active ? 4500 : 35000;

    // 2. Offloading & Read-back reduction (Use Case B: 86.1% read-back reduction + 80% local LAN execution)
    // Without UC2: 100% of queries go to cloud LLM at full cost.
    // With UC2: 80% of execution is handled locally by BENNY_LEMONADE_ENDPOINTS ($0 cloud cost), and read-back tokens are compressed by 86.1% (~2,300 tokens/query avg).
    let cloudQueriesRatio = useCase2Active ? 0.20 : 1.00;
    let finalQueryTokens = (useCase1Active && useCase2Active) ? 2300 : (useCase2Active ? (baseQueryTokens * 0.4) : baseQueryTokens);

    const primeTokens = monthlyQueries * finalQueryTokens;
    // Price per million tokens: optimized routing drops cost from $10 to $3/mil for remaining cloud traffic when UC2 is active
    const costPerMil = useCase2Active ? 3 : 10;
    const primeCost = ((primeTokens * cloudQueriesRatio) / 1000000) * costPerMil;

    const savings = Math.max(0, legacyCost - primeCost);
    const percentSaved = Math.round((savings / legacyCost) * 100);

    legacyRes.textContent = `$${Math.round(legacyCost).toLocaleString()}/mo`;
    primeRes.textContent = `$${Math.round(primeCost).toLocaleString()}/mo`;
    savingRes.textContent = `$${Math.round(savings).toLocaleString()}/mo`;
    
    // Update label to reflect active combination
    if (useCase1Active && useCase2Active) {
      percentRes.textContent = `${percentSaved}% Saved // Tri-Graph CAG + MCP Combo Active`;
    } else if (useCase1Active) {
      percentRes.textContent = `${percentSaved}% Saved // Code Graph Navigation Active (-92.9% Context)`;
    } else if (useCase2Active) {
      percentRes.textContent = `${percentSaved}% Saved // MCP Nexus Offload Active (-86.1% Read-Back)`;
    } else {
      percentRes.textContent = `0% Saved // Legacy Cloud Mode (No Toggles Active)`;
    }
  };

  teamSlider.addEventListener('input', calculate);
  codeSlider.addEventListener('input', calculate);
  querySlider.addEventListener('input', calculate);
  if (toggleUC1) toggleUC1.addEventListener('change', calculate);
  if (toggleUC2) toggleUC2.addEventListener('change', calculate);
  calculate();
}

/* ==========================================================================
   4. ACT I: Three.js 3D Exploding Blueprint & Anti-Gravity Physics
   ========================================================================== */
function init3DBlueprint() {
  const canvas = document.getElementById('blueprintCanvas');
  const container = document.querySelector('.blueprint-canvas-container');
  if (!canvas || !container || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.z = 18;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xC5B38E, 1.2);
  dirLight.position.set(10, 15, 10);
  scene.add(dirLight);

  const mainGroup = new THREE.Group();
  scene.add(mainGroup);

  // Layer 1: Core Cylinder (Warm Gold / HITL Signature Anchor)
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xC5B38E, wireframe: true, transparent: true, opacity: 0.85 });
  const coreGeo = new THREE.CylinderGeometry(1.6, 1.6, 5.5, 16, 4);
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  mainGroup.add(coreMesh);

  // Layer 2: Hexagonal Prisms (Retro Rust / Pypes Layer 0 Algebra)
  const prismMat = new THREE.MeshBasicMaterial({ color: 0xB85D3D, wireframe: true, transparent: true, opacity: 0.75 });
  const prismGroup = new THREE.Group();
  const prismGeo = new THREE.CylinderGeometry(0.8, 0.8, 4.0, 6, 1);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const p = new THREE.Mesh(prismGeo, prismMat);
    p.position.set(Math.cos(angle) * 3.2, 0, Math.sin(angle) * 3.2);
    p.userData = { origX: p.position.x, origZ: p.position.z };
    prismGroup.add(p);
  }
  mainGroup.add(prismGroup);

  // Layer 3: Orbiting Toruses (Sage Green / Tri-Graph CAG Virtualization)
  const torusMat = new THREE.MeshBasicMaterial({ color: 0x9CAF88, wireframe: true, transparent: true, opacity: 0.7 });
  const torusGroup = new THREE.Group();
  for (let i = 1; i <= 3; i++) {
    const tGeo = new THREE.TorusGeometry(3.2 + i * 1.5, 0.12, 8, 36);
    const t = new THREE.Mesh(tGeo, torusMat);
    t.rotation.x = Math.PI / (2 + i * 0.5);
    t.rotation.y = (i * Math.PI) / 4;
    t.userData = { origScale: 1.0, origRotX: t.rotation.x };
    torusGroup.add(t);
  }
  mainGroup.add(torusGroup);

  // Layer 4: Swarm Worker Constellation (Alabaster Octahedrons / BENNY_LEMONADE_ENDPOINTS)
  const swarmMat = new THREE.MeshBasicMaterial({ color: 0xF5F2EB, wireframe: true, transparent: true, opacity: 0.65 });
  const swarmGroup = new THREE.Group();
  const octGeo = new THREE.OctahedronGeometry(0.35, 0);
  for (let i = 0; i < 36; i++) {
    const m = new THREE.Mesh(octGeo, swarmMat);
    const radius = 6.0 + Math.random() * 4.5;
    const theta = Math.random() * Math.PI * 2;
    const phi = (Math.random() - 0.5) * Math.PI;
    m.position.set(
      radius * Math.cos(theta) * Math.cos(phi),
      radius * Math.sin(phi),
      radius * Math.sin(theta) * Math.cos(phi)
    );
    m.userData = {
      origX: m.position.x, origY: m.position.y, origZ: m.position.z,
      speed: 0.5 + Math.random() * 1.5
    };
    swarmGroup.add(m);
  }
  mainGroup.add(swarmGroup);

  // Resize handler
  window.addEventListener('resize', () => {
    if (!container) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  // Scroll Progress Tracking across Act I
  const storySection = document.getElementById('blueprint-story');
  const statusBadge = document.getElementById('blueprintStatus');
  const chapCards = document.querySelectorAll('#blueprint-story .floating-glass-panel');
  let scrollProgress = 0;

  const updateScroll = () => {
    if (!storySection) return;
    const rect = storySection.getBoundingClientRect();
    const winHeight = window.innerHeight;
    const totalScroll = storySection.offsetHeight - winHeight;
    if (totalScroll <= 0) return;

    let currentScroll = -rect.top;
    let p = currentScroll / totalScroll;
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    scrollProgress = p;

    // Highlight active chapter card based on scroll progress
    let activeIdx = 0;
    if (p > 0.22 && p <= 0.48) activeIdx = 1;
    else if (p > 0.48 && p <= 0.76) activeIdx = 2;
    else if (p > 0.76) activeIdx = 3;

    chapCards.forEach((card, idx) => {
      if (idx === activeIdx) {
        if (!card.classList.contains('active-card')) {
          card.classList.add('active-card');
          playClickSound();
        }
      } else {
        card.classList.remove('active-card');
      }
    });

    if (statusBadge) {
      const stageNames = [
        'STAGE 1: INTEL HITL SIGNATURE CORE INTACT',
        'STAGE 2: PYPES TRANSFORMATION PRISMS EXPLODING',
        'STAGE 3: TRI-GRAPH CAG TORUSES EXPANDING',
        'STAGE 4: LONGVIEW SWARM CONSTELLATION FAN-OUT'
      ];
      statusBadge.textContent = stageNames[activeIdx] + ` (${Math.round(p * 100)}%)`;
    }
  };

  window.addEventListener('scroll', updateScroll, { passive: true });
  updateScroll();

  // Animation & Anti-Gravity Physics Loop
  let clock = new THREE.Clock();
  const animate = () => {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();

    // Rotational inertia
    mainGroup.rotation.y = time * 0.18 + scrollProgress * Math.PI * 1.5;
    mainGroup.rotation.x = Math.sin(time * 0.4) * 0.12 + scrollProgress * 0.4;

    // Anti-gravity vertical hover oscillation
    mainGroup.position.y = Math.sin(time * 1.2) * 0.35;

    // Interpolate Layer 2: Hex Prisms Explosion
    const prismScale = 1.0 + scrollProgress * 2.8;
    prismGroup.children.forEach(p => {
      p.position.x = p.userData.origX * prismScale;
      p.position.z = p.userData.origZ * prismScale;
      p.rotation.y = time * 0.5;
    });

    // Interpolate Layer 3: Toruses Expansion & Tilt
    const torusScale = 1.0 + scrollProgress * 1.6;
    torusGroup.children.forEach((t, idx) => {
      t.scale.set(torusScale, torusScale, torusScale);
      t.rotation.x = t.userData.origRotX + Math.sin(time * 0.8 + idx) * 0.3 * scrollProgress;
      t.rotation.z = time * (0.15 + idx * 0.05);
    });

    // Interpolate Layer 4: Swarm Particles Anti-Gravity Bubble Drift
    const swarmSpread = 1.0 + scrollProgress * 3.5;
    swarmGroup.children.forEach(m => {
      m.position.x = m.userData.origX * swarmSpread + Math.cos(time * m.userData.speed) * 0.4;
      m.position.y = m.userData.origY * swarmSpread + Math.sin(time * m.userData.speed) * 0.6;
      m.position.z = m.userData.origZ * swarmSpread + Math.sin(time * m.userData.speed) * 0.4;
      m.rotation.x += 0.02;
      m.rotation.y += 0.02;
    });

    renderer.render(scene, camera);
  };
  animate();
}

/* ==========================================================================
   5. ACT II: Bridge Cockpit // Scroll-Driven Telemetry HUD
   ========================================================================== */
const LENS_DATA = {
  pulse: `[STATUS] All local systems nominal. 2 active LAN workers fanned out.
---
Host: ryzen.local:13305/api/v1   [ACTIVE] Model: Qwen-2.5-Coder-32B  Latency: 12ms  GPU: 18.4GB/24GB
Host: t480.local:13305/api/v1    [ACTIVE] Model: Llama-3-8B-Instruct  Latency: 28ms  CPU: 16 threads
---
[TELEMETRY] Local Cache Hit Rate: 88.4% | Tokens Saved This Session: 412,890`,

  memory: `[MEMO-RAY] Session Entity Tree: session_99482
├── Thought 01: "Analyze VaR exposure on Counterparty CPTY-8834" [CONFIDENCE: 0.98]
│   ├── Query: Knowledge RAG (risk_guidelines_2026.pdf#L412)
│   └── Query: Code AST (src/risk/calculator.rs::compute_var)
└── Artifact 01: Signed Executive Deliverable (counterparty_exposure.aamp)
    └── HMAC SHA-256: 8f4e2a99b10c3847a192837482... [PINNED]`,

  documents: `[TOGAF-SAD] Document RAG Virtualization Index
├── Doc: Architecture_Definition_Document_v3.4.pdf [INDEXED: 142 sections]
│   ├── Section 4.2: Data Sovereignty & Local-First Boundaries [MATCH]
│   └── Section 8.1: Cryptographic Lineage Verification [MATCH]
└── Local Embeddings: Quantized ONNX (all-MiniLM-L6-v2) | Latency: 4ms`,

  code: `[TREE-SITTER] Real-time AST Graph Resolver
├── Repo: prime-silo-core (Rust / TypeScript)
├── Resolved Symbol: prime_silo::pypes::vectorized_engine::execute_step
├── Caller Count: 14 | Callee Count: 6 | Test Coverage: 94.2%
└── Mutation Guard: LOCKED (Requires HITL HMAC Signature before edit)`,

  flows: `[PYPES LAYER 0] Staged Data Transformation Algebra
├── Stage 01 [BRONZE]: Ingesting raw SWIFT trade records (1,200,000 rows) -> 110ms
├── Stage 02 [SILVER]: Polars vectorized schema validation & outlier rejection -> 84ms
└── Stage 03 [GOLD]: Aggregating institutional risk exposures -> 42ms
[STATUS] Checkpoint id #8841 pinned. Available for instant resumption.`,

  runs: `[CLP LEDGER] Chronological Lineage Protocol Audit Ledger
├── Run #99481 | Swarm: 4 workers | Duration: 1.4s | HMAC: 3a98f12c... [VERIFIED]
├── Run #99482 | Swarm: 2 workers | Duration: 0.8s | HMAC: 8f4e2a99... [VERIFIED]
└── Run #99483 | Swarm: 6 workers | Duration: 2.1s | HMAC: 7b11c49e... [VERIFIED]
[AUDIT] 100% reproducible execution logs. Zero unauthorized state drift.`
};

const LENS_NAMES = {
  pulse: 'LENS 01 // PULSE',
  memory: 'LENS 02 // MEMORY',
  documents: 'LENS 03 // DOCUMENTS',
  code: 'LENS 04 // CODE',
  flows: 'LENS 05 // FLOWS',
  runs: 'LENS 06 // RUNS'
};

function initScrollCockpit() {
  const cockpitSection = document.getElementById('cockpit');
  const hudScreen = document.getElementById('cockpitScreen');
  const badge = document.getElementById('cockpitLensBadge');
  const cards = document.querySelectorAll('#cockpit .floating-glass-panel');
  if (!cockpitSection || !hudScreen || !cards.length) return;

  let currentLens = 'pulse';

  const updateCockpit = () => {
    const winMiddle = window.innerHeight * 0.52;
    let closestCard = cards[0];
    let minDiff = Infinity;

    cards.forEach(card => {
      const rect = card.getBoundingClientRect();
      const cardMiddle = rect.top + rect.height * 0.5;
      const diff = Math.abs(cardMiddle - winMiddle);
      if (diff < minDiff) {
        minDiff = diff;
        closestCard = card;
      }
    });

    const lensKey = closestCard.getAttribute('data-lens') || 'pulse';
    if (lensKey !== currentLens) {
      currentLens = lensKey;
      cards.forEach(c => c.classList.remove('active-card'));
      closestCard.classList.add('active-card');

      if (badge) badge.textContent = LENS_NAMES[lensKey] || 'LENS 01 // PULSE';
      
      // Smooth fade transition
      hudScreen.style.opacity = 0.2;
      setTimeout(() => {
        hudScreen.textContent = LENS_DATA[lensKey] || LENS_DATA.pulse;
        hudScreen.style.opacity = 1.0;
      }, 150);

      playClickSound();
    }
  };

  window.addEventListener('scroll', updateCockpit, { passive: true });
  updateCockpit();
}

/* ==========================================================================
   6. ACT III: Benny CLI Substrate // Scroll-Driven Terminal Cinema
   ========================================================================== */
const TUI_STAGES = [
  {
    key: 'refactor',
    tabId: 'tuiTabRefactor',
    badge: '● TASK 01 // AST REFACTORING (MCP)',
    title: 'USE CASE 01 // LEGACY CODEBASE REFACTORING via prime-silo-nexus MCP',
    desc: 'Offload massive codebase migrations without blowing up cloud LLM context windows. Via the prime-silo-nexus MCP server, Claude invokes offload_exec with an aamp.offload_task/1 manifest—enforcing strict Digest Discipline so zero verbose code is returned.',
    specs: [
      'Tree-Sitter AST indexing maps caller/callee graphs to isolate atomic functions locally',
      'Enforces Green/Yellow/Red risk matrix: deterministic local checks run before LLM judging',
      'Digest Discipline: offload_exec returns ONLY a compact verification digest to Claude'
    ],
    cmd: 'benny plan --ast-refactor "migrate legacy auth to async jwt" --via-mcp',
    progressText: 'Routing aamp.offload_task/1 manifest to local Benny runtime...',
    logs: [
      '[MCP-NEXUS] Received task manifest via offload_exec tool (Risk Tier: 🟡 YELLOW).',
      '[LOCAL-GATE] Executing deterministic Tree-Sitter AST boundary checks... [PASSED]',
      '[AUDIT-PROOF] Measured 92.9% graph query savings & 86.1% digest read-back reduction.',
      '[DIGEST] Returning compact 140-byte verification digest to planner context.'
    ],
    success: '[HMAC SHA-256] Plan verified & sealed. Zero token tax on cloud planner context.'
  },
  {
    key: 'audit',
    tabId: 'tuiTabAudit',
    badge: '● TASK 02 // REGULATORY AUDIT',
    title: 'USE CASE 02 // HIGH-FREQUENCY FINANCIAL & REGULATORY AUDIT',
    desc: 'Offload continuous compliance verification of multi-terabyte Bronze ➔ Silver ➔ Gold parquet pipelines against strict financial and privacy mandates (BASEL III, GDPR, SEC Reporting).',
    specs: [
      'Vectorized Polars execution validates 10M+ rows in sub-100ms timeframes',
      'Automatic step-level checkpointing (--resume <id>) prevents rerun waste',
      'Flags Value at Risk (VaR) margin anomalies and PII data leakage instantly'
    ],
    cmd: 'benny pypes audit --compliance "BASEL-III, GDPR, SEC-17a-4"',
    progressText: 'Vectorized Polars query scanning 14,200,000 Silver parquet records...',
    logs: [
      '[PYPES] Verifying step-level checkpoints across 12 institutional storage silos...',
      '[POLARS] Isolating VaR margin threshold violations > $2,500,000 in CPTY-9921...',
      '[COMPLIANCE] Auto-redacting 340 customer SSN fields before intermediate cache.'
    ],
    success: '[ANOMALY ISOLATED] Generated mathematical proof of compliance. Spawning L2 review.'
  },
  {
    key: 'swarm',
    tabId: 'tuiTabSwarm',
    badge: '● TASK 03 // LAN SWARM FAN-OUT',
    title: 'USE CASE 03 // AUTONOMOUS LAN SWARM RESEARCH & SYNTHESIS',
    desc: 'Offload complex literature reviews, multi-repository bug root-cause hunting, or vulnerability triage to your own distributed engineering hardware without paying cloud AI SaaS taxes.',
    specs: [
      'Fan-out tasks across local Ryzen workstations, ThinkPads, and Apple Silicon Macs',
      'Automatic hardware thermal throttling and RAM watchdog memory guards',
      'Synthesizes parallel worker delta reports into a single executive briefing'
    ],
    cmd: 'benny longview swarm --lan "root cause memory leak in polars pipeline"',
    progressText: 'Fanning out diagnostic probes to BENNY_LEMONADE_ENDPOINTS...',
    logs: [
      '[WORKER-01] ryzen.local (Qwen-32B): Tracing Polars dataframe buffer allocations... [DONE in 410ms]',
      '[WORKER-02] t480.local (Llama-8B): Analyzing OS kernel memory maps... [DONE in 290ms]',
      '[WORKER-03] m3max.local (DeepSeek-R1): Cross-referencing Rust allocator lifecycles... [DONE in 340ms]'
    ],
    success: '[SYNTHESIS COMPLETE] Merged 3 worker deltas into canonical root-cause fix.'
  },
  {
    key: 'docs',
    tabId: 'tuiTabDocs',
    badge: '● TASK 04 // SAD RAG INDEXING',
    title: 'USE CASE 04 // INSTITUTIONAL KNOWLEDGE & SAD RAG INDEXING',
    desc: 'Offload the ingestion of messy enterprise PDFs, TOGAF Software Architecture Documents (SADs), and legal contracts into instant, locally queryable knowledge graphs without vector DB subscriptions.',
    specs: [
      'Local-first embedding generation via Quantized ONNX models (zero third-party leakage)',
      'Section-level citation anchors with direct diff overlays for rapid auditing',
      'Tree-Sitter markdown and PDF structure parsing preserves table hierarchies'
    ],
    cmd: 'benny docs index --sad-rag "./enterprise_architecture/SAD_v4.2.pdf"',
    progressText: 'Running local Quantized ONNX embeddings on 480 architectural pages...',
    logs: [
      '[TREE-SITTER] Extracted 64 system boundary diagrams and 112 compliance tables.',
      '[ONNX-RAG] Indexed 2,840 semantic chunks into local Memo-Ray entity graph.',
      '[SECURITY] Verified zero data exfiltration across network perimeter.'
    ],
    success: '[KNOWLEDGE INDEXED] Sub-millisecond local semantic search now active.'
  },
  {
    key: 'test',
    tabId: 'tuiTabTest',
    badge: '● TASK 05 // CI/CD BLAST RADIUS',
    title: 'USE CASE 05 // AUTOMATED CI/CD REGRESSION & BLAST RADIUS ISOLATION',
    desc: 'Offload regression testing and race-condition hunting. Before merging pull requests, Benny calculates the exact architectural blast radius and executes only the affected test suites.',
    specs: [
      'Tri-Graph CAG (Contextual Argument Graph) maps shared dependency impact',
      'Skips redundant unit tests by analyzing AST execution graphs mathematically',
      'Generates cryptographically signed test receipts for continuous integration gates'
    ],
    cmd: 'benny test blast-radius --pr 4821 --enforce-cag',
    progressText: 'Calculating Tri-Graph CAG dependency impact for PR #4821...',
    logs: [
      '[CAG-ENGINE] Identified 3 downstream microservices affected by AuthController edit.',
      '[TEST-RUNNER] Isolating and executing 18 relevant integration specs... [18/18 PASSED]',
      '[RECEIPT] Generated immutable test verification receipt for CI pipeline.'
    ],
    success: '[BLAST RADIUS CONTAINED] Zero regression leaks detected. PR approved for merge.'
  },
  {
    key: 'sign',
    tabId: 'tuiTabSign',
    badge: '● TASK 06 // CRYPTOGRAPHIC PINNING',
    title: 'USE CASE 06 // AGENTAMP CRYPTOGRAPHIC SEALING & INSTITUTIONAL SIGN-OFF',
    desc: 'Offload final deliverable verification. Benny validates executive dashboards, analytical reports, and custom view schemas against institutional rules, sealing them with an immutable cryptographic hash.',
    specs: [
      'Strict schema compliance verification against canonical aamp.view/1 standards',
      'Generates immutable HMAC SHA-256 institutional signature proofs',
      'Pins verified view directly to your L2 canonical workspace for regulatory sign-off'
    ],
    cmd: 'benny agentamp sign --seal "institutional_risk_dashboard.aamp"',
    progressText: 'Verifying view schema against canonical institutional rules...',
    logs: [
      '[AGENTAMP] Validating dashboard draft against aamp.view/1 standards...',
      '[SCHEMA] 14 financial charts, 2 interactive filters, 1 action recommendation [VALID]',
      '[CRYPTO] Computing HMAC SHA-256 institutional signature over AST payload...'
    ],
    success: '[SEALED & PINNED] Deliverable permanently archived to L2 canonical workspace.'
  }
];

function initScrollCLI() {
  const terminalSection = document.getElementById('terminal');
  const tuiOutput = document.getElementById('tuiOutput');
  const statusBadge = document.getElementById('cliStatusBadge');
  const screen = document.getElementById('terminalScreen');
  if (!terminalSection || !tuiOutput) return;

  let currentStageIdx = -1;
  let typeTimer = null;

  const runTuiStage = (stageIdx) => {
    const stage = TUI_STAGES[stageIdx];
    if (!stage) return;

    if (typeTimer) clearTimeout(typeTimer);
    tuiOutput.innerHTML = '';

    // Update sidebar tabs
    TUI_STAGES.forEach((s, idx) => {
      const tabEl = document.getElementById(s.tabId);
      if (tabEl) {
        if (idx === stageIdx) tabEl.classList.add('active-tab');
        else tabEl.classList.remove('active-tab');
      }
    });

    if (statusBadge) statusBadge.textContent = stage.badge;

    // 1. Render Rich Textual Box Panel immediately
    const boxDiv = document.createElement('div');
    boxDiv.className = 'tui-box-panel';
    boxDiv.innerHTML = `
      <span class="tui-box-title">╭─ ${stage.title} ─────────────────────────────────────────╮</span>
      <div class="tui-box-desc">${stage.desc}</div>
      <ul class="tui-specs-list">
        ${stage.specs.map(spec => `<li>➔ ${spec}</li>`).join('')}
      </ul>
      <span style="color: var(--border-taupe); font-size: 0.75rem; display: block; margin-top: 8px;">╰─────────────────────────────────────────────────────────────────────────────╯</span>
    `;
    tuiOutput.appendChild(boxDiv);

    // 2. Build execution script queue
    const scriptQueue = [
      { type: 'cmd', text: stage.cmd },
      { type: 'progress', text: stage.progressText },
      ...stage.logs.map(l => ({ type: 'out', text: l })),
      { type: 'success', text: stage.success }
    ];

    let stepIdx = 0;
    const playNextStep = () => {
      if (stepIdx >= scriptQueue.length) {
        const curDiv = document.createElement('div');
        curDiv.className = 't-line';
        curDiv.innerHTML = '<span class="t-prompt">$</span> <span style="color: var(--border-taupe); font-style: italic;">// Scroll down to advance to next institutional task pipeline...</span>';
        tuiOutput.appendChild(curDiv);
        if (screen) screen.scrollTop = screen.scrollHeight;
        return;
      }

      const item = scriptQueue[stepIdx];
      const div = document.createElement('div');

      if (item.type === 'cmd') {
        div.className = 't-line';
        div.innerHTML = `<span class="t-prompt">$</span> <span class="t-cmd">${item.text}</span>`;
      } else if (item.type === 'progress') {
        div.className = 'tui-progress-bar';
        div.innerHTML = `[████████████████████] 100% | <span style="color: var(--text-alabaster); font-weight: 400;">${item.text}</span>`;
      } else if (item.type === 'success') {
        div.className = 't-line t-success';
        div.textContent = item.text;
      } else {
        div.className = 't-line t-out';
        div.textContent = item.text;
      }

      tuiOutput.appendChild(div);
      if (screen) screen.scrollTop = screen.scrollHeight;
      stepIdx++;
      typeTimer = setTimeout(playNextStep, 350);
    };

    playNextStep();
  };

  const updateTUI = () => {
    const rect = terminalSection.getBoundingClientRect();
    const winHeight = window.innerHeight;
    const totalScroll = terminalSection.offsetHeight - winHeight;
    if (totalScroll <= 0) return;

    let p = -rect.top / totalScroll;
    if (p < 0) p = 0;
    if (p > 1) p = 1;

    let targetIdx = Math.floor(p * 6);
    if (targetIdx >= 6) targetIdx = 5;

    if (targetIdx !== currentStageIdx) {
      currentStageIdx = targetIdx;
      runTuiStage(currentStageIdx);
      playClickSound();
    }
  };

  window.addEventListener('scroll', updateTUI, { passive: true });
  updateTUI();
}

/* ==========================================================================
   7. Neuro-Assist Floating Dock (Retro Brass) & Bionic Reading
   ========================================================================== */
function initNeuroDock() {
  const trigger = document.getElementById('dockTrigger');
  const menu = document.getElementById('dockMenu');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', () => {
    menu.classList.toggle('open');
    playClickSound();
  });

  const fontChk = document.getElementById('toggleDyslexicFont');
  if (fontChk) {
    fontChk.addEventListener('change', (e) => {
      document.body.classList.toggle('neuro-dyslexic', e.target.checked);
      playClickSound();
    });
  }

  const spacingChk = document.getElementById('toggleLineSpacing');
  if (spacingChk) {
    spacingChk.addEventListener('change', (e) => {
      document.body.classList.toggle('neuro-spacing', e.target.checked);
      playClickSound();
    });
  }

  const bionicChk = document.getElementById('toggleBionicReading');
  if (bionicChk) {
    bionicChk.addEventListener('change', (e) => {
      if (e.target.checked) applyBionicReading(true);
      else applyBionicReading(false);
      playClickSound();
    });
  }
}

function initBionicReading() {
  window._bionicOriginals = new Map();
  document.querySelectorAll('.bionic-target').forEach((el, idx) => {
    window._bionicOriginals.set(idx, el.innerHTML);
  });
}

function applyBionicReading(enable) {
  const targets = document.querySelectorAll('.bionic-target');
  if (!enable) {
    targets.forEach((el, idx) => {
      if (window._bionicOriginals && window._bionicOriginals.has(idx)) {
        el.innerHTML = window._bionicOriginals.get(idx);
      }
    });
    return;
  }

  targets.forEach((el, idx) => {
    if (!window._bionicOriginals || !window._bionicOriginals.has(idx)) return;
    const origHtml = window._bionicOriginals.get(idx);

    const temp = document.createElement('div');
    temp.innerHTML = origHtml;

    const processNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (!text.trim()) return;
        const words = text.split(/(\s+)/);
        const bionicWords = words.map(w => {
          if (!w.trim() || w.length === 1) return w;
          const mid = Math.ceil(w.length / 2);
          const boldPart = w.slice(0, mid);
          const restPart = w.slice(mid);
          return `<span class="bionic-anchor">${boldPart}</span>${restPart}`;
        });
        const span = document.createElement('span');
        span.innerHTML = bionicWords.join('');
        node.parentNode.replaceChild(span, node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE' && !node.classList.contains('bionic-anchor')) {
          Array.from(node.childNodes).forEach(processNode);
        }
      }
    };

    Array.from(temp.childNodes).forEach(processNode);
    el.innerHTML = temp.innerHTML;
  });
}
