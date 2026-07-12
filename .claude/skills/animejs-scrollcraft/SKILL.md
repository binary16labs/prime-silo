---
name: animejs-scrollcraft
description: Build animejs.com-grade scroll-driven kinetic pages with the vendored anime.js v4 bundle (website/vendor/anime.esm.min.js). Use when working on the prime-silo marketing site (website/) or any scrollytelling/animation surface. Contains the VERIFIED v4 API, the design language to emulate, the Prime-Silo set-piece specs, and the verification protocol.
---

# anime.js v4 scrollcraft — verified API + design language

The marketing site (`website/`) must feel like https://animejs.com/ — scroll-scrubbed
storytelling where a central object assembles/explodes as you move, springs and staggers
everywhere, SVG lines that draw themselves, numbers that count with the scroll. This file
is the contract; deviations from the API here caused the last rebuild to fail.

## 1. Verified imports (from the ACTUAL vendored bundle, animejs 4.5.0)

```js
import {
  animate, createTimeline, createTimer, createSpring, createDrawable,
  createMotionPath, morphTo, onScroll, stagger, svg, utils, text, eases,
  TextSplitter, ScrollObserver
} from './vendor/anime.esm.min.js';
```
All of the above are REAL named exports (verified by import + export-map inspection).
`svg` object = { createDrawable, createMotionPath, morphTo } equivalents; prefer the
top-level named exports. v4 is TWO-ARGUMENT: `animate(targets, options)` — NEVER
`animate({ targets, ... })` (that's v3; do not shim it, write v4 natively).

## 2. Core idioms

```js
// basic
animate('.chip', { opacity: [0,1], translateY: [24,0], delay: stagger(60, { from: 'first' }),
  duration: 700, ease: 'out(3)' });

// spring
animate(el, { scale: [0.6, 1], ease: createSpring({ stiffness: 120, damping: 12 }) });

// timeline
const tl = createTimeline({ defaults: { duration: 600, ease: 'inOutQuad' } });
tl.add('#g-docs',  { translateX: -180, translateY: -60 })
  .add('#g-code',  { translateX: 180,  translateY: -40 }, '<<')   // '<<' = with previous
  .add('#g-links path', { strokeDashoffset: [utils.$('#g-links path')[0]?.getTotalLength?.()||300, 0] }, '+=200');

// SCROLL-SCRUBBED timeline (the signature move) — verified option keys:
// container, axis, enter, leave, sync, repeat, debug,
// onEnter/onLeave/onEnterForward/onEnterBackward/onLeaveForward/onLeaveBackward,
// onUpdate, onSyncComplete
const tl2 = createTimeline({
  autoplay: onScroll({
    target: sectionEl,          // element whose position drives progress
    enter:  'bottom top',       // '<target-edge> <container-edge>' — when target bottom meets viewport top… (also accepts 'min max', numbers, 'center', '+=/-=' offsets)
    leave:  'top bottom',
    sync:   true,               // true = hard progress link (scrub); or an ease name string for smoothed scrub ('inOutQuad'); or 'play pause' method pair
  })
});

// SVG line drawing
const [line] = createDrawable('#seal-lineage path');   // returns proxies with a `draw` prop
animate(line, { draw: '0 1', duration: 900, ease: 'inOutSine' });

// text splitting (kinetic type)
const split = text.split('.hero-headline', { words: { wrap: 'clip' } });
animate(split.words, { y: ['1.2em', 0], opacity: [0,1], delay: stagger(40), ease: 'out(4)' });

// counter scrub
animate(statEl, { textContent: [0, 248], modifier: utils.round(0), duration: 1200 });
```

Reduced-motion contract: gate EVERY animation behind
`!matchMedia('(prefers-reduced-motion: reduce)').matches && !document.documentElement.classList.contains('calm-motion')`.
CSS must default to the FINAL (assembled/exploded-readable) state so the page is complete with zero JS.

**MOBILE-FIRST (the primary surface — most visitors arrive on phones).** Narrow layouts keep the
FULL scrub experience; they re-choreograph, never degrade to static:
- Sticky pinning stays on mobile (`position:sticky` works on iOS/Android). Chapter layout goes
  vertical: stage pinned at top (~62svh), the step rail becomes a bottom card strip — one card
  visible at a time, swapped per beat (translateX carousel), progress dots above it.
- Use `svh`/`dvh` units, NEVER bare `100vh` (iOS URL-bar resize breaks pins and causes the
  "scroll jumps/breaks when narrow" bug). Root cause of narrow breakage is usually (a) vh units,
  (b) horizontal overflow from an oversized stage SVG — clamp stages with `max-width:100%` and
  `overflow-x:clip` on body/chapters, (c) layout thrash — animate transforms/opacity ONLY.
- Set-piece SVGs must be built with a portrait-safe viewBox (contain within ~92vw × 58svh);
  scale the composition, don't crop it.
- Touch performance: no `backdrop-filter` on mobile widths, `will-change: transform` on stage
  groups only while a chapter is active (add/remove via onEnter/onLeave), passive scroll listeners.
- Test order is mobile FIRST: 375×812 beat screenshots BEFORE desktop ones.

## 3. The scrollytelling chassis (what was missing last time)

Every explode chapter MUST be this shape — a tall scroller with a pinned stage:
```html
<section class="chapter chapter--dark" id="trigraph" data-visual="trigraph">
  <div class="chapter-pin">          <!-- position:sticky; top:0; height:100vh -->
    <div class="chapter-stage"> …one big SVG set-piece… </div>
    <aside class="chapter-rail"> …step cards, .active follows progress… </aside>
  </div>
  <div class="chapter-track" style="height:320vh"></div> <!-- scroll runway -->
</section>
```
One `createTimeline({ autoplay: onScroll({ target: section, enter:'top top', leave:'bottom bottom', sync:true }) })`
per chapter; divide it into labeled beats (one per step card); drive `.chapter-rail .step.active`
from timeline progress (`onUpdate` → index = floor(progress * steps)).

## 4. The design language to emulate (animejs.com signatures)

- ONE hero object animating on load (staggered grid assembly), then scroll owns everything.
- Motion personality: springs (slight overshoot), `out(3..5)` eases, 500–900ms, stagger everything that's plural.
- SVG-first visuals: stroke-drawn diagrams (createDrawable), morphs, motion paths — not raster.
- Scrubbed, not triggered: sections read as a timeline you drive with the wheel; reversing scroll reverses the story.
- Numbers are alive: stats count with scroll progress.
- Controls-as-UI garnish: little play/scrub affordances, progress dots on chapters.
- Density restraint: one set-piece per viewport, generous whitespace, type does the talking between acts.

## 5. Prime-Silo set-pieces (the creative brief)

Palette: alabaster #F5F2EB · cream #EAE5D9 · moss #1E2D24/#16221B/#26382D · rust #B85D3D · sage #9CAF88 · taupe #C5B38E · charcoal #1A241E. Fonts: Playfair Display / Outfit / Courier Prime.

**A. THE SILO (page centerpiece — hero + first chapter).** Draw an actual grain-silo SVG
(cylinder + conical roof + ring seams, stroke-based, moss on alabaster). Hero: silo assembles
from staggered ring segments; Benny (inline symbol from `dog_no_bg.svg` parts) sits beside it,
tail-wag loop. First chapter ("inside the silo"): scroll slides the silo shell OPEN (two shell
halves translate apart) revealing 4 stacked floors inside — each floor a subsystem
(tri-graph mesh / LONGVIEW pipeline / governance seal / cockpit). Each scroll beat lifts one
floor out toward the viewer (scale+translate, spring settle), dims the others, draws its label
line out to the rail card. Reverse scroll re-stacks them. Finale: shell closes, seal stamp.

**B. THE MEMO-RAY DIAL (circular step-through).** A circular dial (like a radar/clock) for the
LONGVIEW workflow: 6 nodes on a ring (inventory→extract→map→graph→enrich→deliver), a sweeping
progress arc (createDrawable on a circle path), the active node blooms (spring scale + rust fill),
a center readout swaps per beat (step name + one-liner + count-up stat). Driven by the chapter
scrub. This pattern = "step-through of workflows" and can be reused for any pipeline.

**C. TERMINAL CINEMA.** A moss-dark terminal window (Courier Prime) that types real CLI lines
(`benny longview run --phase map`, ledger lines, `[graph] +12 nodes / 16 edges`) with a blinking
caret, timed by the scrub (each beat = one command+output block). Output lines stagger in;
numbers in output count up. Keep content sourced from content.json (interactiveTerminal).

**D. Everything else** (problem cards, manifesto split, feature grid, calculator bars, roadmap)
gets entrance staggers + micro-interactions only — restraint.

## 6. Verification protocol (non-negotiable)

1. `node website/build.mjs` → exit 0, lints clean (no `[[`, no forbidden claims, relative paths only).
2. Serve `website/` statically (launch config `prime-silo-website`, port 8791) — NEVER file://.
3. `preview_eval`: assert `.chapter` count ≥ 3, `.chapter-pin` sticky computed style, timeline count, zero console errors.
4. MOBILE FIRST: at 375×812, screenshot hero then 25/50/75% of each chapter track — the
   set-piece MUST look different at each beat AND the step card strip must track it. Then
   repeat at desktop width. `document.documentElement.scrollWidth <= innerWidth` must hold
   at every beat (no horizontal overflow — the classic narrow-breakage cause).
5. Emulate `prefers-reduced-motion` → page fully readable, no motion.
6. Resize during a pinned chapter (narrow→wide→narrow) → no stuck stages, no dead zones.
