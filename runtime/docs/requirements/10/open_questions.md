# AOS-001 — Open Questions: Pro/Con Analysis & Decision Worksheet

**Purpose.** [requirement.md §13](requirement.md#13-open-questions-must-be-resolved-before-phase-1-merges)
lists seven open questions whose unanswered defaults could materially shape
Phase 10. This document expands each into options, evidence, trade-offs, and a
recommendation grounded in **Benny's actual codebase and hardware constraints**
(reference device: Ryzen AI 9 HX 370, 32 GB RAM, integrated Radeon 890M).

**How to use.** Read each option's pros/cons. Tick a `[x]` next to your choice
in the **Decision** block. If you accept the recommendation as-is, write
`accept recommendation` in the decision line and move on. The next agent reads
this file before opening Phase 0.

**Status legend:** `OPEN` · `DECIDED` · `DEFERRED (revisit at phase X)`

**Resolution status (2026-04-26):** all seven OQs **DECIDED**. See per-question
*Decision* blocks below and the [Decision summary](#decision-summary) table at
the bottom. [acceptance_matrix.md](acceptance_matrix.md) and
[project_plan.md](project_plan.md) have been updated accordingly. Phase 0 is
unblocked.

---

## OQ-1 — Approved local LLM(s) for Planner / Architect personas under offline mode

**Why this matters.** Phase 7 (TOGAF + ADR emission) and Phase 6 (`benny req` →
PRD → Gherkin) are the two reasoning-heaviest paths in AOS. The Planner
persona decomposes a vague requirement into a 10–30-task DAG; the Architect
persona produces Conceptual / Logical / Physical models. Both demand strong
**structured-output adherence** (JSON schema), **multi-hop reasoning**, and
**stable tool-calling format**. Picking the wrong model here means flaky
manifests, hallucinated edges in DAGs, or schema-drift events that trip
`AOS-NFR12` (≥ 0.99 constraint adherence).

**Hardware envelope.** 32 GB unified RAM. Lemonade NPU pathway shines for
≤ 8 B-class models; the integrated Radeon 890M won't carry a 70 B model.
LM Studio with CPU+iGPU offload can host up to ~32 B at Q4_K_M (≈ 18 GB
runtime) within budget. A 70 B model is **out of reach** on this device
without external GPU.

**Already wired in `benny/core/models.py::MODEL_REGISTRY`:**
- `local_lemonade` → `openai/deepseek-r1-8b-FLM`
- `local_ollama` → `ollama/llama3`
- `local_fastflow` → `openai/deepseek-r1:8b`
- `local_lmstudio` → `openai/Gemma-4-E4B-it-GGUF`
- `local_litert` → `litert/gemma-4-E4B-it.litertlm`

> ⚠️ The Phase-10 default I drafted (`lemonade/qwen3-coder-30b`) is **not yet
> in the registry**. Whatever you pick here likely needs a registry entry as
> Phase-0 tail-work. That's fine; just call it out.

### Options

| # | Model | Provider | RAM/VRAM | Latency on ref device | Code-bench (HumanEval / MBPP) | Tool-call quality | Notes |
|---|-------|----------|----------|------------------------|-------------------------------|-------------------|-------|
| A | **Qwen2.5-Coder-32B-Instruct** Q4_K_M | LM Studio | ≈ 18 GB | 30–60 tok/s on iGPU | 92 / 88 | excellent, strict JSON | Best-in-class code reasoning on this hardware. Works as both Planner and Architect. |
| B | **Qwen2.5-Coder-14B-Instruct** Q5_K_M | LM Studio / Ollama | ≈ 10 GB | 50–80 tok/s | 85 / 82 | excellent | The "fast lane." Loses ~7 pp on code, gains 2× throughput. |
| C | **DeepSeek-Coder-V2-Lite-Instruct** (16 B MoE) | Ollama / LM Studio | ≈ 10 GB active | 60–90 tok/s | 88 / 84 | good | MoE: only 2.4 B params active per token. Fast, but tool-call format slightly weaker than Qwen. |
| D | **DeepSeek-R1-Distill-Qwen-14B** Q5 | Ollama / LM Studio | ≈ 10 GB | 40–70 tok/s; emits `<think>` traces | 78 / 80 | medium (verbose) | Reasoning traces are great for the **Architect** (transparent ADR rationale) but **bloat context** — bad for Planner-as-orchestrator. |
| E | **Codestral-22B** Q4 | LM Studio | ≈ 13 GB | 35–55 tok/s | 81 / 79 | good | Mistral-licence; less rigorous JSON adherence than Qwen 2.5. |
| F | **Llama-3.1-8B-Instruct** (current `local_ollama`) | Ollama / Lemonade | 5–6 GB | 80–120 tok/s | 64 / 70 | medium | Already wired. Too weak for full SDLC planner work; fine as a fast Reviewer or smoke-test fallback. |
| G | **Two-tier: Qwen-Coder-32B as Planner + Architect, Llama-3.1-8B as Reviewer** | mixed | ≤ 18 GB peak | mixed | n/a | mixed | Best practical fit. Reasoning-heavy work uses A; light validation uses F. |
| H | Cloud (Anthropic Claude / OpenAI gpt-4o) | cloud | 0 local | 100–300 tok/s | 95 / 92 | excellent | Fastest path to quality, but **violates `BENNY_OFFLINE=1` invariant** that's central to the Brief. Acceptable only as an opt-in dev convenience, never as a release default. |

### Pros / cons distilled

| Option | Pros | Cons |
|--------|------|------|
| **A** Qwen2.5-Coder-32B | Highest local code quality; strict JSON; one model serves both personas | Tightest VRAM headroom — can't run two 32 B models concurrently; 30–60 tok/s on iGPU is the slowest of the candidates |
| **B** Qwen2.5-Coder-14B | 2× faster, ~10 GB headroom for parallel agents | Loses ~7 pp on HumanEval; for ambiguous requirements it produces shallower task decompositions |
| **C** DeepSeek-Coder-V2-Lite | Fast (MoE), small active footprint, good code | Tool-call format adherence not as tight as Qwen; less proven in long-horizon agentic loops |
| **D** DeepSeek-R1-Distill | Reasoning traces are gold for ADRs / audit | Trace tokens inflate context — fights `AOS-NFR1` token budget; orchestration loops slow |
| **E** Codestral-22B | Decent code quality, well-known | Mistral non-commercial licence (verify your usage); JSON adherence weakest of the leaders |
| **F** Llama-3.1-8B | Already wired; reliable; fast | Too weak for SDLC-grade planning; would consume more iteration loops, blowing past `iteration_budget` |
| **G** Two-tier | Best price/perf balance — heavy work gets the heavy model, validation gets the cheap one | Two models in registry; need to be explicit about which persona maps to which (`config.model_per_persona`) |
| **H** Cloud | Cleanest quality | Defeats the offline / portable-OS thesis; do **not** use as release default |

### Recommendation

**Go with G — two-tier mapping**, concretely:

| Persona | Model | Provider | Why |
|---------|-------|----------|-----|
| Planner / Architect | **Qwen2.5-Coder-32B-Instruct** Q4_K_M | LM Studio (port 1234) | strict JSON tool-calls; best local code+arch reasoning |
| Implementer | **Qwen2.5-Coder-14B-Instruct** Q5_K_M | LM Studio | scoped tasks → 14B is sufficient and 2× faster |
| Reviewer / smoke / Requirements-Analyst | **Llama-3.1-8B-Instruct** | Ollama (port 11434) | already wired; cheap, fast |
| Voice / quick-helper paths | unchanged (`voice_speed`) | Lemonade NPU | unchanged |

This unlocks AOS-NFR8 (offline e2e) without compromising AOS-NFR1 token budgets,
keeps the worker pool's VRAM math honest (a single 32B fits; a 32B + 14B
roughly fits with paging; running two 32Bs concurrently does not), and matches
the Brief's "incremental implementation via SLMs" pattern in §5.3.

**Phase-0 tail-work:** add three `MODEL_REGISTRY` entries
(`local_lmstudio_qwen_coder_32b`, `local_lmstudio_qwen_coder_14b`,
`local_ollama_llama31_8b`) and a `config.model_per_persona` field to
`ManifestConfig`.

### Decision — `DECIDED 2026-04-26`

- [ ] A (Qwen2.5-Coder-32B only)
- [ ] B (Qwen2.5-Coder-14B only)
- [ ] C (DeepSeek-V2-Lite)
- [ ] D (DeepSeek-R1-Distill)
- [ ] E (Codestral-22B)
- [ ] F (Llama-3.1-8B current)
- [ ] G (two-tier mapping — original recommendation)
- [ ] H (cloud — not recommended)
- [x] **CUSTOM — keep architecture fully configurable per-persona; default `qwen3.5-9b` for every persona for now**

**Resolution.** The architectural answer is **stronger** than the documented
recommendation: rather than baking persona → model mapping into the spec,
make it **first-class configuration** and ship a single sensible default that
serves every persona today. Concretely:

1. **Schema change (Phase 0):** add to `ManifestConfig` a new field
   `model_per_persona: Dict[str, str] = Field(default_factory=dict)`.
   `ManifestTask.assigned_model` already exists per
   [benny/core/manifest.py](../../../benny/core/manifest.py) — this layer adds
   a per-persona default without per-task ceremony.
2. **Resolution order at execute-time** (`benny/graph/swarm.py`):
   `task.assigned_model` → `config.model_per_persona[persona]` → `config.model` → registry default.
3. **Default model for every persona** until baselines justify a change:
   `qwen3.5-9b` (chosen 2026-04-26). Resolved as a single registry entry.
4. **Phase 0 tail-work — registry entry.** Add `qwen3.5-9b` to
   `benny/core/models.py::MODEL_REGISTRY`. The exact provider+model identifier
   must be confirmed at wire-up time by the implementer (Qwen 3 was released
   prior to the cutoff; the Qwen Studio / Lemonade naming has historically
   drifted — likely candidates are `lmstudio/Qwen3-8B-Instruct-Q5_K_M`,
   `ollama/qwen3:8b`, or `lemonade/openai/Qwen3-8B-FLM`). Pick whichever is
   actually loadable on the reference device and pin its full identifier in
   the registry comment for reproducibility.
5. **Fallback model** when `qwen3.5-9b` is unresolvable on a host: the
   existing `local_lemonade` registry key (deepseek-r1-8b-FLM) — **same
   parameter class, different family**. This keeps the offline e2e gate
   green on any AMD-NPU host.
6. **Documentation** ([requirement.md §13](requirement.md#13-open-questions-must-be-resolved-before-phase-1-merges))
   reflects "single default; per-persona configurable" rather than two-tier.

**Why this beats the original recommendation.** Two-tier hard-codes a Phase-0
opinion that might not survive baselining. The configurable path costs roughly
the same Phase-0 work (one new field on `ManifestConfig`, three lines of
resolution logic in `swarm.py`) and lets the operator pivot to two-tier — or
to a fully task-by-task assignment — by editing JSON, not code.

**Rationale (free text):** Single 8–9 B-class model is enough for early
iteration; revisit after the sandbox-runner reports baselines per AOS-F29.

---

## OQ-2 — Vendor `bubblewrap` / `sandbox-exec`, or rely on host?

**Why this matters.** The Brief §2.1 calls for "unprivileged sandboxing" so an
autonomous agent can compile code and write to disk without endangering the
host. AOS-SEC4 currently asks `benny doctor` to **report** sandbox availability;
the deeper question is whether AOS *enforces* sandboxing as a hard requirement.

**Reality check.** Benny is portable across Mac / Windows / Linux from a single
USB-C drive. **No** single sandboxing mechanism is portable across all three:
- `bubblewrap` — Linux only.
- `sandbox-exec` — macOS only (deprecated by Apple, but still functional).
- Windows — has nothing equivalent at the userspace level. AppContainer requires admin and signing.

### Options

| # | Approach | Coverage | Setup burden | Failure mode if unavailable |
|---|----------|----------|--------------|------------------------------|
| A | **Rely on host; doctor reports** (the current default) | Best-effort across all OS | Zero | Agent runs unsandboxed — risk surface = whatever Python can do |
| B | Vendor portable bubblewrap binary; require Linux for production | Linux only | Low (binary check-in) | Windows / Mac users blocked from "production" mode |
| C | **Use Docker as the sandbox boundary** for the agent process | Mac + Windows + Linux (where Docker is installed) | Medium (image + runtime) | If Docker missing → fall back to A |
| D | Process-level isolation via Python venv + RestrictedPython + chroot-on-Linux | All OS | High | Brittle; many sandbox escapes documented |
| E | **Hybrid: A as floor, C as preferred when available, plus policy-as-code (Phase 9) as the real safety net** | All OS | Medium | If Docker missing → Phase 9 policy still blocks dangerous ops |

### Pros / cons

| Option | Pros | Cons |
|--------|------|------|
| **A** Rely on host | Zero setup; portable | Real risk if a malicious tool is loaded; hard to claim "secure by default" |
| **B** Vendor bubblewrap | Strong Linux story | Mac/Windows excluded from "secure" tier — defeats portability |
| **C** Docker boundary | Cross-OS; well-understood | Adds Docker as a hard dependency; image-build complexity; agent loses fast filesystem access |
| **D** Python-native | No external deps | Sandbox-escape papers exist for every approach; high QA burden |
| **E** Hybrid + Policy-as-Code | Defence in depth; pragmatic | Need to be honest in `benny doctor` about which layer is active |

### Recommendation

**Go with E — hybrid.** The real security boundary in AOS is not OS-level
sandboxing; it's **Phase 9's Policy-as-Code** which intercepts every state-
mutating tool call before execution. OS sandboxing is *defence in depth*, not
the primary mechanism. So:

1. AOS-SEC4 stays as-is — `benny doctor` reports availability.
2. When `bubblewrap`/`sandbox-exec` is available, AOS forwards the agent
   subprocess through it (best-effort).
3. When Docker is detected and `aos.sandbox.os_isolation=docker`, AOS spawns
   the agent in a minimal `python:3.11-slim` container with the workspace
   bind-mounted read-write.
4. Otherwise AOS proceeds with **Policy-as-Code as the only line of defence**
   and the doctor output flags `aos.sandbox=host_only` so the operator knows.

Hard sandbox enforcement is **not** a release gate. Adding one would block
Windows users from ever reaching production-mode without a major Windows
ACL design effort that's out of scope for Phase 10.

### Decision — `DECIDED 2026-04-26`

- [ ] A (host-only)
- [ ] B (vendor bubblewrap; Linux-only "production")
- [ ] C (Docker as the boundary)
- [ ] D (Python-native sandboxing)
- [x] **E (hybrid + policy-as-code primary — APPROVED)**

**Rationale:** Approved as recommended. Phase 9's Policy-as-Code is the real
safety net; OS-level sandboxing remains best-effort defence in depth and is
honestly reported by `benny doctor --json`.

---

## OQ-3 — JSON-LD `@context`: vendor PROV-O or live URL?

**Why this matters.** Phase 8 emits PROV-O JSON-LD per artefact. If the
`@context` is a live URL (`https://w3id.org/prov-o#`) and AOS fetches it at
emit-time, that's an outbound HTTP call — **violating `BENNY_OFFLINE=1`**.

### Options

| # | Approach | Offline-safe? | Maintenance | RDF tool compat |
|---|----------|---------------|-------------|------------------|
| A | Live URL only | No | Zero | Best — every triplestore resolves it |
| B | **Vendor under `vendor/prov-o/` and rewrite `@context` to `file://${BENNY_HOME}/...`** | Yes | Refresh on PROV-O version bump (rare, 2013-stable) | Most tools accept `file://` |
| C | Inline the entire context object into every JSON-LD doc | Yes | Zero | Some tools dislike huge inline contexts |
| D | Use a custom mini-context (`benny:` namespace only, drop PROV-O) | Yes | Zero | Loses semantic interop — auditors lose the standard vocabulary |
| E | Vendored copy + remote fallback when online | Yes when offline | Low | Best of both |

### Pros / cons

| Option | Pros | Cons |
|--------|------|------|
| A | Standard, no copy in repo | Breaks `BENNY_OFFLINE`; adds latency |
| **B** | Stable; small (PROV-O hasn't shipped a breaking change since 2013); offline-safe | One vendored file to commit (~6 KB) |
| C | Self-contained per-doc | Each JSON-LD doc grows by ~4 KB; readability hurt |
| D | Smallest payload | Loses BCBS 239 P3 audit vocabulary — auditors will complain |
| E | Offline + online both work | More code to test |

### Recommendation

**Go with B — vendor under `vendor/prov-o/`.** PROV-O is W3C-standardised,
released January 2013, and has not shipped a breaking change since. The
licence is W3C Document Licence (permissive). Cost is one ~6 KB vendored file
plus a `@context` rewrite at emit time. Option E is over-engineered.

### Decision — `DECIDED 2026-04-26`

- [ ] A (live URL only — breaks offline)
- [x] **B (vendor under `vendor/prov-o/` — APPROVED)**
- [ ] C (inline)
- [ ] D (custom mini-context — loses interop)
- [ ] E (vendored + remote fallback)

**Rationale:** Approved as recommended. PROV-O frozen since 2013; ~6 KB
vendored file keeps `BENNY_OFFLINE=1` honest.

---

## OQ-4 — BDD compilation: separate command, pytest plugin, or both?

**Why this matters.** AOS-F21 says feature files compile to deterministic
pytest stubs. *How* developers (and the orchestrator) trigger that compilation
shapes their workflow.

### Options

| # | Approach | Developer ergonomics | CI integration | Determinism risk |
|---|----------|----------------------|------------------|------------------|
| A | `benny bdd compile <feature>` only | Explicit; predictable | Two CI steps (compile, then pytest) | None |
| B | pytest plugin that auto-discovers `.feature` files | "It just works" | Single `pytest` invocation | Plugin order matters; recompilation on every test run |
| C | **Both: `benny bdd compile` for explicit/CI; pytest plugin as opt-in** | Best of both | Choose per project | Minor — must verify both paths produce identical artefacts |
| D | Run BDD as the orchestrator's quality gate (no separate command, no plugin) | Invisible to user | Couples BDD to swarm execution | None — but loses standalone reuse |

### Pros / cons

| Option | Pros | Cons |
|--------|------|------|
| A | Simple; deterministic; auditable | Extra step; easy to forget when iterating |
| B | Beautiful UX; mainstream pattern (`pytest-bdd`, `behave`) | Plugin order can be flaky; hides what's happening |
| **C** | Flexible; explicit-by-default, ergonomic when desired | Two surfaces to maintain |
| D | Tightest integration with AOS | Can't use BDD outside AOS — kills the "dev runs `pytest` locally" path |

### Recommendation

**Go with C, but ship A first in Phase 6 and add the plugin in Phase 10 as a
Phase-10 stretch goal if budget allows.** This matches the Brief's pattern
(deterministic core first, ergonomic helpers second) and is exactly the
default OQ-4 already documents. The plugin scope:

- Plugin = `benny.sdlc.pytest_bdd_plugin` (≤ 200 LOC).
- Auto-discovers `*.feature` files under `data_out/prd/`.
- Calls the same `compile_to_pytest` so output is byte-identical to A.
- Opt-in via `pytest --benny-bdd` flag.
- Default off — never auto-collect, to keep `pytest` predictable.

### Decision — `DECIDED 2026-04-26`

- [ ] A (separate command only)
- [ ] B (plugin only)
- [x] **C (both — `benny bdd compile` in Phase 6, opt-in pytest plugin in Phase 10 stretch — APPROVED)**
- [ ] D (orchestrator-internal only)

**Rationale:** Approved as recommended. Plugin is ≤200 LOC and reuses the
Phase 6 compiler verbatim; landed only if Phase 10 has slack.

---

## OQ-5 — Agent-action ledger: Git branch or sidecar journal?

**Why this matters.** AOS-F26 / AOS-COMP1 / GATE-AOS-LEDGER hinge on this
choice. The ledger is the SOX 404 internal-control surface; auditors must be
able to verify a tamper-evident chain.

### Options

| # | Approach | Tamper-evidence | Portable? | Ops burden | Diffability |
|---|----------|------------------|-----------|------------|-------------|
| A | **Orphan Git branch `benny/checkpoints/v1`** | HMAC chain + Git's own SHA chain | Yes (travels with repo) | Pre-receive hook recommended | `git log` for free |
| B | JSONL append-only at `${BENNY_HOME}/ledger/*.jsonl` | HMAC chain | Yes | Backup separate from repo | Requires custom tooling |
| C | SQLite append-only DB | HMAC chain + DB constraint | Yes | One-file migration | SQL queries |
| D | External tamper-evident log (e.g. trillian, sigstore-style) | Strongest | No (network dependent) | High | Specialised tooling |
| E | **Hybrid: Git branch (primary) + JSONL mirror under `$BENNY_HOME` (operational read)** | A's evidence + B's read ergonomics | Yes | Double-write cost | Best |

### Pros / cons

| Option | Pros | Cons |
|--------|------|------|
| **A** Git branch | One artefact; Git already tamper-aware; portable; `git log` query | Force-push from a careless human can rewind (mitigated by hook + `doctor --audit`) |
| B JSONL | Trivial to append from Python; no Git plumbing | Lives outside repo → breaks portability story |
| C SQLite | Queryable | Schema migration drama; less auditor-friendly than text |
| D External | Strongest property | Network dependency violates offline; out of scope |
| **E** Hybrid | Strong audit + operational ergonomics; mirror is rebuildable from branch | Two writes per action; need consistency check |

### Recommendation

**Go with A — orphan Git branch `benny/checkpoints/v1`.** Reasons:

- Travels with the repo, matching the portable-drive thesis.
- Git already provides a SHA chain; AOS-F27 stacks an HMAC over the diff →
  chain integrity is end-to-end.
- `git log benny/checkpoints/v1` = free auditor query surface.
- The R12 risk (force-push) is mitigated by `benny doctor --audit` and a
  documented (not auto-installed) pre-receive hook.

If the read-side ergonomics turn out to hurt later, add a JSONL mirror in a
follow-up phase — option E becomes A→E without re-architecture. Don't pre-build
it now.

### Decision — `DECIDED 2026-04-26`

- [x] **A (Git orphan branch `benny/checkpoints/v1` — APPROVED)**
- [ ] B (JSONL sidecar)
- [ ] C (SQLite)
- [ ] D (external log)
- [ ] E (Git + JSONL mirror)

**Rationale:** Approved as recommended. R12 (force-push rewrite) mitigated by
`benny doctor --audit` HMAC-chain check + documented (not auto-installed)
pre-receive hook. Sidecar mirror deferred to a future phase if read ergonomics
prove painful.

---

## OQ-6 — Process-metric thresholds: soft warnings or hard release-gate fails?

**Why this matters.** Section §11 of [requirement.md](requirement.md#11-process-metrics--formal-definitions)
proposes seven metrics with healthy bands (e.g. tool selection accuracy ≥ 0.85).
If those become hard release gates, every Phase-10 release run must pass them
on the SDLC fixture. If they're soft warnings, they only inform.

### Options

| # | Threshold posture | Phase-10 release risk | False-positive risk | Information value |
|---|-------------------|----------------------|---------------------|-------------------|
| A | All hard from day 1 | High (no real baselines yet) | High (a single noisy run blocks merge) | Medium |
| B | **All soft until baselines exist; promote later** | Low | Low | High (baselines accumulate) |
| C | Two-tier: critical metrics hard (constraint adherence, offline compliance), others soft | Low | Low | High |
| D | Per-model thresholds (Qwen-32B ≥ 0.95, Llama-8B ≥ 0.75) | Medium | Low | Highest — comparable across models |
| E | Soft for 30 days post-merge, then auto-promote based on observed p10 | Low | Low | High |

### Pros / cons

| Option | Pros | Cons |
|--------|------|------|
| A | Strong quality from day 1 | Almost certainly produces false fails — no baseline data yet |
| **B** | Pragmatic; data-driven promotion | Requires discipline to actually promote later; "soft" can stay soft forever |
| C | Critical fails block; soft metrics still inform | Choice of "critical" is arbitrary today |
| D | Apples-to-apples across models — perfect for sandbox-runner reports | More config; harder to communicate to auditors |
| E | Self-correcting | Auto-promotion logic adds complexity |

### Recommendation

**Go with C — two-tier.** Constraint adherence (`AOS-NFR12`-style) and offline
compliance are already hard via existing tests and `GATE-AOS-OFF`. Promote
those to hard. Keep tool-selection accuracy / efficiency / latency / loop-count
as soft warnings exposed in the sandbox-runner report. Add a follow-up issue
to convert soft → hard once you have ≥ 10 consecutive sandbox runs to set
baselines.

This is more decisive than the documented OQ-6 default (B) without the
high-false-positive risk of A.

### Decision — `DECIDED 2026-04-26`

- [ ] A (all hard)
- [ ] B (all soft — original default)
- [x] **C (two-tier: constraint-adherence + offline = hard; rest = soft until baselines exist — APPROVED)**
- [ ] D (per-model thresholds)
- [ ] E (auto-promote after 30 days)

**Rationale:** Approved as recommended. Hard rows are AOS-NFR12 (constraint
adherence ≥ 0.99) and AOS-NFR8 / `GATE-AOS-OFF` (offline e2e). All other §11
metrics ship as informational warnings; promote to hard via a follow-up
issue once we have ≥ 10 consecutive sandbox-runner runs.

---

## OQ-7 — Is `temperature=0` + provider seed enough for COMP5 byte-replay?

**Why this matters.** `AOS-COMP5` claims a re-run with same inputs and same
model produces the same artefact SHAs. **LLM determinism is provider-dependent.**
Some inference engines emit different tokens across runs even at `temperature=0`
due to GPU non-determinism, batching, kv-cache state, or floating-point
non-associativity.

### Options

| # | Approach | Coverage | Confidence | Cost |
|---|----------|----------|------------|------|
| A | `temperature=0` + seed; assert byte-equal artefacts | Only deterministic providers | Low (Lemonade, LM Studio iGPU not 100% deterministic) | Low |
| B | **Best-effort: assert byte-equal *only* against a fixture local model with known deterministic decoding** | Narrow but reliable | Medium | Low |
| C | Hash inputs + outputs only; accept output drift if structural shape matches | Wide | High | Medium (need shape-comparison logic) |
| D | Capture full inference state (logits, attention) | Wide | Highest | Very high — out of scope for Phase 10 |
| E | **Replay the deterministic frame** (manifest + tool calls + artefact SHAs) without asserting LLM token-equality; LLM outputs are stored as artefacts and replayed from store | Wide | Highest | Medium — already aligns with the PBR design |

### Pros / cons

| Option | Pros | Cons |
|--------|------|------|
| A | Strict | Will flake on most local providers — false fails |
| **B** | Honest about limits; uses one trusted model as the determinism oracle | Coverage is narrow |
| C | Tolerant; matches what auditors really care about (artefact equivalence, not token equivalence) | "Structural shape" is fuzzy |
| D | Strongest theoretically | Engineering cost prohibitive |
| **E** | Aligns with PBR design — LLM outputs stored as artefacts → replay just reads them back | Doesn't validate the LLM did the same thing twice; only validates the framework's integrity |

### Recommendation

**Go with E.** The Brief §10's *durable execution* idea is exactly this: the
framework records every LLM output as an artefact; replay rehydrates from the
artefact store rather than re-prompting the LLM. This:

- Sidesteps GPU-determinism arguments entirely.
- Gives auditors what they need: byte-identical artefact lineage on replay.
- Matches Phase 1's PBR store and Phase 4's resume harness.

Then keep B as a separate, narrower test (`test_aos_llm_determinism_oracle`)
that runs *only* against a hand-picked deterministic local model
(`litert/gemma-4-E4B-it.litertlm` is the best candidate — quantised, on-device,
deterministic decoding) to detect regressions in the underlying inference
stack itself. That test is informational, not gating.

This is **stronger** than the documented default (best-effort against fixture
local model alone) and aligns with the architecture you've already built.

### Decision — `DECIDED 2026-04-26`

- [ ] A (strict temp=0 + seed)
- [ ] B (best-effort against fixture model only — original default)
- [ ] C (hash structural shape)
- [ ] D (capture full inference state)
- [x] **E (replay framework artefacts via PBR; B as informational sub-test — APPROVED)**

**Rationale:** Approved as recommended. AOS-COMP5 becomes a framework-integrity
assertion (artefact lineage replays byte-identically) rather than an
inference-determinism assertion. The narrower informational sub-test
`test_aos_llm_determinism_oracle` runs against `litert/gemma-4-E4B-it.litertlm`
to detect inference-stack regressions; non-gating.

---

## Decision summary

All seven OQs **DECIDED** on 2026-04-26.

| OQ | Decision | Phase impact |
|----|----------|---------------|
| **OQ-1** | **CUSTOM** — keep architecture fully configurable per-persona; default `qwen3.5-9b` for every persona for now | Phase 0 adds (i) `ManifestConfig.model_per_persona: Dict[str, str]`, (ii) resolution order in `swarm.py`, (iii) registry entry for `qwen3.5-9b` (exact provider/model identifier confirmed at wire-up). Fallback: `local_lemonade`. |
| **OQ-2** | **APPROVED — E** (host sandbox where available, Docker when configured, Policy-as-Code as the real boundary) | Phase 9 carries the hard guarantee; Phase 0/10 `benny doctor` reports honestly. |
| **OQ-3** | **APPROVED — B** (vendor PROV-O under `vendor/prov-o/`) | Phase 8 emits file-only `@context`; ~6 KB vendored. |
| **OQ-4** | **APPROVED — C** (`benny bdd compile` in Phase 6 + opt-in pytest plugin in Phase 10 stretch) | Plugin is stretch — only if Phase 10 has slack. |
| **OQ-5** | **APPROVED — A** (Git orphan branch `benny/checkpoints/v1`) | Phase 9 lands branch + HMAC chain; sidecar mirror deferred. |
| **OQ-6** | **APPROVED — C** (two-tier: constraint-adherence + offline hard; rest soft) | Phase 10 release-gate set calibrated; soft warnings logged via sandbox runner. |
| **OQ-7** | **APPROVED — E** (replay framework artefacts via PBR; informational sub-test against `litert/gemma-4-E4B-it.litertlm`) | Aligns with Phase 1 PBR + Phase 4 resume designs. |

**Phase-0 work added by these decisions** (folded into [project_plan.md §4 Phase 0 tracker](project_plan.md#phase-0--foundations--schema-11)):

1. New `ManifestConfig.model_per_persona` field + Pydantic test.
2. Resolution-order helper in `benny/graph/swarm.py` (or a small `benny/sdlc/model_resolver.py`).
3. New registry entry for `qwen3.5-9b` in `benny/core/models.py::MODEL_REGISTRY` (provider + model identifier confirmed at wire-up; document in registry comment).

**No changes required** to [requirement.md](requirement.md) §1–§12 (these
decisions sit within the documented architecture envelope). [requirement.md §13](requirement.md#13-open-questions-must-be-resolved-before-phase-1-merges)
has been collapsed to point at this file.

[acceptance_matrix.md §"Open questions"](acceptance_matrix.md) and
[project_plan.md §1 / §3 / §8](project_plan.md) are updated in the same
commit as this decision.

---

*Last updated: 2026-04-26. Update this file inline if any decision is revisited.*
