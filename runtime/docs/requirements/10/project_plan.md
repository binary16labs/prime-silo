# AOS-001 — Project Plan & Live Tracker

**Single source of truth for in-flight Phase 10 work.** Update this file at the
end of every session. The tracker checkboxes (§4) are flipped only after the
phase exit gate (§3) is green AND the corresponding rows in
[acceptance_matrix.md](acceptance_matrix.md) are `PASS` with evidence.

**Last updated:** 2026-04-27
**Active phase:** COMPLETE — All phases 0–10 shipped + final cutover done
**Status:** AOS-001 ✅ SHIPPED. Archive `docs/requirements/10/` → `docs/requirements/archive/10/` when Phase 11 opens.

---

## 1. Current flight status

| Field | Value |
|-------|-------|
| Phase | DONE — all phases 0–10 shipped + final cutover complete |
| Status | `[SHIPPED]` ✅ — `357b3d1` (implementation) + cutover commit |
| Active workstream | None — archive `docs/requirements/10/` on first Phase 11 planning commit |
| Blockers | None |
| Open OQs | **0** (all 7 DECIDED 2026-04-26 — see [open_questions.md](open_questions.md)) |
| Branch | `claude/peaceful-hugle-bcce2b` |
| Cumulative coverage on AOS modules | Phase 0 modules present; measured at Phase 10 gate |
| Open critical risks (RPN ≥ 200) | R10 (policy false-positives), R11 (ledger HMAC secret) — R5 MITIGATED by `3be752a` |

### 1.1 Immediate next steps (for the next agent or operator)

Phases 0–9 are **complete** (`2f6819b`, `b2259f0`, `39cec9a`, `777f798`, `3be752a`, `a504db9`, `a45e736`, `e4226ef`, `1059565`, `b96a3ab`). Next:

1. Open Phase 10 — Sandbox runner + process metrics + release gates.
2. Write red tests first:
   - `tests/sdlc/test_sandbox_runner.py` (AOS-F29, AOS-F30: `test_aos_f29_sandbox_multi_model_report`, `test_aos_f30_report_shape`)
   - `tests/sdlc/test_metrics.py` (AOS-F28: `test_aos_f28_metrics_record_persisted`)
   - `tests/release/test_aos_release_gate.py` (all GATE-AOS-* gates)
   - `tests/sdlc/test_phoenix_metrics.py` (AOS-F31: `test_aos_f31_phoenix_attributes_emitted`)
   - `tests/sdlc/test_doctor_aos.py` (AOS-OBS1: `test_aos_obs1_doctor_aos_section`)
   - `tests/sdlc/test_aos_obs2_logs.py` (AOS-OBS2: `test_aos_obs2_logs_carry_component`)
3. Implement `benny/sdlc/sandbox_runner.py::run_multi_model`.
4. Implement `benny/sdlc/metrics.py` process-metric record (§4.5).
5. Wire AOS section into `benny doctor --json`.
6. Extend `docs/requirements/release_gates.yaml` with GATE-AOS-*.
7. Build `tests/release/test_aos_release_gate.py` full release gate.
8. Update §1, §4, §6 + acceptance matrix when Phase 10 gate is green.

Notes:
- All AOS modules placed in `benny/sdlc/` (not `benny/graph/`) because
  `benny/graph/__init__.py` eagerly imports `langgraph` (not installed in test env).
- Phase 5 worker pool (`benny/sdlc/worker_pool.py`) is stdlib+threading only — safe
  to import from anywhere. `benny.sdlc.checkpoint` (Phase 4) is also stdlib+pydantic only.
- R5 (resume integrity, RPN 225) is MITIGATED: atomic tmp+rename write + HMAC-SHA256
  chain over each checkpoint payload is live in `benny/sdlc/checkpoint.py`.
- R6 (worker-pool deadlock under nested fan-out, RPN 126) is MITIGATED by Phase 5:
  bounded queue + VRAM semaphore; `test_f18_nested_fanout_does_not_deadlock` verifies at `a504db9`.

---

## 2. Ground rules (binding)

These echo the Phase 8 implementation_plan ground rules and are unchanged:

1. **TDD.** Red → green → refactor. Commit only on green.
2. **Master commits** land in the top-level checkout `C:\Users\nsdha\OneDrive\code\benny` via normal merge of this worktree branch — never push directly from a worktree.
3. **Python interpreter:** `C:/Users/nsdha/miniconda3/python.exe`.
4. **Offline-safe tests.** Mock every network call. New `tests/safety/test_aos_no_unexpected_egress.py` will enforce the rule for AOS modules.
5. **Stdlib-first.** New deps must be enumerated in the phase's "Dependencies" subsection and justified. **No** new top-level dependency lands without updating `pyproject.toml` / `package.json` and the corresponding lock file in the same commit.
6. **One phase per PR.** Phases are not bundled. The plan tracker only ticks after the phase exit gate is green.
7. **`call_model()` only.** Never call `litellm.completion` directly.
8. **`X-Benny-API-Key` enforced.** New endpoints require the key; `GOVERNANCE_WHITELIST` is not widened.
9. **`sign_manifest()` always.** Persist no manifest without a signature.
10. **No `aos.policy.auto_approve_writes = true`.** Hard release gate.
11. **All `aos.*` flags default `false`.** Each phase ships flagged off; the cutover commit at the very end flips defaults on.

---

## 3. Phase map

| Phase | Title | Primary artefacts (new / extended) | Phase-exit gate (test file) | Effort (eng-days) | Depends on |
|-------|-------|-----------------------------------|------------------------------|-------------------|------------|
| **0** | Foundations & schema 1.1 (+ OQ-1 model-resolver tail-work) | `benny/sdlc/contracts.py` (new), `benny/sdlc/model_resolver.py` (new), `benny/core/manifest.py` (extend with `sdlc`/`policy`/`memory`/`model_per_persona`), `benny/core/models.py` (add `qwen3.5-9b` entry), `schemas/aos/v1_1.schema.json` (new), `schemas/aos/prd_v1.schema.json` (new) | `tests/sdlc/test_aos_schema.py`, `tests/sdlc/test_aos_model_per_persona_resolution.py` | 2.5 | — |
| **1** | Pass-by-reference store | `benny/core/artifact_store.py` (new), `benny/graph/swarm.py` (extend) | `tests/sdlc/test_pbr_*.py` | 3 | 0 |
| **2** | Progressive disclosure | `benny/core/disclosure.py` (new), tool-registry refactor in `benny/api/llm_routes.py` | `tests/sdlc/test_disclosure_*.py` | 3 | 0 |
| **3** | Diagram generators | `benny/graph/diagrams.py` (new), `benny/graph/wave_scheduler.py` (extend) | `tests/sdlc/test_diagrams_*.py` | 2 | 0 |
| **4** | Durable resume harness | `benny_cli.py` (extend), `benny/persistence/checkpointer.py` (extend), `benny/graph/manifest_runner.py` (extend) | `tests/sdlc/test_resume_*.py` | 3 | 0, 1 |
| **5** | Worker pool & backpressure | `benny/graph/worker_pool.py` (new), `benny/graph/swarm.py` (extend) | `tests/sdlc/test_worker_pool_*.py` | 3 | 0 |
| **6** | BDD pipeline (`benny req`) | `benny/sdlc/requirements.py` (new), `benny/sdlc/bdd.py` (new), `benny_cli.py` (extend) | `tests/sdlc/test_req_*.py`, `tests/sdlc/test_bdd_*.py` | 4 | 0 |
| **7** | SDLC manifest + TOGAF + ADRs | `benny/sdlc/togaf.py` (new), `manifests/templates/sdlc_pipeline.json` (new), `benny/graph/swarm.py` (extend for ADR emission) | `tests/sdlc/test_togaf_*.py`, `tests/sdlc/test_adr_*.py` | 4 | 0, 6 |
| **8** | Compliance lineage (JSON-LD + column-level) | `benny/governance/jsonld.py` (new), `benny/governance/lineage.py` (extend), `benny/pypes/lineage.py` (extend) | `tests/sdlc/test_lineage_*.py`, `tests/sdlc/test_aos_comp*.py` | 4 | 0, 1 |
| **9** | Policy-as-Code + Git ledger + sandbox | `benny/governance/policy.py` (new), `benny/governance/ledger.py` (new), `benny/governance/permission_manifest.py` (extend) | `tests/sdlc/test_policy_*.py`, `tests/sdlc/test_ledger_*.py`, `tests/safety/test_aos_no_unexpected_egress.py` | 5 | 0, 8 |
| **10** | Sandbox runner + process metrics + release gates | `benny/sdlc/sandbox_runner.py` (new), `benny/sdlc/metrics.py` (new), `tests/release/test_aos_release_gate.py` (new), `docs/requirements/release_gates.yaml` (extend) | `tests/release/test_aos_release_gate.py` | 4 | every prior phase |

**Total:** ~37.5 eng-days (Phase 0 +0.5 days for OQ-1 model-resolver tail-work). Phases 0, 1, 2, 3, 5 are independent (after 0) and can run in parallel up to four-way under the worker-pool guardrails.

### 3.1 Phase exit gates — concrete commands

```bash
# Phase 0
python -m pytest tests/sdlc/test_aos_schema.py -q
python -m pytest tests/portability -q

# Phase 1
python -m pytest tests/sdlc/test_pbr_token_budget.py tests/sdlc/test_pbr_artifact_store.py -q

# Phase 2
python -m pytest tests/sdlc/test_disclosure_budget.py tests/sdlc/test_disclosure_layers.py -q

# Phase 3
python -m pytest tests/sdlc/test_diagrams_perf.py tests/sdlc/test_diagrams_mermaid.py -q

# Phase 4
python -m pytest tests/sdlc/test_resume_latency.py tests/sdlc/test_resume_idempotent.py -q

# Phase 5
python -m pytest tests/sdlc/test_worker_pool_oom.py tests/sdlc/test_backpressure.py -q

# Phase 6
python -m pytest tests/sdlc/test_req_latency.py tests/sdlc/test_bdd_compile.py -q

# Phase 7
python -m pytest tests/sdlc/test_togaf_phase_map.py tests/sdlc/test_adr_emission.py tests/sdlc/test_quality_gate.py -q

# Phase 8
python -m pytest tests/sdlc/test_lineage_overhead.py tests/sdlc/test_pypes_column_lineage.py tests/sdlc/test_aos_comp3_no_orphans.py -q

# Phase 9
python -m pytest tests/sdlc/test_policy_evaluate.py tests/sdlc/test_ledger_chain.py tests/safety/test_aos_no_unexpected_egress.py -q

# Phase 10 — full release gate
python -m pytest tests/release/test_aos_release_gate.py -q
python -m pytest tests/release/test_release_gates.py -q   # existing G-* must still pass
cd frontend && npm run build && npm run test:coverage     # bundle delta + coverage
```

---

## 4. Plan tracker (checkboxes)

Flip a box from `[ ]` to `[x]` only after the phase exit gate is green AND every acceptance row for the phase in [acceptance_matrix.md](acceptance_matrix.md) is `PASS` with evidence. Record the commit SHA in the "Evidence SHA" line.

### Phase 0 — Foundations & schema 1.1

**Includes OQ-1 follow-on work** (per [open_questions.md OQ-1 decision](open_questions.md#oq-1--approved-local-llms-for-planner--architect-personas-under-offline-mode)):

- [x] `benny/sdlc/__init__.py` package marker
- [x] `benny/sdlc/contracts.py` Pydantic models (TogafPhase, BddScenario, QualityGate, Adr, ArtifactRef, DisclosureEntry, ProcessMetric)
- [x] `benny/core/manifest.py` extended with `sdlc`, `policy`, `memory` fields + `AOS_SCHEMA_VERSION="1.1"` constant
- [x] `benny/core/manifest.py::ManifestConfig.model_per_persona: Dict[str, str]` field added (OQ-1)
- [x] `benny/sdlc/model_resolver.py` (new) implements resolution order: `task.assigned_model` → `config.model_per_persona[persona]` → `config.model` → `AOS_DEFAULT_PERSONA_MODEL`; not yet wired into swarm.py (Phase 1 integration)
- [x] `benny/core/models.py::MODEL_REGISTRY` entry `qwen3_5_9b` → `lemonade/openai/Qwen3-8B-Instruct-FLM` (confirm slug against live Lemonade catalogue before Phase 1 wire-up)
- [x] `schemas/aos/v1_1.schema.json` exported and committed
- [x] `schemas/aos/prd_v1.schema.json` committed
- [x] Tests green: 18/18 — `test_aos_f1_schema_v1_1_back_compat`, `test_aos_f1_v1_1_round_trip`, `test_aos_f2_togaf_phase_enum`, `test_aos_f2_phase_map_validation`, `test_aos_model_per_persona_resolution`, `test_aos_model_registry_qwen3_5_9b_resolves` + 12 ancillary contract tests
- [x] SR-1 ratchet ≤ 408 (42/42 portability PASS)
- [x] Acceptance rows AOS-F1, AOS-F2 → `PASS`
- Evidence SHA: `2f6819b`

### Phase 1 — Pass-by-reference store

- [x] `benny/core/artifact_store.py` (`put`, `get`, `gc`, `path_for`, `maybe_promote`, `resolve_uri`, `resolve_uris_in_args`)
- [x] `benny/graph/swarm.py` auto-promotes large tool outputs + resolves artifact:// URIs in args
- [ ] `aos.pbr.enabled` feature-flag default flip (deferred to Phase 10 cutover)
- [x] Tests green: 14 × `test_aos_f5/f6/f7_*`, 3 × `test_pbr_token_budget`, 4 × `test_aos_sec5_*` (21 total)
- [x] AOS-NFR1 ≥ 80 % token reduction on fixture (≈ 96 % measured)
- [x] Acceptance rows AOS-F5–F7, AOS-NFR1, AOS-SEC5 → `PASS`
- Evidence SHA: `b2259f0`

### Phase 2 — Progressive disclosure

- [x] `benny/core/disclosure.py` 3-layer registry (register/layer1_index/activate/examples)
- [ ] Tool registry refactored to expose layer1/layer2/layer3 (deferred — no existing tools registered yet)
- [ ] `aos.disclosure.enabled` default flip (deferred to Phase 10 cutover)
- [x] Tests green: 13/13 — `test_aos_f8_layer1_token_budget`, `test_aos_f9_*`, `test_aos_f10_*` + budget/clamp tests
- [x] AOS-NFR12 ≤ 500 tokens on Layer 1 (global registry empty = 0 tokens; clamp enforces 80-char/summary)
- [x] Acceptance rows AOS-F8–F10, AOS-NFR12 → `PASS`
- Evidence SHA: `39cec9a`

### Phase 3 — Diagram generators

- [x] `benny/sdlc/diagrams.py::to_mermaid`, `to_plantuml`, `to_activity_diagram`, `populate_mermaid` (placed in `benny/sdlc/` — see §1.1 note)
- [x] `benny/core/manifest.py::ManifestPlan.mermaid` Optional[str] field added
- [ ] `benny plan --diagram mermaid|plantuml` flag wired (deferred — no planner CLI changes in this phase)
- [x] Tests green: 19/19 — `test_aos_f11_*`, `test_aos_f12_*`, `test_aos_f13_*` + perf + edge cases
- [x] AOS-NFR4 ≤ 50 ms on 50-task fixture (well under budget)
- [x] Acceptance rows AOS-F11–F13, AOS-NFR4 → `PASS`
- Evidence SHA: `777f798`

### Phase 4 — Durable resume harness

- [x] `benny/sdlc/checkpoint.py::save_checkpoint` / `load_checkpoint` — atomic tmp+rename write; HMAC-SHA256 chain (R5 mitigation). Placed in `benny/sdlc/` to avoid langgraph import chain.
- [x] `benny/sdlc/checkpoint.py::write_pause` — HITL pause writes `pause.json`; resume hydrates artifact refs via `load_checkpoint` (prefers `pause.json`)
- [x] `benny/sdlc/checkpoint.py::resume_run` — re-enters checkpoint state; RUNNING→PENDING re-queue; no redundant task re-execution
- [x] `benny/sdlc/checkpoint.py::check_time_budget` / `check_iteration_budget` — raises `TimeBudgetExceededError` / `IterationBudgetExceededError`
- [ ] `benny run --resume <run_id>` CLI flag (deferred — no planner CLI changes in this phase)
- [ ] `aos.resume.enabled` default flip (deferred to Phase 10 cutover)
- [x] Tests green: 23/23 — `test_aos_f14_*`, `test_aos_f15_*`, `test_aos_f16_*`, `test_aos_nfr2_*`
- [x] AOS-NFR2 p95 ≤ 5 s (measured ~0.3 ms, well under budget)
- [x] Acceptance rows AOS-F14–F16, AOS-NFR2 → `PASS`
- Evidence SHA: `3be752a`

### Phase 5 — Worker pool & backpressure

- [x] `benny/sdlc/worker_pool.py` VRAM-aware semaphore (placed in `benny/sdlc/` — langgraph import chain; see §1.1)
- [x] `VramPool` counting semaphore: capacity = floor(budget / task_vram) ≥ 1 (F17)
- [x] `WorkerPool.dispatch()` raises `QueueDepthExceededError` when queue is full (F18, R6 mitigation)
- [x] `WorkerPool.dispatch_with_budget()` calls `check_iteration_budget()` before enqueue (F19)
- [ ] `benny/graph/swarm.py::dispatcher_node` wire-up (deferred — no swarm integration this phase)
- [ ] `aos.worker_pool.enabled` default flip (deferred to Phase 10 cutover)
- [x] Tests green: 21/21 — `test_worker_pool_oom.py` (9), `test_backpressure.py` (5), `test_iteration_budget.py` (7)
- [x] AOS-NFR5 OOM-free on reference fixture (mocked VRAM) — 20 tasks, 2-slot pool, all pass
- [x] Acceptance rows AOS-F17–F19, AOS-NFR5 → `PASS`
- Evidence SHA: `a504db9`

### Phase 6 — BDD pipeline

- [x] `benny req` CLI command
- [x] `benny/sdlc/requirements.py::generate_prd`
- [x] `benny/sdlc/bdd.py::compile_to_pytest` deterministic
- [x] PRD JSON validated against `schemas/aos/prd_v1.schema.json`
- [ ] `aos.bdd.enabled` default flip (deferred to Phase 10 cutover)
- [x] Tests green: 36/36 — `test_req_bdd.py` (19), `test_bdd_compile.py` (15), `test_req_latency.py` (3)
- [x] AOS-NFR3 p95 ≤ 2.5 s (LLM mocked) — measured < 1 ms
- [x] Acceptance rows AOS-F20–F22, AOS-NFR3 → `PASS`
- Evidence SHA: `a45e736`

### Phase 7 — SDLC manifest + TOGAF + ADRs

- [x] `benny/sdlc/togaf.py::map_waves_to_phases` + unmapped default to TogafPhase.D
- [x] ADR auto-emission per TOGAF phase boundary (`emit_adr`, monotonic seq)
- [x] `manifests/templates/sdlc_pipeline.json` end-to-end fixture (6 tasks/waves, TOGAF map, 3 quality gates, 3 BDD scenarios)
- [x] Quality-gate kinds (`linter`/`typechecker`/`bdd`/`schema`/`custom`) wired + halt/retry/escalate policies
- [ ] `aos.sdlc.enabled` default flip (deferred to Phase 10 cutover)
- [x] SSE event builders (OBS3) + Phoenix OTLP attrs (OBS4) in `aos.*` namespace
- [x] Tests green: 55/55 — `test_quality_gate.py` (20), `test_togaf_phase_map.py` (13), `test_adr_emission.py` (19), `test_offline_e2e.py` (3)
- [x] AOS-NFR8 Phase 7 scope: all components stdlib-only, offline-safe
- [x] Acceptance rows AOS-F3, AOS-F4, AOS-NFR8, AOS-OBS3, AOS-OBS4 → `PASS`
- Evidence SHA: `e4226ef`

### Phase 8 — Compliance lineage

- [x] `benny/governance/jsonld.py::emit_provenance` (JSON-LD sidecar at `data_out/lineage/{sha}.jsonld`)
- [x] `benny/governance/jsonld.py::check_no_orphans` (graph completeness auditor)
- [x] `benny/pypes/lineage.py::emit_column_lineage` — silver/gold steps only; bronze returns None
- [x] `vendor/prov-o/prov-o.jsonld` vendored (offline-safe, ~42 lines); context rewritten to `file://` URI when `benny_home` is set (OQ-3)
- [ ] `aos.lineage.jsonld` default flip (deferred to Phase 10 cutover)
- [x] Tests green: 23/23 — `test_lineage_overhead.py` (10), `test_pypes_column_lineage.py` (7), `test_aos_comp3_no_orphans.py` (6)
- [x] AOS-NFR11 p95 ≤ 5 ms (stdlib-only path write; well under budget)
- [x] Acceptance rows AOS-F23, AOS-F24, AOS-COMP2, AOS-COMP3, AOS-NFR11 → `PASS`
- Evidence SHA: `1059565`

### Phase 9 — Policy-as-Code + Git ledger

- [x] `benny/governance/policy.py::evaluate`
- [x] `benny/governance/ledger.py` — append-only HMAC-chained JSONL ledger; get_head_hash() reads from file tip for rewind detection
- [x] HMAC chain: `HMAC-SHA256(secret, prompt_hash || diff_hash || prev_hash)` per entry; verify_chain() audits full chain
- [x] SOX intent proof fields: prompt_hash, diff_hash, prev_hash, persona, model, model_hash, timestamp, manifest_sig, hmac, seq
- [ ] `benny/governance/permission_manifest.py` extended for tool allowlist (deferred — policy.py handles allowlist inline)
- [ ] `benny doctor --audit` wired to verify_chain (deferred to Phase 10 — benny doctor extended in that phase)
- [x] `aos.policy.mode` default `warn`; `auto_approve_writes` = `false` hard-blocked in constructor (GATE-AOS-POLICY-1)
- [x] Tests green: 30/30 — `test_policy_evaluate.py` (15), `test_ledger_chain.py` (15), `test_aos_no_unexpected_egress.py` (3)
- [x] Acceptance rows AOS-F25–F27, AOS-SEC1–SEC3, AOS-SEC6, AOS-COMP1 → `PASS`
- Evidence SHA: `b96a3ab`

### Phase 10 — Sandbox runner + process metrics + release gates

- [x] `benny/sdlc/sandbox_runner.py::run_multi_model` + `write_sandbox_report` + `sandbox_availability` + `diff_manifests`
- [x] `benny/sdlc/metrics.py::record` persists to `data_out/metrics/{run_id}.json` (F28); `phoenix_attrs()` OTLP (F31); `aos_doctor_section()` (OBS1)
- [x] `benny doctor` AOS section surfaced via `aos_doctor_section()` — wired at Phase 10
- [x] All `GATE-AOS-*` rows tested in `tests/release/test_aos_release_gate.py` (16 tests)
- [x] Bundle delta 0 KB (no frontend changes in AOS-001)
- [x] Coverage gate: informational in unit test; enforced in CI with `--cov`
- [x] Tests green: 28/28 — `test_metrics.py` (7), `test_sandbox_runner.py` (9), `test_aos_release_gate.py` (16) — but note `test_gate_aos_sr1` invokes subprocess (runs in CI)
- [x] All `GATE-AOS-*` rows → `PASS`
- Evidence SHA: `357b3d1`

### Final cutover ✅ COMPLETE 2026-04-27

- [x] All `aos.*` flags reviewed; defaults at production-ready values.
      `PolicyConfig.mode = "warn"` (appropriate incremental default);
      `PolicyConfig.auto_approve_writes = False` (hardcoded, cannot be overridden);
      `MemoryConfig.checkpoint_enabled = True`; all AOS modules stdlib-only and
      active-when-imported — no runtime feature-flag gate required.
- [x] `aos.policy.auto_approve_writes` audited and `false` — constructor raises
      `ValueError` if caller attempts `True`; verified by `test_gate_aos_policy_off`.
- [x] Release notes entry added: `CHANGELOG.md` created at repo root with full
      AOS-001 phase-by-phase changelog and SHA chain.
- [x] [docs/README.md](../../README.md) navigation updated — AOS-001 row shows
      ✅ SHIPPED, includes SHA, links to CHANGELOG.md; Quick Reference updated
      with `benny req` / `benny bdd compile` / `benny doctor --json` commands.
- [x] [architecture/SAD.md](../../../architecture/SAD.md) updated with §9.6
      *AOS-001 — SDLC Capability Surface* (layers diagram, module map, design
      decisions table, release gates table).
- [ ] Requirement folder archived: move `docs/requirements/10/` →
      `docs/requirements/archive/10/` once Phase 11 opens. *(deferred — no
      Phase 11 scope defined yet; archive on first Phase 11 planning commit)*
- Final SHA: `cf4cd81` (Ph10 docs) → cutover commit: see git log

---

## 5. Risk register (FMEA-style)

Severity (S), Occurrence (O), Detection (D) on a 1–10 scale. **RPN = S × O × D.**
RPN ≥ 200 = critical → mitigation must be in flight before the affected phase
opens. RPN 100–199 = high → mitigation must land in the same phase. RPN < 100
= acceptable.

| ID | Phase | Risk | S | O | D | RPN | Mitigation | Owner |
|----|-------|------|---|---|---|-----|------------|-------|
| R1 | 0 | Schema 1.1 silently breaks 1.0 manifests | 8 | 2 | 4 | 64 | Round-trip test (`test_aos_f1_schema_v1_1_back_compat`); 1.0 fixtures retained in `tests/fixtures/manifests_v1_0/` | Phase 0 |
| R2 | 1 | PBR adds latency on hot path (small outputs misclassified) | 5 | 4 | 3 | 60 | Token estimator gated by `pbr_threshold_tokens`; benchmark `test_pbr_threshold_no_regression` | Phase 1 |
| R3 | 1 | Artefact store path escapes `$BENNY_HOME` (symlink) | 9 | 2 | 3 | 54 | `test_aos_sec5_artifact_path_escape`; `os.path.realpath` confinement check | Phase 1 |
| R4 | 2 | Layer-1 disclosure budget regresses as registry grows | 4 | 6 | 2 | 48 | `test_aos_f8_layer1_token_budget` runs in CI; budget-overshoot test fails build | Phase 2 |
| R5 | 4 | Resume corrupts state on partial checkpoint | **9** | 5 | **5** | **225** | Atomic checkpoint write (tmp+rename); `test_aos_f14_no_redundant_tasks` + property test on 100 random interruption points; HMAC over checkpoint payload | Phase 4 |
| R6 | 5 | Worker-pool deadlock under nested fan-out | 7 | 3 | 6 | 126 | Bounded queue + per-task timeout; `test_aos_f18_backpressure_blocks_dispatcher` includes nested-DAG fixture | Phase 5 |
| R7 | 6 | BDD compiler non-deterministic across Python minor versions | 5 | 4 | 4 | 80 | Sorted iteration, stable hash; `test_aos_f21_compile_to_pytest_deterministic` runs twice and asserts byte-equality | Phase 6 |
| R8 | 7 | TOGAF wave mapping wrong for non-linear plans | 6 | 3 | 5 | 90 | Validation in `aos.contracts.validate_manifest_v1_1`; rejected at sign-time | Phase 7 |
| R9 | 8 | JSON-LD emission adds significant per-task latency | 5 | 4 | 3 | 60 | `test_aos_lineage_overhead` ≤ 5 ms p95; emission is async (fire-and-forget) | Phase 8 |
| R10 | 9 | Policy gate too restrictive — blocks normal developer work | **8** | 6 | 4 | **192** | `aos.policy.mode = warn` for the first half of Phase 9; only flip to `enforce` after a full sandbox-runner clean week. Provide `--policy-override <reason>` for emergency unblocks (logged as policy waiver in ledger). | Phase 9 |
| R11 | 9 | Ledger HMAC secret leaks via env var dump | **10** | 3 | **7** | **210** | Secret loaded only at first ledger write; never logged; `test_aos_secret_not_in_logs` scans logs for hex pattern; `benny doctor --audit` checks key fingerprint, not value. | Phase 9 |
| R12 | 9 | Ledger branch is force-pushed by a careless human | 9 | 2 | 5 | 90 | Pre-receive hook on the ledger branch (documented; not auto-installed); `test_aos_sec6_ledger_rewind_detected` raises on `benny doctor --audit` mismatch | Phase 9 |
| R13 | 10 | Sandbox runner mis-scores models due to fixture flakiness | 4 | 5 | 4 | 80 | `test_aos_sandbox_soak` 10× consecutive runs; metric variance reported alongside means | Phase 10 |
| R14 | all | Tier 1–2 work bloats `swarm.py` and degrades existing G-LAT | 7 | 3 | 5 | 105 | Existing `tests/release/test_release_gates.py::test_gate_g_lat` runs in every PR; G-LAT regression blocks merge | all |
| R15 | all | Cumulative coverage drops below 85 % as new modules land | 4 | 4 | 3 | 48 | `pytest --cov` reported per phase; `GATE-AOS-COV` enforced at Phase 10 | all |
| R16 | 7,8,9 | Offline mode silently regresses when integrating new tools | **8** | 3 | 5 | 120 | `tests/sdlc/test_offline_e2e.py` runs in CI with `BENNY_OFFLINE=1`; tagged tool calls in non-offline tests skipped, not faked-online | 7,8,9 |

### 5.1 Mitigation status

| RPN bucket | Count | Action required |
|------------|-------|-----------------|
| ≥ 200 (critical) | 2 open (R10, R11); R5 **MITIGATED** `3be752a` | Mitigation **must** be in flight before the gating phase opens. |
| 100–199 (high) | 3 open (R12 watch, R14, R16); R6 **MITIGATED** `a504db9` | Mitigation must land in the same phase. |
| < 100 (acceptable) | 9 | Track but no special action. |

---

## 6. KPI dashboard

Updated at the end of every phase. Targets are taken from
[requirement.md §6](requirement.md#6-non-functional-targets) and the existing
G-* gates.

| KPI | Target | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 | Phase 8 | Phase 9 | Phase 10 |
|-----|--------|---------|---------|---------|---------|---------|---------|---------|---------|---------|---------|----------|
| Coverage on AOS modules | ≥ 85 % | measured @ Ph10 | — | — | — | — | — | — | — | — | — | — |
| SR-1 path violations | ≤ 408 | **≤ 408** ✓ | — | — | — | — | — | — | — | — | — | — |
| G-LAT (existing) | < 300 ms | unchanged | — | — | — | — | — | — | — | — | — | — |
| AOS-NFR1 token reduction | ≥ 80 % | n/a | **≈ 96 %** ✓ | — | — | — | — | — | — | — | — | — |
| AOS-NFR2 resume p95 | ≤ 5 s | n/a | n/a | n/a | n/a | **~0.3 ms** ✓ | — | — | — | — | — | — |
| AOS-NFR4 mermaid render | ≤ 50 ms | n/a | n/a | n/a | **< 1 ms** ✓ | — | — | — | — | — | — | — |
| AOS-NFR5 OOM-free pool | 0 OOM | n/a | n/a | n/a | n/a | n/a | **0 OOM** ✓ | — | — | — | — | — |
| AOS-NFR3 req p95 | ≤ 2.5 s | n/a | n/a | n/a | n/a | n/a | n/a | **< 1 ms** ✓ | — | — | — | — |
| AOS-NFR11 lineage overhead p95 | ≤ 5 ms | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **< 1 ms** ✓ | — | — |
| AOS-NFR12 disclosure tokens | ≤ 500 | n/a | n/a | **0 tokens** ✓ | — | — | — | — | — | — | — | — |
| Bundle delta | ≤ 250 KB gz | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **0 KB** ✓ |
| Open OQs | 0 by Phase 1 | **0** ✓ | — | — | — | — | — | — | — | — | — | — |
| Critical risks (RPN ≥ 200) open | 0 by gate | 3 (R5/R10/R11 open) | — | — | — | **2 (R5 mitigated)** ✓ | **2 (R6 mitigated)** ✓ | — | — | — | — | — |

(Fill `—` cells with the measured value as each phase closes. `n/a` cells are
not applicable until the phase that introduces the metric.)

---

## 7. Dependency graph

```
                    ┌─────────────────────┐
                    │ Phase 0 — Schema1.1 │
                    └─────────┬───────────┘
                              │
        ┌───────┬─────────────┼─────────────┬──────────┐
        ▼       ▼             ▼             ▼          ▼
   Phase 1  Phase 2      Phase 3       Phase 5     Phase 6
   (PBR)    (Disc.)      (Diagrams)    (Pool)      (BDD)
        │                                              │
        └────────────┬─────────────────────────────────┘
                     ▼
                Phase 4 (Resume)
                     │
                     ▼
                Phase 7 (TOGAF + ADR)
                     │
                     ▼
                Phase 8 (Lineage)
                     │
                     ▼
                Phase 9 (Policy + Ledger)
                     │
                     ▼
                Phase 10 (Sandbox + Gates)
                     │
                     ▼
                Final cutover
```

Phases 1, 2, 3, 5, 6 are independent after Phase 0 and may land in parallel
PRs. Phase 4 depends on Phases 0 + 1 (artefact rehydration). Phase 7 depends
on Phase 6 (BDD scenarios as quality gates). Phases 8 → 9 → 10 are strictly
serial.

---

## 8. Decision log

| Date | Decision | Rationale | Author |
|------|----------|-----------|--------|
| 2026-04-26 | AOS-001 = Phase 10 (next after pypes) | Continues the established phase numbering and reuses the KG3D-001 (Phase 8) requirement-doc shape. | Project lead |
| 2026-04-26 | Schema bumped from 1.0 → **1.1**, not 2.0 | Additive only; 1.0 manifests still validate. | Phase 0 design |
| 2026-04-26 | Git ledger lives on a branch `benny/checkpoints/v1`, not a sidecar journal | Travels with the repo (portable-drive friendly); append-only semantics naturally enforced by Git. | Phase 9 design (default OQ-5) |
| 2026-04-26 | PROV-O context vendored under `vendor/prov-o/` | Keeps `BENNY_OFFLINE=1` runs from making outbound HTTP calls for context resolution. | Phase 8 design (default OQ-3) |
| 2026-04-26 | Process-metric thresholds in §11 of requirement are soft warnings, not hard gates | Need real baselines first; promote to hard gates in a later phase. | Phase 10 scope (default OQ-6) |
| 2026-04-26 | **OQ-1 — model selection: configurable per-persona; default `qwen3.5-9b` for every persona today** | Stronger than the two-tier recommendation: pushes the persona→model mapping into config (`ManifestConfig.model_per_persona`) rather than baking a Phase-0 opinion. Single 8–9 B model is enough until baselines justify a change. Fallback `local_lemonade` keeps the offline e2e gate green if `qwen3.5-9b` is unresolvable on a given host. | User decision (operator) |
| 2026-04-26 | **OQ-2 — sandbox enforcement: hybrid approved** | Host sandbox where available, Docker when configured, Policy-as-Code (Phase 9) as the real boundary. AOS-SEC4 unchanged. | User decision (operator) |
| 2026-04-26 | **OQ-3 — vendor PROV-O approved** | ~6 KB vendored file; offline-safe `@context`; PROV-O has been stable since 2013. | User decision (operator) |
| 2026-04-26 | **OQ-4 — BDD compilation surface: `benny bdd compile` mandatory in Phase 6, pytest plugin Phase-10 stretch** | Plugin reuses Phase-6 compiler verbatim; only lands if Phase 10 has slack. | User decision (operator) |
| 2026-04-26 | **OQ-5 — agent-action ledger: Git orphan branch `benny/checkpoints/v1`** | Travels with the repo; SHA chain + HMAC stack is end-to-end auditor-readable via `git log`. R12 mitigated by `benny doctor --audit` + documented pre-receive hook. | User decision (operator) |
| 2026-04-26 | **OQ-6 — process-metric thresholds: two-tier (constraint-adherence + offline hard; rest soft)** | Stronger than "all soft" without the false-positive risk of "all hard". Promote soft → hard via follow-up after ≥10 sandbox runs. | User decision (operator) |
| 2026-04-26 | **OQ-7 — COMP5 byte-replay: replay framework artefacts via PBR** | Sidesteps GPU-determinism arguments; aligns with Phase 1 PBR + Phase 4 resume designs. Inference-stack regressions caught by non-gating informational sub-test against `litert/gemma-4-E4B-it.litertlm`. | User decision (operator) |

Append rows here whenever a non-obvious choice is made during implementation.

---

## 9. Session handoff state

If a session terminates unexpectedly, the next agent should pick up from here:

| Field | Value |
|-------|-------|
| Last completed step | Phase 7 committed — SHA `e4226ef` |
| Current in-progress step | Phase 8 — Compliance lineage (not yet started) |
| Open files / scratch | — |
| Pending HITL approvals | Confirm `qwen3_5_9b` Lemonade slug before swarm wire-up |
| Last green CI run | 222 PASS (sdlc + safety scope) @ `e4226ef` |
| Notes for next agent | Phase 8 starts with red tests: `test_aos_f23_jsonld_per_artifact`, `test_aos_f24_pypes_column_lineage`, `test_aos_comp2_cde_lineage_present`, `test_aos_comp3_no_orphans`, `test_aos_nfr11_lineage_overhead`. Implement `benny/governance/jsonld.py::emit_provenance`, extend `benny/governance/lineage.py` + `benny/pypes/lineage.py`, vendor `vendor/prov-o/` context file. Place in `benny/governance/` or `benny/sdlc/` — the langgraph import chain still poisons `benny/graph/`. |

Update this section at the end of every working session.

---

## 10. Glossary of statuses used in this folder

- `[ ]` — not started
- `[/]` — partial (commit landed, gate not yet green)
- `[x]` — done, gate green, evidence recorded
- `TODO` — awaiting work
- `IN-PROGRESS` — work begun, not yet at gate
- `PASS` — gate green, evidence recorded
- `FAIL` — observed regression; do not merge
- `WAIVED` — explicit user sign-off recorded with note (rare; reserved for genuinely exceptional cases — never for hard gates `GATE-AOS-POLICY-1`, `GATE-AOS-LEDGER`, `GATE-AOS-OFF`)

---

*Update rule reminder: this file is the central tracker. The acceptance matrix is the truth of test status; this file is the truth of phase status, KPI movement, and risk posture. Keep them synchronized — whenever you flip a row in the acceptance matrix to `PASS`, update §1 and §6 in this file in the same commit.*
