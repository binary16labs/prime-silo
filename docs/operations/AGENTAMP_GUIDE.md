# AgentAmp — Skinnable, Pluggable Agentic Cockpit

AgentAmp turns Benny's CLI and Studio surfaces into a **Winamp-style cockpit for the agentic era**. Skin packs customise every visual surface — colours, typography, motion, sound cues, CLI glyphs, and WebGL visualisers — without touching the deterministic core.

**Phases 1–6 shipped.** Phases 7–9 in progress.

Full requirements: [docs/requirements/11/requirement.md](../requirements/11/requirement.md)
Acceptance matrix: [docs/requirements/11/acceptance_matrix.md](../requirements/11/acceptance_matrix.md)

---

## Phase roadmap

| Phase | What ships | Status |
|-------|-----------|--------|
| **1** | Skin pack format, HMAC signing, scaffold + pack + sign + install CLI | ✅ SHIPPED |
| **2** | AgentVis plugin SDK, iframe sandbox, CSP enforcement | ✅ SHIPPED |
| **3** | DSP-A pipeline — 32-bin spectrum, VU meters, loop index | ✅ SHIPPED |
| **4** | Mini-mode (Textual TUI), skinnable CLI palette | ✅ SHIPPED |
| **5** | Equalizer panel — manifest knobs, PUT /agentamp/eq, ledger entries | ✅ SHIPPED |
| **6** | Playlist & enqueue, cockpit user state, import/export, layout DSL | ✅ SHIPPED |
| 7 | Effects pipeline, JSON-LD provenance per plugin invocation | 🚧 TODO |
| 8 | `skin_designer` LLM skill, local marketplace registry | 🚧 TODO |
| 9 | Release-gate hardening, compliance pillar §11 | 🚧 TODO |

---

## TL;DR — Create and install your first skin

```bash
# 1. Scaffold a new skin draft
benny agentamp scaffold-skin my-team-skin

# 2. Edit the draft
#    $BENNY_HOME/agentamp/drafts/my-team-skin/skin.manifest.json

# 3. Pack, sign, and install
benny agentamp pack   $BENNY_HOME/agentamp/drafts/my-team-skin --out my-team-skin.aamp
benny agentamp sign   my-team-skin.aamp
benny agentamp install my-team-skin.aamp --workspace default
```

The skin is now in `$BENNY_HOME/agentamp/registry/my-team-skin/`.

---

## Browser UI (Studio → AgentAmp icon)

Click the **Music2** icon (♫) in the Studio navigation rail to open the AgentAmp cockpit view. It has three panels:

| Panel | Phase | What it shows |
|-------|-------|--------------|
| **Active Skin** | 1 | Skin ID, version, signature status |
| **DSP-A Spectrum** | 3 | 32-bin static spectrum (live when SSE feed is active) |
| **AgentVis Plugin Host** | 2 | Plugin sandbox iframe placeholder |
| **Playlist** | 6 | Run history from `/api/agentamp/playlist` |
| **Equalizer** | 5 | Live knob form → PUT /api/agentamp/eq |

Requires `npm run dev` (frontend) and `benny up` (backend) to be running.

---

## Skin pack format (`.aamp`)

A `.aamp` file is a standard ZIP:

```
skin.manifest.json      ← normative root (required)
sprites/                ← PNG/SVG sprite sheets (optional)
shaders/                ← GLSL ES 3.00 fragment shaders (optional)
sounds/                 ← OGG/MP3 sound cues (optional)
plugins/                ← AgentVis / effect plugin dirs (Phase 2+)
README.md               ← human-readable notes (optional)
```

### `skin.manifest.json` fields

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `"1.0"` | Fixed at Phase 1 |
| `id` | string | Unique identifier — registry folder name |
| `tokens` | object | Design tokens: `color`, `font`, `motion`, `spacing` |
| `sprites` | array | `{ id, uri, width, height }` |
| `shaders` | array | `{ id, stage, uri }` — `stage` is `"pre"` or `"post"` |
| `sounds` | array | `{ id, uri, trigger }` — `trigger` is an SSE event name |
| `cli_palette` | object | `{ ansi: {...}, glyphs: { bullet, running, done, failed, warning, paused } }` |
| `layout` | object | `{ windows: [...], minimode: { rows, cols } }` — see Phase 6 Layout DSL |
| `plugins` | array | AgentVis plugin refs (Phase 2+) |
| `permissions` | object | `{ events, egress, audio, haptic }` — `egress: []` = deny-all |
| `signature` | object or `null` | `{ algorithm, value, signed_at }` — `null` in drafts |

### Layout window fields (Phase 6)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | — | Window identifier |
| `x`, `y` | int | 0 | Top-left corner (overridden by `snap`) |
| `w`, `h` | int | 400/300 | Width/height in pixels |
| `z` | int | 0 | Z-order |
| `snap` | string | `null` | Snap zone: `tl`, `tr`, `bl`, `br`, `c` |
| `min_w`, `min_h` | int | 0 | Minimum dimensions; clamped before snap |

Minimal example:

```jsonc
{
  "schema_version": "1.0",
  "id": "my-team-skin",
  "tokens": {
    "color": { "bg": "#0d1117", "surface": "#161b22", "accent": "#58a6ff",
               "text": "#c9d1d9", "muted": "#6e7681" },
    "font": { "family": "JetBrains Mono, monospace", "size_base": 13 },
    "motion": { "enabled": true, "reduced": false },
    "spacing": { "unit": 8 }
  },
  "layout": {
    "windows": [
      { "id": "main",     "x": 0,   "y": 0,   "w": 920, "h": 540, "snap": "tl" },
      { "id": "playlist", "x": 920, "y": 0,   "w": 320, "h": 540, "snap": "tr" }
    ],
    "minimode": { "rows": 24, "cols": 80 }
  },
  "permissions": { "events": [], "egress": [], "audio": false, "haptic": false },
  "signature": null
}
```

---

## CLI reference

### `scaffold-skin` (Phase 1)

```bash
benny agentamp scaffold-skin <skin_id> [--drafts-dir <path>]
```

Creates a deterministic draft tree under `drafts_dir/<skin_id>/`. Always emits `"signature": null`. Idempotent.

### `pack` (Phase 1)

```bash
benny agentamp pack <draft_dir> --out <path.aamp>
```

Zips the draft directory into a `.aamp` file.

### `sign` (Phase 1)

```bash
benny agentamp sign <path.aamp>
```

Computes HMAC-SHA256 and writes `signature` into `skin.manifest.json` inside the zip.

```bash
export BENNY_HMAC_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
```

### `install` (Phase 1)

```bash
benny agentamp install <path.aamp> [--workspace <ws>] [--dev-mode]
```

Checks path traversal → verifies HMAC → copies to `$BENNY_HOME/agentamp/registry/<id>/`.

Exit codes: `0` success, `1` I/O/parse error, `2` security rejection.

### `enqueue` (Phase 6)

```bash
benny agentamp enqueue <manifest.json> [--workspace <ws>] [--api-base <url>] [--api-key <key>]
```

POSTs the manifest to `POST /api/run` on the running Benny backend and returns the new `run_id`. Does no scheduling itself — dispatches via the existing run-orchestration API (AAMP-F12).

```bash
# Example
benny agentamp enqueue manifests/my-plan.json --workspace prod
# [agentamp] enqueued: run_id=run-a4f8b21c3d00
```

### `export-cockpit` (Phase 6)

```bash
benny agentamp export-cockpit <out.aamp.cockpit>
```

Bundles the current cockpit user state (active skin id, equalizer knob locks, window positions) into a portable `.aamp.cockpit` zip. Use this to move your full setup to another machine.

```bash
benny agentamp export-cockpit ~/my-cockpit.aamp.cockpit
# [agentamp] cockpit exported: ~/my-cockpit.aamp.cockpit  (4096 bytes)
# Contains: cockpit.json, eq.json, bundle.json
```

### `import-cockpit` (Phase 6)

```bash
benny agentamp import-cockpit <in.aamp.cockpit>
```

Restores cockpit user state from a `.aamp.cockpit` bundle.

```bash
benny agentamp import-cockpit ~/my-cockpit.aamp.cockpit
# [agentamp] cockpit restored from: ~/my-cockpit.aamp.cockpit
#   Active skin: finance-classic
#   Knob locks:  3 path(s)
#   Windows:     2 position(s)
```

---

## AgentVis Plugin SDK (Phase 2)

Plugins are WebGL/Three.js visualisers that run in a sandboxed iframe with no access to credentials or arbitrary network egress.

### Plugin manifest (`plugin.manifest.json`)

```jsonc
{
  "schema_version": "1.0",
  "kind": "agentvis",
  "id": "swarm-waveform",
  "name": "Swarm Waveform",
  "version": "1.0.0",
  "entry": "index.js",
  "events_subscribed": ["token", "wave_started", "wave_ended"],
  "permissions": {
    "events": ["token", "wave_started", "wave_ended"],
    "egress": [],
    "audio": false,
    "haptic": false
  },
  "signature": { "algorithm": "HMAC-SHA256", "value": "...", "signed_at": "..." }
}
```

### Sandbox security

| Attribute | Value |
|-----------|-------|
| `iframe.sandbox` | `"allow-scripts"` only — no `allow-same-origin`, `allow-forms`, etc. |
| `Content-Security-Policy` | `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; img-src data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'` |
| Network egress | `connect-src 'none'` — `fetch`, `WebSocket`, `EventSource` all blocked inside the plugin |
| Watchdog | Misbehaving plugins (infinite loop) are killed within 2 s of unresponsiveness |

### Event filtering (AAMP-F4, AAMP-SEC6)

Plugins receive DSP-A envelopes **only** for the event types declared in `permissions.events`. Attempts to subscribe to undeclared types are silently ignored — no exception crosses the iframe boundary.

---

## DSP-A Pipeline (Phase 3)

`benny.agentamp.dsp.transform(sse_stream)` is a **pure-functional, deterministic** transformer. Same input log → same envelope sequence (modulo `captured_at`).

### Envelope schema (`§4.4`)

```jsonc
{
  "kind": "aamp_event",
  "source_event": { "type": "token", "task_id": "...", "delta": "..." },
  "derived": {
    "spectrum_bin": [/* 32 floats in [0,1] */],
    "vu_left":      0.42,
    "vu_right":     0.51,
    "loop_index":   2,
    "policy_state": "approved",
    "layout_event": null          // set for layout-transition envelopes (Phase 6)
  },
  "captured_at": "ISO-8601"
}
```

### Computed fields

| Field | Algorithm |
|-------|-----------|
| `spectrum_bin` | 32-bin histogram over `ord(ch) % 32` of recent token deltas, normalised to sum ≤ 1.0 |
| `vu_left` | Fraction of recent events that are dispatcher events (`wave_started`, `task_started`) |
| `vu_right` | Fraction of recent events that are reasoner events (`wave_ended`, `task_completed`, `quality_gate_*`) |
| `loop_index` | Monotonic count of `wave_started` events seen |
| `policy_state` | Most-recently-seen policy verdict: `"approved"` or `"denied"` |
| `layout_event` | Set by `make_layout_envelope()` for layout transitions (Phase 6); `null` otherwise |

### Layout-event envelopes (Phase 6)

```python
from benny.agentamp.dsp import make_layout_envelope

env = make_layout_envelope("main", "window_moved")
# env.derived.layout_event == "window_moved"
# env.source_event == {"type": "aamp_layout", "window_id": "main", "event": "window_moved"}
```

---

## Mini-mode TUI (Phase 4)

```bash
benny --tui
```

Launches a Textual app whose palette and glyphs come from the active skin's `cli_palette`. Minimum terminal: 80×24 (`SkinMinimode.rows=24, cols=80`). The TUI hosts: run-list pane, current-wave pane, log tail pane, and a 1-line status bar.

---

## Equalizer Panel (Phase 5)

The equalizer panel reads its knob list from the skin's `eq.manifest.json` and writes through `PUT /api/agentamp/eq`. Every write:

1. Validates the knob path against the allow-list (AAMP-F9)
2. Evaluates `aamp.eq_write` policy — denial pauses for HITL (AAMP-SEC5)
3. Signs the updated manifest (AAMP-F9)
4. Records a ledger entry (AAMP-COMP1)
5. Preserves the previous signature in `previous_signatures` (AAMP-COMP2)

### Allowed knob paths

```
config.model                    config.max_concurrency
config.max_depth                config.handover_summary_limit
config.allow_swarm              config.skills_allowed
config.model_per_persona        tasks[*].assigned_model
tasks[*].complexity             tasks[*].deterministic
tasks[*].estimated_tokens
```

Task paths (`tasks[<N>|*].*`) additionally support a **per-task picker** (AAMP-F10): supply `task_ids` to the API to update only specific tasks.

**Knob locks:** toggle the lock icon to pin a knob value across runs. Lock state persists at `$BENNY_HOME/agentamp/user/eq.json`.

### REST API

```bash
curl -X PUT http://localhost:8000/api/agentamp/eq \
  -H "X-Benny-API-Key: benny-mesh-2026-auth" \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": { "schema_version": "1.0", "config": { "model": "gpt-4o", "max_concurrency": 2 }, "plan": { "tasks": [] } },
    "workspace": "default",
    "knobs": [{ "path": "config.model", "value": "claude-3-5-sonnet", "locked": false }]
  }'
```

Response includes `updated_manifest`, `new_signature`, `previous_signatures`, `ledger_seq`.

---

## Playlist & Enqueue (Phase 6)

### Browser playlist (AAMP-F11)

The **Playlist** panel in the cockpit reads `GET /api/agentamp/playlist` and renders run history as a Winamp-style track list. Each row shows:
- Status icon (✓ completed / ✗ failed / ⟳ running / ⏱ pending)
- Manifest ID and model name
- Start timestamp and duration
- Click-to-select: expands a detail panel and shows a **Load** button

### REST API

```bash
# List playlist (run history)
GET /api/agentamp/playlist?workspace=default&limit=50

# Enqueue a manifest (React UI)
POST /api/agentamp/enqueue
{ "manifest": { ... }, "workspace": "default" }
```

---

## User State & Portability (Phase 6)

### Persistent user state (AAMP-F18)

All cockpit customisation lives under `$BENNY_HOME/agentamp/user/`:

| File | Contents |
|------|----------|
| `cockpit.json` | Active skin id, knob locks, window positions |
| `eq.json` | Equalizer knob-lock state (also written by the equalizer panel) |

No absolute paths are stored — SR-1 gate enforces this.

### Import / export cockpit (AAMP-F19)

The `.aamp.cockpit` bundle is a zip containing `cockpit.json`, `eq.json`, and a `bundle.json` metadata header. Use it to transfer your full cockpit setup to another machine:

```bash
# On machine A:
benny agentamp export-cockpit ~/cockpit-backup.aamp.cockpit

# On machine B:
benny agentamp import-cockpit ~/cockpit-backup.aamp.cockpit
```

The REST API also exposes `GET/PUT /api/agentamp/user-state` for the React cockpit to persist window positions and skin selection.

---

## Layout DSL (Phase 6)

The layout DSL resolves skin-pack window declarations into concrete viewport-clamped positions.

### Snap zones (AAMP-F20)

| Zone | Position |
|------|---------|
| `tl` | Top-left (0, 0) |
| `tr` | Top-right (viewport_w − w, 0) |
| `bl` | Bottom-left (0, viewport_h − h) |
| `br` | Bottom-right (viewport_w − w, viewport_h − h) |
| `c`  | Centre ((viewport_w − w) ÷ 2, (viewport_h − h) ÷ 2) |

Snap overrides `x`/`y`. After snap, `x + w` and `y + h` are clamped to the viewport boundary. `min_w`/`min_h` are enforced before clamping.

### Layout-event envelopes (AAMP-F21)

When a window position changes (moved, resized, snapped), a DSP-A envelope is emitted so visualisers can react:

```python
from benny.agentamp.layout import layout_event_envelope
env = layout_event_envelope("main", "window_snapped")
# env.derived.layout_event == "window_snapped"
```

### REST API

```bash
POST /api/agentamp/layout/apply
{
  "windows": [
    { "id": "main",     "w": 920, "h": 540, "snap": "tl" },
    { "id": "playlist", "w": 320, "h": 540, "snap": "tr" }
  ],
  "viewport_w": 1920,
  "viewport_h": 1080
}
```

---

## HMAC key setup

All Benny processes that sign or verify must share the same key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
# → e.g. 3f8a2b1c...
export BENNY_HMAC_KEY=3f8a2b1c...
```

The same key signs `SwarmManifest` objects, checkpoints, and skin packs — one secret per environment.

---

## Security guarantees

| Threat | Mitigation |
|--------|-----------|
| Zip path traversal (`../evil.py`) | Every member name checked against `_TRAVERSAL_RE`; raises `SkinPathEscape` |
| Unsigned or tampered pack | HMAC-SHA256 checked on every `install`; no bypass in production |
| Skin calling external URLs | `permissions.egress: []` = deny-all; CSP `connect-src 'none'` inside iframes |
| Absolute paths in skin assets | SR-1 ratchet gate (`pytest tests/portability/`) catches new violations |
| Auto-signing by LLM design tool | `aamp.designer.auto_sign = false`; hard gate `GATE-AAMP-AUTOSIGN-1` |
| Plugin infinite loop | Watchdog kills misbehaving iframe within 2 s |
| Equalizer writes bypassing policy | `aamp.eq_write` intent evaluated by `PolicyEvaluator` before any mutation |

---

## Feature flags

All flags default to `false`; flip to `true` only when the phase lands.

| Flag | Default | Purpose |
|------|---------|---------|
| `aamp.enabled` | `false` | Master switch |
| `aamp.dev_mode` | **`false`** | Allow unsigned packs. **Never `true` in CI/release.** |
| `aamp.policy.auto_load_remote_skins` | **`false`** | Hard gate: never flip |
| `aamp.tui.enabled` | `false` | Mini-mode TUI (Phase 4) |
| `aamp.sandbox.csp_strict` | **`true`** | Must remain `true` at release |
| `aamp.marketplace.remote_pull_enabled` | `false` | Phase 8 |
| `aamp.lineage.enabled` | `false` | Phase 7 JSON-LD provenance |
| `aamp.designer.enabled` | `false` | Phase 8 `skin_designer` skill |
| `aamp.designer.auto_sign` | **`false`** | Hard gate: LLM drafts never auto-signed |

---

## Release gates (`G-AAMP-*`)

Enforced by `tests/release/test_aamp_release_gate.py` (Phase 9).

| Gate | Condition |
|------|-----------|
| `GATE-AAMP-AUTOSIGN-1` | `aamp.designer.auto_sign = false`; install unconditionally rejects unsigned packs |
| `GATE-AAMP-DEVMODE-1` | `aamp.dev_mode = false` at release |
| `GATE-AAMP-CSP-1` | `aamp.sandbox.csp_strict = true` at release |
| `GATE-AAMP-POLICY-1` | `aamp.policy.auto_load_remote_skins = false` at release |
| `G-AAMP-COV` | Coverage ≥ 85% on `benny/agentamp/**` and `frontend/src/agentamp/**` |
| `G-AAMP-OFF` | `BENNY_OFFLINE=1` end-to-end smoke passes |
| `G-AAMP-SR1` | SR-1 ratchet not raised by AAMP-001 |
| `G-AAMP-SIG` | All shipped reference skins verify under HMAC at boot |
| `G-AAMP-BUNDLE` | UI bundle delta ≤ 350 KB gzipped |
| `G-AAMP-LEDGER` | Every loaded skin/plugin in smoke session has a ledger entry |

---

## Offline use (`BENNY_OFFLINE=1`)

Phases 1–6 are all offline-safe:

- `scaffold-skin`, `pack`, `sign`, `install` are stdlib-only — no network calls.
- The local registry under `$BENNY_HOME/agentamp/registry/` is the only storage target.
- `export-cockpit` / `import-cockpit` read from the filesystem only.
- `enqueue` requires the local Benny backend to be running, but not the internet.
- Phase 8 remote marketplace pull is gated on `BENNY_OFFLINE=0`.

---

## Where the code lives

| Concern | Path |
|---------|------|
| Pydantic contracts | `benny/agentamp/contracts.py` |
| HMAC sign / verify | `benny/agentamp/signing.py` |
| Zip loader + path-traversal guard | `benny/agentamp/skin.py` |
| Scaffold generator | `benny/agentamp/scaffold.py` |
| CLI handlers (all subcommands) | `benny/agentamp/cli.py` |
| Plugin manifests + CSP constants | `benny/agentamp/plugins.py` |
| Plugin sandbox host | `benny/agentamp/sandbox.py` |
| DSP-A pipeline + envelope factory | `benny/agentamp/dsp.py` |
| Textual TUI | `benny/agentamp/tui.py` |
| Equalizer panel + ledger write | `benny/agentamp/equalizer.py` |
| Playlist data layer | `benny/agentamp/playlist.py` |
| User state persistence + export/import | `benny/agentamp/user_state.py` |
| Layout DSL engine | `benny/agentamp/layout.py` |
| FastAPI routes | `benny/api/agentamp_routes.py` |
| React cockpit (browser surface) | `frontend/src/agentamp/AgentAmpCockpit.tsx` |
| Equalizer panel UI | `frontend/src/agentamp/EqualizerPanel.tsx` |
| Playlist panel UI | `frontend/src/agentamp/PlaylistPanel.tsx` |
| AgentVis JS SDK | `frontend/src/agentamp/sdk/index.js` |
| Policy intent constants | `benny/governance/policy.py` (`AAMP_INTENT_*`) |
| Tests (202 passing) | `tests/agentamp/` |
| Release gates config | `docs/requirements/release_gates.yaml` |
