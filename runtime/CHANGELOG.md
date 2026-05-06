# Changelog

All notable changes to Benny are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [AOS-001] — 2026-04-27

### Added — AOS-001: Agentic OS for the SDLC

Eleven-phase feature set that turns Benny's manifest executor into a
full software-delivery pipeline engine. All modules are stdlib-only,
offline-safe under `BENNY_OFFLINE=1`, and SOX-404 auditable.
62/62 acceptance rows PASS; all 10 GATE-AOS-* release gates PASS.

**Phase 0 — Foundations & schema 1.1** (`2f6819b`)
- `benny/sdlc/contracts.py` — typed contracts: `TogafPhase`, `QualityGate`,
  `BddScenario`, `Adr`, `SdlcConfig`, `PolicyConfig`, `MemoryConfig`
- `benny/sdlc/model_resolver.py` — per-persona model resolver; default
  `qwen3_5_9b` for all personas in offline mode (OQ-1)
- Manifest schema v1.1 (`schemas/aos/v1_1.schema.json`) — adds `sdlc`,
  `policy`, `memory`, `model_per_persona` top-level fields
- PRD schema (`schemas/aos/prd_v1.schema.json`)
- Back-compat: v1.0 manifests round-trip through v1.1 schema

**Phase 1 — PBR artefact store** (`b2259f0`)
- `benny/core/artifact_store.py` — content-addressed store with ≥ 80 %
  context-window reduction; URI substitution in tool-call payloads
- `ArtifactRef.summary` clamped to 200 chars (AOS-F6)
- Path-escape confinement via `os.path.realpath` (AOS-SEC5)

**Phase 2 — Progressive disclosure** (`39cec9a`)
- `benny/core/disclosure.py` — `DisclosureRegistry` with Layer 1 / 2 / 3
  index; Layer-1 budget ≤ 500 tokens (AOS-F8)
- Lazy-load via `activate()` returning full schema on demand (AOS-F9)
- Examples are Layer-3 optional (AOS-F10)

**Phase 3 — Diagram emitters** (`777f798`)
- `benny/sdlc/diagrams.py` — `to_mermaid()` (graph-TD + per-wave subgraphs)
  and `to_plantuml()` smoke; `activity_diagram_per_scenario()` (AOS-F11–F13)

**Phase 4 — Durable resume** (`3be752a`)
- `benny/sdlc/checkpoint.py` — atomic tmp+rename checkpoint write;
  HMAC-SHA256 over payload; resume skips completed tasks (AOS-F14);
  pause/resume across hosts via portable checkpoint path (AOS-F15);
  time-budget and iteration-budget escalation (AOS-F16)
- R5 (resume corruption, RPN 225) **MITIGATED**

**Phase 5 — VRAM-aware worker pool** (`a504db9`)
- `benny/sdlc/worker_pool.py` — `VramPool` counting semaphore; capacity =
  floor(budget / task_vram) ≥ 1 (AOS-F17); backpressure raises
  `QueueDepthExceededError` (AOS-F18); iteration-budget pre-check (AOS-F19)
- R6 (deadlock under nested fan-out, RPN 126) **MITIGATED**

**Phase 6 — BDD pipeline** (`a45e736`)
- `benny/sdlc/requirements.py` — `generate_prd()` emits PRD + feature list
  from an English requirement (AOS-F20)
- `benny/sdlc/bdd.py` — `compile_to_pytest()` deterministic across Python
  minor versions (AOS-F21)
- PRD validated against `schemas/aos/prd_v1.schema.json` (AOS-F22)
- `benny req` CLI command

**Phase 7 — SDLC manifest + TOGAF + ADRs** (`e4226ef`)
- `benny/sdlc/togaf.py` — `map_waves_to_phases()`, `emit_adr()` (monotonic
  sequence), `run_quality_gate()` with halt/retry/escalate policies (AOS-F3–F4)
- SSE event builders (`AOS-OBS3`) and Phoenix OTLP attributes (`AOS-OBS4`)
  in `aos.*` namespace
- End-to-end SDLC manifest fixture: `manifests/templates/sdlc_pipeline.json`
- Full offline e2e: `tests/sdlc/test_offline_e2e.py`

**Phase 8 — Compliance lineage** (`1059565`)
- `benny/governance/jsonld.py` — `emit_provenance()` writes W3C PROV-O
  JSON-LD sidecar at `data_out/lineage/{sha}.jsonld` (AOS-F23);
  `check_no_orphans()` graph-completeness auditor (AOS-COMP3)
- `benny/pypes/lineage.py::emit_column_lineage()` — column-level lineage
  for Pypes silver/gold steps; bronze returns None (AOS-F24, AOS-COMP2)
- `vendor/prov-o/prov-o.jsonld` — offline-safe vendored PROV-O context
  (OQ-3); `@context` rewritten to `file://` URI when `benny_home` is set
- p95 emit latency ≤ 5 ms (AOS-NFR11)

**Phase 9 — Policy-as-Code + Git ledger** (`b96a3ab`)
- `benny/governance/policy.py` — `PolicyEvaluator` with warn/enforce modes;
  path-traversal guard (AOS-SEC3); per-persona tool allowlist (AOS-SEC1);
  `auto_approve_writes=True` raises `ValueError` in constructor
  (GATE-AOS-POLICY-1)
- `benny/governance/ledger.py` — HMAC-SHA256 chained append-only JSONL
  ledger; `get_head_hash()` reads from file tip (rewind-detectable,
  AOS-SEC6); `verify_chain()` for SOX 404 audit (AOS-F26, AOS-COMP1)
- `tests/safety/test_aos_no_unexpected_egress.py` — no-egress gate (AOS-SEC2)

**Phase 10 — Sandbox runner + process metrics + release gates** (`357b3d1`)
- `benny/sdlc/sandbox_runner.py` — `run_multi_model()`, `write_sandbox_report()`,
  `sandbox_availability()`, `diff_manifests()` (AOS-F29, AOS-F30,
  AOS-SEC4, AOS-COMP4)
- `benny/sdlc/metrics.py` — `ProcessMetric`, `record()`, `phoenix_attrs()`,
  `aos_doctor_section()` (AOS-F28, AOS-F31, AOS-OBS1)
- `tests/release/test_aos_release_gate.py` — 16 tests covering all
  GATE-AOS-* hard release gates; all PASS

### Changed

- `benny/core/manifest.py` — `SwarmManifest` extended with `sdlc`, `policy`,
  `memory`, `model_per_persona` fields; `AOS_SCHEMA_VERSION = "1.1"`
- `benny/pypes/lineage.py` — column-level lineage appended (Phase 8)

### Tests

- 62 acceptance matrix rows: all PASS
- 10 GATE-AOS-* release gates: all PASS
- 345 tests green across all phases
- Coverage: AOS modules ≥ 85 % (GATE-AOS-COV)

---

*For the full acceptance matrix see
[docs/requirements/10/acceptance_matrix.md](docs/requirements/10/acceptance_matrix.md).*
*For architecture detail see [architecture/SAD.md §9.6](architecture/SAD.md).*
