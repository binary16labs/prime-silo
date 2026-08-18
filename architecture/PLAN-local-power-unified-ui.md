# PLAN: Local AI Power + Unified Prime-Silo UI

> **Status:** Approved plan, not yet started (rev 5, 2026-07-05: added Workstream G — DAG-native workflow core; Workstream R — reverse-engineer app → TOGAF SAD → modular services; §0.5 goal tree + delivery governance; Workstream Q — security/SRE/quality pipeline; §10 memory & skills updates; rev 5 rebuilds Workstream E from the live-site design review — honest positioning, claims registry, brief→mocks→contract delivery; rev 6 adds §1.5 agent roster — Antigravity + Claude execution model with author≠verifier rule, plugin/skill dual-form, MCP-driven demo capture; rev 7 adds §9.5 Workstream F — six product features in wave one + Milestone 2 committed; rev 8 adds §3.5 Workstream W — declarative work contracts + deterministic next-item delivery engine, sustainability accounting in F5, frontier-consultation checkpoints; rev 9 adds §1.6 NFR register, A6 sovereignty gradient for low-power hardware, F7 backup/restore, sealed exports (M2-3 expanded), M2-5 compliance dossier, MCP-registry publishing, capability-profile rule; rev 10 grounds the plan in the LONGVIEW card-corpus review — path/encoding lint in Q2, evidence-seeded judge calibration in A0, A7 card schema v2; rev 11 ships the **`delivery/` execution directory** — OKRs→epics→milestones→BDD/TDD task contracts + kanban board, W0's canonical backlog is `delivery/tasks/`, Antigravity protocol renders to `delivery/AGENTS.md`, standing backend approval for B/G/Q/W, sequential author≠verifier provision, Q0 rescoped to the full 57-occurrence credential inventory; rev 12 integrates Antigravity/Gemini review — W2 worktree mechanics, verifier-audit CI gate, blocker-triage self-healing loop, semantic offload cache, VCR tapes for hermetic CI, C7 cognitive profiles, F8 sovereignty shield, F2 test-drive, M2-6 memory mesh, M2-7 drift radar; **rev 13 (2026-07-21) adds §2.5 Workstream T** — a house-method QLoRA model trained on the code + LONGVIEW corpus (EP-T → M3, KR1.5, tasks T0–T4): a hybrid that fine-tunes _method + agent behaviour_ and keeps _facts_ in RAG, not from-scratch pretraining; trainer = T480 + Razer Core X eGPU + Radeon RX 9060 XT 16GB (RDNA4/gfx1200), ROCm-on-Windows + Unsloth)
> **Audience:** Implementing agents (Haiku/Sonnet class). Read the whole Execution Protocol before touching any file.
> **Owner decisions already made (do not re-litigate):**
>
> 1. UI scope = **new Prime-Silo shell** hosting existing modules; user-facing rename now, internal identifiers later behind aliases.
> 2. Shared multi-agent state = **file ledger in `PRIME_SILO_HOME/coordination/`** served via existing `/api` + EventBus SSE.
> 3. Offload proving order = **verify existing ADR-004 path first**, then code tasks, knowledge tasks, agent-support tasks.
> 4. Website = **single polished product landing page**; delete stale `site/`.
> 5. (rev 2) Lineage is **native to telemetry**: one run-event stream per DAG execution is the single source for progress, telemetry, and lineage. A run is an _instance of the manifest's DAG_. CLI (rich Textual) and UI render the **same stream** and command through the **same verbs**. Workflow **types** are derived from proven manifests and customized via a guide + agent assist.

---

## 0. Vision (why this plan exists)

Prime-Silo becomes the place where a human plans strategically with a frontier agent (Claude) while **local models (qwen3.5-9B-FLM via lemonade/FLM) do the bulk execution work** — deterministically, offline-capable, auditable. Three agents (Claude Code, opencode, Benny runtime) work the same project **sharing one task ledger and one knowledge store**. Every workflow is a **manifest that IS a DAG**; every execution is an instance of that DAG emitting one event stream that is simultaneously **progress, telemetry, and lineage** — rendered identically in a rich terminal tracker and in the Bridge. The UI stops being a Frankenstein of modules and becomes one calm, modern, ADHD/Dyslexia-friendly product: a **Bridge** for oversight, a **Studio** that feels like NotebookLM, and no "Space Agent" branding anywhere the user can see.

### Hard-won facts the plan is built on (do not rediscover these)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                      | Consequence                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| qwen3.5-9B-FLM produces short outputs reliably: LONGVIEW observed ~415-token self-truncation; live telemetry (2026-07-05 17:12, lemonade) shows a clean **500-token output** at 7,695 input — so ~500 is achievable (likely a `max_tokens` ceiling, not a hard 415 self-limit), but nothing longer is proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | LONGVIEW v2 + live session telemetry        | Never ask the local model for long outputs. Window every task at **≤ ~400-token output budget** (safety margin under the proven 500); assemble results **in code**.                                                                                                                                                                                   |
| 16k context works and is stable, set via `recipe_options` + `/load` — but **prefill is expensive**: measured TTFT 22.0 s at 7.7k input tokens, generation 8.33 tok/s (a 500-token output ≈ 22 s wait + 60 s generation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | LONGVIEW v2 + live telemetry 2026-07-05     | Prompts may be long, outputs short — **and every model call pays the prefill toll.** Windowing (A1) must optimize for _fewer, fuller windows_, not many small ones; per-call overhead ≈ TTFT dominates chatty designs. A0's 120 s silence watchdog is consistent with these numbers (TTFT at 16k input may reach ~45 s — do not lower the threshold). |
| **Model-routing roulette + swap thrash (live incident 2026-07-06, overnight):** deep-synthesis ingest looped all night at 40/161 cards. Three compounding defects: (1) `default`-role model resolution falls through to auto-detect which returns **`models[0]` of lemonade's catalog** (= DeepSeek-GGUF, unchosen) while `graph_synthesis` was pinned to qwen3.5-FLM → two engines (FLM/NPU vs llamacpp) evicting each other per alternation → load race → "No model loaded" on both; (2) **4-hour client timeout** per ingest batch hid each failure for hours; (3) **no batch checkpointing** — every retry re-ingested the same first 40 files. `models.py:_get_active_model_raw` priority chain: env → run snapshot → workspace manifest (longview_v2 has none) → `models[0]` | live incident + code read                   | **A8**. Immediate mitigation: `BENNY_DEFAULT_MODEL=lemonade/qwen3.5-9b-FLM` (priority −1, pins all roles). Durable: kill catalog-roulette, run-level model affinity, minutes-scale timeouts, per-file checkpointing. Strengthens the §1.6 capability-profile rule: _unconfigured_ defaults are as dangerous as hardcoded ones.                        |
| **Recovery paths need their own tests (A8.1, found live 2026-07-06 by the owner's relaunch):** the A8 reconcile only fired on an _in-run_ batch failure — a **fresh process** after a kill/timeout recomputed "pending" from a stale/absent `ingested.json` and re-ingested the finished 40-card batch (relaunch saw 164 pending, truth was 124). Fixed same-day (v1.12.4): reconcile against wiki evidence at **phase start**, before pending is computed. Also observed: pipeline is sequential — "later phases didn't run" during a multi-hour model phase is _not yet_, not _skipped_ (status.json's stale `phase` field invites exactly this misread → G0/G1 heartbeats)                                                                                                      | owner relaunch                              | Meta-lesson for every workstream: **a fix for a failure mode must be tested from the restart path, not only the in-process path** — crash-only (§1.6) means recovery code is first-class code. Verifier note for A8: gate now includes the startup-reconcile scenario.                                                                                |
| **Output silence ≠ wedge (live incident 2026-07-05 ~21:27–22:30):** window fragments stopped for ~1 h and looked exactly like the known wedge signature — but the **NPU was visibly busy**: flm.exe had respawned (22:24) and was doing model reload + full 16k prefill, which legitimately produces zero output for long stretches. Filesystem/token-only observability cannot distinguish "working hard" from "hung"; the operator had to check Task Manager                                                                                                                                                                                                                                                                                                                     | live run observation                        | **Wedge = no tokens AND idle compute.** A0's watchdog must probe compute activity before classifying; G0 gains in-flight heartbeats; F2/Bridge surface live NPU/GPU/CPU utilization so nobody needs Task Manager again.                                                                                                                               |
| ADR-004 offload orchestrator (router matrix, task manifest schema, judge gate, `offload_exec` MCP) is built, 17/17 tests pass, **real-local-model path unverified**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | branch `feat/local-offload-orchestrator`    | Workstream A starts with verification, not construction.                                                                                                                                                                                                                                                                                              |
| lemonade on :13305 has a known "generation wedge" (hangs, needs service restart)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | TOGAF report runs                           | Every offload runner needs a watchdog timeout + wedge detection + honest failure ledger entry.                                                                                                                                                                                                                                                        |
| **Manifests already execute as DAGs**: `runtime/benny/pypes/orchestrator.py` computes topological order from step `inputs`/`outputs`, detects cycles, checkpoints, and supports `resume_from_step`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | code, 2026-07-05                            | Workstream G does NOT build a DAG engine. It makes the DAG the _native contract_ for events, tracking, and UI.                                                                                                                                                                                                                                        |
| **Lineage is currently split in two**: OpenLineage→Marquez HTTP emission in `runtime/benny/governance/lineage.py` (opt-in via `BENNY_LINEAGE_ENABLED` because a dead Marquez wedged RAG ingest for minutes/file) + separate local governance/AER disk events read by the Runs widgets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | lineage.py header comment                   | G0 unifies on ONE local stream; OpenLineage becomes an optional _consumer/adapter_. Never reintroduce blocking HTTP in the hot path.                                                                                                                                                                                                                  |
| A **rich Textual TUI tracker already exists**: `runtime/benny/agentamp/tui.py` (BennyTUI: run-list, current-wave, log-tail, status bar; skinnable palette; 80×24 floor with line-mode fallback; <300 ms first frame NFR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | AAMP-001 Phase 4                            | G1 evolves BennyTUI (adds a DAG pane, feeds it from the G0 stream). Do not write a new TUI.                                                                                                                                                                                                                                                           |
| DAG/graph rendering widgets already exist in the app: `widgets/dag/canvas`, `widgets/workflow_designer`, `widgets/run/reasoning_trace`, plus `step_through` player                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | app tree                                    | G2 reuses these for the live run view.                                                                                                                                                                                                                                                                                                                |
| Report-swarm planner once exploded a 6-task template into 45 tasks + 267 MB of variable expansion (the 38-min failure)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | TOGAF manifest fixes                        | Workflow _types_ are fixed-shape templates with parameter schemas. Planners may fill parameters, never grow the DAG unbounded.                                                                                                                                                                                                                        |
| The UI's problems are diagnosed in `architecture/REQUIREMENTS-ui-ux-refactor.md`: no unified shell, `box-shadow: none !important` flattening, space-themed login dissonance, static mascot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | that doc                                    | Workstream C implements it; don't re-audit.                                                                                                                                                                                                                                                                                                           |
| Canonical color tokens live in `app/L0/_all/mod/_core/framework/css/colors.css` (earth-tone / memo-ray palette decision already made)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ADR-004-adopt-memo-ray-aesthetic            | All new CSS uses these variables. Never hardcode colors.                                                                                                                                                                                                                                                                                              |
| "Space Agent" appears in ~91 places / 40+ files, including load-bearing identifiers (`space-desktop:` IPC channels, `node space` CLI, `space.js`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | grep 2026-07-05                             | Rename user-facing strings only in C4; identifier rename is Workstream H (deferred, alias-first).                                                                                                                                                                                                                                                     |
| EventBus `subscribe_all` SSE + activity-store + Bridge activity chip already exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | commits 082b1ae..20d2299                    | Ledger + run events (B, G) ride this bus; don't build a second event system.                                                                                                                                                                                                                                                                          |
| Voicebox TTS (:17493) + LONGVIEW report/book pipelines exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | v1.11.0                                     | Studio's "Audio Overview" and "Report" outputs are thin wrappers over existing pipelines.                                                                                                                                                                                                                                                             |
| `manifest.workspace` silently overrides env vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | LONGVIEW debugging                          | Any new manifest template must log its resolved workspace (`→ workspace` line) and the runner must assert it matches expectation.                                                                                                                                                                                                                     |
| TOGAF SAD manifests already exist (`runtime/manifests/togaf_sad_prime_silo.json` + `togaf_plus` + `togaf_enterprise` variants, fixed 6-task shape) and a code graph comes from `benny enrich`; vision ingestion (VIS-001) turns figures/diagrams into graph surrogates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | TOGAF fixes + LONGVIEW code phase + ADR-003 | Workstream R generalizes these to _any target app_; it does not invent a new SAD pipeline.                                                                                                                                                                                                                                                            |
| `npm audit` (2026-07-05): **lodash ≤4.17.23 HIGH** (prototype pollution, `_.template` code injection) + **js-yaml 4.0–4.1.1 moderate** (DoS); both have upstream fixes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | audit run                                   | Q0 fixes now; Q2 makes audit a blocking CI gate so it can't regress.                                                                                                                                                                                                                                                                                  |
| Hardcoded shared credential `api_key="benny-mesh-2026-auth"` in `runtime/benny/api/studio_executor.py:755`; meanwhile a **per-install key** mechanism already exists (v1.2.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | grep + release notes                        | Q0 removes the literal; reuse the per-install key path. Never commit credentials — Q2's secrets scan (reusing existing `governance/portability/secrets_scanner.py`) enforces it.                                                                                                                                                                      |
| Server default bind is `0.0.0.0` (`server/app.js:85`, cluster.js) — LAN-exposed by default for a local-first tool; ADR-003 left a known same-origin isolation gap open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | code + code-review remediation notes        | Q0 flips default to loopback (opt-in env for LAN) and closes the ADR-003 residual.                                                                                                                                                                                                                                                                    |
| `runtime/requirements.txt` is `>=`-unpinned (one `==` in the file); Node has a lockfile but CI installs lint tooling ad-hoc (`npm install --no-save …@^9`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | file inspection                             | No reproducible builds → Q1 lockfiles + SBOM.                                                                                                                                                                                                                                                                                                         |
| CI today: lint.yml (ESLint/Prettier/proxy tests, Ruff/Black) + release/snapshot/pages workflows. The **Python test suite never runs in CI**; no dependency audit, no secrets scan, no CodeQL; the v1.2.8 release shipped broken because nothing booted the artifact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | workflows + release_v1_2_8 postmortem       | Q2 (CI gates) + Q3 (boot-the-artifact smoke in release) close this.                                                                                                                                                                                                                                                                                   |
| **LONGVIEW card-corpus review (2026-07-05, 148 cards mid-run; full findings: `architecture/REVIEW-longview-cards-2026-07-05.md`):** the measured failure taxonomy of 9 months of sessions — **#1 = Windows path/encoding (52)**, service-down (43), wedge/timeout (29), env drift (28), model-invalid-JSON (23), context limits (19), permissions (14); 343 operator traits form a consistent profile (explicit>implicit, validate-before-commit, honest errors); repeated verbatim open_threads prove the missing shared backlog (Workstream W's evidence base); silent truncation at list caps (no `truncated` flag); project-name aliasing fragments the graph                                                                                                                  | card corpus analysis                        | Q2 gains the path/encoding lint (top observed failure class); A0 judge calibration is seeded from this taxonomy + trait profile; A7 fixes the card schema.                                                                                                                                                                                            |
| Live-site review (2026-07-05, binary16labs.github.io/prime-silo): earth-tone palette + Neuro-Assist dock + TUI aesthetic are **good and kept**; but the page shows **unvalidated numeric claims** ("98% token tax elimination", "-92.9% EMPIRICAL AUDIT PROOF" — the memo-ray token-audit found these NOT validated; v2 harness still blocked), fabricated telemetry, no screenshots of the real app, no download path (email-a-gmail demo funnel for an OSS desktop app), 5 scroll-jacked acts (one 550vh) contradicting the C0 calm rules, Three.js from CDN, heavy inline styles                                                                                                                                                                                                | source + WebFetch review                    | Workstream E rebuild: honest positioning, claims registry + CI gate, one real demo moment, download-first.                                                                                                                                                                                                                                            |

---

## 0.5 Goal tree & delivery governance (how the vision survives delivery)

The failure mode this section prevents: dozens of green gates that add up to a product nobody envisioned. Gates prove phases _work_; this section proves they still _serve the goal_.

### North star

> **Prime-Silo is a local-first AI workbench: a human plans strategically with a frontier agent while local models execute deterministically — offline-capable, auditable, and calm to use.**

### Goal tree (every phase must trace to exactly one product goal)

| #   | Product goal                                                                     | Measured by                                                                                                                                     | Served by          |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| P1  | Local model does the heavy execution work reliably                               | offload task success rate against real qwen3.5; % of dev/knowledge work delegable                                                               | A0–A5              |
| P2  | Multiple agents work one project without collision or repetition                 | ledger adoption by all 3 agents; zero double-claimed tasks                                                                                      | B0–B3              |
| P3  | Every run is observable and explainable (progress = telemetry = lineage)         | one stream renders identically in TUI + Bridge; lineage answerable for any artifact                                                             | G0–G2              |
| P4  | Workflows are products: typed, customizable, safe                                | catalog types instantiate green; wizard/CLI byte-parity                                                                                         | G3, R2/R3 as types |
| P5  | The app feels like one designed, accessible product                              | C6 parity flip; c1 layout gate at 3 resolutions; zero Space-Agent strings                                                                       | C0–C6, D, E        |
| P6  | Prime-Silo can reverse-engineer and re-architect other software                  | fixture SAD + blueprint gates green with 100% citation grounding                                                                                | R0–R3              |
| P7  | The product is secure, reproducible, and honest about its own health             | Q gates: clean audits, locked deps, CI runs all tests, releases boot-verified                                                                   | Q0–Q3              |
| P8  | The product works _with_ you: findable, automated, attention-respecting          | palette reaches everything; watched/scheduled workflows run unattended; recap replaces polling; real usage numbers                              | F1–F6              |
| P9  | Delivery itself is deterministic, offline-capable, and environmentally accounted | agents complete work via `work next` with zero cherry-picking; a full phase delivered end-to-end offline; honest energy/CO₂e accounting per run | W0–W3, F5          |

### Traceability rules (mechanical, for the implementing model)

1. **Every PR names its phase and goal** in the description: `Phase: G1 — Goal: P3`. A PR that cannot name one of P1–P7 is out of scope — stop and write a blocker.
2. **This file is the single source of scope.** New scope = a new rev of this file (like revs 2–4), approved by the owner, with the goal tree updated. No scope enters through a PR description.
3. **Vision gate at each workstream completion:** when the last phase of a workstream lands, the closing PR includes a short `VISION-CHECK.md` diff note: which goal advanced, what the measured-by column now reads, and one honest sentence on drift observed. The owner reads seven of these, total, across the whole plan.
4. **Definition of Done for the release** (ship checklist): P1–P7 rows all have their "measured by" evidenced; §12 map fully ticked or moved to Workstream H with owner sign-off; CLAUDE.md + AGENT-AWARENESS.md + skills updated (§10).

---

## 1. Execution Protocol (the "6-sigma" rules — apply to EVERY phase)

These rules exist so a smaller model cannot get lost or cause damage. They are not optional.

1. **One phase per session/PR.** Each phase below is a self-contained card: goal, allowed files, steps, gate. Do not start a phase until its listed dependencies are gate-green.
2. **Allowlist discipline.** Only create/modify files listed in the phase card (plus its test files). If the correct fix seems to require touching another file, STOP and write a blocker entry (see rule 7). Never touch: `node_modules/`, `dist/`, `archive/`, `memoray/` (vendored), `runtime/__pycache__/`, anything under `L1/` or `L2/`.
3. **Gate before, gate after.** Before starting, run the gate script of the phase you depend on (regression check). After finishing, your own gate script must pass. A phase is DONE only when its gate passes from a clean checkout of the branch.
4. **Gates are scripts, not judgment.** Every phase ships `scripts/gates/<phase-id>.mjs` (or `.py` for runtime phases) that exits 0/1. UI phases additionally require a screenshot saved to `scratch/gates/<phase-id>/` at 1280×800 and 1920×1080.
5. **Small diffs.** Target < 400 changed lines per PR (excluding lockfiles/generated). If a phase can't fit, split it and update this plan file with the split.
6. **Feature flags, never rip-and-replace.** The new shell mounts behind `PRIME_SILO_NEW_SHELL=1` (env + `/api/config` flag) until phase C6 parity gate passes. Old routes keep working throughout. Same pattern for the unified event stream: legacy AER/Runs readers keep working until G0's compatibility gate passes.
7. **Two strikes → blocker.** If a gate fails twice for the same reason, stop. Append a `blocked` event to the coordination ledger (after B1 exists; before that, write `scratch/BLOCKERS.md`) with: phase id, what failed, exact error, what you tried. Do not improvise around the design.
8. **Honest reporting.** Never mark a step done that you did not verify. "Should work" = not done. If offline/local services (lemonade, Voicebox, runtime) are down, say so in the ledger and stop — do not stub the result.
9. **Update the map.** When a phase completes, tick its checkbox in §12 of this file and add one line to `CLAUDE.md` current-status only if it changes agent-facing behavior.
10. **Lint + tests always.** `npm run lint` (repo eslint) and the relevant test suite must pass before the gate script.

### 1.5 Agent roster & roles (who does what)

The delivery is **Antigravity + Claude based**, with Benny's local models as the execution substrate and the human as the only authority for signatures and scope.

| Agent                     | Role in this plan                                                                                                                                                    | Why                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Claude** (Claude Code)  | Strategic planning with the owner; architecture/spec phases (B0, G0, E0, D1, SPEC docs); complex implementation phases                                               | Frontier reasoning where design judgment matters                                                 |
| **Antigravity**           | Implementation phases; **default gate verifier for every phase** — runs the CLI, executes the test suites, runs `scripts/gates/*`, records the verdict in the ledger | Proven track record: Antigravity ran the CLI and did the tests throughout this project's history |
| **Benny (local qwen3.5)** | Offloaded execution work via the A-workstream manifests; never a phase owner                                                                                         | Deterministic, judged, windowed execution — not planning                                         |
| **Human (owner)**         | Signatures, scope revs of this file, the two human gates (D1 Studio spec, E1 mock pick), release approval                                                            | ADR-001                                                                                          |

**Rules:**

- **Author ≠ verifier.** The agent that implemented a phase does not certify its gate. Default: Antigravity verifies Claude's phases and vice versa; the verifier re-runs the gate from a clean checkout and appends a `task_done` (or `task_blocked`) event naming both agents. Before B1 exists, the verdict goes in the PR description. This is the plan's strongest 6-sigma control: every phase is independently reproduced before it counts.
- **Both harnesses load the same protocol.** Agent-facing instructions ship in dual form from one source: Claude Code reads `CLAUDE.md` + `.claude/skills/`, Antigravity reads `AGENTS.md` — the §10 `phase-runner` content is written once and rendered into both (a small build step, not two hand-maintained copies). **Render target for Antigravity: `delivery/AGENTS.md` (an owned local doc, colocated with the delivery system), with a single index line added to root `/AGENTS.md`** — the root file's own rules (repo-wide rules only, abstract, <500 lines, detail pushed to local docs) forbid inlining the full protocol there. Optionally packaged as a Claude Code **plugin** (skills + MCP config bundled) so any Claude session on any machine gets the protocol + coordination tools in one install; Antigravity gets the same via `delivery/AGENTS.md` + the B2 MCP server, which both harnesses can mount.
- **Standing backend approval (owner-granted, this rev):** Workstreams **B, G, Q, W** are architecturally backend-owned (multi-agent coordination, atomic filesystem leases, SSE broadcast, run-event streams, security remediation) — this satisfies root `/AGENTS.md`'s backend-justification rule _by design_. Agents may modify `server/`, `runtime/`, and `commands/` for these workstreams **within each task contract's allowlist** without pausing to re-request backend permission per PR. Anything outside a contract allowlist still stops (protocol rule 2).
- Both agents coordinate exclusively through the B-workstream ledger once B2 lands (Antigravity via the MCP tools or CLI, both of which it can drive).

### 1.6 Non-functional register (binding across all workstreams)

These are properties, not phases. Each has an owner-gate (the phase whose gate must assert it) so they cannot silently erode.

| NFR                                        | Rule                                                                                                                                                                                                                                                                                         | Asserted by                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Crash-only, resumable**                  | Every long-running process (ingest, LONGVIEW, R-runs, offload packs) survives kill-9 and resumes from its last checkpoint; partial work is never silently lost                                                                                                                               | each workstream's pack gates; G0 events make resume points visible |
| **Liveness observable**                    | Every in-flight generation emits heartbeats (G0 `node_heartbeat`) and hardware utilization is visible in-app (F2/Pulse); "no output yet" and "not working" are distinguishable states everywhere they're rendered — wedge classification always requires _idle compute_, never silence alone | A0 watchdog gate + G1/G2 render heartbeats + F2 gate               |
| **Retention budgets**                      | `runs/`, ledger, and logs have declared size budgets with archival (not deletion) when exceeded; growth is shown honestly in the F5 meter                                                                                                                                                    | F5 gate + a Q3 disk-budget check                                   |
| **Performance budgets at fixture scale**   | TUI first-frame < 300 ms (existing NFR); shell TTI < 2 s; graph views render the 200k-node code-graph fixture and 30k-concept knowledge fixture without stack overflow or > 5 s stalls (both scales have already broken the app once)                                                        | C1/G1/G2 gates run at fixture scales                               |
| **WCAG 2.2 AA**                            | The shell conforms — formal audit at parity flip; the European Accessibility Act makes this a market requirement, and accessibility is this product's identity anyway                                                                                                                        | C6 gate                                                            |
| **Zero phone-home, proven**                | No telemetry, analytics, or content leaves the machine except user-configured endpoints (cloud model APIs the user added, GitHub for updates the user requested). Verified by network audit (A5 technique) against the running app, in CI                                                    | Q2 security wall + `claims.json` entry for the website             |
| **Capability profiles, never model names** | Task manifests declare capability requirements (ctx ≥ N, JSON-reliable, tok/s floor) — never a model id. The router maps capabilities → available models (F2 garage inventory). A new model drops in with zero manifest edits + an M2-2 judge recalibration                                  | A2/A3/G3 validation rejects hardcoded model ids                    |
| **Backups exist**                          | PRIME_SILO_HOME has a snapshot/restore path (F7); a product holding all user data locally with no cloud safety net must ship one                                                                                                                                                             | F7 gate                                                            |

---

## 2. Workstream A — Local model does real work (qwen3.5-9B-FLM)

**Goal:** Claude (and any frontier agent) can hand execution-heavy tasks to the local model reliably, online or offline, and trust the results because a deterministic gate + judge checked them.

### A0 — Verify the real local path end-to-end _(depends on: nothing — DO THIS FIRST)_

- **Files:** `runtime/` offload runner tests only; `manifests/offload/examples/`; new `scripts/gates/a0.py`.
- **Steps:**
  1. Confirm lemonade is serving qwen3.5-9B-FLM with 16k ctx (`recipe_options` + `/load`). Record model id + ctx in the gate output.
  2. Run one existing example offload manifest through the **sync** MCP path (`offload_exec`) and one through the **async runner**, against the real endpoint.
  3. Add a **watchdog with compute-aware states** (the 2026-07-05 silence≠wedge lesson): on token silence past N seconds (default 120), probe compute activity (lemonade stats/health endpoint if available, else OS perf counters for the NPU/GPU engine + flm.exe CPU time delta). Silence + **busy compute** → `prefill_in_progress` (keep waiting, log heartbeat, apply a generous hard ceiling ~15 min); silence + **idle compute** → `wedge_suspected`, honest ledger entry, exit non-zero. Also detect **model-process respawn** (flm.exe PID change) and log it as `model_restarted` — after a respawn, expect reload+full-prefill delays and reset the clock. Do NOT auto-restart the service (state-changing) — report it.
  4. Calibrate the judge gate on 5 known-good and 5 known-bad outputs (see `manifests/offload/JUDGE-CALIBRATION.md`). **Seed the calibration from measured evidence, not intuition:** the known-bad set includes the top observed failure modes from the card-corpus review (invalid/truncated JSON, path-mangled outputs, context-overflow truncation); the acceptance criteria encode the measured operator profile (explicit over implicit, actionable errors over silent failure, no unvalidated claims) — see `architecture/REVIEW-longview-cards-2026-07-05.md`.
- **Gate `a0.py`:** runs a trivial offload manifest against the real endpoint; asserts judge verdict recorded, ledger entry honest, resolved workspace logged, total wall time < 5 min. Exits 1 with reason `service_down` if lemonade unreachable (that is a valid, honest failure — not a pass).

### A1 — Windowing/assembly helper _(depends on: A0)_

- **Files:** `runtime/brain/windowing.py` (new), tests, `scripts/gates/a1.py`.
- **What:** One reusable helper that: splits work into windows sized for ≤ ~400-token outputs (proven-safe margin under the measured 500-token ceiling), runs each window as a separate generation, assembles results losslessly in code (LONGVIEW pattern), and validates each window's output against a per-task schema (JSON schema or regex contract) with **bounded retry (max 2) then honest partial-failure**.
- **Prefill economics (measured 2026-07-05: TTFT 22 s @ 7.7k input, 8.33 tok/s):** each call costs ~TTFT + output/TPS, so the splitter must **maximize work per window**, packing input context toward the 16k budget and batching items per window, rather than issuing many small calls. The helper exposes a per-run cost estimate (calls × (est. TTFT + out/TPS)) so manifests can be sanity-checked against wall-time expectations before running.
- **Semantic content-addressed cache:** a local SQLite cache keyed on `hash(window text + system prompt + schema + model id + ctx + sampling params)` — a hit with a **passing judge verdict** returns instantly (0 s, 0 Wh). Makes iterative dev runs, test suites, and re-ingestion near-free. Honesty rules: cache hits still emit G0 events flagged `cached: true` (F5 meters them as saved work, never hides them); any change to model, params, or prompt version misses by construction; cache is per-home, size-budgeted (§1.6 retention).
- **Gate:** property test: given a 50-item synthetic task, all 50 items appear exactly once in assembled output; a poisoned window (model returns garbage) yields a `partial` result with the failed window identified — never silent loss.

### A2 — Dev-task manifest pack _(depends on: A1; emits G0 events once G0 lands)_

- **Files:** `manifests/offload/dev/` (new): one manifest per task + shared includes; `runtime/` task handlers; gates.
- **Tasks (one manifest each, in this order):**
  1. `commit_summary` — diff in → conventional summary out. Acceptance: deterministic checks + judge.
  2. `docstring_gen` — windowed per function; acceptance: code still parses (`ast.parse`), no non-docstring lines changed (diff guard).
  3. `unit_test_gen` — windowed per function; acceptance: generated tests **run** and fail-or-pass legitimately (no import errors); tests that fail are kept but marked `xfail-candidate`, never deleted.
  4. `log_triage` — log chunk in → classified findings JSON out; acceptance: schema-valid, every finding cites a line number that exists.
  5. `code_review_notes` — windowed per file; advisory output only.
- **Design rule for all five:** each manifest is a **pypes DAG** (explicit steps with `inputs`/`outputs` — this is what makes G-workstream tracking free). Deterministic pre-checks first (cheap, code), judge second (model), human-visible diff artifact always written to `agent_sandbox/drafts/offload/<run_id>/`. Loops allowed: a manifest may loop `generate → check → regenerate` max 2 iterations, then emit best-effort with `review_required: true`.
- **Gate per task:** golden-input run produces schema-valid, acceptance-passing output against the real model. Pack gate `a2.py` runs all five.

### A3 — Knowledge-task manifest pack _(depends on: A1)_

- **Files:** `manifests/offload/knowledge/` (new).
- **Tasks:** `summarize_doc` (windowed map-reduce), `card_gen` (LONGVIEW card pattern generalized), `graph_enrich_batch` (wraps existing `benny enrich-graph` stages), `report_section` (feeds Studio/LONGVIEW).
- Same design rules and gate pattern as A2. Reuse LONGVIEW code by extraction, not duplication — if a function exists in `scripts/longview/`, move it into `runtime/brain/` and import from both.

### A4 — Agent-support path (Claude delegates mid-session) _(depends on: A2 or A3, B1)_

- **What:** `offload_exec` MCP becomes the ergonomic front door: a frontier agent submits a task by name + params, gets either sync result (small tasks) or a ticket; async completions land in the **outbox** and as a ledger event so the agent (and the Bridge UI) see them. Include a `capabilities` MCP tool that lists available task manifests with their input schemas — so agents discover what they can delegate instead of guessing. (After G3, `capabilities` reads the workflow-type catalog rather than a private list.)
- **Gate:** scripted session: submit async task → poll ledger → digest contains honest result; submit while lemonade down → immediate honest `red` routing, no hang.

### A5 — Offline assurance _(depends on: A2)_

- **What:** `benny offload preflight --offline` asserts: all endpoints in `router.matrix.json` are localhost, model files present, no manifest references a remote URL. CI-style gate runs the full A2 pack with outbound network blocked (Windows: run gate under a firewall-rule scope or assert no non-localhost sockets opened via `psutil` audit).
- **Gate:** full dev pack passes with network audit showing localhost-only.

### A6 — Sovereignty gradient (no capable local model ≠ no sovereignty) _(depends on: A2, F2 for capability reporting)_

- **The principle:** a user on a weak laptop keeps **data sovereignty even without compute sovereignty**. All knowledge, graphs, lineage, ledger, governance, and workflow orchestration stay local and are served to agents via the MCP/verbs surface regardless of where _generation_ happens. Only the inference tokens travel.
- **Three explicit tiers, user-chosen and always visible:**
  1. **Full local** — generation on this machine's models (the default when the F2 garage reports a capable model).
  2. **LAN local** — generation on another machine in the user's LAN pool (existing multi-endpoint router).
  3. **Frontier-assisted** — the F2 garage reports _no capable local model_ for a task's capability profile; generation routes to a user-configured frontier API (Claude, or whatever the user chose), OR the frontier agent already in session (Claude/Antigravity mounted via MCP) simply performs the generation step itself while using all local functions — graph queries, ledger, lineage, judge, sandbox — through the MCP. Either way the run is still a normal G0 DAG with full lineage, the judge gate still applies, F5 meters it honestly as cloud tokens, and nothing but the generation prompt/response leaves the machine.
- **Mechanics:** the router matrix gains a `fallback` column per capability profile; frontier endpoints are ordinary router entries flagged `remote: true` (opt-in, per NFR zero-phone-home — they only exist if the user configured them). Manifests don't change at all (capability-profile rule, §1.6). The garage (F2) is the single source of "what can this machine do."
- **Gate:** with the local endpoint disabled and a mock remote configured, an A2 task completes via the fallback with correct lineage + F5 cloud attribution; with no fallback configured, the task honestly refuses with `no_capable_model` (never a silent hang); the MCP path is exercised by an agent session completing a generation step against local graph functions.

### A7 — LONGVIEW card schema v2 + assembly normalizers _(depends on: current v2 run COMPLETE — do not disturb it; applies to the next delta run)_

- **Files:** `scripts/longview/` schema + assembly, `architecture/REVIEW-longview-cards-2026-07-05.md` is the requirements source.
- **Schema v2 additions (all deterministic to collect — no new model calls):** session `started_at`/`ended_at`/`duration` (from raw log timestamps; period stays for grouping); `model` + `ctx` + local/cloud (from run_config/telemetry where available); `disposition` (`success|partial|abandoned` — derivable rules first, judge only for ambiguous); quantitative counts (files touched, commits, tests run/passed where the log shows them); **stable thread ids** on `open_threads`/`proposed_next` (content-hash) so resolution links across sessions instead of verbatim repeats; **truncation honesty** — every capped list gets `<field>_total` when it overflowed (cap stays for token budget; loss becomes visible); future hooks: `run_id`/ledger task ids once G0/B exist.
- **Assembly normalizers (deterministic code, also runnable post-hoc on v2 cards):** canonical project registry + alias map (`prime-silo`≡`Prime-Silo`, `benny`≡`Benny`≡`Benny Studio`, workspace-folder leaks like `outputs` remapped or flagged); path canonicalization for evidence (`/c:/…` fixes, prefer repo-relative + commit hash when resolvable); bullet-artifact stripping (leading `". "`).
- **Rollup quality (from the 2026-07-05 operator/capabilities rollup review):** trait canonicalization + semantic merge (370 unique traits / 391 links = near-zero consolidation; case variants of the same trait split evidence); traits gain `subject: operator|agent` and `polarity: strength|risk` (e.g. "repeats failed commands" may be agent behavior misattributed to the operator); capabilities gain a domain taxonomy rollup. **Privacy partition:** rollups mix personal-context work (job applications) with product work — profile data gets a `personal|professional` partition, redacted by default from anything shared (sealed exports M2-3, compliance dossiers M2-5, memory mesh M2-6).
- **Gate:** v2→v2.1 post-hoc normalization run over the existing 148+ cards produces zero parse errors, zero alias-split projects, zero malformed evidence paths; a fixture session with known timestamps/counts yields the exact v2 fields; a saturated list carries its honest `_total`.

### A8 — Model-routing hygiene + ingest resilience _(depends on: nothing — HOTFIX-CLASS, from the 2026-07-06 swap-thrash incident)_

- **Files:** `runtime/benny/core/models.py` (`_get_active_model_raw`), the deep-synthesis ingest client (timeout + batching), `runtime/tests/core/`, `scripts/gates/a8.py`.
- **What (four fixes, each independently small):**
  1. **Kill catalog roulette:** the auto-detect fallback never returns `models[0]` blindly. Order of preference becomes: the model **currently loaded** on the provider (a swap-free choice by definition) → the model already used by this run (run-level affinity) → capability-profile match via the router → only then first-catalog, logged at WARNING with the word `roulette` so it's greppable.
  2. **Run-level model affinity (single-NPU rule):** within one run, every role resolves to the run's primary model unless the workspace manifest _explicitly_ maps that role differently. Alternating engines on one NPU is opt-in, never accidental.
  3. **Sane timeouts + honest failure:** ingest batch calls drop from 4 h to minutes-scale per call (default 10 min, configurable), wired to the A0 compute-aware watchdog semantics (busy compute extends, idle compute fails fast).
  4. **Per-file checkpointing:** ingest records progress per card; a retry resumes at the first unprocessed card, never re-ingests a completed one (content-hash skip, same pattern as the map phase's window cache).
- **Gate `a8.py`:** with a mock provider whose catalog lists model B first while model A is loaded, default-role resolution returns A (loaded-model preference); a run using model A never emits a request for model B unless the manifest maps it (affinity test); a stalled mock ingest call fails in ≤ the configured timeout, not hours; a killed-and-restarted ingest of a 10-card fixture processes exactly the unfinished remainder.

---

## 2.5 Workstream T — House-method model (train on code + LONGVIEW)

**Goal (P1, P9):** a local model that has internalized not just _the code_ but _how we got there_ —
the reasoning, decisions, and working method behind the estate — so it can support development,
investigations, and task execution. **Honest scope split (the design decision):** fine-tuning distils
**method + voice + agent tool-use** (verify-before-commit, dry-run-first, additive design, ADR/card
structure, how we drive tools); it does **not** store facts reliably. **Facts stay in RAG**
(S16/memo-ray/LONGVIEW), retrieved at inference. This is a **QLoRA** fine-tune (4-bit, ~7–8B base),
**not** from-scratch pretraining and **not** cramming facts into weights. The tuned model becomes a
**candidate engine behind Benny's router** and drives the ADR-004 offload path — **additive**, never a
replacement for the current engine. Contracts live in `delivery/tasks/T0..T4.md` (EP-T → M3, KR1.5);
design source `~/.claude/plans/mellow-tinkering-swan.md`. **Trainer hardware:** Lenovo T480 + Razer
Core X eGPU (TB3) + Sapphire Pulse Radeon **RX 9060 XT 16GB (RDNA4 / gfx1200)**, Windows host,
ROCm-on-Windows + Unsloth (RDNA4 needs **ROCm 7.0.2+**, verified on the T480 at ROCm 7.13; WSL2-ROCm
fallback). Benny is the serving/agent tier, **not** a trainer.

### T0 — Prove the trainer end-to-end _(depends on: nothing — DO THIS FIRST for T; make-or-break)_

- **Files:** `scripts/train/smoke/`, new `scripts/gates/t0.py`, `docs/train/T0-trainer-evidence.md`.
- **What:** ROCm-on-Windows enumerates gfx1200 on the eGPU (`rocm-smi`/`hipInfo`); Unsloth installs;
  a ~30-step 4-bit QLoRA runs on a 7B toy dataset with loss recorded and a reloadable adapter saved.
  The least-proven link in the stack (RDNA4 in a TB3 eGPU under Windows ROCm) — prove it before any
  data investment. Fallback ladder: WSL2-ROCm → cloud-train/serve-local → smaller base.
- **Gate `t0.py`:** asserts gfx1200/~16GB reported and a smoke-run artifact (adapter + step count +
  decreasing loss) exists; exits non-zero `gpu_absent` when no compute device reports gfx1200.

### T1 — Clone the Benny home to the trainer _(depends on: nothing)_

- **Files:** `scripts/train/clone_home/`, new `scripts/gates/t1.mjs`, `docs/train/T1-clone-provenance.md`.
- **What:** carry a full `PRIME_SILO_HOME` clone (code + RAG stores + LONGVIEW cards/KG + runtime) to
  the T480 so it builds data, trains, and serves RAG locally — no hard LAN dependency. Windows→Windows,
  so no store-format conversion; the real risk is absolute-path assumptions in the home. Snapshot with
  recorded provenance (source commit/timestamp) + a refresh procedure — no silent drift.
- **Gate `t1.mjs`:** the home resolver points at the clone and a known key reads back from each store
  (S16 doc+vector, a memo-ray session, LONGVIEW cards) with no call back to the desktop.

### T2 — Data pipeline: instruction + trajectory dataset _(depends on: nothing — builds from the corpus)_

- **Files:** `scripts/train/build_dataset.mjs` + `lib/` + `tests/` + `dataset/`, `scripts/gates/t2.mjs`,
  `docs/train/T2-dataset-card.md`. **Reuse** `scripts/longview/` (`store/walk/card_triples/retrieve/record`).
- **What:** fine-tune quality is ~90% data, and the corpus is _already structured_. Emit two SFT streams:
  **Stream A** method/voice `(instruction → house-style response)` from LONGVIEW cards + ADRs + synthesis;
  **Stream B** agent trajectories `(state + goal → next tool call)` from Benny/offload/Claude tool-use
  traces. Carve a held-out eval set **before** training; hand-audit a ~200-row gold set. **Privacy: run
  `scripts/longview/lib/leak_gate.mjs` over every row** — job-application/CV context never enters training.
- **Gate `t2.mjs`:** both streams schema-valid; a seeded CV/job row is excluded; leak gate reports 0
  personal-context hits; the held-out split is disjoint from train.

### T3 — First QLoRA run + honest base-vs-tuned eval _(depends on: T0, T2)_

- **Files:** `scripts/train/qlora/`, `scripts/train/eval/`, `scripts/gates/t3.py`, `docs/train/T3-eval-report.md`.
- **What:** QLoRA (rank 16, lr 2e-4, packed ~16k ctx) on Stream A+B over the T0-proven trainer; base =
  Qwen2.5-Coder-7B-Instruct or Qwen3-8B (pick per T0 smoke + eval fit — installed inference builds inform
  the choice, but training pulls **HF safetensors**). **Define the rubric before training.** Eval base vs
  tuned on held-out method tasks + tool-call correctness with **RAG disabled**, so the number reflects the
  fine-tune's own contribution. Merge adapter → GGUF. A tuned model that does **not** beat base is an
  honest, logged result — never tune the rubric to pass.
- **Gate `t3.py`:** an eval report records the base-vs-tuned delta per category and a merged GGUF loads;
  green only if tuned ≥ base on the rubric. This is KR1.5's primary instrument.

### T4 — Wire tuned model behind Benny's router + offload _(depends on: T3)_

- **Files:** `runtime/benny/router/` + `tests/router/`, `scripts/gates/t4.py`, `docs/train/T4-integration.md`.
- **What:** register the tuned GGUF as an **additive candidate** in Benny's multi-endpoint router (current
  engine stays default; unhealthy tuned endpoint falls back, never hard-fails) and drive one real ADR-004
  offload task with RAG grounding, no regression vs the current engine. Reuses A0's proven offload path.
- **Gate `t4.py`:** router config shows the tuned engine additive (not default); one trivial offload task
  completes through the judge gate on the tuned engine with an honest ledger entry. Closes KR1.5 with T3.

**Exit (VISION-CHECK):** which KRs moved (KR1.5, and KR1.2/1.3 if the tuned engine improves offload),
the measured base-vs-tuned delta (no unmeasured "trained on how we got there" claims), one honest line
on drift. (T5 — DPO on verify-before-commit preference pairs / larger base / delta-refresh — is optional,
deferred.)

## 3. Workstream B — Shared coordination ledger (three agents, one truth)

**Goal:** Claude Code, opencode, and Benny working the same project see the same task list, claim work without colliding, and share discovered knowledge.

### B0 — Ledger spec + validator _(depends on: nothing — can run parallel to A0)_

- **Files:** `architecture/SPEC-coordination-ledger.md` (new), `server/coordination/schema/` JSON schemas, validator lib + tests.
- **Design (build exactly this):**
  - Location: `PRIME_SILO_HOME/coordination/` → `tasks.jsonl` (append-only events), `knowledge/*.md` (shared notes, one fact per file, frontmatter: `topic`, `source_agent`, `confidence`), `leases/` (claim files).
  - Event types: `task_created`, `task_claimed`, `task_progress`, `task_done`, `task_blocked`, `task_released`, `knowledge_added`. Every event: `id` (ulid), `ts` (ISO-8601), `agent` (registered agent id — seed set `claude|antigravity|opencode|benny|human`, extensible via a `coordination/agents.json` registry rather than a hard enum), `task_id`, `payload`. A task that maps to a manifest run carries `run_id` so ledger tasks link to G0 run streams.
  - **Claim protocol (collision safety):** to work task T, agent writes `leases/<task_id>.json` with `agent`, `expires_at` (now + 15 min), heartbeat-renewed. Claim is valid only if the lease file was created by you (atomic create-exclusive, `wx` flag) or is expired. State is derived by folding `tasks.jsonl`; the ledger is truth, leases are advisory locks.
  - Append-only: agents never edit or delete ledger lines. Compaction is a human-run CLI later; out of scope.
- **Gate:** validator rejects malformed events; simulated 3-agent concurrent claim (3 processes racing `wx` create) yields exactly one winner, 20/20 runs.

### B1 — Server API + SSE _(depends on: B0)_

- **Files:** `server/coordination/` routes, wiring into existing EventBus.
- **Endpoints:** `GET /api/coord/tasks` (folded state), `GET /api/coord/tasks/:id/events`, `POST /api/coord/events` (validated append), `GET /api/coord/knowledge?topic=`. Every accepted append is re-broadcast on the existing EventBus SSE (`coord.*` topics).
- **Gate:** integration test: POST event → appears in GET state and arrives on SSE within 2 s; invalid event → 422 and no ledger write.

### B2 — Agent surfaces (CLI + MCP) _(depends on: B1)_

- **Files:** `runtime/` CLI (`benny coord ls|claim|progress|done|note`), MCP tools in the prime-silo-nexus server (`coord_list`, `coord_claim`, `coord_report`, `coord_note`); Antigravity and opencode mount the same MCP server / hit the same API — one surface, four agents.
- All three surfaces are thin clients of the B1 API when the server is up, with **direct-file fallback** (same validator lib) when it isn't — offline still works. (After G2 these verbs migrate into the unified verbs registry; build them registry-shaped from the start: name + params schema + handler.)
- **Gate:** scripted: CLI claims a task, MCP client sees it claimed and is refused the claim, CLI reports done, MCP sees `done` state. Repeat with server stopped (file fallback).

### B3 — Bridge coordination panel _(depends on: B1, C2)_

- **What:** live panel in the Bridge: task board (todo/claimed/done, colored by agent), knowledge feed, blocked items surfaced prominently; tasks with a `run_id` deep-link to the G2 live run view. Uses the existing activity-store + SSE.
- **Gate:** preview-driven check: create task via API → appears in panel without reload; screenshots at both required resolutions.

---

## 3.5 Workstream W — Declarative work contracts + deterministic delivery engine (P9)

**Goal (P9):** development work itself becomes what our data workflows already are — **declarative contract objects executed by modular services**. An agent (local or frontier, online or offline) asks for exactly one next item, receives a token-frugal contract, delivers it inside a provisioned sandbox, hands it to an independent verifier, and repeats. No browsing the backlog, no cherry-picking, no re-reading this whole plan every session. The plan's own phases become the first backlog — this workstream dogfoods itself.

**The philosophy (binding):** a work item is to human/agent work what a pypes manifest is to data work — a declarative, versioned contract (inputs, outputs, acceptance, authority) executed by small composable services (selector, sandbox provisioner, runner, verifier, ledger). The contract is immutable once signed; execution state lives in the B-ledger, never in the contract. Frontier models (Claude) are the **consultation and planning partner** — they author and review contracts, unblock blockers, and hold the vision checkpoints (§0.5) — while execution defaults local. That division is the sovereignty model: plan with the frontier, deliver on your own hardware.

### W0 — Work-item contract format + the plan as backlog _(depends on: B0 for schema alignment)_

- **Files:** `architecture/SPEC-work-contracts.md`, **`delivery/tasks/` (the single canonical in-repo development backlog — the `delivery/` system created 2026-07-05 supersedes the earlier `backlog/` naming; do NOT create a separate `backlog/` dir)**; product-usage work items live in `PRIME_SILO_HOME/coordination/work/`. JSON-schema + validator, `scripts/gates/w0.mjs`.
- **Format (token-friendly by construction — think "issues, but offline and frugal"):** one markdown file per item. YAML frontmatter: `id`, `title`, `phase` (e.g. `C1`), `goal` (P1–P9), `deps` (item ids), `authority` (`agent-ok|human-signed`), `allowlist` (files), `tools` (required capabilities: node, pytest, preview, MCP servers), `sandbox` (`worktree|in-place`), `verify` (the gate command), `budget` (max changed lines). Body: **goal** (2–3 sentences), **acceptance** (checkboxes), **context pointers** (file:line refs, memory names, graph node ids — _never inlined content_). **Hard token budget: an item ≤ ~600 tokens, enforced by the validator.** State (`todo/claimed/done/blocked`) is _not_ in the file — it is derived from the B-ledger, keeping contracts declarative and immutable once signed.
- **Dogfood conversion:** every phase card in this plan is converted into `delivery/tasks/` items (a phase may split into several ≤-budget items). This plan file remains the human-readable narrative + goal tree; `delivery/` (tasks + board + traceability) becomes the machine-readable execution form and is **authoritative for task state**. From then on, protocol rule 1 reads: "one _work item_ per session."
- **Gate `w0.mjs`:** every backlog item validates (schema, token budget, resolvable deps/allowlist paths, verify command exists); the dependency graph over items is acyclic and mirrors §12; a deliberately over-budget item is rejected.

### W1 — `work next`: the deterministic selector + delivery loop _(depends on: W0, B2)_

- **What:** `benny work next` (CLI + MCP tool, G2-registry-shaped) computes the ready set (all deps `done`, no valid lease, authority satisfied) and returns **exactly one item** — topological order, then priority, then lexicographic id. The same inputs always yield the same item: no choice offered, no choice possible. The delivery loop around it: `work next` → auto-claim (B-lease) → deliver → `work verify` (runs the item's verify command) → handoff event for the independent verifier (§1.5 author≠verifier) → verifier confirms → `done` event → loop. `work blocked <reason>` is the only other exit. An agent that wants a _different_ item doesn't get one — re-prioritization is a human edit to the backlog, PR-reviewed.
- **Blocker triage (self-healing loop):** anything entering BLOCKED automatically joins the frontier-consultation queue. Claude reviews the blocker log at the next checkpoint, amends or splits the contract (blockers are usually architectural ambiguity, dependency conflicts, or underspecified scenarios — frontier work), logs `unblocked`, and returns the item to READY. Blocked items never stagnate and never get improvised around.
- **Gate:** simulated backlog: two agents pulling concurrently receive different items (lease race, 20/20); completing an item makes exactly its dependents ready; selector is reproducible (same state → same item, 100 trials); a `done` without a distinct verifier agent id is rejected.

### W2 — Sandbox + tool provisioning _(depends on: W1)_

- **What:** claiming an item provisions its declared sandbox: `worktree` mode runs **`git worktree add .worktrees/<task-id> -b feat/<task-id>`** — the agent's entire TDD loop happens inside that worktree, giving 100% collision-free multi-agent concurrency (no index-lock races, no overlapping scratch edits) with zero container overhead; on `work verify` pass the engine exports the clean branch/diff for the verifier. The allowlist is enforced by a pre-commit/pre-done check (files changed ⊆ allowlist, diff size ≤ budget); declared `tools` are preflighted (binary present, service healthy, MCP mounted) **before** work starts — a missing tool is an immediate honest `blocked`, not a mid-task improvisation. This mechanizes protocol rules 2 and 5: allowlist and diff-budget stop being discipline and become enforcement.
- **Gate:** item with out-of-allowlist edit is refused at `work verify`; over-budget diff refused; missing declared tool yields `blocked` with the tool named; worktree cleaned up after `done`.

### W3 — Dogfood proof: a real phase delivered by the engine _(depends on: W2; first candidates: any ready C or F item)_

- **What:** one full plan phase is delivered end-to-end **driven only by the engine**: agent session starts with the `phase-runner` skill + `work next`, never reads this plan file, completes the item(s), independent verifier confirms, ledger tells the whole story, recap (F4, if landed) shows it. Ideally run once with Claude executing and once with a local-model-assisted session, to prove the token-frugal format actually fits small contexts.
- **Gate:** the delivered phase's own gate is green; the executing session's transcript contains no read of `PLAN-local-power-unified-ui.md` (the contract was sufficient); ledger events reconstruct the full claim→verify→done chain with distinct author/verifier.

**Frontier-consultation checkpoints (the partnership contract):** Claude (or another frontier model) is pulled in at exactly these points, by design rather than ad-hoc: contract authoring/splitting (W0 conversions), blocker resolution (`task_blocked` events are the queue Claude works), the seven §0.5 VISION-CHECKs, and Milestone planning. Everything between checkpoints defaults to local/offline execution. This is the sovereignty argument _and_ the frontier-partnership argument in one mechanism: local capacity makes users take on bigger ambitions, which makes the planning partner more valuable, not less.

---

## 4. Workstream G — DAG-native workflow core (lineage = telemetry, one tracker, CLI/UI parity, workflow types)

**Goal:** the manifest's DAG is the _single contract_ everything hangs off: one run-event stream per execution carries progress, telemetry, and lineage; the rich terminal tracker and the Bridge render that same stream; CLI, UI, and agents command through the same verbs; and proven manifests become a catalog of customizable workflow types.

**Modularity rule for the whole workstream:** two contracts, everything else pluggable.

- **Contract 1 — the run-event stream (G0):** exactly one producer (the pypes orchestrator); all consumers (TUI, Bridge, lineage fold, OpenLineage adapter, coordination ledger linker) read the stream and never each other.
- **Contract 2 — the verbs registry (G2):** one declaration per capability (name, params JSON-schema, handler, authority level); CLI subcommands, REST endpoints, and agent/MCP tools are _generated_ from it, so the surfaces cannot drift.

### G0 — Unified run-event stream: lineage native to telemetry _(depends on: nothing — third zero-dependency starter)_

- **Files:** `architecture/SPEC-run-events.md` (new), `runtime/benny/pypes/events.py` (new single emitter), edits in `runtime/benny/pypes/orchestrator.py` (emit at existing step boundaries only), `runtime/benny/governance/lineage.py` (becomes a _consumer/adapter_), schema + tests, `scripts/gates/g0.py`.
- **Design (build exactly this):**
  - A run is an instance of the manifest's DAG: `run_id` + `manifest_id` + `manifest_hash` + the resolved topological order, written once as a `run_started` header event containing the full node/edge list. **The DAG shape is frozen at start; no event may introduce a node that wasn't in the header** (this is the 267 MB-blowup guard at the schema level).
  - Event types: `run_started`, `node_started`, `node_progress`, `node_finished`, `node_failed`, `node_retried`, `artifact_produced` (node, path/uri, content-hash), `artifact_consumed`, `run_finished`, `run_failed`, **`node_heartbeat`** (periodic while a node is in flight: `phase: prefill|generating|assembling`, tokens streamed so far, compute-busy flag — so trackers render _liveness_, not just state transitions; a node with recent heartbeats is alive no matter how long since its last artifact). Every event: `run_id`, `node_id`, `attempt`, `ts`, plus telemetry fields (`duration_ms`, `tokens_in/out`, `model`, `endpoint`) where applicable.
  - **Lineage is a fold, not a system:** the lineage graph (which artifact came from which node/run, back through `artifact_consumed` edges) is derived by folding `artifact_*` events. No second lineage write path.
  - Storage: `PRIME_SILO_HOME/runs/<run_id>/events.jsonl`, append-only, written by the orchestrator only. Non-blocking: event write failure logs and degrades, never fails the step.
  - **OpenLineage/Marquez becomes an optional consumer**: an adapter tails the stream and emits OpenLineage RunEvents when `BENNY_LINEAGE_ENABLED=1`. The gate that keeps HTTP out of the hot path (the RAG-ingest wedge lesson) is preserved by construction — the adapter is a separate process/task, never inline.
  - **Compatibility:** existing local governance/AER events and the Runs widgets keep working until this stream reaches parity; the gate proves parity before any legacy reader is touched (protocol rule 6).
- **Gate `g0.py`:** run an example pypes manifest → events validate against schema; folded lineage reproduces what `benny runs inspect <run_id>` reports today; DAG-freeze enforced (injecting an unknown node_id event fails validation); with Marquez down and lineage enabled, step wall time unaffected (±5%) — no inline HTTP.

### G1 — DAG-aware terminal tracker (evolve BennyTUI) _(depends on: G0)_

- **Files:** `runtime/benny/agentamp/tui.py` + new `runtime/benny/agentamp/dag_pane.py`, tests in `runtime/tests/agentamp/`.
- **What:** the existing rich Textual direction, matured. Add a **DAG pane** to BennyTUI: nodes in topological rows (waves), colored/glyphed by state (pending/running/done/failed/retrying — glyphs from the existing skin palette), current node's `node_progress` detail + log-tail beneath, artifacts listed as they're produced. Driven _only_ by tailing the G0 stream — the TUI never queries the orchestrator directly (Contract 1). Keep: skinnable palette, 80×24 floor with `run_line_mode` fallback (line-mode prints wave-by-wave state lines from the same stream), <300 ms first-frame NFR. `benny runs watch <run_id>` attaches to a live or finished run.
- **Gate:** Textual pilot tests: scripted run → DAG pane shows every node reaching a terminal state in topological order; a `node_failed` renders the failure + honest exit; line-mode fallback produces the same state sequence as the TUI for the same stream.

### G2 — Verbs registry: CLI ⇄ UI ⇄ agent parity + live run view _(depends on: G0; UI part depends on C2)_

- **Files:** `runtime/benny/verbs/` (new registry), thin rewires in `benny_cli.py` + `runtime/benny/api/` routes, `server/` proxy passthrough, Bridge run view using existing `widgets/dag/canvas` + `widgets/run/reasoning_trace`, onscreen-agent (Benny) skill wiring.
- **What:**
  1. **Registry:** every commandable capability declared once — `name`, `summary`, `params` (JSON-schema), `handler`, `authority` (`agent-ok | human-only` per ADR-001: e.g. `runs.watch` agent-ok, `pypes.run` human-only). From this one table generate: CLI subcommands (help text included), REST endpoints (`/api/verbs` lists them; `/api/verbs/<name>` invokes with schema validation), and the agent/MCP tool manifest.
  2. **Benny helps from the UI with the same power as the CLI:** the onscreen agent's skill enumerates `/api/verbs` filtered to `agent-ok` — so "Benny, watch that run" in the UI and `benny runs watch` in the terminal execute the identical handler. Human-only verbs render as a **prepared command the user confirms** (one click / one keypress), never auto-executed.
  3. **Live run view in the Bridge:** the manifest DAG rendered with the existing dag canvas widget, node states streamed over SSE from the G0 stream (same EventBus), click a node → its telemetry, logs, artifacts, and lineage-upstream; `step_through` player replays finished runs from the same events file. The TUI and this view are two renderers of one stream — feature-for-feature aligned by construction.
- **Distribution:** once stable, the generated MCP manifest is packaged and **published to MCP registries** so any agent client (Claude Code/Desktop, IDEs, other harnesses) can mount prime-silo — local execution, knowledge graph, workflow catalog — as a capability. This is the product's cheapest and most credible growth channel: developers discover it through the agent they already use.
- **Gate `g2` (parity script):** set-diff of CLI verb list vs `/api/verbs` vs agent tool list = empty; invoking the same agent-ok verb via CLI and via API yields identical handler results; human-only verb via agent surface returns `requires_human` (never executes); live run view shows node state transitions without reload; replay of a finished run renders the same terminal states as G1's tracker.

### G3 — Workflow types catalog + guided customization _(depends on: G2, A2, A3; wizard UI depends on C2)_

- **Files:** `manifests/catalog.json` (new) + `architecture/SPEC-workflow-types.md`, per-type parameter schemas next to their manifests, wizard module in the shell, `benny pypes plan` integration.
- **What (types come from what already works — no invented workflows):**
  - Seed catalog from proven manifests: **Ingest & enrich** (RAG ingestion + graph enrich), **Deep report** (LONGVIEW report path), **Book/long-form** (LONGVIEW book path), **Audio overview** (Voicebox pipeline), **Dev pack tasks** (A2), **Knowledge pack tasks** (A3), **Enterprise report** (TOGAF templates — the fixed 6-task shape, not the planner blowup). Workstream R contributes two more types once green: **Reverse-engineer app (SAD)** (R2) and **Modularization blueprint** (R3).
  - Each type = manifest template (fixed DAG shape) + parameter JSON-schema + human-readable card (what it does, inputs, typical duration, example output). **Customization = parameters, source selection, and step enable/disable within the fixed shape.** Changing the DAG shape itself = authoring a new type (agent-assisted, below), never silent template growth.
  - **Guided customization (the guide):** wizard in the shell following C0 progressive-disclosure rules — pick a type card → one decision per screen (sources → parameters with sane defaults → review DAG preview rendered with the dag widget → confirm). Output is a concrete manifest instance; dry-run (`plan` mode) validates before any execution is offered.
  - **Agent-assisted authoring:** "help me build a workflow" hands the request + catalog to an agent (frontier or local via A4) which drafts via `benny pypes plan` into `agent_sandbox/` — advisory, human signs/executes per ADR-001. The agent may compose existing type steps; the schema-level DAG-freeze and a step-count ceiling (default ≤ 12) are enforced at validation, guarding the planner-blowup failure mode.
- **Gate `g3.py`:** every catalog entry instantiates with example params → manifest validates + dry-runs green; wizard produces a byte-identical manifest to the equivalent CLI invocation (parity!); agent-drafted workflow lands only in `agent_sandbox/` and fails validation if it exceeds the step ceiling or mutates a template's DAG shape.

---

## 5. Workstream C — One Prime-Silo (shell, de-brand, adaptive layout)

**Goal:** the app feels like one designed product: calm, modern, spacious, no branding leftovers, no squashed graphs, kind to ADHD/Dyslexic users.

### C0 — Design system contract _(depends on: nothing)_

- **Files:** `app/L0/_all/mod/_core/framework/css/colors.css` (extend, single source of truth), new `framework/css/layout.css`, `framework/css/type.css`, `architecture/DESIGN-SYSTEM.md`.
- **Codify (exact rules the lower model applies mechanically):**
  - **Color:** only `var(--*)` tokens from colors.css. Gate greps for hex literals in new/changed CSS.
  - **Type (dyslexia-friendly):** base ≥ 16px; line-height ≥ 1.5; measure ≤ 70ch; never justified text; generous letter-spacing on all-caps labels; a user toggle `Readable font` swapping to a high-legibility stack (Atkinson Hyperlegible if bundled, else system-ui) persisted in settings.
  - **ADHD / progressive disclosure:** every view has exactly one primary action visually dominant; advanced controls live behind a consistent `More ▸` disclosure; long processes always show a step indicator (`n of m`) + what happens next; no ambient motion — animation only as feedback to user action (mascot micro-states are the sanctioned exception, C5); focus states always visible.
  - **Depth:** remove the global `box-shadow: none !important` (in `mod/_core/visual/index.css`); define 3 elevation tokens.
  - **Layout tokens:** spacing scale, radius scale, pane gap.
- **Gate `c0.mjs`:** stylelint-style script: no hex colors / no `!important` shadows / no `text-align: justify` in `app/L0/_all/mod/_prime_silo/**` and `framework/css/**`.

### C1 — Adaptive layout contract (fixes squashed graphs) _(depends on: C0)_

- **Files:** `framework/css/layout.css`, a new `widgets/pane-contract.js`, targeted edits in `bridge/bridge.css` + the widget wrappers (`force_graph_2d`, `kg3d`, `dag`, `codegraph`, `three_renderer`).
- **The contract:**
  1. Shell → page → pane chain is `display:flex/grid` with `min-height:0` / `min-width:0` at every level (the classic flexbox squash cause) so panes genuinely fill the viewport.
  2. Every visualization widget receives its size from a shared `PaneContract` helper: ResizeObserver on the pane → debounced `resize(width, height)` call into the widget; **no widget reads `window.innerWidth` or hardcodes canvas dimensions.**
  3. Panes are user-resizable where split (drag handles) and remember their split ratio in localStorage.
  4. Container queries (`@container`) for pane-level responsive behavior — a pane at 4K half-screen and a pane on a laptop both look intentional.
- **Gate `c1.mjs`:** preview script loads Bridge + graph views at 1280×800, 1920×1080, 3840×2160; asserts each graph canvas ≥ 90% of its pane's client box and pane chain has no fixed px widths on the ancestors; screenshots archived.

### C2 — Prime-Silo shell _(depends on: C1; ships behind `PRIME_SILO_NEW_SHELL` flag)_

- **Files:** new `app/L0/_all/mod/_prime_silo/shell/` module only (+ route registration).
- **What:** one persistent app frame: left rail with four destinations — **Bridge** (oversight/coordination/live runs), **Studio** (documents/creation, D-workstream), **Observe** (runs, graphs, lifelog), **Setup** — top bar with global status (runtime up/down, model loaded, home dir), consistent page header with breadcrumb, and a single content pane that hosts the existing module views unchanged inside the C1 layout contract. Keyboard: `1–4` switch sections, `?` shows shortcuts.
- **Explicit non-goals:** do not rewrite hosted modules; do not migrate routes; old shell remains default.
- **Gate:** with flag on, all existing module views render inside the shell with no console errors; with flag off, zero behavioral diff (`git diff`-level assurance via route tests).

### C3 — Login + first-run retheme _(depends on: C0)_

- **What:** implement the fixes already specified in `REQUIREMENTS-ui-ux-refactor.md`: strip space gradients from `login.html`, organic palette, "Zen Mode" framing; first-run flow becomes progressive (welcome → pick home dir → services check → done, one decision per screen).
- **Gate:** screenshots + no hardcoded colors + first-run completes in the preview with a fresh profile.

### C4 — De-brand pass (user-facing only) _(depends on: C2)_

- **Files:** the ~40 files from the audit — but **only string literals, titles, alt text, logos, docs prose**. Explicitly forbidden in this phase: `space-desktop:` IPC channel names, `node space` CLI name, `space.js`/module file names, `package.json` `name` fields, upstream `space-agent` references in dependency metadata.
- **Steps:** generate the authoritative hit list with the grep from §0 into `scratch/debrand-audit.md`, classify each hit `user-facing | identifier | vendored`, replace only `user-facing`, check off every line.
- **Gate `c4.mjs`:** case-insensitive grep for `space agent|space-agent` over rendered UI strings, HTML, and docs (excluding the identifier/vendored allowlist file) returns zero; app boots; IPC smoke test passes.

### C5 — Mascot micro-states _(depends on: C0; small, optional-last)_

- Benny idle/listening/processing CSS keyframe states per the requirements doc. Motion-reduced media query honored. (Processing state should reflect real state: bind to G0/coord SSE activity, not a timer.)

### C7 — Cognitive profiles (one-click Sensory & Cognitive Calm presets) _(depends on: C0, C2)_

- **What:** three presets in the shell top bar + Setup dock, built entirely from C0 tokens/settings (no parallel style system):
  - **⚡ Focus (ADHD):** primary CTA visually amplified, secondary panels collapsed, non-essential notifications silenced (recap F4 still collects them), prominent `Step n of m` indicator for active jobs.
  - **📖 Reading (Dyslexia):** high-legibility font stack (C0 Readable-font setting), line-height 1.8, measure ≤ 65ch, plus a **reading ruler** (subtle horizontal highlight tracking cursor/focus to prevent line-jumping).
  - **🌙 Zen:** warm muted contrast from colors.css, all micro-animations off (mascot included), terminal/log tails collapsed into plain-language bullet summaries.
  - Profiles persist per user, are composable with the base theme, honor `prefers-reduced-motion`, and the website's Neuro-Assist dock (E0) mirrors the same three names so product and site tell one story.
- **Gate:** each profile toggles via one click and via the palette (F1); a DOM audit script asserts each profile's measurable properties (font stack, line-height, animation count = 0 in Zen, single amplified CTA in Focus); profiles survive reload; WCAG contrast maintained in all three.

### C6 — Shell parity + default flip _(depends on: C2, C3, C4, B3, G2-UI)_

- Parity checklist (every old-shell capability reachable in new shell) written and verified; flag default flips on; old shell kept one release behind a `legacy` flag.
- **Gate:** parity checklist 100%; all prior C-gates re-run green.

---

## 6. Workstream D — Studio (NotebookLM feel)

**Goal:** a document-grounded workspace: bring sources in, understand them, produce artifacts — with the same progressive, low-cognitive-load discipline.

### D1 — Studio spec _(depends on: C2)_

- **Files:** `architecture/SPEC-studio.md` + clickable HTML mock in `agent_sandbox/views/`.
- **Layout (three zones, NotebookLM-style):** left **Sources** rail (documents in the knowledge store, per-source include/exclude toggles, add-source drop zone → existing ingestion pipeline); center **Chat** grounded in RAG over the _selected_ sources with **inline numbered citations that open the source at the passage**; right **Outputs** rail — generated artifacts as cards.
- **Output types (each wraps an existing pipeline — build no new generation code):** Summary & FAQ (A3 `summarize_doc`), Report/Deep-dive (LONGVIEW report path), **Audio Overview** (report → Voicebox Kokoro pipeline from v1.11.0), Study cards (A3 `card_gen`). After G3, output cards are simply workflow-type instantiations — the Studio buttons and the wizard converge.
- **Progressive discovery:** empty state teaches by doing ("Drop a PDF to begin"); after first source, suggest exactly 3 actions; every long generation shows staged progress (its G0 DAG, rendered compactly) and lands as a card, never a modal wait.
- **Gate:** spec reviewed by human (this is the one human-gate in the plan).

### D2 — Studio: sources + grounded chat _(depends on: D1, A3)_

- Reuses existing Ask-the-docs RAG chat and ingestion; adds source-scoping + citations-with-passage-jump.
- **Gate:** scripted: ingest 2 known docs, ask a question answerable only from doc 2 with doc 1 deselected → answer cites doc 2 only; citation click opens correct passage.

### D3 — Studio: outputs rail _(depends on: D2, G3 preferred)_

- The four output cards wired to their pipelines via workflow types (G3) and the coordination ledger (each generation is a ledger task with a `run_id` → visible in Bridge too).
- **Gate:** each output type produces a real artifact from the test corpus; Audio Overview yields a playable WAV.

---

## 7. Workstream E — Website (rebuilt after the 2026-07-05 live-site design review)

**Owner decisions locked (rev 5):** voice = **honest local-first tool** (drop the "Sovereign AI Agent OS / institutional cognition" register); the 5 scroll-cinema acts are replaced by **one real demo moment**; the token calculator and all unvalidated %/$ claims are **removed until validated** by the honest count_tokens v2 harness; delivery flow = **brief → 3 mocks → owner picks → mock becomes the acceptance contract**.

**Keep from the current site (it earned it):** the earth-tone palette (unify with C0 tokens — same family already), the **Neuro-Assist dock** (readable-font/bionic/line-spacing toggles; align its implementation with the app's C0 `Readable font` setting), the authentic TUI visual accents, and the SEO/OG/JSON-LD hygiene (with rewritten, honest copy).

### E0 — Design brief + claims registry _(depends on: nothing for the brief; screenshots need C2)_

- **Files:** `website/DESIGN-BRIEF.md` (new), `website/claims.json` (new), `scripts/gates/e0.mjs`.
- **The brief locks the words before any code** (copy is where vision drifts; the implementing model builds, it does not write):
  - Full copy deck: hero — _"A local-first AI workbench. Your documents, your models, your machine."_ — every headline, card sentence, CTA label, and the accessibility statement, pre-written and owner-approved.
  - Page structure (wireframe order): hero + real shell screenshot → three "what you can do" cards (Studio: understand your documents / Bridge: watch agents work / Offload: your hardware does the heavy lifting) → one architecture diagram (deterministic SVG, R2-style — not model-drawn) → **one real demo moment** (recorded cast of the actual BennyTUI or real Bridge run — captured from the product, never simulated) → accessibility statement + Neuro-Assist → download buttons per platform (latest GitHub release assets) + quickstart snippet → footer.
  - Design constraints restated as checkable rules: C0 tokens only; single primary CTA (Download); motion only on user interaction; `prefers-reduced-motion` honored; no CDN assets (self-host everything, per Q1 supply-chain rules); ≤ 70ch measure; no fabricated data anywhere in markup.
- **The truth policy (structural honesty):** `claims.json` is the registry — every numeric or comparative claim on the page (`%`, `$`, "×", "fastest", counts) must have an entry: `claim`, `source` (in-repo script, gate output, or validated benchmark), `verified_date`. **The current site's token-economics numbers do not qualify** (the v1 benchmark was found invalid; v2 harness is blocked) — they are removed, not reworded. The calculator returns only if/when v2 produces real data.
- **Gate `e0.mjs`:** brief exists with owner-approval line; claims gate runs against current `website/` and **fails** (proving it catches the existing violations) — it must pass against the rebuilt site in E2.

### E1 — Three static mocks, owner picks _(depends on: E0; real screenshots need C2)_

- **Files:** `website/prototypes/mock-a|b|c/` (static HTML/CSS only, shared C0 token file, no JS beyond the demo-moment placeholder).
- Three variants of the same brief (e.g., editorial-calm / product-shot-forward / TUI-flavored), each fully responsive, screenshotted at 390/1280/1920. **Owner reviews the screenshots and picks one** (second human gate in the plan, mirroring D1). The chosen mock's screenshots are archived as the **acceptance contract**.
- **Gate:** all three mocks pass the claims gate + C0 token lint + reduced-motion check; owner's pick recorded in the brief.

### E2 — Build + ship _(depends on: E1)_

- **Files:** `website/` rebuilt to the chosen mock. Delete `website/prototypes/` losers (keep the winner as reference), delete stale `site/` dir (deletion — flag in PR description).
- Implementation must match the contract screenshots within tolerance at all three widths; download links resolve to latest release assets per platform.
- **Demo moment is captured through the product's own MCP, not screen-recorded by hand:** `website/scripts/capture-demo.mjs` drives a real catalog workflow via the verbs/MCP surface (`offload_exec` or a G3 type against the fixture corpus, offline), records the actual G0 event stream + TUI output as a replayable cast, and exports Bridge screenshots. The site _replays a real run_ — never simulates one — and the capture script re-runs at each release so the demo can't go stale. (Until G2/G3 exist, an interim cast of a real `benny pypes` run of an existing manifest is acceptable; the script upgrade lands with G3.)
- **Gate `e2.mjs`:** visual match vs contract screenshots; Lighthouse ≥ 90 all categories; zero external requests (no CDN); claims gate green; link checker green; zero "Space Agent" strings; deploy-pages workflow publishes it.

---

## 8. Workstream R — Reverse-engineer an application → TOGAF SAD → modular-service blueprint

**Goal:** point Prime-Silo at _any_ application repo and get, offline: a full ingestion + knowledge/code graph of it, a **TOGAF-compliant Solution Architecture Document with diagrams** at the depth we reached on prime-silo itself — and beyond, now that the 16k local model allows much larger evidence windows — and then, as an extension of the same DAG, a **modular-service translation blueprint** (how to decompose the app into services and migrate safely).

**Grounding rule for the whole workstream (the anti-hallucination contract):** every claim in every generated document must cite graph node ids (files, symbols, endpoints, tables) that _exist in the ingested graph_. Deterministic extractors produce the facts; the local model only narrates and organizes them. A claim without a resolvable citation fails validation — this is checked by script, not judgment.

### R0 — Target-app ingestion profile + baseline _(depends on: A1)_

- **Files:** `architecture/SPEC-reverse-engineering.md` (new), `manifests/reveng/ingest_app.json` (new, fixed-shape pypes DAG), `runtime/` extractor generalization, `scripts/gates/r0.py`.
- **What:** generalize the existing ingestion + `benny enrich` code graph from "prime-silo analyzing itself" to an arbitrary `target_repo` parameter. The ingest DAG (fixed shape): `inventory` (file census, languages, LOC, build files) → `static_extract` (deterministic: AST symbols, imports/dependency edges, entry points, routes/endpoints, DB schemas/queries, config surface, external calls) → `doc_ingest` (README/docs/diagrams through the existing RAG + VIS-001 vision pipeline) → `graph_build` (typed nodes/edges in the knowledge store, namespaced per target app) → `narrate` (local model via A1 windowing writes short component descriptions, each citing node ids) → `coverage_report` (what % of files/symbols are graphed and narrated — honest gaps listed).
- **Baseline fixture:** a small known app from this monorepo (e.g. `binary16/chattabot` or `audio-converter-ui`) checked into the gate as the golden target. The fixture's expected inventory (file count, endpoint list) is recorded so extractor regressions are caught exactly.
- **Gate `r0.py`:** run against the fixture → graph contains every known endpoint/entry point of the fixture (recall check against a hand-verified list); coverage report ≥ 90% files inventoried, gaps honestly listed; all narration citations resolve; run is a valid G0 event stream once G0 lands.

### R1 — Evidence dossiers at 16k _(depends on: R0)_

- **Files:** `manifests/reveng/dossiers.json`, `runtime/brain/` dossier assembler, gate.
- **What:** the step that the 16k window newly enables — per architectural view, assemble a large _evidence dossier_ in code (graph queries, not model output): Business view (features/user flows inferred from routes+docs), Application view (components, dependencies, interfaces), Data view (schemas, stores, flows), Technology view (runtimes, infra, build/deploy). Each dossier is fed to the local model in windows (A1) to produce per-view findings: responsibilities, coupling hot-spots, risks, external contracts — every finding citing node ids. Dossier assembly is deterministic; only findings-prose is model-generated.
- **Gate:** dossiers for the fixture are reproducible byte-identical from the same graph (determinism); findings validate (schema + citation resolution); a poisoned dossier entry (planted fake node id) is caught by the citation gate.

### R2 — TOGAF SAD generation with diagrams _(depends on: R1; catalog entry needs G3)_

- **Files:** `manifests/reveng/togaf_sad_app.json` (evolves the existing `togaf_sad_*` templates into a target-parameterized type), diagram generators in `runtime/`, gate.
- **What:** fixed-shape DAG (respect the 6-task-template lesson — sections are fixed, the _target_ is the parameter) producing a TOGAF-structured SAD: Architecture Vision, Business / Application / Data / Technology architecture sections (from R1 dossiers), Interface catalog, Constraints & risks, Gaps & recommendations, Compliance appendix mapping each section to its TOGAF ADM artifact.
  - **Diagrams are deterministic artifacts, not model drawings:** generated from graph queries as Mermaid/Graphviz sources rendered to SVG — context diagram, component/dependency diagram, data-flow diagram, deployment diagram. The model may _select and caption_ diagrams, never invent boxes. (Optional, flagged: the VIS-001 vision judge scores rendered diagrams for legibility, advisory only.)
  - Output: one SAD (markdown → existing PDF path) + diagram SVGs + a machine-readable `sad.json` (sections, claims, citations) that R3 consumes.
- **Gate `r2.py`:** fixture SAD contains every required TOGAF section (checklist); 100% of claims cite resolvable node ids; every diagram source compiles and every referenced node exists; interface catalog exactly matches the graph's endpoint set (no invented endpoints — set-equality, both directions); registered as a G3 catalog type that instantiates and dry-runs green.

### R3 — Modular-service translation blueprint _(depends on: R2)_

- **Files:** `manifests/reveng/modularize.json`, `runtime/` boundary analysis, gate.
- **What:** extends the same DAG beyond the SAD. Deterministic analysis first: candidate service boundaries from the code graph (community detection on the dependency graph + coupling/cohesion metrics + data-ownership analysis of which code touches which stores); seam inventory (shared tables, god modules, synchronous call chains that would become network hops). The local model then narrates, per candidate service: purpose, owned data, exposed interface (drawn from the actual endpoint/call graph), and migration order — composed into a **Modularization Blueprint**: target architecture diagram, strangler-fig migration plan (which seam to cut first and why), per-service one-page specs, risk register, and draft ADRs. All of it advisory, written to `agent_sandbox/drafts/reveng/<run_id>/` — humans decide; nothing touches the target repo.
- **Explicit non-goal:** generating the migrated code. Scaffolding generation is a later type built on A2 once a blueprint has been human-approved.
- **Gate `r3.py`:** fixture blueprint: every proposed service maps ≥ 95% of the fixture's code files to exactly one service (no orphans, no double-ownership without an explicit `shared` designation); every proposed interface corresponds to an existing call edge in the graph; migration steps form a DAG with no forward references; citation gate passes; registered as a G3 catalog type.

---

## 9. Workstream Q — Security, SRE & quality pipeline

**Goal (P7):** the product is secure by default, builds are reproducible, every release is boot-verified before it ships, and the pipeline makes regressions impossible rather than merely detectable.

### Q0 — Security remediation (known issues, fix NOW) _(depends on: nothing — fifth zero-dependency starter, do in week 1)_

- **Files:** `package.json`/lockfile, `runtime/benny/api/studio_executor.py` (+ its client/tests), `server/app.js` + `server/runtime/cluster.js` + docs mentioning HOST, ADR-003 follow-up files, `scripts/gates/q0.mjs`.
- **Steps:**
  1. `npm audit fix` → lodash + js-yaml patched; verify proxy tests still green. If a transitive pin blocks the fix, use `overrides` in package.json — never ignore the advisory.
  2. Remove the `benny-mesh-2026-auth` literal: mesh/A2A auth reads from the existing per-install key mechanism (v1.2.6 path) or env; fail-fast with a clear error when absent (matching the fail-fast-keys pattern from the 2026-06-24 remediation). Rotate: treat the old value as burned.
  3. Default bind → `127.0.0.1`. LAN exposure becomes explicit opt-in (`HOST=0.0.0.0` env / config with a logged warning). Update docs/llms-full.txt examples.
  4. Close the ADR-003 residual same-origin isolation gap (scoped as documented in the code-review remediation notes).
- **Gate `q0.mjs`:** `npm audit --audit-level=moderate` exits 0; repo-wide grep for the burned key returns 0; server started with no HOST env answers on loopback and refuses/never listens on external interfaces; ADR-003 follow-up test passes.

### Q1 — Reproducible supply chain _(depends on: Q0)_

- **Files:** `runtime/requirements.txt` → add `runtime/requirements.lock` (pip-compile/uv, hashes on), CI + packaging install from the lock; `.github/dependabot.yml` (weekly, grouped); SBOM step (CycloneDX for npm + pip) attached to release artifacts.
- **Rule going forward:** direct deps state intent (`>=`), the lock states truth; both committed. New dependency = one justification line in the PR (what it's for, why stdlib/existing deps can't).
- **Gate:** clean-machine install from lock succeeds offline-from-cache; two consecutive CI runs produce identical dependency trees; release artifact contains SBOMs.

### Q2 — CI quality gates (make lint.yml a real quality wall) _(depends on: Q1)_

- **Files:** `.github/workflows/lint.yml` (extend), new `security.yml`, `scripts/gates/run-touched.mjs`.
- **Add to CI, all blocking:**
  1. **Python test suite** (`runtime/tests/`, pytest) — it currently never runs in CI. Real-service tests run against **recorded-tape fixtures (VCR pattern, `runtime/tests/fixtures/tapes/`)**: under `CI=true` the HTTP clients for lemonade (:13305), Voicebox (:17493), and OpenLineage replay golden recorded responses — deterministic, offline, no GPU runners. Live-service verification stays in the phase gates (A0 etc.). Tapes are re-recorded by a documented script, never hand-edited.
  2. **Node tests** beyond the three proxy tests: run everything in `tests/`.
  3. **Plan gates:** `run-touched.mjs` maps changed paths → workstream → runs that workstream's `scripts/gates/*` (hermetic subset). A phase's gate lives in CI from the day it lands, so protocol rule 3 is enforced by machine, not discipline.
  4. **Security wall:** `npm audit --audit-level=moderate` + `pip-audit` against the lock + **secrets scan wired from the existing `runtime/benny/governance/portability/secrets_scanner.py`** (it exists, tested, and is not in CI — the cheapest win in this plan) + CodeQL (js + python, default queries).
  5. **Verifier-audit gate (`scripts/gates/audit-delivery-log.mjs`):** parses `delivery/board/LOG.md` (later: the B-ledger) and **fails CI if any `verified-by` agent matches the author of that task's `claimed`/`authored` events** — the author≠verifier rule mechanized in hardware, not prompts. Also fails on DONE entries with no verifier event. (This script is small enough to author alongside Q0 and run locally before Q2 wires it into CI.)
  6. **Path/encoding lint — targets the #1 measured failure class (52 of 354 card-corpus failures):** ship a shared path utility (Node + Python: normalize separators, no raw concatenation, UTF-8 explicit on every file open) and a lint rule banning `+`/f-string path building and default-encoding `open()` in `runtime/benny/**` and `server/**`; new code must use the utility. Ratchet like coverage: existing violations recorded as the floor, count only goes down.
  7. **Coverage ratchet:** record current line coverage as the floor; CI fails if coverage drops below the recorded floor; the floor only moves up (small honest steps, no target theater).
- **Gate:** a PR that introduces a moderate-severity dep, a committed fake secret, or a coverage drop is rejected by CI (verify with three deliberate canary PRs, then close them).

### Q3 — SRE: release honesty + operational health _(depends on: Q2)_

- **Files:** `.github/workflows/release-desktop.yml` (extend), `server/` + `runtime/` health endpoints, `DEVOPS.md`, `architecture/RUNBOOK-release.md` (new).
- **What:**
  1. **Boot-the-artifact smoke:** release workflow unpacks each built artifact and runs the existing `desktop:localtest` boot check (server answers 200, runtime supervisor starts, `/api/home` resolves) — the v1.2.8 broken-installer failure becomes structurally impossible. Snapshot builds run the same smoke on one platform.
  2. **Health surface:** one `/healthz` per process (server, runtime) returning component status (home resolved, model endpoint reachable, memoray reachable) — the shell's C2 top-bar status and `doctor` read this; no second health path.
  3. **Structured logs + error budget:** runtime + server log JSON lines with `run_id`/`node_id` correlation (aligns with G0); crash/wedge events (`wedge_suspected` from A0) are counted in the activity store so the Bridge can show "3 wedges this week" honestly.
  4. **Runbook:** codify the hard-won release rules — tag/commit ordering (v1.2.4 lesson), build guard (v1.2.9 lesson), rollback = delete release + refit as next patch (never reuse a tag) — as `RUNBOOK-release.md` steps with check commands; the devops-pipeline skill points at it (§11).
- **Gate:** deliberately broken artifact (missing runtime asset) fails the release smoke; `/healthz` degrades honestly when lemonade is stopped; runbook dry-run executed once by a fresh agent session using only the doc.

### Q-rules — additions to the Execution Protocol (apply from now on, all workstreams)

11. **No new secrets in code, ever.** Secrets come from env or the per-install keystore; the CI secrets scan is the enforcement, fail-fast-on-missing is the pattern.
12. **Forbidden constructs** (CI-linted): `eval`, `new Function`, `child_process` with `shell: true` or string-built commands (array-args `spawn` like `workflows_run.js` is the sanctioned pattern), lodash `_.template` on non-literal input, unpinned `pip install` in workflows, YAML load without safe loader.
13. **Every new API endpoint** declares input validation (JSON-schema at the boundary) and an authority level; once G2 lands, new endpoints go through the verbs registry or state in the PR why not.
14. **Localhost by default.** Anything that listens binds loopback unless the user explicitly opts into LAN exposure.

---

## 9.5 Workstream F — Product features, wave one (P8)

**Goal (P8):** the workbench stops being something you drive and starts working with you: everything findable in one keystroke, workflows that run themselves, attention respected instead of demanded, and honest numbers about what the system did. Every feature here **consumes** infrastructure the plan already builds (verbs registry, catalog, event stream, ledger) — none of them may build a parallel mechanism.

### F1 — Global command palette (Ctrl+K) _(depends on: C2, G2)_

- **What:** one palette over everything: **verbs** (from the G2 registry, filtered by authority — human-only verbs appear as prepared-commands), **navigation** (shell sections, module views), and **nouns** (documents, runs, ledger tasks, graph nodes via existing search APIs). Fuzzy match, keyboard-first, recent-items on empty query. ADHD rule: the palette is the _primary_ navigation affordance — anything reachable by clicking must be reachable by typing.
- **Gate:** scripted: every registered verb and every shell destination is reachable from the palette; a fixture document, run id, and task id each resolve as results; palette opens < 100 ms; fully keyboard-operable (no mouse in the test).

### F2 — Model garage _(depends on: A0; panel lives in Setup, needs C2)_

- **What:** a Setup panel that makes local-model ops non-arcane: installed models list (from lemonade + FLM inventory), health/loaded state, context size, one-click load with the correct `recipe_options` (the 16k lesson codified into UI), **wedge detection surfaced from the A0 watchdog with a supervised one-click restart** (explicit user action — never automatic, per the H-deferral), and a small throughput benchmark ("this machine: N tok/s") whose result is stored and shown. The router matrix reads live health from here.
- **Live compute telemetry (the "never Task Manager again" rule):** the garage (and the Bridge Pulse view) shows real-time NPU/GPU/CPU utilization per compute target plus the model process state (loaded/prefilling/generating/idle/respawned — from the A0 probe + G0 heartbeats). During any run, a user glancing at the app can tell _the hardware is working_ even when no output has landed yet — the 2026-07-05 incident where output silence looked like a wedge while the NPU was visibly busy must be diagnosable in-app.
- **Heterogeneous targets + power awareness:** benchmarks are per compute target (NPU/GPU/CPU — the lemonade/FLM stack spans all three), each with its recorded power figure feeding F5's energy accounting; on battery, the garage flags heavy work and F3 schedules defer discretionary runs to AC power. The garage's capability report (model × target × ctx × tok/s) is what A6's sovereignty gradient and the router consume — and rendered as a plain-language scorecard it answers the question every local-AI user actually has: _"which model should I run for my tasks on my hardware?"_ (honest, task-grounded, reproducible — the anti-leaderboard).
- **Test Drive (after G3):** pick any catalog workflow type in the garage, click Test Drive → it runs against the golden calibration fixture on the selected local model and shows a side-by-side scorecard: judge quality score vs the calibration baseline, tok/s, memory, energy estimate. Calibrates expectations _before_ a user commits real work to their hardware — confidence built by evidence, not marketing.
- **Gate:** with lemonade stopped, garage shows honest `down` state and the restart affordance; benchmark produces a stored, dated result; load-model round-trip verified against `/api` with the ctx size asserted.

### F3 — Watched folders + scheduler _(depends on: G3; B1 for task events)_

- **What:** two triggers for catalog types: **watched folders** (`PRIME_SILO_HOME/inbox/<type>/` — a file landing there instantiates the mapped workflow type with the file as source; the classic use: drop a PDF → auto-ingest) and a **scheduler** (cron-like entries in `PRIME_SILO_HOME/schedules.json`: nightly LONGVIEW delta, weekly graph enrich, release-time demo re-capture). Both go through the same path as manual runs: a ledger task + a G0 run — no side-door execution. Determinism boundary respected: **only human-signed catalog types are schedulable**; agents may draft schedule entries but a human enables them.
- **Gate:** drop fixture file → ingest run appears in ledger + Bridge without manual action; schedule entry fires at the scheduled tick (test clock) and produces a normal G0 run; an unsigned type in a schedule entry is refused at validation.

### F4 — "While you were away" recap _(depends on: G0, B1; renders in shell, C2)_

- **What:** on app open (and optionally as a tray notification when the app is backgrounded), one calm card folding the G0 stream + ledger since last-seen: runs finished (with one-line honest outcomes), tasks completed/blocked per agent, wedges or failures, and **things awaiting your signature** at the top. One primary action per item (open run / sign / dismiss). C0 discipline: this is the _replacement_ for polling dashboards, so it must be complete — anything not in the recap didn't happen.
- **Gate:** scripted: finish a run + block a task while "away" (last-seen timestamp rewound) → recap shows exactly those two items with correct outcomes; empty-state shows nothing rather than filler; dismissed items don't return.

### F5 — Honest usage meter _(depends on: G0)_

- **What:** the real version of the deleted website calculator, inside the product: fold G0 telemetry into per-day/per-workflow/per-model totals — tokens processed locally vs sent to cloud endpoints, wall time, run counts, wedge counts. Rendered in Observe; exportable as JSON. **This is the designated data source for any future public claim** — when a number here is stable and methodology-documented, it can enter `website/claims.json` (E0) with this meter as its source.
- **Sustainability accounting (P9):** the meter also estimates energy per run — local inference: measured wall time × the F2 garage benchmark's tok/s × a per-machine power figure (user-entered TDP or measured, recorded with the benchmark); cloud calls: published per-token energy-intensity estimates, source cited in the methodology doc. Rendered as watt-hours and estimated g CO₂e per run/day/workflow, always labeled _estimate_ with the methodology one click away. Same honesty rules as everything else: no figure without a documented method, and any public use goes through `claims.json`. This is a real product differentiator — nobody in this space shows users the environmental cost of their AI work, and local-first is the story's natural winner.
- **Gate:** synthetic event stream with known totals folds to exactly those totals; local-vs-cloud split matches the router ledger for a real A2 pack run; energy fold on a synthetic stream with known parameters reproduces hand-computed watt-hours; export validates against a schema; methodology doc exists and every constant in it is sourced.

### F6 — Run diffing _(depends on: G0; UI in Observe, C2)_

- **What:** compare two runs of the same manifest: per-node status/duration/attempt deltas, artifact content-hash changes (with text-diff drilldown for text artifacts), judge-score deltas, telemetry deltas. CLI (`benny runs diff <a> <b>`) and Observe view render the same comparison (G2 parity discipline). After Workstream R: diffing two SAD runs of the same target = an **architecture drift report** for free.
- **Gate:** two fixture runs with a known planted difference (one changed artifact, one slower node) → diff reports exactly those; identical runs diff to empty; CLI and UI outputs agree on the same fixture pair.

### F7 — Backup & restore of PRIME_SILO_HOME _(depends on: B0/G0 storage layout settled; scheduling via F3)_

- **What:** `benny home snapshot` produces a dated, hash-manifested archive of PRIME_SILO_HOME (graphs, ledger, runs, knowledge, config — secrets/keystore explicitly excluded and listed as excluded); `benny home restore <snapshot>` verifies every hash before touching anything and refuses partial restores. Setup panel exposes both plus a scheduled-backup toggle (an F3 schedule to a user-chosen destination — second disk, NAS path). A local-first product holding all user data with no cloud safety net ships this or it isn't trustworthy (§1.6 NFR).
- **Gate:** snapshot → corrupt one file in the archive → restore refuses with the file named; clean restore to an empty home reproduces byte-identical graphs/ledger; secrets verified absent from the archive; scheduled backup fires via the F3 test clock.

### F8 — Sovereignty Shield (live air-gap indicator) _(depends on: C2, F5; pairs with A6 + §1.6 zero-phone-home)_

- **What:** a live top-bar chip that **watches actual socket state** of the Node server and Python runtime (psutil/OS-level, not self-reporting): all connections loopback → solid **"🛡️ 100% Local"**; a configured remote fallback active (A6 tier 3) → **"🌐 Hybrid — cloud fallback active"**; clicking the chip opens the real-time egress audit: which runs sent what token counts to which endpoint (fed by F5/G0 `remote` attribution). This turns the zero-phone-home NFR from a CI claim into something the user _watches being true_ — the single most credible sovereignty feature the product can ship.
- **Gate:** with only local services running, chip reads 100% Local and the socket audit shows loopback-only; triggering one mock remote call flips the chip within 2 s and the egress log shows exactly that call's endpoint + token counts; no third state ever shows "local" while a non-loopback socket is open (property test).

### Milestone 2 — committed second wave (documented now so it is not lost)

These are **committed, not deferred** — they enter as wave-one phases in the first plan rev after C6 (shell parity) lands. Recorded here with their design intent so no future session re-derives them:

| M2 id | Feature                                                                | Design intent (one paragraph, binding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Builds on                                                    |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| M2-1  | **Voice in Studio**                                                    | Voicebox already does both directions; wire it conversationally: dictate a question into Studio chat (transcribe), read any answer or artifact aloud (TTS, profile-selectable). A marquee dyslexia feature hiding in an existing service. Push-to-talk, never always-listening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Voicebox :17493, D2                                          |
| M2-2  | **Feedback → judge calibration loop**                                  | Thumbs-up/down on every offload artifact appends to a per-task-type golden set; the judge gate recalibrates against the growing set on a schedule (an F3 scheduled workflow). Makes quality compound instead of being a one-time A0 calibration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A2/A3, F3                                                    |
| M2-3  | **Sealed exports** (immutable, lineage-complete, ontology-transparent) | Export any Studio/R artifact as a **sealed document**: (1) _immutable_ — content-addressed (hash tree over content + attachments), signed with the per-install key; any modification breaks the seal, verifiable offline by a small standalone verifier tool shipped with the product; (2) _lineage-complete_ — embeds the G0 lineage fold for the artifact (which runs, nodes, models, and sources produced it, with content hashes); (3) _ontology-transparent_ — embeds an ontology manifest: every concept/term the document relies on, resolved to its knowledge-graph node with definition and provenance, plus a **completeness attestation** (which sources were included/excluded from the corpus, coverage %, honest gaps — the R0 coverage-report pattern); (4) _transparent method_ — model ids, capability profiles, judge verdicts, prompt hashes. **C2PA content credentials** embedded in rendered forms (PDF/audio) so provenance survives outside prime-silo. Same seal mechanism later signs shared workflow types. This is the product's trust artifact: a document that carries its own audit. | R2 `sad.json`, G0 lineage fold, R0 coverage, per-install key |
| M2-4  | **First-run sample corpus + guided tour**                              | Ship 3 sample docs + 1 sample repo; first-run Studio suggests exactly three actions on them ("generate an audio overview of these"). Progressive discovery needs something to discover on day one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | D1–D3, G3                                                    |
| M2-6  | **Institutional memory mesh** (graph sync to memo-ray)                 | B-workstream knowledge notes and R-workstream graph builders emit semantic triples (`[Symbol] CALLS [Endpoint]`, `[Doc] EXPLAINS [Component]`) into memo-ray via its MCP server — insights from reverse-engineering and coordination become permanently searchable institutional memory, not transient workspace state. Caution flags: memo-ray is a deliberately-kept vendored fork (re-vendor discipline) and its embedder has wedged before — emission must be async/queued, never inline in ingest hot paths (the Marquez lesson applies).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | B0 knowledge format, R0 graph, memoray/mcp-server            |
| M2-7  | **Architecture Drift Radar**                                           | Periodic R0 graph snapshots of a connected repo + the F6 diff engine, rendered as a timeline: scrub months and watch the dependency graph evolve, with new god-modules, circular dependencies, and broken interface boundaries highlighted. The "diff two SADs" idea made continuous and visual — a feature engineering leaders would pay for on its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | R0–R2 snapshots, F6 diffing, kg3d/dag widgets                |
| M2-8  | **Operator profile + Career Dossier**                                  | Surface the (A7-normalized) operator rollup as an "About you" panel — top traits with session-evidence links, capability-domain radar over time — and use it product-wide: judge acceptance criteria, F4 recap tone, C7 default-profile suggestion, G3 wizard defaults (e.g. dry-run-first for a validate-before-execute operator). The flagship output: **Career Dossier** — a Studio output type generating quantified, evidence-linked achievement bullets from capabilities/outcomes rollups, every claim citing its session (sealed via M2-3). The operator's own "measured claims over assertions" standard, applied to their CV — uniquely possible because prime-silo holds the provenance. Personal-partition rules (A7) apply throughout.                                                                                                                                                                                                                                                                                                                                                                 | A7 rollups, M2-3 seals, D3                                   |
| M2-5  | **Compliance dossier export**                                          | One-click export mapping a project's runs, artifacts, and governance events to the record-keeping obligations of EU AI Act / ISO 42001 / NIST AI RMF: model inventory (garage), lineage per artifact (G0 fold), human-approval records (signatures, human-only verb confirmations), incident log (wedges, failures, blocked events), data-source register (ingestion + coverage). Built as an R2-style fixed-shape manifest producing a sealed M2-3 document. Sovereignty + auditability is what regulated EU buyers are shopping for — this makes prime-silo the _easiest_ way to run governed AI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | M2-3 seals, G0, B-ledger, F2 inventory                       |

_Reviewed and consciously skipped (revisit only if the pain shows up):_ in-app auto-update (let Q3 release smoke settle first), audit-log viewer UI (Observe + G2 run view cover most of it), multi-machine access and multi-project workspaces (both would destabilize B0/G0 storage decisions — H-deferred).

---

## 10. Memory & skills updates (keep the agent layer in sync with the product)

The plan changes what agents can do; the agent-facing docs, skills, and persistent memory must move in lockstep or future sessions will work from a stale world-model.

**Repo docs (update in the same PR as the capability):**

- `CLAUDE.md` current-status: one line per landed phase that changes agent-facing behavior (protocol rule 9).
- `AGENT-AWARENESS.md` + `AGENTS.md`: after **G2**, the verbs registry's `agent-ok`/`human-only` table becomes the authoritative authority list — rewrite the CAN/CANNOT section to point at it instead of a hand-maintained list. After **B2**, document the coordination ledger as the required way to claim work.
- `HOME-DIRECTORY.md`: document `coordination/` (B0) and `runs/<run_id>/events.jsonl` (G0) as owned subtrees.

**Skills (`prime-silo/.claude/skills/`):**

- **Extend `devops-pipeline`** with the Q2 CI gates, the Q3 release smoke, and a pointer to `RUNBOOK-release.md` (after Q3).
- **New `phase-runner` skill** (after B1): the Execution Protocol §1 operationalized — how to pick up a phase card, run dependency gates, respect allowlists, write blocker events, and the §1.5 author≠verifier handshake. This is the skill a Haiku/Sonnet session loads _first_; it makes the protocol self-serve instead of relying on the model re-reading this whole plan. **Dual-form rule (§1.5):** authored once, rendered into both `.claude/skills/phase-runner/SKILL.md` (Claude Code) and `delivery/AGENTS.md` (Antigravity — local owned doc, one index line in root `/AGENTS.md`) by a small build step — never two hand-maintained copies. Once stable, bundle skills + the B2 MCP server config as a **Claude Code plugin** so any machine gets protocol + coordination tools in one install.
- **New `coord-ledger` skill** (after B2): claim/heartbeat/report/note with exact commands, and the rule that unclaimed work is untouchable.
- **New `offload-tasks` skill** (after A4): when to delegate to the local model, the task catalog, honest-failure handling (wedge, red-route).
- **Update `benny-pilot` / onscreen-agent SKILL.md** (after G2): Benny commands via the verbs registry; human-only verbs are prepared-not-executed.

**Persistent agent memory (Claude's memory directory):**

- The plan pointer memory is updated at each rev (done through rev 4). Going forward: after each **workstream** completes (not each phase), update the memory entry with outcomes + non-derivable lessons only — everything derivable from the repo (which phases are ticked, what the code does) stays out of memory, per the existing memory discipline.
- When Q0 lands, the burned `benny-mesh-2026-auth` value and the loopback-default decision get one line in the code-review-remediation memory (they amend ADR-003 context future sessions rely on).

---

## 2.6 Workstream ML — Lineage closure (KR2.2, KR2.4) · plan rev 2026-08-03

`architecture/REVIEW-delivery-lineage-2026-08-03.md` found three of four hops open between a delivery
decision and the lineage DAG: the board is markdown rather than the B0 ledger; L5's `fromCoordEvent`
mapper is dead code in production; and the dashboard's `lineage.mjs` has no coordination source at all.
This is **not new scope** — KR2.2 already required "every run is one event stream = progress +
telemetry + lineage", and KR2.4 asks for an audit "of board/LOG.md / ledger" that cannot be run while
delivery verification lives in prose. Phases: **B4** board→ledger · **B5** register projection (wiring
the existing mapper) · **L15** OpenLineage RunEvents + a coordination source in the DAG · **L16** move
the dashboard out of never-committed `scratch/` into a versioned, gated path.

## 2.7 Workstream M — Model plurality (KR1.6) · plan rev 2026-08-03

Source: `architecture/SOLUTION-model-plurality.md`. EP-T closed KR1.5 (a house model beats its base),
but the estate cannot rank *two* engines on its own agent loop: `run_multi_model` carries eight agentic
metrics and has never produced a real one, because `hook` defaults to a stub returning zeros. Phases
**P0–P4** and **P6** build one instrument (a subject = a persona→model assignment plus serving topology; no
composite score; `unmeasured` never rendered as `0.0`), and **P5** trains the first new base, E4B alone.
Task ids are P-prefixed because M-prefixed ids are milestone-scoped (`M2-1`..`M2-8`). GRPO stays blocked
by R15; Gemma-12B stays deferred pending P5.

**Split, 2026-08-04 (owner decision):** the original P1 measured 673 changed lines against a budget of
550. It is now **P1** (the metric schema — `unmeasured` structurally distinct from `0.0`, `hook=None`
raises, unavailable rows carry a reason) and **P6** (the executor hook — a subject driven through the
manifest, the run-event stream folded into the eight fields). P6 is numbered out of sequence because
contract ids must match `[A-Z]\d+` and `P1a`/`P1b` are invalid; ordering is carried by deps. P2 now
depends on both.

## 11. Workstream H — Deferred (explicitly OUT of scope now)

- Internal identifier rename (`space-desktop:` IPC, `node space` CLI, file names) — alias-first design sketched in a future ADR; do not attempt opportunistically.
- Ledger and run-event compaction/retention tooling.
- Multi-machine coordination (ledger is single-home for now).
- Auto-restart of a wedged lemonade service (needs a supervisor decision with the owner).
- Migrating legacy AER/governance event readers off their current path (only after G0 parity holds through a full release cycle).
- Visual drag-and-drop DAG _editing_ in `workflow_designer` (G3 wizard customizes parameters/toggles; free-form DAG editing is a later product decision).

---

## 12. Order of work + progress map

Parallel tracks: **A** (runtime/Python), **B** (server/Node), **C** (app CSS/JS), **G0** (runtime/Python, disjoint files from A) barely overlap — three agents can genuinely run one track each, coordinating via the ledger the moment B1 lands (before that: `scratch/BLOCKERS.md`).

```
A0 ─ A1 ─┬─ A2 ─┬─ A5
         └─ A3 ─┴─ A4 (needs B1)
A2+F2 ─ A6 (sovereignty gradient)
B0 ─ B1 ─ B2 ─ B3 (needs C2)
B0 ─ W0 ─ W1 (needs B2) ─ W2 ─┬─ W3 (dogfoods a real C/F phase)
                              └─ W4 (harden W2's enforcement)
G0 ─┬─ G1
    └─ G2 ─ G3 (needs A2/A3; wizard needs C2)
A1 ─ R0 ─ R1 ─ R2 ─ R3 (R2/R3 catalog entries need G3)
Q0 ─ Q1 ─ Q2 ─ Q3 (Q3 before any release ships from this plan)
C2+G2 ─ F1 ; A0+C2 ─ F2 ; G3+B1 ─ F3 ; G0+B1+C2 ─ F4 ; G0 ─ F5 ─ (claims source for E) ; G0 ─ F6
(Milestone 2: M2-1..M2-4 enter as phases after C6 lands)
C0 ─┬─ C1 ─ C2 ─┬─ C4 ─ C6 (needs B3, G2-UI)
    └─ C3 ──────┤
    └─ C5       └─ D1 ─ D2 ─ D3 (D3 prefers G3)
E0 (brief/claims now) ─ E1 (mocks; screenshots need C2) ─ E2 (build+ship)
B2+W1 ─ B4 ─ B5 ─ L15   (lineage closure: board→ledger→register→DAG) ; L16 standalone
W2 ─ P0 ─ P1 ─ P6 ─┬─ P2 ─┬─ P4 ─ P5   (model plurality; P5 = E4B alone)
              └─ P3 ─┘
T0 (prove trainer) + T2 (dataset) ─ T3 (QLoRA + eval) ─ T4 (behind Benny router) ; T1 clone-home (parallel)
```

- [ ] A0 verify real offload path - [ ] A1 windowing helper - [ ] A2 dev pack - [ ] A3 knowledge pack - [ ] A4 agent-support - [ ] A5 offline assurance - [ ] A6 sovereignty gradient - [ ] A7 card schema v2 (after v2 run completes) - [ ] A8 model-routing hygiene (hotfix-class)
- [ ] B0 ledger spec - [ ] B1 API+SSE - [ ] B2 CLI/MCP - [ ] B3 Bridge panel
- [ ] W0 work contracts + plan→backlog - [ ] W1 `work next` + delivery loop - [ ] W2 sandbox/tool provisioning - [ ] W3 dogfood proof
- [ ] G0 unified run-event stream - [ ] G1 DAG tracker (TUI) - [ ] G2 verbs registry + live run view - [ ] G3 workflow types + wizard
- [ ] R0 target-app ingestion - [ ] R1 evidence dossiers @16k - [ ] R2 TOGAF SAD + diagrams - [ ] R3 modularization blueprint
- [ ] Q0 security remediation - [ ] Q1 supply chain - [ ] Q2 CI gates - [ ] Q3 release SRE
- [ ] F1 command palette - [ ] F2 model garage (+test drive) - [ ] F3 watched folders + scheduler - [ ] F4 away-recap - [ ] F5 usage meter - [ ] F6 run diffing - [ ] F7 backup/restore - [ ] F8 sovereignty shield
- Milestone 2 (after C6): [ ] M2-1 voice in Studio [ ] M2-2 feedback→judge loop [ ] M2-3 sealed exports [ ] M2-4 sample corpus + tour [ ] M2-5 compliance dossier [ ] M2-6 memory mesh [ ] M2-7 drift radar
- [ ] C0 design system - [ ] C1 layout contract - [ ] C2 shell - [ ] C3 login - [ ] C4 de-brand - [ ] C5 mascot - [ ] C7 cognitive profiles - [ ] C6 parity flip
- [ ] D1 Studio spec - [ ] D2 sources+chat - [ ] D3 outputs
- [ ] E0 design brief + claims registry - [ ] E1 three mocks + owner pick - [ ] E2 build + ship
- [ ] T0 prove trainer (ROCm/eGPU + QLoRA smoke) - [ ] T1 clone Benny home - [ ] T2 data pipeline (method + agent streams) - [ ] T3 QLoRA + honest eval - [ ] T4 wire behind Benny router + offload

**First sessions (zero dependencies):** **Q0 (security remediation — do this one first of all; it fixes live vulnerabilities)**, A0 (verify offload), B0 (ledger spec), C0 (design system), G0 (run-event spec). A0+G0 are both runtime/Python but touch disjoint files; they can be one agent's back-to-back sessions or two agents with the offload runner/orchestrator boundary respected.
