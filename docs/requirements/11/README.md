# AAMP-001 — AgentAmp: A Skinnable, Pluggable Agentic Cockpit

**Phase:** 11 (succeeds Phase 10 / AOS-001)
**Status:** DRAFT — pending OQ resolutions in [requirement.md §13](requirement.md#13-open-questions)
**Author:** Benny Studio team
**Last updated:** 2026-04-28

---

## Purpose

AgentAmp turns Benny's two operator surfaces — the **CLI** (`benny_cli.py`) and the **React/Three.js Studio** (`frontend/src`) — into a Winamp-style cockpit for the agentic era. The driving thesis: the most beloved late-90s desktop UX was **deeply skinnable**, **plugin-extensible**, **audio-reactive**, and **portable as a single file**. That UX shape maps almost 1:1 onto what an agent operator wants today — except the "audio" being visualised is **token streams, swarm activity, model selection, and SSE telemetry**, not WAV samples.

AgentAmp is **integration work**, not a rewrite. Every existing surface is extended through additive theme/plugin hooks; nothing in the deterministic core (manifest schema, swarm executor, governance) changes shape.

The metaphor:

| Winamp 2.95 (1998) | AgentAmp (2026) |
|---|---|
| `.wsz` skin file (zip of bitmaps + `viscolor.txt`) | `.aamp` skin pack (zip of design tokens, sprites, shaders, sounds, manifest) |
| Spectrum analyser / oscilloscope | Token-throughput spectrum, swarm waveform, VRAM/loop heatmap |
| Milkdrop / AVS visualiser plugins | WebGL/Three.js **AgentVis** plugins driven by SSE event streams |
| Equalizer sliders | Manifest-knob panel: temperature, top-p, concurrency, time/iter budgets |
| Playlist Editor | Manifest queue + wave/task list + run history (read from `benny runs`) |
| DSP plugins | **Effects pipeline:** post-process shaders, reactive sound cues, haptic hooks |
| Mini-window mode | **Skinnable Textual TUI** for the CLI (Rich-based, theme-driven) |
| Modern Skins (XML) | Layout DSL: declarative JSON layout for window arrangement |
| `winamp.exe -enqueue` | `benny agentamp enqueue <manifest>` |

---

## Why "AgentAmp" and not just "themes"

A naïve theme system gives you light/dark and a few colour swaps. AgentAmp is intentionally bigger because the agentic era needs:

1. **Cultural legibility.** Operators reading 6 SSE streams, 12 LLM logs, and 3 swarm waves at once need *fast pre-attentive cues*: peripheral colour shifts, motion, sound. Text alone is saturating us. This is exactly the problem Winamp's spectrum/oscilloscope solved for music.
2. **Personalisation without forking.** Every team has a different "house style" — finance compliance teams want auditor-grade chrome; research teams want playful neon. A signed skin pack lets each team ship their identity without forking the frontend.
3. **Plugin economy.** A skin/visualizer SDK, with cryptographic signing and the same governance gates as manifests, lets a community ship `AgentVis` plugins without ever touching `benny/`.
4. **Portability.** Skin packs travel with `$BENNY_HOME`. Plug your USB stick into a different machine and your cockpit looks the same. This is a hard requirement for Benny's portable-first ethos.
5. **Tutorials & demos.** A "Demo" theme is the new screenshot — it's how Benny wins meetings.

---

## Document set

| Document | Role |
|----------|------|
| [README.md](README.md) | This index. Vocabulary, ground rules, do-not list. |
| [requirement.md](requirement.md) | **Normative.** Functional, non-functional, security, observability, and compliance requirements. Every claim is uniquely addressable. |
| [acceptance_matrix.md](acceptance_matrix.md) | Traceability matrix: every requirement ID → at least one test → status → evidence. |

`project_plan.md`, `open_questions.md`, and `source_brief.md` will be added when Phase 11 opens for execution; the `10/` folder is the template.

---

## Glossary

| Term | Definition |
|------|------------|
| **AgentAmp** | The skinnable, pluggable cockpit layer that wraps both the CLI and Studio surfaces. Module roots: `benny/agentamp/` (Python), `frontend/src/agentamp/` (React). |
| **Skin pack** | A `.aamp` file (zip) containing design tokens, sprite sheets, shader sources, optional sound cues, optional CLI palette, and a signed `skin.manifest.json`. |
| **AgentVis** | A WebGL/Three.js visualiser plugin bound to one or more SSE event streams (`token`, `wave_started`, `policy_denied`, etc.). |
| **DSP-A** | "Digital Stream Processor — Agentic". The post-processing pipeline that transforms raw SSE events into visual/audio/haptic cues. |
| **Layout DSL** | Declarative JSON describing window placement, snap behaviour, and minimisation rules — the modern equivalent of Winamp's Modern Skins XML. |
| **Mini-mode** | The skinnable Textual TUI rendered in a single 80×24 terminal pane. |
| **Equalizer panel** | A skinnable form bound to a subset of `SwarmManifest.config` knobs; changes write to the live manifest before the next wave dispatches. |
| **Effects pipeline** | DSP-A's chain of optional post-processors: shaders, sound cues, haptics. Each effect is a plugin. |
| **Skin signature** | HMAC-SHA256 over the skin pack's canonical bytes using the same key path Benny already uses in `sign_manifest()`. |
| **Marketplace** | The local registry under `${BENNY_HOME}/agentamp/registry/` plus an optional curated remote index. The remote index is pull-only; trust is verified per-pack. |

Vocabulary collisions between this folder and earlier requirement folders are resolved in this document's favour.

---

## Six-Sigma framing

AgentAmp lives close to the user surface but reaches deep into governance (signed packs, sandboxed plugins, policy-checked DOM access). We carry over the DPMO discipline established in Phases 8–10:

1. **Define** — every requirement has a unique ID and a one-sentence success criterion ([requirement.md](requirement.md)).
2. **Measure** — every requirement has at least one test in [acceptance_matrix.md](acceptance_matrix.md) and a numeric or boolean target.
3. **Analyse** — failure modes for skins, plugins, and effect chains are enumerated and ranked.
4. **Improve** — phases retire highest-RPN risks first (signing & sandboxing precede marketplace).
5. **Control** — release gates `G-AAMP-*` are appended to `docs/requirements/release_gates.yaml` and enforced by `tests/release/test_aamp_release_gate.py`.

A phase is **not done** until every acceptance row for that phase is `PASS` with a non-empty `Evidence` pointer **and** the relevant gate test is green on `master`.

---

## Do-not-do list (binding for any implementer agent or human)

1. **Do not** allow a skin pack or plugin to issue network calls outside `policy.allowed_egress`. Plugins run in a sandbox iframe (frontend) or restricted subprocess (CLI); both deny egress by default.
2. **Do not** load an unsigned `.aamp` pack outside `aamp.dev_mode=true`. Production loads HMAC-verify before unzip.
3. **Do not** allow plugin code to import or `require` anything from `benny.*` or `frontend/src/*`. Plugins consume the AgentAmp SDK only.
4. **Do not** call `litellm` or any provider SDK from a plugin. Plugins never see model credentials. (Honors the same rule that binds Benny core to `call_model()`.)
5. **Do not** introduce new absolute paths in skin packs, plugin metadata, fixtures, or tests. The SR-1 ratchet is a hard gate.
6. **Do not** widen `GOVERNANCE_WHITELIST`. The new `/agentamp/*` endpoints require `X-Benny-API-Key` like every other route.
7. **Do not** mutate run audit data, manifest signatures, or ledger state from a skin pack or plugin. The deterministic core remains byte-replay-identical regardless of which skin is active.
8. **Do not** check in `.aamp` packs to the repo unless they are reference fixtures under `tests/agentamp/fixtures/`.
9. **Do not** flip `aamp.policy.auto_load_remote_skins` to `true`. It is reserved as a hard release-gate trip-wire (see [acceptance_matrix.md](acceptance_matrix.md) `GATE-AAMP-POLICY-1`).
10. **Do not** bundle phases. One phase per PR; the plan tracker only ticks after the gate is green.
11. **Do not** ship a feature that breaks `BENNY_OFFLINE=1`. Default skins, default visualizers, and the marketplace's local registry MUST work air-gapped. (This is the §11 compliance pillar — see `requirement.md` §5.11 and §9.)

---

## Quick links into the codebase (where new work lands)

| Concern | Module path | Touch type |
|---------|-------------|------------|
| Skin pack format & loader | `benny/agentamp/skin.py` (new), `benny/agentamp/registry.py` (new) | new |
| AgentVis plugin SDK (Python side) | `benny/agentamp/plugins.py` (new) | new |
| AgentVis plugin SDK (frontend) | `frontend/src/agentamp/sdk/` (new) | new |
| DSP-A / SSE event shaping | `benny/agentamp/dsp.py` (new), `benny/core/event_bus.py` (extend) | new + extend |
| Skinnable Textual TUI | `benny/agentamp/tui.py` (new), `benny_cli.py` (extend) | new + extend |
| Layout DSL | `benny/agentamp/layout.py` (new), `frontend/src/agentamp/layout/` (new) | new |
| Equalizer panel binding | `frontend/src/agentamp/equalizer/` (new); reads/writes `SwarmManifest.config` via `/agentamp/eq` | new |
| Marketplace API | `benny/api/agentamp_routes.py` (new); local registry under `${BENNY_HOME}/agentamp/registry/` | new |
| Skin signing | `benny/agentamp/signing.py` (new); reuses `benny/core/manifest.py` HMAC helpers | new |
| Sandboxing (plugin iframe + CSP) | `frontend/src/agentamp/sandbox/` (new); CSP delivered via FastAPI middleware | new |
| Compliance / governance hooks | `benny/governance/policy.py` (extend) — adds `aamp.skin_load`, `aamp.plugin_invoke` intents | extend |
| Release gates | `tests/release/test_aamp_release_gate.py` (new); gates added to `docs/requirements/release_gates.yaml` | new + extend |

---

## Reading order for a new agent

1. This README (vocabulary + do-not list + Winamp mapping table).
2. [requirement.md](requirement.md) §1–§4 (scope, actors, contracts).
3. [acceptance_matrix.md](acceptance_matrix.md) before picking up any phase.
4. [docs/requirements/10/requirement.md](../10/requirement.md) §4 and §8 — AgentAmp's signing, policy, and provenance hooks reuse AOS-001's primitives unchanged.
