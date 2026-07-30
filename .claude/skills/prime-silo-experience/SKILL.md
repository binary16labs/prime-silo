---
name: prime-silo-experience
description: The Prime-Silo product experience contract — identity (Prime-Silo + Agent Benny, never Space Agent), earth-tone design tokens, progressive-discovery doctrine, and the "motion is meaning" choreography rules that bring animejs.com-grade kinetics INTO the app without violating the C0 calm contract. Use for any user-facing UI work in app/, server/pages/, or packaging/ (login, first-run, shell, mascot, Studio, Bridge).
---

# The Prime-Silo experience — identity, discovery, motion

The product is **Prime-Silo**. The guide who lives inside it is **Agent Benny** (the german
shepherd). "Space Agent" is a dead upstream name — it must never appear on a user-facing surface
(strings, titles, alt text, logos, docs prose). Identifiers (`space-desktop:` IPC, `node space`
CLI, file names, package names) are protected until Workstream H — do not rename them.

The feeling to build: **walking into a quiet, beautifully organized grain silo with a very good
dog showing you around.** Calm by default; kinetic at the exact moments that deserve it. The
marketing site (website/) already nails this — the app must feel like the same product.

## 1. One palette, two surfaces

All app color resolves through `var(--*)` tokens in
`app/L0/_all/mod/_core/framework/css/colors.css` (enforced by `scripts/gates/c0.mjs` — hex
literals outside colors.css fail the commit). The family: alabaster/cream grounds, moss/charcoal
greens for depth, rust for the ONE primary action, sage/taupe for structure. Depth = the three
`--elevation-1/2/3` tokens only. Spacing/radius/measure from `layout.css`, type from `type.css`
(base ≥16px, line-height 1.5, ≤70ch, never justify). Read `architecture/DESIGN-SYSTEM.md` in
full before any CSS — it is short and it is law.

## 2. Progressive discovery (the ADHD contract, C0)

- **One decision per screen.** First-run, wizards, and setup flows present exactly one choice,
  then advance. Never a settings wall.
- **One primary action per view**, rust-accented, visually dominant. Everything secondary sits
  behind a consistent `More ▸` disclosure.
- **Teach by doing.** Empty states offer the first action, not documentation ("Drop a PDF to
  begin"). After the first success, suggest exactly 3 next actions.
- **Long work is honest work:** always `Step n of m` + one plain line of "what happens next."
  Progress lands as a card, never a modal wait.
- Benny narrates transitions in first person, short and warm: "I'll keep your documents on this
  machine." — never marketing voice inside the product.

## 3. Motion doctrine — "motion is meaning"

C0 says: _no ambient motion; animation only as feedback to user action_ (mascot micro-states are
the sanctioned exception). This is NOT a ban on the animejs.com aesthetic — it is a targeting
rule. The website proves the style; the app earns it at these moments:

**Sanctioned kinetic moments (choreograph these fully):**

1. **Threshold moments** — login load, first-run steps, section transitions the USER initiated.
   A step change is user action; a spring-staggered entrance of the next step IS feedback.
2. **State becoming visible** — a run starting (DAG nodes light in sequence), ingestion
   progressing (dial arc sweeps to the real fraction), a graph materializing (nodes settle with
   springs, edges draw with `createDrawable`). The animation must be DRIVEN BY REAL EVENTS
   (SSE/EventBus), never a timer pretending. If the data didn't move, the pixels don't move.
3. **Benny micro-states** — idle (breathing ear/tail, subtle), listening (head tilt on input
   focus), processing (bound to real SSE activity). The only allowed loop, and it must be quiet.

**Forbidden:** looping decorative backgrounds, parallax for its own sake, attention-grabbing
pulses on idle UI, anything that moves while the user is reading and nothing is happening.

**Hard gates on every animation, no exceptions:**

```js
const calm =
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.dataset.profile === "zen"; // C7 Zen = zero animation
if (calm) return; // final state must already be in the CSS — page complete with zero JS
```

**Vocabulary (same as the website — one motion language):** springs with slight overshoot
(`createSpring({stiffness:120, damping:12})`), `out(3..5)` eases, 500–900ms, `stagger(40–80)` on
anything plural, SVG stroke-draw for diagrams, counters that count to REAL numbers. Use the
vendored anime.js v4 ESM — vendor it for the app at
`app/L0/_all/mod/_prime_silo/vendor/anime.esm.min.js` (copy from `website/vendor/`). The verified
v4 API + idioms + mobile rules live in `.claude/skills/animejs-scrollcraft/SKILL.md` — read it
before writing a single `animate()` call; API drift is the #1 historical failure source.

## 4. Set-piece patterns (reuse, don't reinvent)

- **The Silo** (identity moment): stroke-drawn silo assembling from ring segments — login and
  brand thresholds. Reference implementation: `website/build.mjs` (heroSiloSvg/siloChapterSvg).
- **The Dial** (any pipeline): N nodes on a ring, sweeping progress arc, active node blooms,
  center readout swaps per step. Reference: `website/` dial chapter. In-app version binds the
  arc to real progress (G0 run events / progress.json fractions), not scroll.
- **Terminal cinema** (honest logs): moss-dark Courier block, typed lines, count-up numbers —
  for run output surfaces. Never fake the log content.
- **Benny walk** (guidance): Benny moves along a path between steps of a flow, sits at the
  active one. Source art: `app/L0/_all/mod/_core/visual/res/chat/overlay/dog_no_bg.svg`
  (body parts are commented per-path — split into <symbol> parts for posing, as website did).

## 5. First-impression flows (the taste bar)

**Login** = "enter the silo": alabaster ground, the silo drawing itself once (~1.2s, then still),
Benny sitting beside the form, rust primary button, moss focus rings. No gradients from space,
no starfields. **First-run** = four screens, one decision each (welcome → home dir → services
check → done); Benny walks the rail between steps; the services check animates real probe
results as they return. Every flow must be fully usable — and look intentional, final states
in CSS — with JS disabled or reduced-motion on.

## 6. Verification (what "done" looks like)

1. `node scripts/gates/c0.mjs` green after ANY CSS touch.
2. Preview at 1280×800 AND 375×812 (the app gets narrow windows too — panes, not pages).
3. `prefers-reduced-motion` emulation: zero running animations, page fully readable.
4. Zen profile (when C7 lands): same as reduced motion.
5. Screenshot the moment of delight AND the calm resting state — both must pass taste review:
   would this feel at home next to https://binary16labs.github.io/prime-silo/ ?
6. Grep your diff for `Space Agent|space agent` — zero user-facing hits.
