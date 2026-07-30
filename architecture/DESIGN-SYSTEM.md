# Design System Contract (C0)

One source of design truth. These rules are not aspirational — they are
enforced by `scripts/gates/c0.mjs` on every commit that touches governed
CSS (`app/L0/_all/mod/_prime_silo/**/*.css` and
`app/L0/_all/mod/_core/framework/css/**/*.css`).

## Token files (single source of truth — extend, never hardcode)

| File                       | Purpose                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `framework/css/colors.css` | Canonical earth-tone palette (ADR-004). All color must resolve through a `var(--*)` token here. |
| `framework/css/layout.css` | Spacing scale, radius scale, pane gap, reading measure.                                         |
| `framework/css/type.css`   | Type scale, line-height, letter-spacing, readable-font stub.                                    |

These three are ported by the website (E0) — keep them portable (tokens
only, no app-specific selectors) so both surfaces draw from one palette.

## Color

Only `var(--*)` tokens from `colors.css` are permitted in governed CSS.
Hex literals anywhere outside `colors.css` are a lint failure. `colors.css`
itself is exempt — it is where hex is allowed to live, because it is the
thing everything else points at.

## Type — dyslexia-friendly

- **Base size:** the document base (`html`/`body`/`:root`) must never be
  set below 16px. Component/chrome labels may be smaller (badges, tab
  labels) — the rule targets body reading text, not every UI micro-label.
- **Line height:** body copy uses `--line-height-body` (1.5). Single-line
  chrome (buttons, badges) may use `--line-height-tight`.
- **Measure:** long-form text blocks cap at `--measure-max` (70ch) via the
  `.type-measure` utility class — ragged-right, scannable line lengths.
- **Never justify.** `text-align: justify` is a hard lint failure anywhere
  in governed CSS; there is no legitimate justified body text in this
  system.
- **All-caps labels** get generous letter-spacing via
  `--letter-spacing-caps` (0.06em) — dense all-caps text is a known
  dyslexia friction point.
- **Readable-font toggle (stub, C0):** a persisted setting key
  `settings.readableFont` (boolean) drives `[data-readable-font="on"]` on
  the app root, which swaps `--font-stack-active` to
  `--font-stack-readable` (Atkinson Hyperlegible if bundled, else
  `system-ui`). The CSS hook and font stacks are defined now in
  `type.css`; the actual toggle UI control lands with C2.

## ADHD / progressive disclosure

- **One primary action.** Every view has exactly one primary action,
  visually dominant (size, weight, or accent color — not more than one
  element competing for that role).
- **`More ▸` disclosure.** Advanced/secondary controls live behind a
  single, consistently-labeled `More ▸` affordance rather than being
  surfaced all at once.
- **Step indicators.** Long-running or multi-step processes always show
  `n of m` progress plus a one-line "what happens next."
- **No ambient motion.** Animation is feedback to a user action only —
  never decorative/looping background motion. The onscreen-agent mascot
  micro-states are the sanctioned exception (C5).
- **Focus states always visible.** `:focus-visible` outlines are never
  suppressed; every interactive element keeps a visible focus ring
  (`--color-focus-ring` / the per-surface `*-focus-ring` tokens).

## Depth (elevation)

The global `box-shadow: none !important` reset that used to live in
`mod/_core/visual/index.css` is gone (ADR-004). Depth is expressed through
exactly **three** elevation tokens, defined in `colors.css`:

| Token           | Use                                 |
| --------------- | ----------------------------------- |
| `--elevation-1` | Resting card / chip — subtle lift.  |
| `--elevation-2` | Popover / menu / topbar panel.      |
| `--elevation-3` | Modal / dialog — the deepest layer. |

Components should reference these tokens (e.g. a panel-shadow variable set
to `var(--elevation-2)`) rather than inventing their own shadow values or
resetting to `none`. `chrome.css` still resets its panel shadow to `none`
and is outside C0's allowlist — grandfathered for C1/module-retheming to
pick up.

## Layout tokens

`layout.css` defines a 4px-based spacing scale (`--space-0` … `--space-16`),
a radius scale (`--radius-sm/md/lg/full`), and `--pane-gap` — the gutter
between adjacent panes, consumed by the C1 adaptive layout contract.

## Enforcement

`node scripts/gates/c0.mjs` scans governed CSS and fails non-zero if:

1. A hex color literal appears outside `colors.css`.
2. `text-align: justify` appears anywhere.
3. The document base font-size drops below 16px.
4. `mod/_core/visual/index.css` reintroduces `box-shadow: none !important`.
5. Framework CSS does not define exactly 3 `--elevation-N` tokens.
6. The hardcoded-color count rises above the recorded ratchet floor, or a
   file outside the grandfathered floor set introduces new hex, or a
   grandfathered file's count increases.

### The ratchet floor

At the time this gate went green, 117 pre-existing hex literals remained
in large module/widget CSS files (`bridge.css`, `lifelog.css`,
`memory.css`, `memoray_client/memoray-theme.css`,
`widgets/memoray/heatmap_radar/heatmap_radar.css`, and others) — outside
C0's allowlist and budget to retheme. These are recorded as a
grandfathered floor inline in `c0.mjs` (`VIOLATION_FLOOR`). The gate
**never allows this floor to rise**: no new offending file, no worse count
on an existing offender. Later phases (C1+, module retheming) shrink this
list by migrating each file to tokens and removing its floor entry.
