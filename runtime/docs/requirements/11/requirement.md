# AAMP-001 — Requirement Specification

**Document status:** Normative. Overrides any conflicting prose in this folder
or in earlier requirement folders. Every requirement below is uniquely
addressable by its ID and is verified by at least one test enumerated in
[acceptance_matrix.md](acceptance_matrix.md). Failures of any **NFR**, **SEC**,
**COMP**, or **GATE** row block release.

---

## 1. Scope

Build, **inside the existing Benny repo**, a Winamp-inspired skinnable cockpit
("AgentAmp") that:

1. Defines a portable **`.aamp` skin-pack format** (zip + signed manifest) that
   covers design tokens, sprite sheets, shader sources, optional sound cues,
   optional CLI palette, and a layout DSL.
2. Ships a **theme engine** that maps skin pack tokens onto the existing
   `frontend/src` design system without forking components.
3. Ships an **AgentVis plugin SDK** that lets third parties write
   WebGL/Three.js visualisers bound to Benny SSE event streams in a sandboxed
   iframe with no access to credentials or arbitrary network egress.
4. Ships a **DSP-A pipeline** that transforms raw SSE event streams (token,
   wave, swarm, policy, lineage) into reactive visual/audio/haptic cues. The
   pipeline is pure-functional and replayable from a recorded SSE log.
5. Ships a **skinnable Textual TUI** ("mini-mode") rendered by the CLI when
   `benny --tui` is invoked, driven by the same skin pack used by the Studio.
6. Ships an **equalizer panel** bound to a documented allow-list of
   `SwarmManifest.config` knobs (model, temperature, top-p, concurrency, time/
   iteration budget). Edits go through the existing manifest signing path.
7. Ships a **playlist view** that reads `benny runs` history and allows
   enqueueing manifests for execution. Re-uses the existing run-orchestration
   API; AgentAmp does not implement scheduling itself.
8. Ships an **effects pipeline** of optional post-processors (post-process
   shaders, sound cues, haptic hooks) declared in the skin pack's manifest
   and chained by DSP-A. Each effect is a plugin, signed and sandboxed
   identically to AgentVis.
9. Ships a **marketplace** with a **local-first registry** under
   `${BENNY_HOME}/agentamp/registry/` and an opt-in pull-only remote index,
   plus first-class **authoring tools** — a CLI scaffold, a Studio editor
   surface, and an LLM-assisted `skin_designer` skill — all of which emit
   *unsigned drafts* that an operator must review and sign before install.
   Trust is verified per-pack via skin signatures; the index never grants
   trust on its own; LLM-generated packs never auto-sign.
10. Persists user customisation under `${BENNY_HOME}/agentamp/user/` and
    supports import/export of cockpit state as a single `.aamp.cockpit`
    bundle so an operator can move their full setup across machines.
11. **Compliance & Benny framework integration (the new §11 pillar):**
    AgentAmp obeys every existing Benny standard end-to-end — signed
    manifests, governance whitelist, offline guard, SR-1 path discipline,
    `call_model()` discipline for any AI features, JSON-LD provenance for
    plugin invocations, policy-as-code intent checks, Phoenix/Marquez
    telemetry, and the 6σ release-gate set. Skins and plugins are
    **first-class governed artefacts**, not a side-channel.

**Out of scope for AAMP-001:** changing the LangGraph swarm executor,
introducing a new manifest schema (AgentAmp uses 1.1), shipping an audio
synthesiser (sounds are pre-recorded samples bundled in the skin), shipping
remote-marketplace publishing (read-only / pull-only this phase), and replacing
the React/Three.js frontend.

---

## 2. Glossary overrides

The terms in [README.md §Glossary](README.md#glossary) apply. Where this
document and the README disagree, this document wins.

---

## 3. Actors & surfaces

| Actor | Surface | Interaction |
|-------|---------|-------------|
| Operator (CLI) | `benny_cli.py` (extended) | `benny agentamp install <pack>`, `benny agentamp use <skin>`, `benny --tui`, `benny agentamp enqueue <manifest>`, `benny agentamp doctor` |
| Studio user | React app (`frontend/src` + new `frontend/src/agentamp`) | New "AgentAmp" surface: skin picker, equalizer, playlist, plugin gallery |
| Skin author | Anyone with the SDK | Authors a `.aamp` pack via `benny agentamp scaffold-skin` and signs with `benny agentamp sign` |
| Plugin author | Anyone with the SDK | Authors an AgentVis or Effect plugin against `frontend/src/agentamp/sdk/` |
| Marketplace consumer | Operator | Browses local registry; opt-in pull from remote index via `benny agentamp pull <index_url>` |
| Sandbox host | Frontend runtime | Renders plugins in a strict CSP iframe; passes only the AgentAmp SDK message port |
| Policy enforcer | `benny/governance/policy.py` (extended) | Checks `aamp.skin_load`, `aamp.plugin_invoke`, `aamp.config_write` intents before they fire |
| Lineage emitter | `benny/governance/lineage.py` (extended) | Emits a JSON-LD record per plugin invocation (model_hash N/A; persona = `aamp:plugin:<id>`) |
| Auditor | Read-only consumer | Reads `${BENNY_HOME}/agentamp/registry/` + `data_out/lineage/aamp_*.jsonld` + the AOS-001 ledger entries for skin/plugin loads |

All HTTP API calls (including the new `/agentamp/*` paths) require
`X-Benny-API-Key: benny-mesh-2026-auth` unless the path is in
`GOVERNANCE_WHITELIST`. The whitelist is **not** widened by AAMP-001.

---

## 4. Data contracts (normative)

All schemas live in `benny/agentamp/contracts.py`. Pydantic models are the
single source of truth. A test (`test_aamp_schema_ts_sync`) enforces the JSON
Schema export at `schemas/agentamp/v1.schema.json` matches the live Pydantic
models byte-for-byte.

### 4.1 Skin pack manifest (`skin.manifest.json`)

```jsonc
{
  "schema_version": "1.0",
  "id": "team-finance-compliance-classic",
  "name": "Finance Compliance Classic",
  "author": { "name": "...", "uri": "..." },
  "license": "MIT | Apache-2.0 | proprietary | ...",
  "compatibility": { "aamp_min": "1.0", "benny_min": "0.18" },

  "tokens": {                            // AAMP-F2
    "color": { "bg": "#0b1220", "fg": "#e7e9ee", "accent": "#7cf2c2", "...": "..." },
    "font":  { "family": "Inter", "mono": "JetBrains Mono", "size_base_px": 14 },
    "motion":{ "duration_ms": 180, "easing": "cubic-bezier(.2,.8,.2,1)" },
    "spacing":{ "base_px": 4 },
    "elevation": { "shadow_low": "...", "shadow_high": "..." }
  },

  "sprites": [                           // AAMP-F1: bitmap atlas
    { "id": "spectrum_bar", "uri": "sprites/spectrum.png", "frame": [0,0,8,128] }
  ],

  "shaders": [                           // AAMP-F3 / AAMP-F8
    {
      "id":   "post_glow",
      "stage":"post",                    // post | overlay | background
      "uri":  "shaders/glow.frag.glsl",
      "uniforms": { "intensity": 0.6 }
    }
  ],

  "sounds": [                            // AAMP-F8 (optional)
    { "id": "wave_advance", "uri": "sounds/click.ogg", "trigger": "wave_started" }
  ],

  "cli_palette": {                       // AAMP-F5
    "ansi": { "bg": "#0b1220", "fg": "#e7e9ee", "accent_256": 79, "...": "..." },
    "glyphs": { "bullet": "▸", "running": "◆", "done": "✓", "fail": "✗" }
  },

  "layout": {                            // AAMP-F7 (Layout DSL)
    "windows": [
      { "id": "main",       "x": 0,   "y": 0,   "w": 920, "h": 540, "snap": "tl" },
      { "id": "playlist",   "x": 920, "y": 0,   "w": 320, "h": 540, "snap": "tr" },
      { "id": "visualizer", "x": 0,   "y": 540, "w": 920, "h": 200, "snap": "bl" }
    ],
    "minimode": { "rows": 24, "cols": 80 }
  },

  "plugins": [                           // AAMP-F3 / AAMP-F8: bundled plugin refs
    { "kind": "agentvis", "id": "swarm-waveform", "version": "1.0.0", "ref": "plugins/swarm-waveform/" },
    { "kind": "effect",   "id": "haptic-on-policy-deny", "version": "1.0.0", "ref": "plugins/haptic/" }
  ],

  "permissions": {                       // AAMP-SEC2
    "events": ["token","wave_started","wave_ended","policy_denied","quality_gate_*"],
    "egress": [],                        // empty = no network
    "audio":  true,
    "haptic": false
  },

  "signature": {                         // AAMP-F1 / AAMP-COMP1
    "algorithm": "HMAC-SHA256",
    "value":     "base64(...)",
    "signed_at": "ISO-8601 UTC"
  }
}
```

Invariants (`benny.agentamp.contracts.validate_skin_manifest`):

- `id` MUST be `^[a-z0-9][a-z0-9-]{2,63}$` (DNS-safe).
- All `uri` fields MUST be relative paths inside the pack — absolute paths
  fail validation (SR-1 alignment).
- `permissions.egress` defaults to `[]`. A non-empty value MUST list bare
  hostnames; wildcards are rejected.
- `signature.value` MUST verify against the canonical bytes of every other
  field with the same key path used by `sign_manifest()`.

### 4.2 AgentVis plugin manifest (`plugin.manifest.json`)

```jsonc
{
  "schema_version": "1.0",
  "kind": "agentvis | effect",
  "id":   "swarm-waveform",
  "name": "Swarm Waveform",
  "version": "1.0.0",
  "entry": "index.js",                   // ES module; loaded into sandbox iframe
  "events_subscribed": ["token","wave_started","wave_ended"],   // AAMP-F4
  "events_emitted":    [],               // plugins do not synthesise SSE
  "renders": "canvas | dom | audio | haptic",
  "sdk_min": "1.0",
  "permissions": {                       // AAMP-SEC2 (must be a subset of skin perms)
    "events": ["token","wave_started","wave_ended"],
    "egress": [],
    "audio":  false,
    "haptic": false
  },
  "signature": { "algorithm": "HMAC-SHA256", "value": "...", "signed_at": "..." }
}
```

Invariants:

- A plugin's `permissions` MUST be a subset of its host skin's `permissions`
  (intersection, not union). Verified pre-mount.
- A plugin runs in an iframe with `sandbox="allow-scripts"` only; no
  `allow-same-origin`, no `allow-top-navigation`, no `allow-forms`.
- A plugin receives events only via `postMessage` from the AgentAmp SDK
  bootstrapper. It cannot reach `window.parent.location`, `fetch`, or
  `WebSocket` directly. CSP blocks any attempt.

### 4.3 Equalizer binding (`eq.manifest.json` — bundled in skin pack)

```jsonc
{
  "knobs": [
    { "id": "temperature",       "path": "config.model_kwargs.temperature", "min": 0, "max": 2,  "step": 0.05, "default": 0.2 },
    { "id": "top_p",             "path": "config.model_kwargs.top_p",       "min": 0, "max": 1,  "step": 0.01 },
    { "id": "concurrency",       "path": "config.swarm_max_concurrency",    "min": 1, "max": 16, "step": 1 },
    { "id": "iteration_budget",  "path": "tasks[*].iteration_budget",       "min": 1, "max": 10, "step": 1 },
    { "id": "time_budget_s",     "path": "tasks[*].time_budget_seconds",    "min": 30,"max": 1800,"step": 30 }
  ]
}
```

Invariants:

- Every `path` MUST resolve against the live `SwarmManifest` (1.1) Pydantic
  model. Unknown paths fail load.
- Edits write to a **draft** manifest, then sign-and-replace via
  `sign_manifest()`. The pre-edit signature is preserved in
  `runs[].previous_signatures` for audit (AAMP-COMP2).

### 4.4 DSP-A event envelope

```jsonc
{
  "kind": "aamp_event",
  "source_event": { "type": "token", "task_id": "...", "delta": "..." },
  "derived": {
    "spectrum_bin": [/* 32 floats in [0,1] */],
    "vu_left":      0.42,
    "vu_right":     0.51,
    "loop_index":   2,
    "policy_state": "approved"
  },
  "captured_at": "ISO-8601"
}
```

DSP-A is a **pure transform** over the SSE stream. Given the same input
stream, it emits the same envelopes (deterministic; no wall-clock reads
inside the transform — the timestamp is taken once at envelope construction
and excluded from determinism tests).

### 4.5 `skin_designer` skill I/O contract

Used by `AAMP-F34`. The skill is registered alongside `requirements_analyst`
and `bdd_reviewer`; it is **advisory and side-effect-free** relative to the
registry — the same sandbox-vs-deterministic-core boundary the pypes
sandbox layer obeys (per [CLAUDE.md](../../../CLAUDE.md) and
[docs/operations/PYPES_TRANSFORMATION_GUIDE.md](../../operations/PYPES_TRANSFORMATION_GUIDE.md)).

**Input envelope** (matches the existing skill registry input shape):

```jsonc
{
  "skill": "skin_designer",
  "inputs": {
    "vibe":        "auditor-grade, motion off, high contrast, neon accent only on policy_denied",
    "moodboard":   [ "artifact://${sha256}", "..." ],   // optional images via PBR refs
    "constraints": {
      "license":          "MIT | Apache-2.0 | proprietary",
      "audio_default":    "off | on",
      "motion_budget_ms": 180,
      "ada_contrast_min": 4.5,
      "bundle_kb_max":    512
    },
    "id":          "team-finance-compliance-classic",   // pre-validated DNS-safe
    "workspace":   "..."
  }
}
```

**Output**: a directory tree under
`${BENNY_HOME}/agentamp/drafts/${id}/` containing every file required by
§4.1 *except* `signature` (which is left absent and noted in
`skin.manifest.json` as `"signature": null`). The skill returns a
structured summary:

```jsonc
{
  "draft_id":   "team-finance-compliance-classic",
  "draft_path": "${BENNY_HOME}/agentamp/drafts/team-finance-compliance-classic/",
  "files":      [ "skin.manifest.json", "tokens.json", "sprites/spectrum.png", "..." ],
  "signature":  null,
  "next_steps": [
    "benny agentamp pack ${draft_path}",
    "benny agentamp sign ${draft_path}.aamp",
    "benny agentamp install ${draft_path}.aamp"
  ],
  "warnings":   [ "ADA contrast 4.3 < 4.5 on accent-on-bg; review tokens.color.accent" ]
}
```

Invariants (`benny.agentamp.designer.run`):

- The skill MUST route every model call through
  `benny.core.models.call_model()` (no direct provider SDKs).
- The skill MUST NOT call `agentamp.sign()` and MUST NOT write into
  `${BENNY_HOME}/agentamp/registry/`. Drafts land under
  `${BENNY_HOME}/agentamp/drafts/` only.
- The skill's `next_steps` array MUST be non-empty and MUST list at least
  the three `pack → sign → install` steps above. Verified by
  `test_aamp_f34_next_steps_complete`.
- `BENNY_OFFLINE=1` MUST work end-to-end against a local model.
- The draft tree's `skin.manifest.json` MUST set `"signature": null`. A
  non-null signature emitted by the skill fails review (`SkinSignatureForged`).

---

## 5. Functional requirements

Each requirement has the form `AAMP-F{N}` and is covered by at least one test
of the form `test_aamp_f{n}_*` in
[acceptance_matrix.md](acceptance_matrix.md).

### 5.1 Skin pack format (the new `.wsz`)

- **AAMP-F1** — `benny.agentamp.skin.load(path)` parses a `.aamp` zip,
  validates `skin.manifest.json` against `schemas/agentamp/v1.schema.json`,
  verifies the HMAC signature, and returns a frozen `SkinPack` model. Loading
  an unsigned pack fails unless `aamp.dev_mode=true`.
- **AAMP-F2** — `benny.agentamp.theme.apply(skin)` materialises the skin's
  design tokens as CSS custom properties on `:root` (frontend) and as a
  `Theme` Pydantic instance (Python). Applying a new skin MUST NOT remount
  React components — the Studio updates via CSS variable replacement only.

### 5.2 AgentVis plugin SDK

- **AAMP-F3** — `frontend/src/agentamp/sdk/` exports
  `mount(plugin, hostElement, eventStream)`. The SDK creates the sandbox
  iframe with the CSP described in §8, registers the plugin's
  subscribed-events with DSP-A, and tears down cleanly on unmount.
- **AAMP-F4** — A plugin receives events as DSP-A envelopes (§4.4) only for
  the event types it declared in `permissions.events`. Attempts to subscribe
  to undeclared types are silently ignored (no exception leak across the
  iframe boundary).

### 5.3 DSP-A pipeline

- **AAMP-F5** — `benny.agentamp.dsp.transform(sse_stream) -> Iterator[Envelope]`
  is pure-functional. Given a recorded SSE log, it produces a deterministic
  envelope sequence (verified by replay test, modulo `captured_at`).
- **AAMP-F6** — DSP-A computes a 32-bin spectrum from the rolling token
  throughput windowed at 250 ms; a left/right VU pair from the dispatcher /
  reasoner activity ratio; and a loop-index counter from
  `iteration_budget`-bearing tasks.

### 5.4 Skinnable Textual TUI ("mini-mode")

- **AAMP-F7** — `benny --tui` launches a Textual app whose palette and
  glyphs come from the active skin's `cli_palette`. The TUI hosts: run-list
  pane, current-wave pane, log tail pane, and a 1-line status bar.
- **AAMP-F8** — Mini-mode renders within an 80×24 terminal as the floor.
  Larger terminals get a richer layout; smaller terminals fall back to a
  no-graphic line-mode (verified by `test_aamp_f8_minimode_size_floor`).

### 5.5 Equalizer panel

- **AAMP-F9** — The equalizer panel reads `eq.manifest.json` from the active
  skin, materialises a form bound to the listed paths, and writes through
  `/agentamp/eq` (PUT). The endpoint validates the path is allow-listed,
  produces a draft manifest, signs it, and persists.
- **AAMP-F10** — Editing a knob of type `tasks[*].*` opens a per-task picker;
  applying the value updates only the selected tasks. A "lock" affordance
  pins a knob across runs (state in `${BENNY_HOME}/agentamp/user/eq.json`).

### 5.6 Playlist & enqueue

- **AAMP-F11** — The playlist view reads `benny runs ls` (existing API) and
  renders run history with status, duration, model, cost. Click-to-load
  populates the manifest editor.
- **AAMP-F12** — `benny agentamp enqueue <manifest>` adds a manifest to the
  pending queue and dispatches via the existing `/runs` endpoint. AgentAmp
  itself does no scheduling.

### 5.7 Effects pipeline

- **AAMP-F13** — `benny.agentamp.dsp.effects.chain(envelopes, effects)`
  applies the skin's declared effect plugins in order. Each effect is
  optional; a missing or denied effect is skipped with a warning event.
- **AAMP-F14** — A post-process shader effect reads the previous frame's
  texture and the current envelope's `spectrum_bin` array. Shaders run on a
  shared WebGL2 context owned by AgentAmp; plugins do not own the GL state.

### 5.8 Marketplace

- **AAMP-F15** — The local registry under
  `${BENNY_HOME}/agentamp/registry/` indexes installed packs by id+version.
  `benny agentamp install <pack>` validates and links the pack into the
  registry; `benny agentamp use <id>` activates it.
- **AAMP-F16** — `benny agentamp pull <index_url>` fetches a curated
  catalogue of pack metadata only (no bytes). The operator must explicitly
  `install` each pack. Remote indexes are never auto-trusted; trust is per
  pack, per signature.
- **AAMP-F17** — `benny agentamp doctor` reports: skin signature status,
  plugin signature status, sandbox iframe CSP correctness, registry path
  resolution under `${BENNY_HOME}`, last marketplace pull timestamp, and
  any pack with an unresolved permission upgrade.

### 5.9 Cockpit persistence & portability

- **AAMP-F18** — User customisation (active skin id, knob locks, window
  positions) persists under `${BENNY_HOME}/agentamp/user/`. No absolute
  paths.
- **AAMP-F19** — `benny agentamp export-cockpit <out.aamp.cockpit>` writes
  a single zip containing the active skin pack, plugin set, equalizer
  state, and layout. `import-cockpit` restores it on a different host.

### 5.10 Layout DSL

- **AAMP-F20** — The layout DSL supports absolute coords, snap zones (`tl`,
  `tr`, `bl`, `br`, `c`), and minimum sizes. Out-of-bounds placements clamp
  to the viewport.
- **AAMP-F21** — Layout transitions are CSS-animated; window state changes
  emit DSP-A envelopes (`derived.layout_event`) so visualisers can react.

### 5.11 Compliance & Benny framework integration *(new pillar)*

This is the pillar requested in the brief: "compliant and uses our very high
standards and integration into the benny framework". Every clause below is
release-gated.

- **AAMP-F22** — Every `.aamp` skin pack and plugin manifest is signed via
  `benny.core.manifest.sign_manifest()`'s underlying HMAC helper (shared
  key path). Loading an unsigned pack outside `aamp.dev_mode=true` fails
  with `SkinSignatureMissing`. Verified on every load, not just install.
- **AAMP-F23** — All AgentAmp HTTP routes (`/agentamp/*`) require
  `X-Benny-API-Key`. The `GOVERNANCE_WHITELIST` is **not** widened.
- **AAMP-F24** — AgentAmp respects `BENNY_OFFLINE=1` end-to-end: default
  skins, default visualizers, default DSP-A pipeline, and the local
  registry MUST work air-gapped. Any remote-index pull is gated on
  `BENNY_OFFLINE=0` and refuses with `OfflineRefusal` otherwise.
- **AAMP-F25** — Any AI-driven feature in AgentAmp (e.g., a "describe my
  skin in natural language" flow, a "suggest equalizer settings" flow)
  routes exclusively through `benny.core.models.call_model()`. Direct
  `litellm` or provider-SDK calls fail review.
- **AAMP-F26** — Skin loads, plugin invocations, and equalizer writes pass
  through `benny.governance.policy.evaluate(intent, persona, manifest)`
  before they take effect. New intents: `aamp.skin_load`,
  `aamp.plugin_invoke`, `aamp.config_write`. Denial paths emit
  `policy_denied` SSE events as today.
- **AAMP-F27** — Each plugin invocation emits a JSON-LD provenance record
  per the AOS-001 envelope (§4.4 of `requirement.md` in `10/`) with
  `persona = "urn:benny:agent:aamp:plugin:<id>"`, `model = null`, and
  `prov:used` set to the consumed event types. Records land at
  `data_out/lineage/aamp_${run_id}_${plugin_id}.jsonld`.
- **AAMP-F28** — Skin and plugin signatures are recorded as ledger entries
  on the AOS-001 Git ledger branch `benny/checkpoints/v1` at install time.
  Any subsequent rewind is detected by `benny doctor --audit` and reported
  as `ledger_rewind_detected` (no new ledger; reuse the existing one).
- **AAMP-F29** — All skin pack `uri` fields, registry paths, and user-state
  paths resolve under `${BENNY_HOME}`. SR-1 ratchet (≤ 408 violations)
  MUST NOT increase.
- **AAMP-F30** — AgentAmp emits Phoenix spans with attributes
  `aamp.skin_id`, `aamp.plugin_id`, `aamp.event_type`, `aamp.policy_decision`.
  Span emission overhead is bounded by AAMP-NFR9.
- **AAMP-F31** — `benny doctor --json` gains an `aamp` section reporting:
  active skin id + signature status, loaded plugin count + signature
  statuses, sandbox CSP correctness, registry path resolution, last
  remote-index pull, offline-guard state for AgentAmp routes.
- **AAMP-F32** — AgentAmp ships behind feature flags (`aamp.*`, all default
  `false`) so existing Studio and CLI surfaces are never regressed. The
  flag set is enumerated in §7.

### 5.12 Skin authoring surfaces

These three requirements together define the supported authoring path for
third-party skins. They reuse the manifest signing primitives from
AOS-001 (Phase 10) and the sandbox-layer pattern from pypes (Phase 9).

- **AAMP-F33** — `benny agentamp scaffold-skin <id>` generates a working
  draft tree under `${BENNY_HOME}/agentamp/drafts/<id>/` with stub
  `skin.manifest.json` (`signature: null`), example design tokens, a
  sample sprite atlas, a sample fragment shader, and an
  `eq.manifest.json` listing the documented knob set. The CLI also writes
  a `next_steps.md` describing the `pack → sign → install` handoff. The
  scaffold is deterministic: same `<id>` + same Benny version produces a
  byte-identical draft tree (verified by `test_aamp_f33_scaffold_deterministic`).
- **AAMP-F34** — `benny agentamp design "<vibe>"` invokes the
  `skin_designer` skill per §4.5. The output is an *unsigned* draft tree
  identical in shape to the scaffold's output. The skill is advisory and
  side-effect-free relative to the registry: it MUST NOT install, sign,
  or activate. Honors `BENNY_OFFLINE=1` against a local model. Optional
  moodboard images are passed by PBR reference (per AOS-F5/F6) so they
  never traverse the LLM context as raw bytes.
- **AAMP-F35** — Sign-handoff is mandatory. `benny agentamp install <pack>`
  rejects any pack whose `signature` field is null or fails HMAC
  verification, raising `SkinSignatureMissing` or `SkinSignatureInvalid`.
  No CLI flag, environment variable, or feature flag bypasses this check.
  Auto-signing of LLM-generated drafts is a hard release-gate trip-wire
  (`GATE-AAMP-AUTOSIGN-1`).

---

## 6. Non-functional targets

Reference device: Ryzen AI 9 HX 370, 32 GB RAM, integrated Radeon 890M,
Windows 11, Python 3.11, Chrome 134. NFRs are budget-checked by
`tests/release/test_aamp_release_gate.py`.

| ID | Target | Measurement |
|----|--------|-------------|
| AAMP-NFR1 | Cold-start skin apply ≤ **120 ms** p95 (no React remount). | `tests/agentamp/test_skin_apply_perf.py` |
| AAMP-NFR2 | Switching skins emits **0** unstyled-flash frames over 60 fps capture. | `tests/agentamp/test_skin_switch_no_flash.py` |
| AAMP-NFR3 | DSP-A throughput ≥ **5 000 events/sec** on the reference device. | `tests/agentamp/test_dsp_throughput.py` |
| AAMP-NFR4 | DSP-A replay determinism: same input log → byte-identical envelopes (modulo `captured_at`). | `tests/agentamp/test_dsp_determinism.py` |
| AAMP-NFR5 | A signed `.aamp` pack of ≤ 5 MB installs in ≤ **400 ms** p95. | `tests/agentamp/test_install_perf.py` |
| AAMP-NFR6 | Mini-mode (TUI) renders the first frame in ≤ **300 ms** p95 from cold cache. | `tests/agentamp/test_tui_first_paint.py` |
| AAMP-NFR7 | Coverage ≥ **85 %** on `benny/agentamp/**` and `frontend/src/agentamp/**`. | `tests/release/test_aamp_release_gate.py::coverage` |
| AAMP-NFR8 | SR-1 ratchet not raised. No new absolute paths. | existing `tests/portability/test_no_absolute_paths.py` |
| AAMP-NFR9 | Phoenix span emission overhead ≤ **3 ms** p95 per AgentAmp event. | `tests/agentamp/test_telemetry_overhead.py` |
| AAMP-NFR10 | `BENNY_OFFLINE=1` runs default skin + default visualizers + DSP-A end-to-end. | `tests/agentamp/test_offline_e2e.py` |
| AAMP-NFR11 | Bundle-size delta on the existing UI ≤ **350 KB gzipped** (theme engine + sandbox host; plugin code is lazy-loaded). | `tests/release/test_aamp_release_gate.py::bundle_delta` |
| AAMP-NFR12 | A misbehaving plugin (infinite loop) cannot stall the host; the iframe is killed within ≤ **2 s** of unresponsiveness. | `tests/agentamp/test_plugin_watchdog.py` |

---

## 7. Feature flags & configuration

All flags live in `benny/core/config.py` (extended). Defaults below.

| Flag | Default | Purpose |
|------|---------|---------|
| `aamp.enabled` | `false` until Phase 1 lands; `true` after | Master switch for AgentAmp surfaces. |
| `aamp.dev_mode` | `false` | Allows loading unsigned packs. **MUST remain `false`** in CI / release. |
| `aamp.policy.auto_load_remote_skins` | `false` | **MUST remain `false`**; hard gate (`GATE-AAMP-POLICY-1`). |
| `aamp.tui.enabled` | `false` until Phase 4 lands | Mini-mode TUI. |
| `aamp.dsp.spectrum_bins` | `32` | DSP-A spectrum resolution. Allowed: 16, 32, 64. |
| `aamp.sandbox.csp_strict` | `true` | Strict CSP for plugin iframes. **MUST remain `true`**. |
| `aamp.marketplace.remote_pull_enabled` | `false` until Phase 8 lands | Opt-in remote index pull. |
| `aamp.lineage.enabled` | `false` until Phase 7 lands | JSON-LD provenance for plugin invocations. |
| `aamp.designer.enabled` | `false` until Phase 8 lands | `skin_designer` skill (`benny agentamp design "<vibe>"`). |
| `aamp.designer.auto_sign` | `false` | **MUST remain `false`**; hard gate (`GATE-AAMP-AUTOSIGN-1`). LLM-generated drafts are never auto-signed. |

Flipping `aamp.policy.auto_load_remote_skins`, `aamp.dev_mode`,
`aamp.sandbox.csp_strict`, or `aamp.designer.auto_sign` to a non-default
value at the release gate is a hard block — see
[acceptance_matrix.md](acceptance_matrix.md) IDs `GATE-AAMP-POLICY-1`,
`GATE-AAMP-DEVMODE-1`, `GATE-AAMP-CSP-1`, `GATE-AAMP-AUTOSIGN-1`.

---

## 8. Security & privacy

- **AAMP-SEC1** — Plugin iframes are mounted with
  `sandbox="allow-scripts"` only. No `allow-same-origin`,
  `allow-top-navigation`, `allow-forms`, `allow-popups`,
  `allow-pointer-lock`. Verified by DOM snapshot.
- **AAMP-SEC2** — CSP for plugin iframes:
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; img-src data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'`.
  `connect-src 'none'` denies `fetch` / `WebSocket` / `EventSource` from
  inside the plugin. Plugin permission upgrades MUST update CSP via
  `connect-src` allow-list with explicit hostnames; wildcards rejected.
- **AAMP-SEC3** — `.aamp` zip extraction is path-traversal-safe: each
  member's normalised path MUST start with the pack's extraction root.
  `..` sequences fail extraction with `SkinPathEscape`.
- **AAMP-SEC4** — Skin and plugin signatures use the same HMAC-SHA256 key
  path as `sign_manifest()`. Key rotation is an operational concern shared
  with manifests; no new key store.
- **AAMP-SEC5** — Equalizer writes go through policy.evaluate; an
  `aamp.config_write` denial pauses for HITL.
- **AAMP-SEC6** — Plugins receive **only the events they declared**. A
  declared-but-not-permitted event (e.g., declared `policy_denied` but
  skin's `permissions.events` excluded it) is filtered out by the SDK
  bootstrapper before reaching the iframe.
- **AAMP-SEC7** — `benny agentamp doctor` reports CSP correctness,
  signature status of every loaded asset, and any drift between a pack's
  declared `permissions` and the host's actual sandbox configuration.

---

## 9. Compliance — integration with AOS-001 governance

AgentAmp does **not** introduce a new compliance regime. It re-uses the
SOX 404 and BCBS 239 instruments delivered in Phase 10 (AOS-001) and
extends them to skin/plugin artefacts.

- **AAMP-COMP1** *(SOX 404 — control over UI-mediated state changes)* —
  Every equalizer write is recorded on the AOS-001 ledger branch
  `benny/checkpoints/v1` with: prompt-equivalent (UI action descriptor),
  diff hash, prior ledger hash, persona (`aamp:user`), timestamp.
- **AAMP-COMP2** *(Manifest signature continuity)* — On any equalizer
  write, the previous manifest signature is preserved in
  `runs[].previous_signatures` so an auditor can reconstruct the manifest
  state immediately before AgentAmp made an edit.
- **AAMP-COMP3** *(BCBS 239 P3 — Accuracy)* — Plugin invocations emit
  JSON-LD provenance (§4 of AOS-001) so an auditor can trace which plugins
  rendered which derivations of the SSE stream during a run.
- **AAMP-COMP4** *(BCBS 239 P4 — Completeness)* — `benny doctor --audit`
  verifies that every loaded skin/plugin in the active session has a
  ledger entry. Missing entries fail the audit.
- **AAMP-COMP5** *(Replay)* — Re-running a recorded SSE log through DSP-A
  with the same skin/plugin signatures MUST produce byte-identical
  envelopes (per AAMP-NFR4). This is the AgentAmp analogue of AOS-COMP5.

---

## 10. Observability

- **AAMP-OBS1** — `benny doctor --json` gains an `aamp` section per
  AAMP-F31.
- **AAMP-OBS2** — Structured logs from `benny/agentamp/**` and the React
  surface carry `component="aamp"` and follow the existing LLM-log schema
  (Phase 6).
- **AAMP-OBS3** — SSE events extended with: `aamp_skin_loaded`,
  `aamp_plugin_mounted`, `aamp_plugin_unmounted`, `aamp_eq_write`,
  `aamp_policy_denied`. Schemas live in `benny/core/event_bus.py`.
- **AAMP-OBS4** — Phoenix spans extended per AAMP-F30. No new endpoint.

---

## 11. Rollback

Every phase ships behind its `aamp.*` flag, default `false`. Rolling back
a phase = reverting its merge commit; no schema migration is destructive.
The four irreversible-on-merge surfaces and how to undo each are:

| Surface | Undo |
|---------|------|
| `/agentamp/*` HTTP routes | Behind `aamp.enabled`. Flip false to disable. |
| Ledger entries for skin/plugin loads | Branch is append-only; orphaning has no effect. |
| `runs[].previous_signatures` field | Optional field; consumers tolerate absence. |
| Equalizer writes | Each write is a signed manifest revision; revert by re-signing the prior revision. |

---

## 12. Open questions

- **OQ-1** — Should AgentAmp ship a curated remote index (we host) or
  delegate entirely to community indexes (operators add their own URLs)?
- **OQ-2** — Should plugin code be allowed to import a small allow-listed
  subset of npm (e.g., `three`), or must plugins ship every byte they use?
- **OQ-3** — Does mini-mode (TUI) need a `notebook`-style cell history, or
  is the run-list pane sufficient for the v1 surface?
- **OQ-4** — Should sound cues default `on` or `off` for the reference
  skin? (Accessibility / focus considerations.)
- **OQ-5** — How do we expose a "screenshot/share my cockpit" flow without
  leaking workspace contents through the captured image?

An agent encountering OQ-6+ MUST pause and raise a HITL request; it MUST
NOT invent an answer.

---

## 13. References

- [docs/requirements/10/requirement.md](../10/requirement.md) — AOS-001,
  whose signing, policy, and provenance primitives AgentAmp re-uses.
- [docs/requirements/10/README.md](../10/README.md) — six-sigma framing
  this folder mirrors.
- [docs/operations/PYPES_TRANSFORMATION_GUIDE.md](../../operations/PYPES_TRANSFORMATION_GUIDE.md)
  — sandbox-vs-deterministic-core boundary AgentAmp also obeys.
- [architecture/SAD.md](../../../architecture/SAD.md) — current Benny
  architecture; AgentAmp adds the cockpit layer above the existing
  Studio + CLI.
- Frankel, Justin et al. *Winamp 2.95 Skin Format Documentation*
  (Nullsoft, 1998) — the cultural source.
- W3C *Content Security Policy Level 3* — CSP grammar used in §8.
- W3C PROV-O *The PROV Ontology* — provenance envelope (via AOS-001).
