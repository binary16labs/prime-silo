// navi-key.js — V2 Benny Prime-Silo Earth Console
// Mode-specific dot-matrix displays:
// IDLE (Benny portrait), HAPPY (tongue out), ALERT (guard mode), SLEEPING (curled dog + Zzz),
// RUNNING (basic running dog stride), CODE (Benny at PC), DOCUMENTS (Benny with glasses),
// MEMORY (Brain), AGENTS (Robot).

class NaviKey extends HTMLElement {

  /* ─── Canonical Prime-Silo Zen Earth Palette ───────────────────── */
  static COLORS = {
    pulse:     { arc: '#c47a6a', glow: '#d98e7e', label: 'Pulse'     }, // Coral Terracotta
    memory:    { arc: '#9caf88', glow: '#b2c59e', label: 'Memory'    }, // Prime Sage / Moss
    documents: { arc: '#c4a882', glow: '#d8bc96', label: 'Docs'      }, // Golden Taupe
    code:      { arc: '#6b7d63', glow: '#829679', label: 'Code 3D'   }, // Slate Olive
    flows:     { arc: '#d8c3a5', glow: '#ece0cb', label: 'Flows'     }, // Warm Sandstone
    studio:    { arc: '#b88a74', glow: '#cc9e88', label: 'Studio'    }, // Soft Clay
    runs:      { arc: '#889c7d', glow: '#9fb394', label: 'Runs'      }, // Eucalyptus Sage
    v2:        { arc: '#63a063', glow: '#7ebc7e', label: 'Gov V2'    }, // Emerald Sage
    agents:    { arc: '#788475', glow: '#8f9b8c', label: 'Agents'    }, // Warm Slate
    chats:     { arc: '#a68b6d', glow: '#bca183', label: 'Chat'      }, // Warm Umber
  };

  /* ─── Mode-Specific Dot Matrix Patterns (20×20) ────────────────── */
  static PATTERNS = {
    idle: [
      "00000000000000000000",
      "0000TT00000000TT0000",
      "000TTK00000000KTT000",
      "000TTKK000000KKTT000",
      "000TTKKK0000KKKTT000",
      "000TTTKKKKKKKKTTT000",
      "000TTTTTTTTTTTTTT000",
      "000TTTTRTTTTTRTTT000",
      "000TTTEETTTTTTEETT00",
      "000TTTBETTTTTTBETT00",
      "000KTTTTTTTTTTTTTK00",
      "000KTTTTKKKKTTTTTK00",
      "000KKTTTKKKKTTTTKK00",
      "0000KKTTNTTTTTKKK000",
      "0000KKTTMMTTTTKK0000",
      "00000KKKTTTTTTKK0000",
      "000000KTTTTTTTK00000",
      "0000000TTTTTTT000000",
      "00000000TTTTT0000000",
      "00000000000000000000",
    ],
    happy: [
      "00000000000000000000",
      "0000TT00000000TT0000",
      "000TTK00000000KTT000",
      "000TTKK000000KKTT000",
      "000TTKKK0000KKKTT000",
      "000TTTKKKKKKKKTTT000",
      "000TTTTTTTTTTTTTT000",
      "000TTTTRTTTTTRTTT000",
      "000TTTHHTTTTTTHHTT00",  // H = happy squint eyes
      "000TTTHHTTTTTTHHTT00",
      "000KTTTTTTTTTTTTTK00",
      "000KTTTTKKKKTTTTTK00",
      "000KKTTTKKKKTTTTKK00",
      "0000KKTTNTTTTTKKK000",
      "0000KKTTMMTTTTKK0000",
      "00000KKKPPPPTTKK0000",  // P = tongue out!
      "000000KTTTTTTTK00000",
      "0000000TTTTTTT000000",
      "00000000TTTTT0000000",
      "00000000000000000000",
    ],
    alert: [
      "000TT0000000000TT000",  // Ears perked high
      "000TTK00000000KTT000",
      "000TTKK000000KKTT000",
      "000TTKKK0000KKKTT000",
      "000TTTKKKKKKKKTTT000",
      "000TTTTTTTTTTTTTT000",
      "000TTTTRTTTTTRTTT000",
      "000TTTAATTTTTTAATT00",  // A = alert eye glow
      "000TTTAATTTTTTAATT00",
      "000KTTTTTTTTTTTTTK00",
      "000KTTTTKKKKTTTTTK00",
      "000KKTTTKKKKTTTTKK00",
      "0000KKTTNTTTTTKKK000",
      "0000KKTTMMTTTTKK0000",
      "00000KKKTTTTTTKK0000",
      "000000KTTTTTTTK00000",
      "0000000TTTTTTT000000",
      "00000000TTTTT0000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    sleeping: [
      "0000000000000000ZZ00",  // Basic sleeping dog + floating Zzz
      "00000000000000Z00000",
      "000000000000Z0000000",
      "0000000TTKKTT0000000",
      "00000TTTKSSESTTT0000",  // S = sleeping eyes ~ ~
      "0000TTTTKNM00TTT0000",
      "000TTTTTTTTTTTTTT000",  // Curled body
      "00TTTTTTTKKKKKTTTT00",
      "0TTTTTTTTKKKKKKKTTT0",
      "0TTTTTTTTTKKKKKKKTT0",  // Tail wrapped
      "00TTTTTTTTTTTTTTTT00",
      "000TTTTTTTTTTTTTT000",  // Paws
      "00000TTTTTTTTTT00000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    run1: [
      "00000000000000000000",
      "00000000000000000000",
      "00000000000TTK000000",  // Basic running dog stride 1
      "0000000000TTTKET0000",
      "0000000000TTTKNM0000",
      "00000000TTTTTTT00000",
      "000000TTTTTKKKKK0000",
      "000TTTTTTTTKKKKKKT00",
      "T0TTTTTTTTTTTTTTTTT0",  // Legs reaching forward & back
      "0T0000T0000000T000T0",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    run2: [
      "00000000000000000000",
      "00000000000000000000",
      "0000000000000TTK0000",  // Basic running dog stride 2 (leap)
      "00000000000TTTKET000",
      "00000000000TTTKNM000",
      "000000000TTTTTTT0000",
      "000000TTTTTKKKKK0000",
      "0000TTTTTTTTKKKKKKT0",
      "000T00TTTTTTTTTTTT00",  // Legs tucked mid-air
      "0000000T00T0000T00T0",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    code: [
      "00000000000000000000",
      "0000TT00000000TT0000",  // Benny at a PC! Ears peeking behind monitor
      "000TTK00000000KTT000",
      "000TTKK000000KKTT000",
      "000TTTETTTTTTTET0000",  // Eyes peeking over screen
      "00000CCCCCCCCCCCC000",  // C = PC frame
      "00000CDDDDDDDDDDC000",  // D = code lines on screen!
      "00000CDDDDDDDDDDC000",
      "00000CDDDDDDDDDDC000",
      "00000CCCCCCCCCCCC000",
      "000000000CCCC0000000",  // Stand
      "0000000CCCCCC0000000",
      "00000CCCCCCCCCCCC000",  // Keyboard base
      "000000TTTTTTTTTT0000",  // Paws typing on keyboard
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    documents: [
      "00000000000000000000",
      "0000TT00000000TT0000",  // Benny wearing glasses! 👓
      "000TTK00000000KTT000",
      "000TTKK000000KKTT000",
      "000TTKKK0000KKKTT000",
      "000TTTKKKKKKKKTTT000",
      "000TTTTTTTTTTTTTT000",
      "000TTTTRTTTTTRTTT000",
      "000GGGGGGTTGGGGGG000",  // G = Glasses frame & bridge!
      "000GBEBGBGTTGBEBGB00",  // Glasses lens & eyes underneath
      "000GGGGGGTTGGGGGG000",
      "000KTTTTKKKKTTTTTK00",
      "000KKTTTKKKKTTTTKK00",
      "0000KKTTNTTTTTKKK000",  // Nose
      "0000KKTTMMTTTTKK0000",  // Mouth
      "00000KKKTTTTTTKK0000",
      "000000KTTTTTTTK00000",
      "0000000TTTTTTT000000",
      "00000000TTTTT0000000",
      "00000000000000000000",
    ],
    memory: [
      "00000000000000000000",
      "00000000000000000000",
      "00000DDDD0000DDDD000",  // Just a Brain! 🧠
      "000DDDDDDDDDDDDDDDD0",
      "00DDDDDDDDDDDDDDDDDD",
      "0DDDBBDDDDDDDDBBDDDD",  // D = brain tissue, B = fold creases
      "0DDDDDDDDDDDDDDDDDDD",
      "0DDDDDDDDDDDDDDDDDDD",
      "00DDDDDDDDDDDDDDDDDD",
      "000DDDDDDDDDDDDDDDD0",
      "0000DDDDDDDDDDDDDD00",
      "000000CCCCCC00000000",  // Brain stem
      "0000000CCCC000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    agents: [
      "0000000000AA00000000",  // A = Antenna bulb!
      "0000000000CC00000000",
      "0000CCCCCCCCCCCC0000",  // A Robot! 🤖
      "0000CCCCC00CCCCC0000",  // Robot ears
      "0000CCBEEBCBEEBC0000",  // Robot eyes
      "0000CCCCCCCCCCCC0000",
      "0000CCCCDDDDCCCC0000",  // Nose grill
      "0000CCMMMMMMMMCC0000",  // M = Robot mouth grid
      "0000CCCCCCCCCCCC0000",
      "00000000CCCC00000000",  // Neck joint
      "0000CCCCCCCCCCCC0000",  // Shoulders
      "0000CCCCCCCCCCCC0000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
    v2: [
      "00000000000000000000",
      "00000000000000000000",
      "0000CCCCCCCCCCCC0000",  // Shield Top (Governance V2 🛡️)
      "000CDDDDDDDDDDDDC000",  // D = Emerald Sage
      "000CDDDDDDDDDDDDC000",
      "000CDDDDCCCCCCDDDC00",  // Audit Scale bar
      "000CDDDD00CC00DDDC00",
      "000CDDD000CC000DDC00",
      "0000CDD000CC000DDC00",
      "0000CDD000CC000DC000",
      "00000CDD00CC00DC0000",
      "000000CDDCCCCDC00000",  // Shield point
      "0000000CDDDDDC000000",
      "00000000CDDDC0000000",
      "000000000CDC00000000",
      "0000000000C000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
      "00000000000000000000",
    ],
  };

  // Natural Prime-Silo Earth color map
  static DOT_COLORS = {
    T: '#c4a882',  // Golden Taupe Coat
    K: '#2e2922',  // Deep Dark Earth Saddle
    E: '#1a1714',  // Dark Truffle Pupil
    B: '#ece6d8',  // Soft Warm Cream Specular
    R: '#d8c3a5',  // Warm Sand Brow Dot
    N: '#181512',  // Charcoal Nose
    M: '#c47a6a',  // Soft Coral Mouth Accent
    P: '#e07a5f',  // Happy Tongue Out Terracotta Pink
    H: '#c4a882',  // Happy Squint Eye Arc
    A: '#ece6d8',  // Alert Eye Glow / Robot Antenna
    S: '#d8c3a5',  // Sleeping Curved Eye Arc (~ ~)
    G: '#d8c3a5',  // Glasses Frame (Docs)
    C: '#788475',  // Computer / Robot Body (Warm Slate)
    D: '#9caf88',  // PC Screen Code (Sage Green)
    Z: '#d8c3a5',  // Sleeping Zzz
    '1': '#2e2922',
  };

  connectedCallback() {
    this.innerHTML = `
      <div class="navi-key-container">
        <svg class="navi-key-svg" viewBox="-160 -160 320 320">
          <defs>
            <!-- Soft Zen Ambient Aura -->
            <radialGradient id="ps-ambient-aura" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#c4a882" stop-opacity="0.12" />
              <stop offset="75%" stop-color="#9caf88" stop-opacity="0.03" />
              <stop offset="100%" stop-color="#14150f" stop-opacity="0" />
            </radialGradient>
          </defs>

          <!-- Subtle Ambient Aura -->
          <circle class="navi-key-nebula" cx="0" cy="0" r="140" fill="url(#ps-ambient-aura)"></circle>

          <!-- Hit zones come FIRST so arcs/dots rendered after are on top and receive clicks -->
          <circle class="navi-key-core-hit" cx="0" cy="0" r="55"></circle>

          <!-- Outer scan ring -->
          <circle class="navi-key-scan-ring" cx="0" cy="0" r="132"></circle>
          <circle class="navi-key-orbit-ring" cx="0" cy="0" r="110"></circle>

          <!-- Decorative blueprint rings -->
          <circle class="navi-key-ring" cx="0" cy="0" r="122"></circle>
          <circle class="navi-key-ring" cx="0" cy="0" r="52"></circle>
          <circle class="navi-key-ring navi-key-ring--inner" cx="0" cy="0" r="38"></circle>

          <!-- Subtle star nodes -->
          <g class="navi-key-stars"></g>

          <!-- Core Dot Matrix (Benny portrait) -->
          <g class="navi-key-core"></g>

          <!-- Radial Arcs — topmost, receive pointer events -->
          <g class="navi-key-arcs"></g>
        </svg>
      </div>
    `;

    this._expanded = false;
    this._hintShown = false;
    this._isSleeping = false;
    this._currentPetState = 'idle';
    this._animLoopTimer = null;
    this._animFrame = 0;

    this.renderStars();
    this.renderDots('idle');
    this.renderArcs();
    this.bindEvents();
    this.startIdlePulse();
    this._scheduleHintReveal();
  }

  /* ─── State Management ───────────────────────────────────────── */
  setPetState(stateName) {
    if (this._currentPetState === stateName) return;
    this._currentPetState = stateName;

    if (this._animLoopTimer) {
      clearInterval(this._animLoopTimer);
      this._animLoopTimer = null;
    }

    if (stateName === 'running') {
      this._animFrame = 0;
      const runFrames = ['run1', 'run2'];
      this.renderDots(runFrames[0]);
      this._animLoopTimer = setInterval(() => {
        this._animFrame = (this._animFrame + 1) % runFrames.length;
        this.renderDots(runFrames[this._animFrame]);
      }, 200);
    } else {
      const pName = NaviKey.PATTERNS[stateName] ? stateName : 'idle';
      this.renderDots(pName);
    }
  }

  /* ─── Ambient Nodes ──────────────────────────────────────────── */
  renderStars() {
    const starsGroup = this.querySelector('.navi-key-stars');
    let html = '';
    const starCount = 8;
    const radius = 110;
    for (let i = 0; i < starCount; i++) {
      const angle = (i * 360 / starCount) * Math.PI / 180;
      const x = (radius * Math.cos(angle)).toFixed(2);
      const y = (radius * Math.sin(angle)).toFixed(2);
      html += `<circle class="navi-key-star" cx="${x}" cy="${y}" r="1.2" fill="#d8c3a5" opacity="0.35"></circle>`;
    }
    starsGroup.innerHTML = html;
  }

  /* ─── Dot Matrix Render ──────────────────────────────────────── */
  renderDots(patternKey = 'idle') {
    const core = this.querySelector('.navi-key-core');
    if (!core) return;
    const pattern  = NaviKey.PATTERNS[patternKey] || NaviKey.PATTERNS.idle;
    const colorMap = NaviKey.DOT_COLORS;

    const rows    = pattern.length;
    const cols    = pattern[0].length;
    const spacing = 5.0;
    const dotSize = 3.4;
    const xOffset = -(cols * spacing) / 2 + spacing / 2;
    const yOffset = -(rows * spacing) / 2 + spacing / 2;

    let dots = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ch = pattern[r][c];
        if (ch === '0') continue;
        const x  = c * spacing + xOffset;
        const y  = r * spacing + yOffset;
        const fc = colorMap[ch] || '#c4a882';
        dots += `<rect class="navi-key-dot" data-sym="${ch}"
          x="${(x - dotSize / 2).toFixed(2)}"
          y="${(y - dotSize / 2).toFixed(2)}"
          width="${dotSize}" height="${dotSize}" rx="1.2"
          fill="${fc}"></rect>`;
      }
    }
    core.innerHTML = dots;
    this._dots = Array.from(core.querySelectorAll('.navi-key-dot'));
  }

  /* ─── Radial Arcs ────────────────────────────────────────────── */
  renderArcs() {
    const arcsGroup = this.querySelector('.navi-key-arcs');
    const sections  = Object.entries(NaviKey.COLORS).map(([id, v]) => ({ id, ...v }));

    const radius       = 88;
    const gapAngle     = 6;
    const sectionAngle = 360 / sections.length;
    let html = '';

    sections.forEach((sec, idx) => {
      const startAngle = idx * sectionAngle + gapAngle / 2;
      const endAngle   = ((idx + 1) * sectionAngle) - gapAngle / 2;
      const pathData   = this.describeArc(0, 0, radius, startAngle, endAngle);
      const midAngle   = startAngle + (sectionAngle - gapAngle) / 2;
      const textPos    = this.polarToCartesian(0, 0, radius + 36, midAngle);

      html += `
        <g class="navi-key-arc-group" data-target="${sec.id}"
           data-arc-color="${sec.arc}" data-arc-glow="${sec.glow}"
           role="button" aria-label="${sec.label}" tabindex="0">
          <path class="navi-key-arc" d="${pathData}"
            style="stroke:${sec.arc}; stroke-opacity:0.35;"></path>
          <text class="navi-key-label"
            x="${textPos.x.toFixed(1)}" y="${textPos.y.toFixed(1)}"
            style="fill:${sec.arc};">${sec.label}</text>
        </g>`;
    });

    arcsGroup.innerHTML = html;

    // Prep arc dash offsets
    this.querySelectorAll('.navi-key-arc').forEach(p => {
      const len = p.getTotalLength();
      p.setAttribute('stroke-dasharray', len);
      p.setAttribute('stroke-dashoffset', len);
    });
  }

  /* ─── Events ─────────────────────────────────────────────────── */
  bindEvents() {
    const coreHit   = this.querySelector('.navi-key-core-hit');
    const container = this.querySelector('.navi-key-container');
    const svg       = this.querySelector('.navi-key-svg');
    const arcGroups = this.querySelectorAll('.navi-key-arc-group');

    /* Listen for custom pet-state events */
    this.addEventListener('set-pet-state', (e) => {
      if (e.detail && e.detail.state) this.setPetState(e.detail.state);
    });

    /* Progressive discovery: outer hover shows faint hint */
    const showHint = () => {
      if (this._isSleeping || this._hintShown || this._expanded) return;
      this._hintShown = true;
      container.classList.add('hinted');
      if (!window.anime) return;
      anime({
        targets: this.querySelectorAll('.navi-key-label'),
        opacity: [0, 0.35],
        duration: 550,
        easing: 'easeOutSine'
      });
      this.querySelectorAll('.navi-key-arc').forEach(p => {
        anime({
          targets: p,
          strokeDashoffset: [p.getTotalLength(), p.getTotalLength() * 0.5],
          strokeOpacity: [0.35, 0.55],
          duration: 650,
          easing: 'easeOutSine'
        });
      });
    };

    /* Full expand on core hover (if not sleeping) */
    const expandArcs = () => {
      if (this._isSleeping || this._expanded) return;
      this._expanded = true;
      this._hintShown = true;
      container.classList.add('expanded');
      
      // Benny smiles happy on expand!
      if (this._currentPetState === 'idle') {
        this.setPetState('happy');
      }

      if (!window.anime) return;
      this.idleAnim && this.idleAnim.pause();

      this.querySelectorAll('.navi-key-arc-group').forEach((g, i) => {
        const path = g.querySelector('.navi-key-arc');
        anime({
          targets: path,
          strokeDashoffset: [path.getTotalLength(), 0],
          strokeOpacity: [0.35, 0.9],
          easing: 'easeOutExpo',
          duration: 600,
          delay: i * 50
        });
      });

      anime({
        targets: this.querySelectorAll('.navi-key-label'),
        opacity: [0, 1],
        translateY: [6, 0],
        easing: 'easeOutBack',
        duration: 450,
        delay: anime.stagger(50)
      });

      anime({
        targets: this._dots,
        scale: [
          { value: 0.1, easing: 'easeOutSine', duration: 120 },
          { value: 1,   easing: 'easeInOutQuad', duration: 350 }
        ],
        opacity: [0.3, 1],
        delay: anime.stagger(12, { grid: [20, 20], from: 'center' })
      });
    };

    /* Collapse — return to idle */
    const collapseArcs = () => {
      if (!this._expanded) return;
      this._expanded = false;
      this._hintShown = false;
      container.classList.remove('expanded', 'hinted');

      // Return Benny to idle state when collapsed
      if (this._currentPetState === 'happy' || this._currentPetState === 'code' || this._currentPetState === 'documents' || this._currentPetState === 'memory' || this._currentPetState === 'agents') {
        this.setPetState('idle');
      }

      if (!window.anime) return;

      this.querySelectorAll('.navi-key-arc').forEach(p => {
        anime({
          targets: p,
          strokeDashoffset: [0, p.getTotalLength()],
          strokeOpacity: [0.9, 0.35],
          easing: 'easeInExpo',
          duration: 320
        });
      });
      anime({
        targets: this.querySelectorAll('.navi-key-label'),
        opacity: 0,
        translateY: [0, 6],
        easing: 'easeInSine',
        duration: 180
      });

      this.startIdlePulse();
    };

    /* ─── Center Orb Click Toggle: Sleeping vs Happy Wakeup ────────── */
    coreHit.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._isSleeping) {
        // Wake up Benny!
        this._isSleeping = false;
        container.classList.remove('is-sleeping');
        this.setPetState('happy');
        expandArcs();
        
        if (window.anime) {
          anime({
            targets: this._dots,
            scale: [0.2, 1],
            opacity: [0.2, 1],
            easing: 'easeOutElastic(1, .6)',
            duration: 600
          });
        }
      } else {
        // Put Benny to sleep & contract arcs to just matrix display
        collapseArcs();
        this._isSleeping = true;
        container.classList.add('is-sleeping');
        this.setPetState('sleeping');

        if (window.anime) {
          anime({
            targets: this._dots,
            scale: [1.2, 1],
            opacity: [0.9, 0.4],
            easing: 'easeOutSine',
            duration: 500
          });
        }
      }
    });

    // Core hit circle triggers expand; SVG mouseenter triggers the hint
    coreHit.addEventListener('mouseenter', expandArcs);
    svg.addEventListener('mouseenter', showHint);
    svg.addEventListener('mouseleave', collapseArcs);

    /* Arc interactions — mode-specific icon displays! */
    arcGroups.forEach(group => {
      const path  = group.querySelector('.navi-key-arc');
      const color = group.getAttribute('data-arc-color');
      const glow  = group.getAttribute('data-arc-glow');

      group.addEventListener('mouseenter', () => {
        if (this._isSleeping) return;
        const target = group.getAttribute('data-target');
        
        // Mode-specific icon reaction!
        if (target === 'code') {
          this.setPetState('code');       // Benny at PC
        } else if (target === 'documents') {
          this.setPetState('documents');  // Benny with glasses 👓
        } else if (target === 'memory') {
          this.setPetState('memory');     // Brain 🧠
        } else if (target === 'agents') {
          this.setPetState('agents');     // Robot 🤖
        } else if (target === 'v2') {
          this.setPetState('v2');         // Governance V2 Shield 🛡️
        } else if (target === 'runs' || target === 'flows') {
          this.setPetState('running');    // Running dog
        } else if (target === 'pulse') {
          this.setPetState('alert');      // Guard mode
        } else {
          this.setPetState('happy');      // Smile & tongue out
        }

        if (!window.anime) return;
        anime({ targets: path, strokeWidth: 34, stroke: glow, strokeOpacity: 1, duration: 160, easing: 'easeOutQuad' });
        const lbl = group.querySelector('.navi-key-label');
        anime({ targets: lbl, scale: 1.1, fill: glow, duration: 160, easing: 'easeOutSine' });
      });

      group.addEventListener('mouseleave', () => {
        if (this._isSleeping) return;
        if (!window.anime) return;
        anime({ targets: path, strokeWidth: 26, stroke: color, strokeOpacity: 0.9, duration: 220, easing: 'easeOutQuad' });
        const lbl = group.querySelector('.navi-key-label');
        anime({ targets: lbl, scale: 1, fill: color, duration: 200, easing: 'easeOutSine' });
      });

      group.addEventListener('click', () => {
        const target = group.getAttribute('data-target');
        this.dispatchEvent(new CustomEvent('nav-action', { detail: { action: target }, bubbles: true, composed: true }));

        if (window.anime) {
          anime({ targets: path, strokeWidth: [38, 26], stroke: [glow, color], strokeOpacity: [1, 0.9], easing: 'easeOutElastic(1, .6)', duration: 700 });
          anime({
            targets: this._dots,
            fill: [glow, (el) => NaviKey.DOT_COLORS[el.getAttribute('data-sym')] || '#c4a882'],
            scale: [1.3, 1],
            easing: 'easeOutQuad',
            duration: 550,
            delay: anime.stagger(12, { grid: [20, 20], from: 'center' })
          });
        }
      });

      // Keyboard accessibility
      group.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); group.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      });
    });
  }

  /* ─── Idle pulse ─────────────────────────────────────────────── */
  startIdlePulse() {
    if (!window.anime) {
      this._pulseTimer = setTimeout(() => this.startIdlePulse(), 600);
      return;
    }
    if (this.idleAnim) this.idleAnim.pause();
    this.idleAnim = anime({
      targets: this._dots || this.querySelectorAll('.navi-key-dot'),
      opacity: [0.3, 0.85, 0.3],
      easing: 'easeInOutSine',
      duration: 3800,
      loop: true,
      delay: anime.stagger(45, { grid: [20, 20], from: 'center' })
    });

    this._scheduleEyeBlink();
    this._scheduleScanLine();
  }

  _scheduleEyeBlink() {
    clearTimeout(this._blinkTimer);
    const delay = 3200 + Math.random() * 4500;
    this._blinkTimer = setTimeout(() => {
      if (this._isSleeping || this._expanded || this._currentPetState !== 'idle') { this._scheduleEyeBlink(); return; }
      const eyes = Array.from(this.querySelectorAll('.navi-key-dot[data-sym="B"]'));
      if (!eyes.length || !window.anime) { this._scheduleEyeBlink(); return; }
      anime({
        targets: eyes,
        opacity: [1, 0, 0, 1],
        scaleY: [1, 0.05, 0.05, 1],
        duration: 250,
        easing: 'easeInOutSine',
        complete: () => this._scheduleEyeBlink()
      });
    }, delay);
  }

  _scheduleScanLine() {
    clearTimeout(this._scanTimer);
    const delay = 6000 + Math.random() * 6000;
    this._scanTimer = setTimeout(() => {
      if (this._isSleeping || this._expanded || !window.anime) { this._scheduleScanLine(); return; }
      const dots = this._dots || [];
      anime({
        targets: dots,
        opacity: [{ value: 0.9, duration: 100 }, { value: 0.3, duration: 250 }],
        fill: [
          { value: '#d8c3a5', duration: 80 },
          { value: (el) => NaviKey.DOT_COLORS[el.getAttribute('data-sym')] || '#c4a882', duration: 350 }
        ],
        delay: anime.stagger(22, { grid: [20, 20], from: 'first' }),
        easing: 'easeOutSine',
        complete: () => this._scheduleScanLine()
      });
    }, delay);
  }

  _scheduleHintReveal() {
    this._hintTimer = setTimeout(() => {
      if (this._isSleeping || this._expanded) return;
      const ring = this.querySelector('.navi-key-scan-ring');
      if (!ring || !window.anime) return;
      anime({
        targets: ring,
        strokeOpacity: [0.1, 0.45, 0.1],
        strokeDashoffset: [0, 820],
        duration: 2800,
        easing: 'easeInOutSine',
        loop: 2
      });
    }, 5000);
  }

  /* ─── Geometry helpers ───────────────────────────────────────── */
  polarToCartesian(cx, cy, r, deg) {
    const rad = (deg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  describeArc(x, y, r, startDeg, endDeg) {
    const s = this.polarToCartesian(x, y, r, endDeg);
    const e = this.polarToCartesian(x, y, r, startDeg);
    const largeArc = endDeg - startDeg <= 180 ? '0' : '1';
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y}`;
  }
}

customElements.define('navi-key', NaviKey);
