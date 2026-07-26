# Prime-Silo — Website Design Brief (E0)

> **Words locked before code.** This brief is the single source of truth for the marketing site copy,
> structure, and design constraints. E1 builds three mocks from it verbatim; E2 builds the page.
> Every numeric/comparative claim is governed by `website/claims.json` and `scripts/gates/e0.mjs`.
>
> **Status:** APPROVED — authored by claude-opus 2026-07-25, **signed off by the owner (darkhorse)
> 2026-07-26.** Copy + claims policy locked. E1 builds three mocks from this verbatim.

Owner-Approved: darkhorse 2026-07-26
<!-- Owner: replace PENDING with your sign-off (e.g. `Owner-Approved: darkhorse 2026-07-26`) to lock
     the brief. Keep this on its own line, starting exactly with `Owner-Approved:` (no bold/quote).
     The e0 gate stays RED until this line carries a real value. -->

---

## 1. Voice & principles (locked)

- **Honest voice.** No hype, no unverifiable superlatives. Claims are numbers with sources or they
  are not made. The invalidated token-economics figures (the "98%" / "92.9% reduction" line — the v2
  measurement harness is blocked, so they are **not** validated) are **REMOVED from the site, not
  reworded.**
- **One demo moment.** The page earns exactly one "show, don't tell" beat — a single concrete
  interaction that proves local-first is real — not a reel of features.
- **Progressive discovery.** Lead with the plain promise; depth is available, never forced.
- **Sovereignty is the through-line.** Your documents, your models, your machine — stated, then shown.

## 2. Hero (locked copy)

- **Headline:** A local-first AI workbench. Your documents, your models, your machine.
- **Subhead (proposal):** Prime-Silo runs AI agents on your own hardware with an auditable memory of
  everything they read and do — no cloud round-trip, no data leaving the box.
- **Primary CTA:** Download for Windows, macOS, Linux
- **Secondary CTA:** See how it works ↓ (anchors to the one demo moment)

## 3. Page structure / wireframe order (locked)

1. **Hero** — headline + subhead + dual CTA. Earth-tone palette (unified with the app's C0 design
   system). Calm, high-contrast, no autoplaying motion.
2. **The one demo moment** — a single scrollytelling beat (animejs-scrollcraft chassis) showing a real
   local run: a document goes in, an agent reads it, the tri-graph memory records it, an answer comes
   back — all on-device. One idea, shown once, well.
3. **Three pillars** (progressive discovery, no numbers unless registered):
   - *Local execution* — models run on your hardware; offload is opt-in and auditable.
   - *Auditable memory* — a tri-graph (sources, concepts, sessions) you can inspect and teleport.
   - *Deterministic governance* — every change signed, versioned, replayable.
4. **Local vs. cloud** — an honest comparison. If it shows a bar/number, that number is registered in
   claims.json with a source, or it is qualitative only.
5. **How it works** — the pipeline in three plain steps (capture → synthesize → serve), links to docs.
6. **Trust & governance** — Sovereign Memory Teleport, leak gate, OpenLineage mesh (features, not
   numbers, unless registered).
7. **Download / footer** — platforms, GitHub, contact, SEO/OG hygiene intact.

## 4. Checkable design constraints (locked)

- **C1 — Palette:** earth-tone tokens shared with the app's C0 design system (no new brand colors).
- **C2 — Claims:** every numeric or comparative claim in visible copy is registered in
  `website/claims.json` (claim/source/verified_date). `node scripts/gates/e0.mjs --scan` must pass
  before E2 ships. Invalidated numbers are removed, not reworded.
- **C3 — One demo moment:** exactly one scroll-driven set piece; the rest is calm static layout.
- **C4 — Motion is meaning:** animation only where it clarifies (the demo beat); respects
  `prefers-reduced-motion`; nothing autoplays that distracts from reading.
- **C5 — Accessibility:** WCAG AA contrast, keyboard-navigable, alt text on every asset.
- **C6 — SEO/OG hygiene:** preserve the existing metaTitle/metaDescription/OG image/JSON-LD in
  `content.json`; relative asset paths only (GitHub Pages).
- **C7 — Keep from the live site:** earth-tone palette, Neuro-Assist dock, TUI accents.
- **C8 — Copy is frozen at build:** `content.json` remains the frozen copy contract; no bracketed
  placeholder markers ship.

## 5. Claims policy (how §4/C2 is enforced)

- `website/claims.json` is the truth registry. Shape: `{ claims: [{ claim, source, verified_date }] }`.
- `scripts/gates/e0.mjs` (this task): the **armed** checker. `--scan` lists every unregistered numeric
  claim in the public files and exits non-zero. It fails **today** on purpose (the live site still
  carries unregistered numbers) — that proves it is armed. E2 registers the verified claims (e.g. the
  arc-driven coverage figure, with its source) and **removes** the invalidated token-economics numbers,
  then `--scan` goes green.
- Known live numbers to adjudicate in E2 (author's survey, for the owner): `31.4%` (book coverage —
  has a source, register it), `92.9%` / `98%` (token-economics — **remove**, not validated),
  `86.1%` / `66.7%` / `33.3%` (offload-report figures in concept.md — register **only** if their
  source ledger is current, else remove).

## 6. Out of scope (E0)

Building anything (that's E1 mocks → E2 page). Writing new claims from new data (F5 is the future data
source). E0 locks the words + arms the honesty gate; it does not touch the live page.

---

*Handoff: the owner reviews §2–§5 copy, edits as desired, and replaces the `Owner-Approved: PENDING`
line with a real sign-off. That flips the e0 gate's approval check green; the armed claims checker
stays red against the live site until E2 cleans it.*
