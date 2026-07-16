import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const CONTENT_JSON_PATH = path.join(__dirname, 'content.json');
const TEMPLATE_HTML_PATH = path.join(__dirname, 'template.html');
const OUT_INDEX_HTML = path.join(__dirname, 'index.html');
const OUT_SITEMAP = path.join(__dirname, 'sitemap.xml');
const OUT_ROBOTS = path.join(__dirname, 'robots.txt');

// ---------------------------------------------------------------------------
// 1. Version + content + lints
// ---------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
const version = pkg.version || '0.0.0';

const rawContent = fs.readFileSync(CONTENT_JSON_PATH, 'utf-8');

const forbiddenPhrases = ['[[', '98%', '$2,363', '$34', 'token tax'];
function lint(text, label) {
  for (const phrase of forbiddenPhrases) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) {
      console.error(`BUILD ERROR: forbidden phrase/marker "${phrase}" found in ${label}`);
      process.exit(1);
    }
  }
  if (/(?:src|href)="\//.test(text)) {
    console.error(`BUILD ERROR: root-absolute asset path found in ${label} (relative paths only)`);
    process.exit(1);
  }
}
lint(rawContent.replace(/"\@context"|"https?:[^"]*"/g, '""'), 'content.json');
if (rawContent.includes('"/prime-silo/')) {
  console.error('BUILD ERROR: Root-absolute asset path "/prime-silo/" found.');
  process.exit(1);
}

const content = JSON.parse(rawContent.replace(/\{\{site\.version\}\}/g, version));
const byId = Object.fromEntries(content.sections.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// 2. Benny mascot (re-authored from dog_no_bg.svg with animatable group ids)
// ---------------------------------------------------------------------------
const BENNY_PARTS = `
  <g class="b-tail"><path d="M192 176c28 4 40-16 32-34-7-16-28-14-32 2-3 12 4 18 12 16" fill="url(#benny-black)" stroke="#241E1A" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></g>
  <g class="b-body" stroke="#241E1A" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    <path d="M82 150c-10 22-12 46-3 60 6 10 96 10 102 0 9-14 7-38-3-60z" fill="url(#benny-tan)"/>
    <path d="M82 150c-6 13-9 27-7 40 30 10 80 10 110 0 2-13-1-27-7-40-18 12-78 12-96 0z" fill="url(#benny-black)" stroke="none"/>
    <path d="M110 150c-4 22-4 44 0 58 6 7 30 7 36 0 4-14 4-36 0-58z" fill="url(#benny-chest)" stroke="none"/>
    <path d="M92 196c-2 8-2 16 0 18 4 3 16 3 19 0 2-4 2-12 0-20z" fill="url(#benny-tan)"/>
    <path d="M145 194c-3 8-3 16-1 20 3 3 15 3 19 0 2-2 2-10 0-18z" fill="url(#benny-tan)"/>
    <ellipse cx="101" cy="214" rx="12" ry="7" fill="url(#benny-chest)"/>
    <ellipse cx="155" cy="214" rx="12" ry="7" fill="url(#benny-chest)"/>
  </g>
  <g class="b-ear b-ear-left" stroke="#241E1A" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    <path d="M78 64 58 12c24 0 40 14 48 38z" fill="url(#benny-tan)"/>
    <path d="M80 56 66 22c14 1 24 9 30 23z" fill="url(#benny-black)" stroke="none"/>
  </g>
  <g class="b-ear b-ear-right" stroke="#241E1A" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
    <path d="M178 64l20-52c-24 0-40 14-48 38z" fill="url(#benny-tan)"/>
    <path d="M176 56l14-34c-14 1-24 9-30 23z" fill="url(#benny-black)" stroke="none"/>
  </g>
  <g class="b-head">
    <path d="M128 48c-38 0-60 26-60 58 0 30 26 52 60 52s60-22 60-52c0-32-22-58-60-58z" fill="url(#benny-tan)" stroke="#241E1A" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M128 86c-15 0-22 10-24 26-2 18 10 38 24 38s26-20 24-38c-2-16-9-26-24-26z" fill="url(#benny-black)" stroke="#241E1A" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
    <g class="b-eyes" fill="#1C1714"><ellipse cx="104" cy="98" rx="7.5" ry="9"/><ellipse cx="152" cy="98" rx="7.5" ry="9"/></g>
    <circle cx="101.5" cy="95" r="2.3" fill="#fff"/><circle cx="149.5" cy="95" r="2.3" fill="#fff"/>
    <ellipse cx="104" cy="84" rx="5" ry="3.5" fill="#E0A95E"/>
    <ellipse cx="152" cy="84" rx="5" ry="3.5" fill="#E0A95E"/>
    <ellipse cx="128" cy="120" rx="11" ry="8" fill="#120E0C"/>
    <path d="M128 128v8m0 0c-6 0-11-3-13-8m13 8c6 0 11-3 13-8" fill="none" stroke="#0E0A08" stroke-width="4" stroke-linecap="round"/>
    <path class="b-tongue" d="M124 136h8c0 6-2 10-4 10s-4-4-4-10z" fill="#E58A86"/>
  </g>`;

// Inline Benny (parts individually animatable — <use> shadow trees are not)
function bennyInline(cls, caption = '') {
  return `
    <div class="mascot-container ${cls}">
      <svg class="benny-svg" viewBox="0 0 256 256" role="img" aria-label="Benny the German Shepherd mascot">${BENNY_PARTS}</svg>
      ${caption ? `<div class="mascot-caption">${caption}</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// 3. SVG set-pieces
// ---------------------------------------------------------------------------

// 3a. HERO SILO — stroke-drawn grain silo, assembles from ring segments on load
function heroSiloSvg() {
  const rings = [0, 1, 2, 3, 4, 5].map((i) => {
    const y = 132 + i * 45;
    const fill = i % 2 === 0 ? '#F3EFE6' : '#EDE7D9';
    return `<g class="hs-ring"><rect x="66" y="${y}" width="208" height="45" fill="${fill}" stroke="#233026" stroke-width="2.5"/><line x1="66" y1="${y + 45}" x2="274" y2="${y + 45}" stroke="#233026" stroke-width="1" opacity="0.35"/></g>`;
  }).join('\n');
  return `
  <svg id="hero-silo" class="hero-silo" viewBox="0 0 340 470" role="img" aria-label="Prime-Silo grain silo assembling from ring segments">
    <g class="hs-legs" stroke="#233026" stroke-width="3" stroke-linecap="round">
      <line x1="82" y1="402" x2="62" y2="452"/><line x1="258" y1="402" x2="278" y2="452"/>
      <line x1="170" y1="402" x2="170" y2="452"/><line x1="44" y1="452" x2="296" y2="452"/>
    </g>
    ${rings}
    <g class="hs-door"><rect x="150" y="342" width="40" height="60" rx="4" fill="#233026"/><circle cx="182" cy="374" r="3" fill="#B94B2A"/></g>
    <g class="hs-roof"><path d="M56 131 L170 40 L284 131 Z" fill="#233026" stroke="#233026" stroke-width="2.5" stroke-linejoin="round"/><circle cx="170" cy="35" r="6" fill="#B94B2A"/></g>
    <g class="hs-vent"><rect x="148" y="150" width="44" height="14" rx="7" fill="#B94B2A" opacity="0.9"/></g>
  </svg>`;
}

// 3b. INSIDE THE SILO — shell halves + 4 subsystem floors + label lines + seal
function siloChapterSvg(layers) {
  // layers arrive top-first (LONGVIEW, L2, L1, L0) — matches rail card order
  const glyphs = [
    // LONGVIEW: hub + satellites
    `<g class="floor-glyph" stroke="#A8BFA8" stroke-width="1.6" fill="none">
       <circle cx="0" cy="0" r="9" fill="#B94B2A" stroke="none"/>
       <line x1="0" y1="0" x2="-22" y2="-12"/><line x1="0" y1="0" x2="24" y2="-8"/><line x1="0" y1="0" x2="4" y2="20"/>
       <circle cx="-22" cy="-12" r="4.5" fill="#171F19"/><circle cx="24" cy="-8" r="4.5" fill="#171F19"/><circle cx="4" cy="20" r="4.5" fill="#171F19"/>
     </g>`,
    // L2: padlock seal
    `<g class="floor-glyph" stroke="#A8BFA8" stroke-width="1.8" fill="none">
       <path d="M-9 -4 V-11 A9 9 0 0 1 9 -11 V-4"/>
       <rect x="-13" y="-4" width="26" height="20" rx="4" fill="#B94B2A" stroke="none"/>
       <circle cx="0" cy="5" r="2.6" fill="#171F19" stroke="none"/>
     </g>`,
    // L1: git branch
    `<g class="floor-glyph" stroke="#A8BFA8" stroke-width="1.8" fill="none">
       <path d="M-14 14 V-6 M-14 -6 C-14 -14 2 -10 10 -14"/>
       <circle cx="-14" cy="14" r="5" fill="#171F19"/><circle cx="-14" cy="-10" r="5" fill="#B94B2A" stroke="none"/><circle cx="14" cy="-14" r="5" fill="#171F19"/>
     </g>`,
    // L0: tri-graph mesh
    `<g class="floor-glyph" stroke="#A8BFA8" stroke-width="1.6" fill="none">
       <path d="M0 -16 L-18 12 L18 12 Z" stroke-dasharray="4 3"/>
       <circle cx="0" cy="-16" r="5" fill="#B94B2A" stroke="none"/><circle cx="-18" cy="12" r="5" fill="#171F19"/><circle cx="18" cy="12" r="5" fill="#171F19"/>
     </g>`
  ];
  const nums = ['L3', 'L2', 'L1', 'L0'];
  const floors = layers.map((layer, i) => {
    const y = 140 + i * 92;
    return `
    <g class="silo-floor" data-floor="${i}" transform="translate(216 ${y})">
      <g class="floor-anim">
        <rect x="0" y="0" width="328" height="78" rx="10" fill="#233026" stroke="#7F9A83" stroke-width="1.5"/>
        <text x="20" y="48" font-size="20" fill="#B94B2A" class="svg-serif">${nums[i]}</text>
        <text x="66" y="33" font-size="14.5" fill="#F7F6F2" font-weight="600" class="svg-sans">${layer.name}</text>
        <text x="66" y="56" font-size="10" fill="#A8BFA8" letter-spacing="1.5" class="svg-mono">${layer.tag}</text>
        <g transform="translate(290 39)">${glyphs[i]}</g>
      </g>
    </g>`;
  }).join('\n');

  const labelLines = layers.map((_, i) => {
    const y = 179 + i * 92;
    return `<path class="floor-line" data-floor="${i}" d="M548 ${y} C 610 ${y}, 640 ${y}, 726 ${y}" stroke="#B94B2A" stroke-width="2" fill="none" stroke-dasharray="5 5"/>`;
  }).join('\n');

  return `
  <svg id="silo-open-svg" viewBox="0 0 760 560" role="img" aria-label="Cutaway of the Prime-Silo silo revealing four architecture floors">
    <line x1="150" y1="516" x2="610" y2="516" stroke="#233026" stroke-width="2.5" opacity="0.5"/>
    <g id="silo-floors">${floors}</g>
    ${labelLines}
    <g id="shell-left">
      <path d="M380 42 L200 128 L200 508 L380 508 Z" fill="#F3EFE6" stroke="#233026" stroke-width="3" stroke-linejoin="round"/>
      <line x1="200" y1="222" x2="380" y2="222" stroke="#233026" stroke-width="1.2" opacity="0.4"/>
      <line x1="200" y1="314" x2="380" y2="314" stroke="#233026" stroke-width="1.2" opacity="0.4"/>
      <line x1="200" y1="406" x2="380" y2="406" stroke="#233026" stroke-width="1.2" opacity="0.4"/>
    </g>
    <g id="shell-right">
      <path d="M380 42 L560 128 L560 508 L380 508 Z" fill="#EDE7D9" stroke="#233026" stroke-width="3" stroke-linejoin="round"/>
      <line x1="380" y1="222" x2="560" y2="222" stroke="#233026" stroke-width="1.2" opacity="0.4"/>
      <line x1="380" y1="314" x2="560" y2="314" stroke="#233026" stroke-width="1.2" opacity="0.4"/>
      <line x1="380" y1="406" x2="560" y2="406" stroke="#233026" stroke-width="1.2" opacity="0.4"/>
    </g>
    <g id="silo-seal" transform="translate(380 278)" opacity="0">
      <g class="seal-anim">
        <circle r="64" fill="#B94B2A"/>
        <circle r="52" fill="none" stroke="#F7F6F2" stroke-width="2" stroke-dasharray="6 5"/>
        <path d="M-22 2 L-6 18 L26 -18" fill="none" stroke="#F7F6F2" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </g>
  </svg>`;
}

// 3c. TRI-GRAPH — mesh explodes into 3 tinted clusters + CORRELATES_WITH edges
function trigraphSvg() {
  function cluster(id, cx, cy, tint, label) {
    const offs = [[0, 0, 12], [-36, -24, 8], [32, -28, 7], [-22, 30, 7], [36, 22, 8], [6, -48, 6]];
    const nodes = offs.map(([x, y, r], i) =>
      `<circle cx="${x}" cy="${y}" r="${r}" fill="${i === 0 ? tint : '#171F19'}" stroke="${tint}" stroke-width="1.8"/>`).join('');
    const spokes = offs.slice(1).map(([x, y]) =>
      `<line x1="0" y1="0" x2="${x}" y2="${y}" stroke="${tint}" stroke-width="1.2" opacity="0.6"/>`).join('');
    return `
    <g class="tg-cluster" id="${id}" transform="translate(${cx} ${cy})">
      <g class="cluster-anim">
        <circle class="cluster-ring" r="70" fill="none" stroke="${tint}" stroke-width="1.5" stroke-dasharray="4 5" opacity="0.7"/>
        ${spokes}${nodes}
        <text y="96" text-anchor="middle" font-size="13" fill="${tint}" letter-spacing="2" class="svg-mono">${label}</text>
      </g>
    </g>`;
  }
  return `
  <svg id="trigraph-svg" viewBox="0 0 760 560" role="img" aria-label="Tri-graph mesh separating into documents, code and memory clusters joined by CORRELATES_WITH edges">
    <g id="tg-edges">
      <path class="tg-edge" d="M262 196 C 320 210, 400 216, 496 216" stroke="#8C847A" stroke-width="2" fill="none" stroke-dasharray="7 6"/>
      <path class="tg-edge" d="M238 232 C 280 320, 320 380, 350 424" stroke="#8C847A" stroke-width="2" fill="none" stroke-dasharray="7 6"/>
      <path class="tg-edge" d="M540 262 C 510 330, 470 390, 430 430" stroke="#8C847A" stroke-width="2" fill="none" stroke-dasharray="7 6"/>
      <text class="tg-edge-label svg-mono" x="378" y="196" text-anchor="middle" font-size="10.5" fill="#D1CDC7" letter-spacing="1.5">CORRELATES_WITH</text>
      <text class="tg-edge-label svg-mono" x="238" y="340" text-anchor="middle" font-size="10.5" fill="#D1CDC7" letter-spacing="1.5" transform="rotate(64 238 340)">CORRELATES_WITH</text>
      <text class="tg-edge-label svg-mono" x="520" y="352" text-anchor="middle" font-size="10.5" fill="#D1CDC7" letter-spacing="1.5" transform="rotate(-58 520 352)">CORRELATES_WITH</text>
    </g>
    ${cluster('tg-docs', 190, 160, '#A8BFA8', 'DOCUMENTS')}
    ${cluster('tg-code', 570, 180, '#D65D38', 'CODE · AST')}
    ${cluster('tg-memory', 385, 430, '#C5B38E', 'MEMORY')}
  </svg>`;
}

// 3d. MEMO-RAY DIAL — 6-node circular workflow, sweeping arc, center readout
function dialSvg(dialLabels) {
  const CX = 320, CY = 320, R = 230;
  const nodes = dialLabels.map((label, k) => {
    const a = (-90 + k * 60) * Math.PI / 180;
    const x = (CX + R * Math.cos(a)).toFixed(1);
    const y = (CY + R * Math.sin(a)).toFixed(1);
    // label placement radially outward
    const lx = (CX + (R + 52) * Math.cos(a)).toFixed(1);
    const ly = (CY + (R + 52) * Math.sin(a) + 4).toFixed(1);
    const anchor = Math.cos(a) > 0.3 ? 'start' : Math.cos(a) < -0.3 ? 'end' : 'middle';
    return `
    <g class="dial-node" data-node="${k}" transform="translate(${x} ${y})">
      <g class="dial-node-anim">
        <circle r="27" fill="#FFFFFF" stroke="#233026" stroke-width="2.5"/>
        <text y="6" text-anchor="middle" font-size="15" fill="#233026" font-weight="700" class="svg-mono">0${k + 1}</text>
      </g>
      <text class="dial-node-label" x="${(lx - x).toFixed(1)}" y="${(ly - y).toFixed(1)}" text-anchor="${anchor}" font-size="14" fill="#59544E" letter-spacing="1.2" class="svg-mono">${label.toUpperCase()}</text>
    </g>`;
  }).join('\n');
  const ticks = Array.from({ length: 12 }, (_, k) => {
    const a = (k * 30) * Math.PI / 180;
    return `<line x1="${(CX + 210 * Math.cos(a)).toFixed(1)}" y1="${(CY + 210 * Math.sin(a)).toFixed(1)}" x2="${(CX + 220 * Math.cos(a)).toFixed(1)}" y2="${(CY + 220 * Math.sin(a)).toFixed(1)}" stroke="#C5B38E" stroke-width="2"/>`;
  }).join('');
  return `
  <svg id="dial-svg" viewBox="0 0 640 640" role="img" aria-label="LONGVIEW workflow dial: inventory, extract, map, graph, enrich, deliver">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#E5E2DC" stroke-width="8"/>
    ${ticks}
    <path id="dial-arc" d="M ${CX} ${CY - R} A ${R} ${R} 0 1 1 ${CX} ${CY + R} A ${R} ${R} 0 1 1 ${CX} ${CY - R}" fill="none" stroke="#B94B2A" stroke-width="8" stroke-linecap="round"/>
    ${nodes}
  </svg>`;
}

// 3e. GOVERNANCE SEAL — seal splits into manifest / HMAC hash / lineage chain
function governanceSvg() {
  const chainNodes = [-120, -40, 40, 120].map((y, i) =>
    `<circle cx="0" cy="${y}" r="15" fill="${i === 3 ? '#B94B2A' : '#171F19'}" stroke="#EBCD9C" stroke-width="2"/>`).join('');
  const chainLinks = [-120, -40, 40].map((y) =>
    `<path class="gov-link" d="M0 ${y + 15} L0 ${y + 65}" stroke="#EBCD9C" stroke-width="2.5" fill="none"/>`).join('');
  return `
  <svg id="governance-svg" viewBox="0 0 760 540" role="img" aria-label="Governance seal splitting into a manifest, an HMAC signature and a lineage chain">
    <g id="gov-manifest" transform="translate(150 160)">
      <g class="gov-anim">
        <rect x="-52" y="-66" width="104" height="132" rx="8" fill="#171F19" stroke="#8C847A" stroke-width="2"/>
        <text y="-42" text-anchor="middle" font-size="10.5" fill="#D65D38" class="svg-mono">run.manifest.json</text>
        <line class="gov-doc-line" x1="-34" y1="-22" x2="34" y2="-22" stroke="#8C847A" stroke-width="2"/>
        <line class="gov-doc-line" x1="-34" y1="-4" x2="20" y2="-4" stroke="#8C847A" stroke-width="2"/>
        <line class="gov-doc-line" x1="-34" y1="14" x2="28" y2="14" stroke="#8C847A" stroke-width="2"/>
        <line class="gov-doc-line" x1="-34" y1="32" x2="10" y2="32" stroke="#8C847A" stroke-width="2"/>
        <text y="56" text-anchor="middle" font-size="9.5" fill="#A8BFA8" class="svg-mono">tool calls · file hashes</text>
      </g>
    </g>
    <g id="gov-chain" transform="translate(612 250)">
      <g class="gov-anim">
        ${chainLinks}${chainNodes}
        <text y="164" text-anchor="middle" font-size="10.5" fill="#A8BFA8" letter-spacing="1.5" class="svg-mono">CLP LINEAGE</text>
      </g>
    </g>
    <g id="gov-seal" transform="translate(380 240)">
      <g class="seal-anim">
        <circle class="gov-seal-outer" r="78" fill="none" stroke="#EBCD9C" stroke-width="3"/>
        <circle class="gov-seal-inner" r="62" fill="none" stroke="#EBCD9C" stroke-width="1.5" stroke-dasharray="7 6"/>
        <path class="gov-seal-check" d="M-26 2 L-8 20 L30 -22" fill="none" stroke="#B94B2A" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
        <circle class="gov-seal-pulse" r="78" fill="none" stroke="#B94B2A" stroke-width="2" opacity="0"/>
      </g>
      <text y="112" text-anchor="middle" font-size="12" fill="#D1CDC7" letter-spacing="3" class="svg-mono">HMAC-SHA256 · SEALED</text>
    </g>
    <text id="gov-hash" data-final="hmac: 9f3a c07d 41be 88e2 5f16 d2aa 73c9 0b41 — verified" x="380" y="452" text-anchor="middle" font-size="15" fill="#EBCD9C" class="svg-mono">hmac: 9f3a c07d 41be 88e2 5f16 d2aa 73c9 0b41 — verified</text>
  </svg>`;
}

// 3f. LINEAGE MESH DAG — provenance graph assembles session->card->graph->book->pdf,
// HMAC seal stamps, then a sensitive session teleports into a quarantine lane.
// Topology mirrors scratch/longview_run/dashboard/lineage.mjs (the real DAG).
function lineageDagSvg() {
  const node = (id, x, y, w, label, extra = '') =>
    `<g id="${id}" class="ln-node"><rect x="${x}" y="${y}" width="${w}" height="40" rx="7" fill="#171F19" stroke="#EBCD9C" stroke-width="1.6"${extra}/><text x="${x + w / 2}" y="${y + 25}" text-anchor="middle" font-size="13" fill="#D1CDC7" class="svg-mono">${label}</text></g>`;
  return `
  <svg id="lineage-svg" viewBox="0 0 760 560" role="img" aria-label="A provenance graph flowing from sessions to cards to graph to book to PDF, sealed by HMAC, with a sensitive session teleported into an isolated quarantine lane">
    <!-- main provenance spine (arrowheads are separate .ln-arrow elements so they
         fade in only as each edge finishes drawing — SVG markers ignore dashoffset) -->
    <path class="ln-edge" d="M128 150 L211 150" stroke="#A8BFA8" stroke-width="2" fill="none"/>
    <path class="ln-edge" d="M289 150 L361 150" stroke="#A8BFA8" stroke-width="2" fill="none"/>
    <path class="ln-edge" d="M439 150 L511 150" stroke="#A8BFA8" stroke-width="2" fill="none"/>
    <path class="ln-edge" d="M550 170 L550 225 L430 225 L430 263" stroke="#A8BFA8" stroke-width="2" fill="none"/>
    <path class="ln-arrow" transform="translate(211 150)" d="M-8 -4 L0 0 L-8 4 Z" fill="#A8BFA8"/>
    <path class="ln-arrow" transform="translate(361 150)" d="M-8 -4 L0 0 L-8 4 Z" fill="#A8BFA8"/>
    <path class="ln-arrow" transform="translate(511 150)" d="M-8 -4 L0 0 L-8 4 Z" fill="#A8BFA8"/>
    <path class="ln-arrow" transform="translate(430 263) rotate(90)" d="M-8 -4 L0 0 L-8 4 Z" fill="#A8BFA8"/>

    <!-- sessions cluster -->
    <g id="ln-sessions" class="ln-node">
      <circle cx="88" cy="130" r="12" fill="#26382D" stroke="#EBCD9C" stroke-width="1.5"/>
      <circle cx="112" cy="152" r="12" fill="#26382D" stroke="#EBCD9C" stroke-width="1.5"/>
      <circle cx="86" cy="172" r="12" fill="#26382D" stroke="#EBCD9C" stroke-width="1.5"/>
      <text x="98" y="202" text-anchor="middle" font-size="12" fill="#A8BFA8" class="svg-mono">sessions</text>
    </g>
    ${node('ln-cards', 211, 130, 78, 'cards')}
    ${node('ln-graph', 361, 130, 78, 'graph')}
    ${node('ln-book', 511, 130, 78, 'book')}
    ${node('ln-pdf', 391, 263, 78, 'pdf')}

    <!-- HMAC seal stamped beside the book -->
    <g id="ln-seal" transform="translate(680 150)">
      <g class="ln-seal-anim">
        <circle class="ln-seal-outer" r="30" fill="none" stroke="#B94B2A" stroke-width="2.5"/>
        <circle class="ln-seal-inner" r="23" fill="none" stroke="#B94B2A" stroke-width="1" stroke-dasharray="5 4"/>
        <path class="ln-seal-check" d="M-10 1 L-3 8 L12 -9" fill="none" stroke="#B94B2A" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <circle class="ln-seal-pulse" r="30" fill="none" stroke="#B94B2A" stroke-width="2" opacity="0"/>
      <text y="50" text-anchor="middle" font-size="10.5" fill="#B94B2A" class="svg-mono">HMAC</text>
    </g>

    <text id="ln-gate" x="726" y="300" text-anchor="end" font-size="11" fill="#A8BFA8" class="svg-mono">leak-gate: CLEAN</text>

    <!-- quarantine lane -->
    <g id="ln-quarantine">
      <rect class="ln-quar-box" x="34" y="360" width="692" height="168" rx="12" fill="none" stroke="#B94B2A" stroke-width="1.5" stroke-dasharray="8 6"/>
      <text x="52" y="388" font-size="11.5" fill="#B94B2A" letter-spacing="2" class="svg-mono">QUARANTINE WORKSPACE · sovereign teleport</text>
      <path class="ln-teleport-path" d="M95 182 C95 320, 150 320, 150 434" stroke="#B94B2A" stroke-width="2" fill="none" stroke-dasharray="4 5"/>
      <path class="ln-quar-edge" d="M168 449 L215 449" stroke="#B94B2A" stroke-width="1.6" fill="none"/>
      <path class="ln-quar-edge" d="M285 449 L350 449" stroke="#B94B2A" stroke-width="1.6" fill="none"/>
      <path class="ln-arrow" transform="translate(150 434) rotate(90)" d="M-8 -4 L0 0 L-8 4 Z" fill="#B94B2A"/>
      <path class="ln-arrow" transform="translate(215 449)" d="M-7 -3.5 L0 0 L-7 3.5 Z" fill="#B94B2A"/>
      <path class="ln-arrow" transform="translate(350 449)" d="M-7 -3.5 L0 0 L-7 3.5 Z" fill="#B94B2A"/>
      <g id="ln-teleport" class="ln-quar-item">
        <circle cx="150" cy="449" r="13" fill="#241410" stroke="#B94B2A" stroke-width="1.5"/>
        <text x="150" y="486" text-anchor="middle" font-size="11.5" fill="#E0B9A9" class="svg-mono">cv · jpmc</text>
      </g>
      <g class="ln-quar-item"><rect x="215" y="430" width="70" height="38" rx="7" fill="#241410" stroke="#B94B2A" stroke-width="1.3"/><text x="250" y="454" text-anchor="middle" font-size="12" fill="#E0B9A9" class="svg-mono">card</text></g>
      <g class="ln-quar-item"><rect x="350" y="430" width="86" height="38" rx="7" fill="#241410" stroke="#B94B2A" stroke-width="1.3"/><text x="393" y="454" text-anchor="middle" font-size="11" fill="#E0B9A9" class="svg-mono">vectors</text></g>
      <text x="470" y="454" font-size="11" fill="#8C847A" class="svg-mono">moved · journalled · reversible</text>
    </g>
  </svg>`;
}

// ---------------------------------------------------------------------------
// 4. Chapter chassis
// ---------------------------------------------------------------------------
function chapterShell({ id, theme, visual, kicker, headline, sub, steps, stageHtml, extraRailHtml = '', trackVh, beats }) {
  const stepCards = steps.map((s, i) => `
        <li class="step${i === 0 ? ' active' : ''}" data-step="${i}">
          <h4>${s.label}</h4>
          <p>${s.body}</p>
        </li>`).join('\n');
  const dots = Array.from({ length: beats }, (_, i) =>
    `<span class="chapter-dot${i === 0 ? ' active' : ''}" data-dot="${i}"></span>`).join('');
  return `
  <section class="chapter chapter--${theme}" id="${id}" data-visual="${visual}" data-beats="${beats}">
    <div class="chapter-pin">
      <div class="chapter-stage">
        ${stageHtml}
      </div>
      <aside class="chapter-rail">
        <div class="chapter-head">
          <div class="section-kicker">${kicker}</div>
          <h2 class="section-headline">${headline}</h2>
          ${sub ? `<p class="chapter-sub">${sub}</p>` : ''}
        </div>
        <ol class="chapter-steps">${stepCards}
        </ol>
        ${extraRailHtml}
        <div class="chapter-dots" aria-hidden="true">${dots}</div>
      </aside>
    </div>
    <div class="chapter-track" style="height:${trackVh}vh" aria-hidden="true"></div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 5. Section renderers
// ---------------------------------------------------------------------------
const hero = byId.hero;
const heroWords = hero.headline;
const heroSectionHtml = `
  <header class="hero-section" id="hero">
    <div class="hero-content">
      <div class="section-kicker">${hero.kicker}</div>
      <h1 class="section-headline hero-headline">${heroWords}</h1>
      <p class="section-sub">${hero.sub}</p>
      <div class="hero-actions">
        ${hero.ctas.map((c) => `<a href="${c.href}" class="btn ${c.kind === 'primary' ? 'btn-primary' : 'btn-ghost'}">${c.label}</a>`).join('\n')}
      </div>
      <div class="proof-chips">
        ${hero.proofChips.map((chip) => `<span class="proof-chip">${chip}</span>`).join('\n')}
      </div>
    </div>
    <div class="hero-visual">
      ${heroSiloSvg()}
      ${bennyInline('benny-hero', 'Benny — your sovereign agent guide')}
    </div>
  </header>`;

// Inside-the-silo signature chapter (interactiveSilo data)
const silo = content.interactiveSilo;
const siloChapterHtml = chapterShell({
  id: 'inside-the-silo',
  theme: 'light',
  visual: 'silo',
  kicker: silo.kicker,
  headline: silo.headline,
  sub: silo.sub,
  steps: silo.layers.map((l) => ({ label: l.name, body: l.desc })),
  stageHtml: siloChapterSvg(silo.layers),
  trackVh: 480,
  beats: 6
});

// Tri-graph chapter
const tg = byId.trigraph;
const trigraphChapterHtml = chapterShell({
  id: 'trigraph',
  theme: 'dark',
  visual: 'trigraph',
  kicker: tg.kicker,
  headline: tg.headline,
  steps: tg.steps,
  stageHtml: trigraphSvg(),
  trackVh: 400,
  beats: tg.steps.length
});

// LONGVIEW dial chapter
// Enablers — six load-bearing primitives, each with what it unlocks
const ena = byId.enablers;
const enablersSectionHtml = !ena ? '' : `
  <section class="enablers-section" id="enablers">
    <div class="section-inner">
      <div class="section-kicker">${ena.kicker}</div>
      <h2 class="section-headline">${ena.headline}</h2>
      <p class="section-sub enablers-intro">${ena.intro}</p>
      <div class="enablers-grid">
        ${ena.items.map((e, i) => `
        <article class="enabler-card reveal-item" data-enabler="${i}">
          <div class="enabler-num svg-mono">0${i + 1}</div>
          <h3>${e.name}</h3>
          <p>${e.body}</p>
          <p class="enabler-unlocks"><span class="unlock-arrow" aria-hidden="true">→</span> <strong>Unlocks:</strong> ${e.unlocks}</p>
        </article>`).join('')}
      </div>
    </div>
  </section>`;

const lv = byId.longview;
const builtOnHtml = !lv.builtOn ? '' : `
        <div class="built-on">
          <span class="built-on-label svg-mono">${lv.builtOn.label}</span>
          <div class="built-on-chips">${lv.builtOn.items.map((b) => `<a class="built-on-chip" href="#enablers">${b}</a>`).join('')}</div>
        </div>`;
const dialReadout = `
  <div class="dial-readout">
    <div class="dial-step-kicker">Phase 01 / 0${lv.dial.length}</div>
    <div class="dial-step-name">${lv.steps[0].label}</div>
    <div class="dial-stats">
      ${lv.proofStats.map((s) => `
      <div class="dial-stat">
        <span class="dial-num" data-target="${s.value}" data-decimals="${Number.isInteger(s.value) ? 0 : 1}">${s.value}</span><span class="dial-suffix">${s.suffix}</span>
        <em>${s.note}</em>
      </div>`).join('')}
    </div>
  </div>`;
const longviewChapterHtml = chapterShell({
  id: 'longview',
  theme: 'cream',
  visual: 'dial',
  kicker: lv.kicker,
  headline: lv.headline,
  steps: lv.steps,
  sub: lv.sub,
  stageHtml: dialSvg(lv.dial) + dialReadout,
  extraRailHtml: builtOnHtml,
  trackVh: 440,
  beats: lv.steps.length
});

// Governance chapter
const gov = byId.governance;
const governanceChapterHtml = chapterShell({
  id: 'governance',
  theme: 'dark',
  visual: 'governance',
  kicker: gov.kicker,
  headline: gov.headline,
  steps: gov.steps,
  stageHtml: governanceSvg(),
  trackVh: 380,
  beats: gov.steps.length + 1
});

// Lineage-mesh DAG chapter (additive — sits alongside the governance seal)
const lin = byId.lineage;
const lineageChapterHtml = !lin ? '' : chapterShell({
  id: 'lineage',
  theme: 'dark',
  visual: 'lineage',
  kicker: lin.kicker,
  headline: lin.headline,
  sub: lin.sub,
  steps: lin.steps,
  stageHtml: lineageDagSvg(),
  trackVh: 460,
  beats: lin.steps.length
});

// Terminal cinema (interactiveTerminal data)
const term = content.interactiveTerminal;
function wrapNumbers(line) {
  return line.replace(/(\d+(?:\.\d+)?)/g, (m) => `<span class="t-num" data-num="${m}">${m}</span>`);
}
const termBlocks = term.workflows.map((w, i) => `
      <div class="term-block" data-beat="${i}">
        <div class="term-line term-prompt">
          <span class="term-user">operator@prime-silo:~$</span>
          <span class="term-cmd" data-cmd="${w.command}">${w.command}</span><span class="term-caret" aria-hidden="true"></span>
        </div>
        <div class="term-out">
          ${w.logs.map((l) => `<div class="term-log">${wrapNumbers(l)}</div>`).join('\n')}
        </div>
      </div>`).join('\n');
const terminalSectionHtml = `
  <section class="chapter chapter--terminal" id="terminal" data-visual="terminal" data-beats="${term.workflows.length}">
    <div class="chapter-pin">
      <div class="chapter-stage chapter-stage--terminal">
        <div class="terminal-head">
          <div class="section-kicker">${term.kicker}</div>
          <h2 class="section-headline">${term.headline}</h2>
          <p class="section-sub">${term.sub}</p>
        </div>
        <div class="terminal-window">
          <div class="terminal-titlebar">
            <div class="term-dots"><span class="term-dot dot-red"></span><span class="term-dot dot-yellow"></span><span class="term-dot dot-green"></span></div>
            <div class="term-title">Prime-Silo Runtime — Sovereign Agent Shell</div>
            <div class="term-status">HMAC: SECURE</div>
          </div>
          <div class="terminal-body">${termBlocks}
          </div>
        </div>
      </div>
    </div>
    <div class="chapter-track" style="height:320vh" aria-hidden="true"></div>
  </section>`;

// --- flat sections (entrance staggers + micro-interactions only) ---
const prob = byId.problem;
const problemSectionHtml = `
  <section class="problem-section" id="problem">
    <div class="section-kicker">${prob.kicker}</div>
    <h2 class="section-headline">${prob.headline}</h2>
    <div class="cards-grid reveal-group">
      ${prob.cards.map((c) => `
      <div class="problem-card reveal-item">
        <h3>${c.title}</h3>
        <p>${c.body}</p>
      </div>`).join('\n')}
    </div>
  </section>`;

const man = byId.boundary;
const manifestoSectionHtml = `
  <section class="manifesto-section" id="boundary">
    <div class="manifesto-inner">
      <div class="section-kicker">${man.kicker}</div>
      <h2 class="section-headline">${man.headline}</h2>
      <p class="section-sub manifesto-intro">${man.intro}</p>
      <div class="manifesto-grid reveal-group">
        <div class="manifesto-box generated reveal-item">
          <h3>${man.left.label}</h3>
          <ul>${man.left.items.map((i) => `<li>${i}</li>`).join('\n')}</ul>
        </div>
        <div class="manifesto-box guaranteed reveal-item">
          <h3>${man.right.label}</h3>
          <ul>${man.right.items.map((i) => `<li>${i}</li>`).join('\n')}</ul>
        </div>
      </div>
      <p class="manifesto-outro">${man.outro}</p>
    </div>
  </section>`;

const feat = byId.features;
const featuresSectionHtml = `
  <section class="features-section" id="features">
    <div class="section-kicker">${feat.kicker}</div>
    <h2 class="section-headline">${feat.headline}</h2>
    <div class="features-grid reveal-group">
      ${feat.features.map((f) => `
      <div class="feature-item reveal-item">
        <div>
          <span class="feature-tag">${f.tag}</span>
          <h3 class="feature-name">${f.name}</h3>
          <p class="feature-blurb">${f.blurb}</p>
        </div>
      </div>`).join('\n')}
    </div>
  </section>`;

const comp = byId.compounding;
const compoundingSectionHtml = `
  <section class="compounding-section" id="compounding">
    <div class="section-kicker">${comp.kicker}</div>
    <h2 class="section-headline">${comp.headline}</h2>
    <p class="section-sub compounding-body">${comp.body}</p>
    <div class="chain-visual reveal-group">
      ${comp.chain.map((node, i, arr) => `
      <div class="chain-node reveal-item"><strong>${node.label}</strong><span>${node.note}</span></div>
      ${i < arr.length - 1 ? '<span class="chain-arrow reveal-item">→</span>' : ''}`).join('\n')}
    </div>
  </section>`;

const calc = byId.calculator;
const calculatorSectionHtml = `
  <section class="calculator-section" id="calculator">
    <div class="section-kicker">${calc.kicker}</div>
    <h2 class="section-headline">${calc.headline}</h2>
    <div class="calc-disclaimer">${calc.disclaimer}</div>
    <div class="calculator-card reveal-item">
      <div class="calc-inputs">
        ${calc.inputs.map((inp) => `
        <div class="input-group">
          <div class="input-header">
            <span>${inp.label}</span>
            <span class="input-value-display" id="val-${inp.key}">${inp.default}</span>
          </div>
          <input type="range" id="input-${inp.key}" data-calc-key="${inp.key}" min="${inp.min}" max="${inp.max}" step="${inp.step}" value="${inp.default}" />
        </div>`).join('\n')}
      </div>
      <div class="calc-results">
        <div>
          <h3 class="calc-results-title">Estimated Operational Spend</h3>
          <div class="bars-comparison">
            <div class="bar-row">
              <div class="bar-header"><span>Cloud API Expenditure</span><strong id="display-cloud-cost">$0.00 / mo</strong></div>
              <div class="bar-track"><div class="bar-fill cloud-fill" id="bar-cloud" style="width: 80%;"></div></div>
            </div>
            <div class="bar-row">
              <div class="bar-header"><span>Prime-Silo Local Electrical Spend</span><strong id="display-local-cost">$0.00 / mo</strong></div>
              <div class="bar-track"><div class="bar-fill local-fill" id="bar-local" style="width: 15%;"></div></div>
            </div>
          </div>
        </div>
        <div class="calc-formula">
          <div>${calc.formulaNote}</div>
          <div class="calc-footnote">* ${calc.assumptionsFootnote}</div>
        </div>
      </div>
    </div>
  </section>`;

const aud = byId.audiences;
const audiencesSectionHtml = `
  <section class="audiences-section" id="audiences">
    <div class="section-kicker">${aud.kicker}</div>
    <h2 class="section-headline">${aud.headline}</h2>
    <div class="audiences-grid reveal-group">
      <div class="audience-card reveal-item">
        <h3>${aud.personal.headline}</h3>
        <ul>${aud.personal.bullets.map((b) => `<li>${b}</li>`).join('\n')}</ul>
      </div>
      <div class="audience-card reveal-item">
        <h3>${aud.institutional.headline}</h3>
        <ul>${aud.institutional.bullets.map((b) => `<li>${b}</li>`).join('\n')}</ul>
      </div>
    </div>
  </section>`;

const road = byId.roadmap;
const roadmapSectionHtml = `
  <section class="roadmap-section" id="roadmap">
    <div class="roadmap-inner">
      <div class="section-kicker">${road.kicker}</div>
      <h2 class="section-headline">${road.headline}</h2>
      <div class="roadmap-grid reveal-group">
        ${road.items.map((item) => `
        <div class="roadmap-item reveal-item">
          <h4>${item.name}</h4>
          <p>${item.blurb}</p>
        </div>`).join('\n')}
      </div>
    </div>
  </section>`;

const faq = byId.faq;
const faqSectionHtml = `
  <section class="faq-section" id="faq">
    <div class="section-kicker">${faq.kicker}</div>
    <h2 class="section-headline">${faq.headline}</h2>
    <div class="faq-list reveal-group">
      ${faq.items.map((i) => `
      <div class="faq-item reveal-item">
        <h4>${i.q}</h4>
        <p>${i.a}</p>
      </div>`).join('\n')}
    </div>
  </section>`;

const contact = byId.contact;
const contactSectionHtml = `
  <section class="contact-section" id="contact">
    <div class="section-kicker">${contact.kicker}</div>
    <h2 class="section-headline">${contact.headline}</h2>
    <p class="section-sub contact-sub">${contact.sub}</p>
    <div class="contact-actions">
      <a href="${contact.downloadCta.href}" class="btn btn-primary">${contact.downloadCta.label}</a>
      <a href="${contact.githubCta.href}" class="btn btn-ghost">${contact.githubCta.label}</a>
    </div>
    <p class="contact-email">Direct Contact: <a href="mailto:${contact.email}">${contact.email}</a></p>
  </section>`;

const footerSectionHtml = `
  <div class="footer-content">
    <div>
      <h3 class="footer-line">${content.footer.line}</h3>
      <p class="footer-seo">${content.footer.seoParagraph}</p>
    </div>
    <div class="footer-side">
      <ul class="footer-links">
        ${content.footer.links.map((l) => `<li><a href="${l.href}">${l.label}</a></li>`).join('\n')}
      </ul>
      <div class="mascot-container benny-footer">
        <svg class="benny-svg benny-svg--small" viewBox="0 0 256 256" aria-hidden="true"><use href="#benny-symbol" /></svg>
      </div>
    </div>
  </div>
  <div class="footer-bottom">
    <span>${content.footer.license}</span>
    <span>v${version}</span>
  </div>`;

// ---------------------------------------------------------------------------
// 6. Navbar (compressed: 4 primary + More dropdown + CTA)
// ---------------------------------------------------------------------------
const PRIMARY_COUNT = 4;
const primaryLinks = content.nav.links.slice(0, PRIMARY_COUNT);
const moreLinks = content.nav.links.slice(PRIMARY_COUNT);
const navPrimaryHtml = primaryLinks.map((l) => `<li><a href="${l.href}">${l.label}</a></li>`).join('\n');
const navMoreHtml = [
  // duplicated primary links: only shown at narrow widths (CSS)
  ...primaryLinks.map((l) => `<li class="nav-dup"><a href="${l.href}">${l.label}</a></li>`),
  ...moreLinks.map((l) => `<li><a href="${l.href}">${l.label}</a></li>`),
  `<li><a href="#faq">FAQ</a></li>`
].join('\n');
const navCtaHtml = `<a href="${content.nav.cta.href}" class="btn btn-primary nav-cta">${content.nav.cta.label}</a>`;

// ---------------------------------------------------------------------------
// 7. Assemble + write
// ---------------------------------------------------------------------------
const mainHtml = [
  heroSectionHtml,
  siloChapterHtml,
  trigraphChapterHtml,
  enablersSectionHtml,
  longviewChapterHtml,
  governanceChapterHtml,
  lineageChapterHtml,
  terminalSectionHtml,
  problemSectionHtml,
  manifestoSectionHtml,
  featuresSectionHtml,
  compoundingSectionHtml,
  calculatorSectionHtml,
  audiencesSectionHtml,
  roadmapSectionHtml,
  faqSectionHtml,
  contactSectionHtml
].join('\n');

let template = fs.readFileSync(TEMPLATE_HTML_PATH, 'utf-8');
content.seo.jsonLd.softwareVersion = version;

const replacements = {
  metaTitle: content.seo.metaTitle,
  metaDescription: content.seo.metaDescription,
  keywords: content.seo.keywords.join(', '),
  ogTitle: content.seo.ogTitle,
  ogDescription: content.seo.ogDescription,
  ogImage: content.seo.ogImage,
  jsonLd: JSON.stringify(content.seo.jsonLd, null, 2),
  bennyParts: BENNY_PARTS,
  navPrimary: navPrimaryHtml,
  navMore: navMoreHtml,
  navCta: navCtaHtml,
  main: mainHtml,
  footerSection: footerSectionHtml
};

for (const [key, val] of Object.entries(replacements)) {
  template = template.split(`{{${key}}}`).join(val);
}

// Output asserts (verification protocol)
const chapterCount = (template.match(/<section class="chapter /g) || []).length;
const asserts = [
  [chapterCount >= 4, `>=4 chapter sections (got ${chapterCount})`],
  [template.includes('class="chapter-pin"'), 'chapter-pin present'],
  [template.includes('class="chapter-stage"'), 'chapter-stage present'],
  [template.includes('class="chapter-rail"'), 'chapter-rail present'],
  [template.includes('id="hero-silo"'), 'hero silo SVG present'],
  [template.includes('id="silo-open-svg"'), 'silo chapter SVG present'],
  [template.includes('id="dial-svg"'), 'dial SVG present'],
  [template.includes('id="trigraph-svg"'), 'trigraph SVG present'],
  [template.includes('id="governance-svg"'), 'governance SVG present'],
  [template.includes('id="lineage-svg"'), 'lineage DAG SVG present'],
  [template.includes('class="terminal-window"'), 'terminal window present'],
  [!template.includes('{{'), 'no unresolved template markers']
];
for (const [ok, label] of asserts) {
  if (!ok) {
    console.error(`BUILD ERROR: assert failed — ${label}`);
    process.exit(1);
  }
}
// Lint final HTML too (skip legit external/anchor/mailto URLs)
lint(template.replace(/(?:src|href)="(?:https?:|mailto:|#|\.\/)[^"]*"/g, ''), 'generated index.html');

// Content-hashed asset URLs: bust browser/CDN caches whenever css/js change
// (GitHub Pages + heuristic caching otherwise serves stale assets after deploys).
const assetHash = (f) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, f))).digest('hex').slice(0, 10);
template = template
  .replace('href="./styles.css"', `href="./styles.css?v=${assetHash('styles.css')}"`)
  .replace('src="./app.js"', `src="./app.js?v=${assetHash('app.js')}"`);

const GENERATED_BANNER = `<!-- GENERATED FILE — DO NOT EDIT DIRECTLY. EDIT website/content.json & website/template.html AND RUN node website/build.mjs -->\n`;
fs.writeFileSync(OUT_INDEX_HTML, GENERATED_BANNER + template, 'utf-8');

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://binary16labs.github.io/prime-silo/</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
fs.writeFileSync(OUT_SITEMAP, sitemapXml, 'utf-8');

const robotsTxt = `User-agent: *
Allow: /

Sitemap: https://binary16labs.github.io/prime-silo/sitemap.xml`;
fs.writeFileSync(OUT_ROBOTS, robotsTxt, 'utf-8');

console.log(`Build OK — index.html (${chapterCount} chapters), sitemap.xml, robots.txt · v${version}`);
