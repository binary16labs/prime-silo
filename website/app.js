/* Prime-Silo marketing site — kinetic layer.
   Native anime.js v4 (two-argument) throughout. All motion is:
   - gated behind prefers-reduced-motion AND html.calm-motion
   - scroll-scrubbed via createTimeline({ autoplay: onScroll({ sync: true }) })
   - reversible (reverse scroll rewinds every chapter)
   CSS defaults are the final readable states; zero-JS renders a complete page. */

import {
  animate, createTimeline, onScroll, stagger, createDrawable, spring, splitText,
  utils, clamp
} from './vendor/anime.esm.min.js';

const html = document.documentElement;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ==========================================================================
   1. Neuro-Assist dock (persisted)
   ========================================================================== */
const toggleDyslexicBtn = $('#toggle-dyslexic');
const toggleBionicBtn = $('#toggle-bionic');
const toggleMotionBtn = $('#toggle-motion');

if (localStorage.getItem('ps_neuro_dyslexic') === 'true') {
  document.body.classList.add('font-opendyslexic');
  toggleDyslexicBtn?.classList.add('active');
}
if (localStorage.getItem('ps_neuro_bionic') === 'true') {
  document.body.classList.add('bionic-active');
  toggleBionicBtn?.classList.add('active');
}
if (localStorage.getItem('ps_neuro_calm_motion') === 'true') {
  html.classList.add('calm-motion');
  toggleMotionBtn?.classList.add('active');
}

toggleDyslexicBtn?.addEventListener('click', () => {
  const active = document.body.classList.toggle('font-opendyslexic');
  toggleDyslexicBtn.classList.toggle('active', active);
  localStorage.setItem('ps_neuro_dyslexic', String(active));
});

toggleBionicBtn?.addEventListener('click', () => {
  const active = document.body.classList.toggle('bionic-active');
  toggleBionicBtn.classList.toggle('active', active);
  localStorage.setItem('ps_neuro_bionic', String(active));
});

toggleMotionBtn?.addEventListener('click', () => {
  const active = html.classList.toggle('calm-motion');
  toggleMotionBtn.classList.toggle('active', active);
  localStorage.setItem('ps_neuro_calm_motion', String(active));
  if (active) teardownMotion();
  else initMotion();
});

/* Bionic Reading (skips terminal + kinetic headline) */
function applyBionicReading(container) {
  if (!container) return;
  $$('p, li', container).forEach((p) => {
    if (p.dataset.bionicDone || p.closest('.term-block') || p.closest('.hero-headline')) return;
    if (p.children.length > 0) return; // structured nodes (e.g. rail .step cards) keep their markup
    p.dataset.bionicDone = 'true';
    const words = p.textContent.split(' ');
    p.innerHTML = words.map((w) => {
      if (w.length <= 3) return `<span class="bionic-bold">${w}</span>`;
      const cut = Math.ceil(w.length * 0.45);
      return `<span class="bionic-bold">${w.slice(0, cut)}</span>${w.slice(cut)}`;
    }).join(' ');
  });
}
applyBionicReading(document.body);

/* ==========================================================================
   2. Honest cloud-vs-local calculator (unchanged model)
   ========================================================================== */
const calcInputs = {
  sessionsPerMonth: $('#input-sessionsPerMonth'),
  avgTokensPerSession: $('#input-avgTokensPerSession'),
  cloudPricePerMTok: $('#input-cloudPricePerMTok'),
  reIngestFactor: $('#input-reIngestFactor'),
  localPowerWatts: $('#input-localPowerWatts'),
  electricityPerKwh: $('#input-electricityPerKwh')
};
const displayCloudCost = $('#display-cloud-cost');
const displayLocalCost = $('#display-local-cost');
const barCloud = $('#bar-cloud');
const barLocal = $('#bar-local');

function calculateCost() {
  if (!calcInputs.sessionsPerMonth) return;
  const sessions = parseFloat(calcInputs.sessionsPerMonth.value) || 40;
  const tokens = parseFloat(calcInputs.avgTokensPerSession.value) || 120000;
  const cloudPrice = parseFloat(calcInputs.cloudPricePerMTok.value) || 3.0;
  const reIngest = parseFloat(calcInputs.reIngestFactor.value) || 1.5;
  const watts = parseFloat(calcInputs.localPowerWatts.value) || 250;
  const kwhRate = parseFloat(calcInputs.electricityPerKwh.value) || 0.3;

  const totalTokensMillion = (sessions * tokens * reIngest) / 1000000;
  const cloudMonthly = totalTokensMillion * cloudPrice;
  const activeHoursMonthly = sessions * 0.4;
  const localMonthly = (watts / 1000) * activeHoursMonthly * kwhRate;

  displayCloudCost.textContent = `$${cloudMonthly.toFixed(2)} / mo`;
  displayLocalCost.textContent = `$${localMonthly.toFixed(2)} / mo`;

  const maxCost = Math.max(cloudMonthly, localMonthly, 10);
  if (barCloud && barLocal) {
    barCloud.style.width = `${clamp((cloudMonthly / maxCost) * 100, 4, 100)}%`;
    barLocal.style.width = `${clamp((localMonthly / maxCost) * 100, 4, 100)}%`;
  }
}
Object.entries(calcInputs).forEach(([key, el]) => {
  if (!el) return;
  el.addEventListener('input', () => {
    const valDisplay = $(`#val-${key}`);
    if (valDisplay) valDisplay.textContent = el.value;
    calculateCost();
  });
});
calculateCost();

/* ==========================================================================
   3. Motion system
   ========================================================================== */
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const mobileQuery = matchMedia('(max-width: 820px)');
const motionAllowed = () => !reduceQuery.matches && !html.classList.contains('calm-motion');

let live = [];          // every animation/timeline created (revert()-able)
let splits = [];        // text splitters
let motionOn = false;

function track(anim) { live.push(anim); return anim; }

function scrubOptions(section) {
  return onScroll({
    target: section,
    enter: 'top top',
    leave: 'bottom bottom',
    sync: true
  });
}

/* Scrubbed timeline whose own onUpdate drives the rail/readout callbacks. */
function scrubTimeline(section, onProgress, defaults = { ease: 'inOutQuad' }) {
  const tl = createTimeline({
    defaults,
    autoplay: scrubOptions(section),
    onUpdate: (self) => onProgress && onProgress(clamp(self.progress ?? 0, 0, 1))
  });
  return track(tl);
}

/* Rail sync: beat index -> .step / .chapter-dot active states.
   Mobile (<=820px): the steps list is a one-card strip — translate it so the
   active card is the visible one (the scrub experience survives narrow layouts). */
const railMobileMQ = window.matchMedia('(max-width: 820px)');
function makeRailSync(section, beats, stepOfBeat) {
  const steps = $$('.chapter-rail .step', section);
  const dots = $$('.chapter-dot', section);
  const list = section.querySelector('.chapter-steps');
  railMobileMQ.addEventListener?.('change', (e) => {
    if (!e.matches && list) list.style.transform = '';
  });
  return (p) => {
    const beat = Math.min(beats - 1, Math.max(0, Math.floor(p * beats)));
    const stepIdx = stepOfBeat ? stepOfBeat(beat) : beat;
    steps.forEach((s, i) => s.classList.toggle('active', i === stepIdx));
    dots.forEach((d, i) => d.classList.toggle('active', i === beat));
    if (list) list.style.transform = railMobileMQ.matches ? `translateX(${-stepIdx * 100}%)` : '';
  };
}

/* --------------------------------------------------------------------------
   3a. HERO — silo assembles from ring segments, kinetic type, Benny idle
   -------------------------------------------------------------------------- */
function initHero() {
  track(animate('#hero-silo .hs-ring', {
    translateY: [46, 0], opacity: [0, 1],
    delay: stagger(70, { from: 'last' }), duration: 700, ease: 'out(3)'
  }));
  track(animate('#hero-silo .hs-roof', {
    translateY: [-60, 0], opacity: [0, 1], delay: 480,
    ease: spring({ stiffness: 110, damping: 13 })
  }));
  track(animate('#hero-silo .hs-door, #hero-silo .hs-vent, #hero-silo .hs-legs', {
    opacity: [0, 1], duration: 500, delay: 720, ease: 'out(2)'
  }));

  try {
    const split = splitText('.hero-headline', { words: { wrap: 'clip' } });
    splits.push(split);
    track(animate(split.words, {
      y: ['1.2em', 0], opacity: [0, 1],
      delay: stagger(40, { start: 150 }), duration: 800, ease: 'out(4)'
    }));
  } catch (e) { /* headline stays static (readable default) */ }

  track(animate('.hero-content .section-kicker, .hero-content .section-sub, .hero-actions', {
    opacity: [0, 1], translateY: [16, 0],
    delay: stagger(110, { start: 250 }), duration: 600, ease: 'out(3)'
  }));
  track(animate('.proof-chip', {
    opacity: [0, 1], translateY: [18, 0], scale: [0.9, 1],
    delay: stagger(60, { start: 650 }), duration: 550, ease: 'out(3)'
  }));

  // Benny idle loop: tail wag + ear twitch + gentle head tilt
  track(animate('.benny-hero .b-tail', { rotate: [-9, 9], duration: 1300, alternate: true, loop: true, ease: 'inOutSine' }));
  track(animate('.benny-hero .b-ear-left', { rotate: [0, -6], duration: 2600, alternate: true, loop: true, delay: 1200, ease: 'inOutQuad' }));
  track(animate('.benny-hero .b-ear-right', { rotate: [0, 5], duration: 2200, alternate: true, loop: true, delay: 600, ease: 'inOutQuad' }));
  track(animate('.benny-hero .b-head', { rotate: [-1.5, 1.5], duration: 3400, alternate: true, loop: true, ease: 'inOutSine' }));
}

/* --------------------------------------------------------------------------
   3b. INSIDE THE SILO — shell halves slide open, floors lift with spring
   settle + label lines draw, finale re-stack + seal stamp.  6 beats / 5200u.
   -------------------------------------------------------------------------- */
function initSiloChapter() {
  const section = $('#inside-the-silo');
  if (!section) return;
  section.classList.add('js-scrub');

  const lines = $$('#silo-open-svg .floor-line').map((p) => createDrawable(p)[0]);
  lines.forEach((l) => utils.set(l, { draw: '0 0' }));

  const railSync = makeRailSync(section, 6, (beat) => clamp(beat - 1, 0, 3));
  const tl = scrubTimeline(section, railSync);

  // beat 0 (0-800): shell halves slide open, interior brightens
  tl.add('#shell-left', { translateX: [0, -172], opacity: [1, 0.55], duration: 800 }, 0)
    .add('#shell-right', { translateX: [0, 172], opacity: [1, 0.55], duration: 800 }, 0)
    .add('#silo-floors', { opacity: [0.55, 1], duration: 600 }, 150);

  // beats 1-4 (800 + i*900): lift floor i forward, dim the rest, draw its label line
  const floorSel = (i) => `#silo-open-svg .silo-floor[data-floor="${i}"] .floor-anim`;
  for (let i = 0; i < 4; i++) {
    const t = 800 + i * 900;
    for (let j = 0; j < 4; j++) {
      const isActive = j === i;
      tl.add(floorSel(j), {
        scale: isActive ? 1.14 : 1,
        translateX: isActive ? -26 : 0,
        opacity: isActive ? 1 : 0.3,
        duration: 460,
        ease: isActive ? 'outBack(1.8)' : 'inOutQuad'
      }, t);
    }
    if (i > 0) tl.add(lines[i - 1], { draw: '0 0', duration: 300 }, t);
    tl.add(lines[i], { draw: '0 1', duration: 520, ease: 'inOutSine' }, t + 180);
  }

  // finale (4400-5200): re-stack, shells close, seal stamps with elastic settle
  const tF = 4400;
  for (let j = 0; j < 4; j++) {
    tl.add(floorSel(j), { scale: 1, translateX: 0, opacity: 1, duration: 300 }, tF);
  }
  tl.add(lines[3], { draw: '0 0', duration: 250 }, tF)
    .add('#shell-left', { translateX: 0, opacity: 1, duration: 420 }, tF + 180)
    .add('#shell-right', { translateX: 0, opacity: 1, duration: 420 }, tF + 180)
    .add('#silo-seal', { opacity: [0, 1], duration: 90 }, tF + 560)
    .add('#silo-seal .seal-anim', {
      scale: [2.1, 1], rotate: [-14, 0], duration: 240, ease: 'outBack(2.2)'
    }, tF + 560);
}

/* --------------------------------------------------------------------------
   3c. TRI-GRAPH — mesh explodes into 3 tinted clusters, dashed
   CORRELATES_WITH edges draw in.  5 beats / 4600u.
   -------------------------------------------------------------------------- */
function initTrigraphChapter() {
  const section = $('#trigraph');
  if (!section) return;
  section.classList.add('js-scrub');

  const edges = $$('#trigraph-svg .tg-edge').map((p) => createDrawable(p)[0]);
  edges.forEach((e) => utils.set(e, { draw: '0 0' }));

  const railSync = makeRailSync(section, 5);
  const tl = scrubTimeline(section, railSync);

  // beat 0: one unified mesh breathing at center
  tl.add('#trigraph-svg', { scale: [0.94, 1], duration: 800, ease: 'out(2)' }, 0);

  // beats 1-3: each cluster separates out of the shared center + its ring blooms
  const bursts = [
    ['#tg-docs', 190, 100, 800],
    ['#tg-code', -190, 80, 1700],
    ['#tg-memory', -5, -170, 2600]
  ];
  for (const [id, dx, dy, t] of bursts) {
    tl.add(`${id} .cluster-anim`, {
      translateX: [dx, 0], translateY: [dy, 0], duration: 900, ease: 'out(3)'
    }, t);
    tl.add(`${id} .cluster-ring`, {
      opacity: [0, 0.7], scale: [0.5, 1], duration: 520, ease: 'outBack(1.6)'
    }, t + 380);
  }

  // beat 4: dashed CORRELATES_WITH edges draw between the clusters
  edges.forEach((e, i) => {
    tl.add(e, { draw: '0 1', duration: 600, ease: 'inOutSine' }, 3500 + i * 220);
  });
  tl.add('#trigraph-svg .tg-edge-label', {
    opacity: [0, 1], duration: 400, delay: stagger(120)
  }, 4050);
}

/* --------------------------------------------------------------------------
   3d. MEMO-RAY DIAL — sweeping arc, blooming nodes, center readout,
   count-up stats.  5 beats (rail) x 6 nodes / 5000u.
   -------------------------------------------------------------------------- */
function initDialChapter() {
  const section = $('#longview');
  if (!section) return;
  section.classList.add('js-scrub');

  const arc = createDrawable('#dial-arc')[0];
  utils.set(arc, { draw: '0 0' });

  const stepLabels = $$('.chapter-rail .step h4', section).map((h) => h.textContent);
  const nSteps = stepLabels.length || 6; // 6 steps = 6 dial nodes (content-driven)
  const kickerEl = $('.dial-step-kicker', section);
  const nameEl = $('.dial-step-name', section);
  const railSync = makeRailSync(section, nSteps);

  const onUpdate = (p) => {
    railSync(p);
    const s = Math.min(nSteps - 1, Math.floor(p * nSteps));
    if (kickerEl) kickerEl.textContent = `Phase 0${s + 1} / 0${nSteps}`;
    if (nameEl) nameEl.textContent = stepLabels[s] || nameEl.textContent;
  };

  const tl = scrubTimeline(section, onUpdate);

  // arc sweeps the full workflow across the whole scrub
  tl.add(arc, { draw: '0 1', duration: 5000, ease: 'linear' }, 0);

  // nodes bloom in sequence (spring scale + rust fill); visited nodes stay lit
  const slot = 5000 / 6;
  for (let k = 0; k < 6; k++) {
    const nodeAnim = `#dial-svg .dial-node[data-node="${k}"] .dial-node-anim`;
    tl.add(nodeAnim, { scale: [1, 1.3], duration: 300, ease: 'outBack(2)' }, k * slot + 60)
      .add(`${nodeAnim} circle`, { fill: '#B94B2A', stroke: '#B94B2A', duration: 250 }, k * slot + 60)
      .add(`${nodeAnim} text`, { fill: '#FFFFFF', duration: 250 }, k * slot + 60)
      .add(nodeAnim, { scale: 1, duration: 320, ease: 'inOutQuad' }, k * slot + 480);
  }

  // count-up stats scrubbed with the dial
  $$('.dial-num', section).forEach((el) => {
    const target = parseFloat(el.dataset.target);
    const dec = parseInt(el.dataset.decimals || '0', 10);
    tl.add(el, {
      textContent: [0, target],
      modifier: dec ? ((v) => v.toFixed(dec)) : utils.round(0),
      duration: 4300, ease: 'linear'
    }, 350);
  });
}

/* --------------------------------------------------------------------------
   3e. GOVERNANCE — seal draws, splits into manifest / HMAC (hash scramble) /
   lineage chain, elastic re-stamp.  5 beats / 4800u.
   -------------------------------------------------------------------------- */
function initGovernanceChapter() {
  const section = $('#governance');
  if (!section) return;
  section.classList.add('js-scrub');

  const sealParts = ['.gov-seal-outer', '.gov-seal-inner', '.gov-seal-check']
    .map((s) => createDrawable(`#governance-svg ${s}`)[0]);
  sealParts.forEach((d) => utils.set(d, { draw: '0 0' }));
  const links = $$('#governance-svg .gov-link').map((p) => createDrawable(p)[0]);
  links.forEach((l) => utils.set(l, { draw: '0 0' }));

  const hashEl = $('#gov-hash');
  const hashFinal = hashEl?.dataset.final || '';
  const HEX = '0123456789abcdef';
  const scrambleWindow = [2000 / 4800, 2800 / 4800];

  const railSync = makeRailSync(section, 5, (beat) => Math.min(beat, 3));
  const onUpdate = (p) => {
    railSync(p);
    if (!hashEl) return;
    const [w0, w1] = scrambleWindow;
    if (p <= w0 || p >= w1) {
      if (hashEl.textContent !== hashFinal) hashEl.textContent = hashFinal;
      return;
    }
    const sub = (p - w0) / (w1 - w0);
    const settled = Math.floor(sub * hashFinal.length);
    hashEl.textContent = hashFinal.split('').map((ch, i) => {
      if (i < settled || !/[0-9a-f]/.test(ch)) return ch;
      return HEX[(Math.random() * 16) | 0];
    }).join('');
  };

  const tl = scrubTimeline(section, onUpdate);

  // beat 0: the seal draws itself
  tl.add(sealParts[0], { draw: '0 1', duration: 600, ease: 'inOutSine' }, 0)
    .add(sealParts[1], { draw: '0 1', duration: 600, ease: 'inOutSine' }, 200)
    .add(sealParts[2], { draw: '0 1', duration: 450, ease: 'out(2)' }, 520)
    .add('#gov-seal text', { opacity: [0, 1], duration: 350 }, 620);

  // beat 1: structured manifest slides out of the seal
  tl.add('#gov-manifest .gov-anim', {
    translateX: [230, 0], translateY: [80, 0], opacity: [0, 1],
    duration: 700, ease: 'outBack(1.2)'
  }, 1000)
    .add('#governance-svg .gov-doc-line', {
      opacity: [0, 1], delay: stagger(100), duration: 260
    }, 1400);

  // beat 2: HMAC signature line materialises (scramble handled in onUpdate)
  tl.add('#gov-hash', { opacity: [0, 1], duration: 320 }, 2050);

  // beat 3: CLP lineage chain pops in + links draw downstream
  tl.add('#gov-chain .gov-anim', {
    translateX: [-230, 0], opacity: [0, 1], duration: 600, ease: 'out(3)'
  }, 3000)
    .add('#gov-chain circle', { r: [0, 15], delay: stagger(130), duration: 380, ease: 'outBack(2)' }, 3150);
  links.forEach((l, i) => {
    tl.add(l, { draw: '0 1', duration: 300, ease: 'inOutSine' }, 3400 + i * 180);
  });

  // finale: elastic re-stamp + pulse ring
  tl.add('#gov-seal .seal-anim', { scale: [1, 1.14], duration: 240, ease: 'in(2)' }, 4000)
    .add('#gov-seal .seal-anim', { scale: 1, duration: 480, ease: 'outElastic(1, 0.5)' }, 4260)
    .add('#governance-svg .gov-seal-pulse', {
      r: [78, 120], opacity: [0.8, 0], duration: 520, ease: 'out(2)'
    }, 4180);
}

/* --------------------------------------------------------------------------
   3f. LINEAGE MESH DAG — provenance graph assembles session->card->graph->
   book->pdf, HMAC seal stamps, then a sensitive session teleports into an
   isolated quarantine lane.  5 beats / 5000u.  Additive sibling of the seal
   chapter; topology mirrors dashboard/lineage.mjs.
   -------------------------------------------------------------------------- */
function initLineageChapter() {
  const section = $('#lineage');
  if (!section) return;
  section.classList.add('js-scrub');

  const edges = $$('#lineage-svg .ln-edge').map((p) => createDrawable(p)[0]);
  const seal = ['.ln-seal-outer', '.ln-seal-inner', '.ln-seal-check']
    .map((s) => createDrawable(`#lineage-svg ${s}`)[0]);
  const quar = $$('#lineage-svg .ln-teleport-path, #lineage-svg .ln-quar-edge')
    .map((p) => createDrawable(p)[0]);
  const box = createDrawable('#lineage-svg .ln-quar-box')[0];
  [...edges, ...seal, ...quar, box].forEach((d) => utils.set(d, { draw: '0 0' }));

  // Downstream nodes start hidden (JS-only; no-JS/reduced-motion shows the full DAG).
  ['#ln-cards', '#ln-graph', '#ln-book', '#ln-pdf', '#ln-seal', '#ln-gate']
    .forEach((s) => utils.set($(s), { opacity: 0 }));
  const quarItems = $$('#lineage-svg .ln-quar-item');
  const quarLabels = $$('#ln-quarantine > text');
  const arrows = $$('#lineage-svg .ln-arrow'); // 4 spine + teleport + 2 quar, in DOM order
  utils.set([...quarItems, ...quarLabels, ...arrows], { opacity: 0 });

  const railSync = makeRailSync(section, 5);
  const tl = scrubTimeline(section, railSync);
  const pop = { opacity: [0, 1], translateY: [14, 0], duration: 500, ease: 'out(3)' };

  // beat 0 — Session -> Card
  tl.add('#ln-cards', pop, 200)
    .add(edges[0], { draw: '0 1', duration: 500, ease: 'inOutSine' }, 300);
  // beat 1 — Card -> Graph
  tl.add('#ln-graph', pop, 1100)
    .add(edges[1], { draw: '0 1', duration: 500, ease: 'inOutSine' }, 1200);
  // beat 2 — Graph -> Book, sealed
  tl.add('#ln-book', pop, 2100)
    .add(edges[2], { draw: '0 1', duration: 500, ease: 'inOutSine' }, 2200)
    .add('#ln-seal', { opacity: [0, 1], duration: 300 }, 2500)
    .add(seal[0], { draw: '0 1', duration: 400, ease: 'inOutSine' }, 2550)
    .add(seal[1], { draw: '0 1', duration: 400, ease: 'inOutSine' }, 2660)
    .add(seal[2], { draw: '0 1', duration: 320, ease: 'out(2)' }, 2820)
    .add('#ln-seal .ln-seal-anim', { scale: [1, 1.16], duration: 200, ease: 'in(2)' }, 3060)
    .add('#ln-seal .ln-seal-anim', { scale: 1, duration: 420, ease: 'outElastic(1, 0.5)' }, 3260)
    .add('#ln-seal .ln-seal-pulse', { r: [30, 60], opacity: [0.8, 0], duration: 480, ease: 'out(2)' }, 3160);
  // beat 3 — end-to-end CLP: pdf lands, spine traces, gate ticks
  tl.add('#ln-pdf', pop, 3300)
    .add(edges[3], { draw: '0 1', duration: 600, ease: 'inOutSine' }, 3400)
    .add('#lineage-svg .ln-edge', { strokeWidth: [2, 3.2, 2], duration: 640, ease: 'inOutSine' }, 3650)
    .add('#ln-gate', { opacity: [0, 1], duration: 320 }, 3850);
  // beat 4 — sovereign teleport into the quarantine lane
  tl.add(box, { draw: '0 1', duration: 600, ease: 'inOutSine' }, 4050)
    .add(quarLabels, { opacity: [0, 1], duration: 300 }, 4120)
    .add(quar[0], { draw: '0 1', duration: 700, ease: 'inOutSine' }, 4200)
    .add(quarItems[0], { opacity: [0, 1], translateY: [-10, 0], duration: 460, ease: 'outBack(1.6)' }, 4720)
    .add(quar[1], { draw: '0 1', duration: 300, ease: 'inOutSine' }, 4780)
    .add(quarItems.slice(1), { opacity: [0, 1], delay: stagger(150), duration: 360 }, 4820)
    .add(quar[2], { draw: '0 1', duration: 300, ease: 'inOutSine' }, 4980);

  // Arrowheads render in order — each fades in only as its edge finishes drawing
  // (order: spine 0-3, then teleport, then the two quarantine edges).
  [[0, 780], [1, 1680], [2, 2680], [3, 3980], [4, 4880], [5, 5060], [6, 5260]]
    .forEach(([i, t]) => tl.add(arrows[i], { opacity: [0, 1], duration: 160, ease: 'out(2)' }, t));
}

/* Restore the lineage DAG to its full readable state (Calm Motion / teardown).
   The scene hides downstream nodes with utils.set (untracked), so revert() alone
   won't bring them back — clear the inline styles so the SVG attribute defaults
   (opacity 1, full-length strokes) render the complete graph. */
function restoreLineage() {
  const svg = $('#lineage-svg');
  if (!svg) return;
  $$('*', svg).forEach((el) => {
    el.style.opacity = '';
    el.style.transform = '';
    el.style.strokeDashoffset = '';
    el.style.strokeDasharray = '';
    el.style.strokeWidth = '';
  });
}

/* --------------------------------------------------------------------------
   3f. TERMINAL CINEMA — typed commands, staggered output, blinking caret,
   count-up numbers; one workflow per scroll beat.  Fully procedural so
   reverse scroll un-types deterministically.
   -------------------------------------------------------------------------- */
function initTerminalChapter() {
  const section = $('#terminal');
  if (!section) return;
  section.classList.add('js-scrub');

  const blocks = $$('.term-block', section).map((block) => ({
    el: block,
    cmdEl: $('.term-cmd', block),
    cmd: $('.term-cmd', block)?.dataset.cmd || '',
    caret: $('.term-caret', block),
    logs: $$('.term-log', block).map((log) => ({
      el: log,
      nums: $$('.t-num', log).map((n) => ({
        el: n,
        target: parseFloat(n.dataset.num),
        dec: n.dataset.num.includes('.') ? 1 : 0
      }))
    }))
  }));

  const n = blocks.length;
  const update = (p) => {
    blocks.forEach((b, k) => {
      const w = clamp((p - k / n) * n, 0, 1);
      b.el.style.opacity = w <= 0 ? 0.14 : 1;
      // type phase: first 22% of the beat
      const typed = Math.round(b.cmd.length * clamp(w / 0.22, 0, 1));
      if (b.cmdEl) b.cmdEl.textContent = b.cmd.slice(0, typed);
      if (b.caret) b.caret.classList.toggle('on', w > 0 && w < 1);
      // output lines stagger across 30%..92% of the beat
      const m = b.logs.length;
      b.logs.forEach((log, j) => {
        const tj = 0.3 + (j * 0.62) / m;
        const on = w >= tj;
        log.el.style.opacity = on ? 1 : 0;
        log.el.style.transform = on ? 'none' : 'translateX(-10px)';
        log.nums.forEach((num) => {
          const nv = num.target * clamp((w - tj) / 0.1, 0, 1);
          num.el.textContent = num.dec ? nv.toFixed(1) : String(Math.round(nv));
        });
      });
    });
  };

  const state = { p: 0 };
  track(animate(state, {
    p: 1, duration: 1000, ease: 'linear',
    autoplay: scrubOptions(section),
    onUpdate: () => update(clamp(state.p, 0, 1))
  }));
  update(0);
  section.dataset.termLive = 'true';
}

function restoreTerminal() {
  const section = $('#terminal');
  if (!section || !section.dataset.termLive) return;
  delete section.dataset.termLive;
  $$('.term-block', section).forEach((block) => {
    block.style.opacity = '';
    const cmdEl = $('.term-cmd', block);
    if (cmdEl) cmdEl.textContent = cmdEl.dataset.cmd;
    $('.term-caret', block)?.classList.remove('on');
    $$('.term-log', block).forEach((log) => {
      log.style.opacity = '';
      log.style.transform = '';
    });
    $$('.t-num', block).forEach((n) => { n.textContent = n.dataset.num; });
  });
}

/* --------------------------------------------------------------------------
   3g. Entrance staggers for the flat sections (restraint: reveal only)
   -------------------------------------------------------------------------- */
let revealObserver = null;
function initReveals() {
  const targets = [];
  $$('.reveal-group').forEach((group) => targets.push({ el: group, items: $$('.reveal-item', group) }));
  $$('.reveal-item').forEach((item) => {
    if (!item.closest('.reveal-group')) targets.push({ el: item, items: [item] });
  });

  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const t = targets.find((x) => x.el === entry.target);
      revealObserver.unobserve(entry.target);
      if (!t) return;
      track(animate(t.items, {
        opacity: [0, 1], translateY: [26, 0],
        delay: stagger(70), duration: 650, ease: 'out(3)'
      }));
    });
  }, { threshold: 0.12 });

  targets.forEach((t) => {
    // hide only content still below the fold, so nothing visible flashes
    if (t.el.getBoundingClientRect().top > window.innerHeight * 0.9) {
      t.items.forEach((i) => { i.style.opacity = '0'; });
    }
    revealObserver.observe(t.el);
  });
}

/* --------------------------------------------------------------------------
   Init / teardown (Calm Motion toggles at runtime)
   -------------------------------------------------------------------------- */
function initMotion() {
  if (motionOn || !motionAllowed()) return;
  motionOn = true;
  initHero();
  initReveals();
  // Chapters scrub at EVERY width — mobile is the primary surface. Narrow
  // layouts re-choreograph via CSS (stage top, one-card rail strip); the
  // timelines are identical.
  initSiloChapter();
  initTrigraphChapter();
  initDialChapter();
  initGovernanceChapter();
  initLineageChapter();
  initTerminalChapter();
}

function teardownMotion() {
  if (!motionOn) return;
  motionOn = false;
  live.forEach((a) => { try { a.revert(); } catch (e) { /* already dead */ } });
  live = [];
  splits.forEach((s) => { try { s.revert(); } catch (e) { /* noop */ } });
  splits = [];
  revealObserver?.disconnect();
  revealObserver = null;
  restoreTerminal();
  restoreLineage();
  $$('.reveal-item').forEach((el) => { el.style.opacity = ''; el.style.transform = ''; });
  $$('.chapter.js-scrub').forEach((c) => {
    c.classList.remove('js-scrub');
    $$('.step', c).forEach((s, i) => s.classList.toggle('active', i === 0));
    $$('.chapter-dot', c).forEach((d, i) => d.classList.toggle('active', i === 0));
  });
}

initMotion();
