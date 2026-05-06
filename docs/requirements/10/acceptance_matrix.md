# AOS-001 — Acceptance Matrix

Each row is the **unit of acceptance**. A phase is not "done" until every row
in its phase group is `PASS` with a non-empty `Evidence` pointer (test name,
CI run id, or commit SHA).

Status legend: `TODO` · `IN-PROGRESS` · `PASS` · `FAIL` · `WAIVED (requires user
sign-off note)`.

Phase column references [project_plan.md §3 Phase map](project_plan.md#3-phase-map).

---

## Functional (from [requirement.md §5](requirement.md#5-functional-requirements))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AOS-F1  | 0   | `test_aos_f1_schema_v1_1_back_compat`, `test_aos_f1_v1_1_round_trip` | PASS | `2f6819b` |
| AOS-F2  | 0   | `test_aos_f2_togaf_phase_enum`, `test_aos_f2_phase_map_validation` | PASS | `2f6819b` |
| AOS-F3  | 7   | `test_aos_f3_quality_gate_kinds`, `test_aos_f3_halt_on_failure` | PASS | `e4226ef` |
| AOS-F4  | 7   | `test_aos_f4_adr_emission`, `test_aos_f4_adr_sequence_monotonic` | PASS | `e4226ef` |
| AOS-F5  | 1   | `test_aos_f5_artifact_put_get_roundtrip`, `test_aos_f5_content_addressed` | PASS | `b2259f0` |
| AOS-F6  | 1   | `test_aos_f6_auto_promote_above_threshold`, `test_aos_f6_summary_clamp_200` | PASS | `b2259f0` |
| AOS-F7  | 1   | `test_aos_f7_uri_substitution_in_tool_call` | PASS | `b2259f0` |
| AOS-F8  | 2   | `test_aos_f8_layer1_token_budget` (≤ 500 tokens) | PASS | `39cec9a` |
| AOS-F9  | 2   | `test_aos_f9_activate_returns_schema`, `test_aos_f9_lazy_load` | PASS | `39cec9a` |
| AOS-F10 | 2   | `test_aos_f10_examples_layer3_optional` | PASS | `39cec9a` |
| AOS-F11 | 3   | `test_aos_f11_to_mermaid_emits_graph_td`, `test_aos_f11_subgraph_per_wave` | PASS | `777f798` |
| AOS-F12 | 3   | `test_aos_f12_to_plantuml_smoke` | PASS | `777f798` |
| AOS-F13 | 3   | `test_aos_f13_activity_diagram_per_scenario` | PASS | `777f798` |
| AOS-F14 | 4   | `test_aos_f14_resume_from_checkpoint`, `test_aos_f14_no_redundant_tasks` | PASS | `3be752a` |
| AOS-F15 | 4   | `test_aos_f15_pause_resume_across_hosts` (mocked move) | PASS | `3be752a` |
| AOS-F16 | 4   | `test_aos_f16_time_budget_escalates`, `test_aos_f16_iteration_budget_escalates` | PASS | `3be752a` |
| AOS-F17 | 5   | `test_aos_f17_vram_aware_capacity` (mocked VRAM) | PASS | `a504db9` |
| AOS-F18 | 5   | `test_aos_f18_backpressure_blocks_dispatcher` | PASS | `a504db9` |
| AOS-F19 | 5   | `test_aos_f19_iteration_budget_raises` | PASS | `a504db9` |
| AOS-F20 | 6   | `test_aos_f20_req_emits_prd_and_feature` | PASS | `a45e736` |
| AOS-F21 | 6   | `test_aos_f21_compile_to_pytest_deterministic` | PASS | `a45e736` |
| AOS-F22 | 6   | `test_aos_f22_prd_schema_validation` | PASS | `a45e736` |
| AOS-F23 | 8   | `test_aos_f23_jsonld_per_artifact` | PASS | `1059565` |
| AOS-F24 | 8   | `test_aos_f24_pypes_column_lineage` | PASS | `1059565` |
| AOS-F25 | 9   | `test_aos_f25_policy_evaluate_modes`, `test_aos_f25_escalate_pauses` | PASS | `b96a3ab` |
| AOS-F26 | 9   | `test_aos_f26_ledger_append_only`, `test_aos_f26_hmac_chain` | PASS | `b96a3ab` |
| AOS-F27 | 9   | `test_aos_f27_sox_intent_proof`, `test_aos_f27_doctor_audit_chain` | PASS | `b96a3ab` |
| AOS-F28 | 10  | `test_aos_f28_metrics_record_persisted` | PASS | `357b3d1` |
| AOS-F29 | 10  | `test_aos_f29_sandbox_multi_model_report` | PASS | `357b3d1` |
| AOS-F30 | 10  | `test_aos_f30_report_shape` | PASS | `357b3d1` |
| AOS-F31 | 10  | `test_aos_f31_phoenix_attributes_emitted` | PASS | `357b3d1` |

## Non-functional (from [requirement.md §6](requirement.md#6-non-functional-targets))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AOS-NFR1  | 1     | `tests/sdlc/test_pbr_token_budget.py` | PASS | `b2259f0` |
| AOS-NFR2  | 4     | `tests/sdlc/test_resume_latency.py`   | PASS | `3be752a` |
| AOS-NFR3  | 6     | `tests/sdlc/test_req_latency.py`      | PASS | `a45e736` |
| AOS-NFR4  | 3     | `tests/sdlc/test_diagrams_perf.py`    | PASS | `777f798` |
| AOS-NFR5  | 5     | `tests/sdlc/test_worker_pool_oom.py`  | PASS | `a504db9` |
| AOS-NFR6  | 10    | `tests/release/test_aos_release_gate.py::coverage` | PASS | `357b3d1` |
| AOS-NFR7  | all   | existing `tests/portability/test_no_absolute_paths.py` | PASS | `357b3d1` |
| AOS-NFR8  | 7,8,9 | `tests/sdlc/test_offline_e2e.py`      | PASS | `e4226ef` |
| AOS-NFR9  | 10    | `tests/sdlc/test_sandbox_soak.py`     | PASS | `357b3d1` |
| AOS-NFR10 | 10    | `tests/release/test_aos_release_gate.py::bundle_delta` | PASS | `357b3d1` |
| AOS-NFR11 | 8     | `tests/sdlc/test_lineage_overhead.py` | PASS | `1059565` |
| AOS-NFR12 | 2     | `tests/sdlc/test_disclosure_budget.py`| PASS | `39cec9a` |

## Security (from [requirement.md §8](requirement.md#8-security--privacy))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AOS-SEC1 | 9 | `test_aos_sec1_persona_tool_allowlist` | PASS | `b96a3ab` |
| AOS-SEC2 | 9 | `tests/safety/test_aos_no_unexpected_egress.py` | PASS | `b96a3ab` |
| AOS-SEC3 | 9 | `test_aos_sec3_path_traversal_rejected` | PASS | `b96a3ab` |
| AOS-SEC4 | 10 | `test_aos_sec4_doctor_reports_sandbox` | PASS | `357b3d1` |
| AOS-SEC5 | 1 | `test_aos_sec5_artifact_path_escape` | PASS | `b2259f0` |
| AOS-SEC6 | 9 | `test_aos_sec6_ledger_rewind_detected` | PASS | `b96a3ab` |

## Compliance — SOX 404 + BCBS 239 (from [requirement.md §9](requirement.md#9-compliance--sox-404--bcbs-239-brief-9))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AOS-COMP1 | 9 | `test_aos_comp1_sox_chain_verify` | PASS | `b96a3ab` |
| AOS-COMP2 | 8 | `test_aos_comp2_cde_lineage_present` | PASS | `1059565` |
| AOS-COMP3 | 8 | `test_aos_comp3_no_orphans`         | PASS | `1059565` |
| AOS-COMP4 | 10 | `test_aos_comp4_diff_smoke`         | PASS | `357b3d1` |
| AOS-COMP5 | 10 | `test_aos_comp5_replay_byte_equal_local` | PASS | `357b3d1` |

## Observability (from [requirement.md §10](requirement.md#10-observability))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AOS-OBS1 | 10 | `test_aos_obs1_doctor_aos_section` | PASS | `357b3d1` |
| AOS-OBS2 | all | `test_aos_obs2_logs_carry_component` | PASS | `357b3d1` |
| AOS-OBS3 | 7,8,9 | `test_aos_obs3_sse_event_schemas` | PASS | `e4226ef` |
| AOS-OBS4 | 7,8,9 | `test_aos_obs4_phoenix_attrs` | PASS | `e4226ef` |

---

## Release gates (hard blocks — extend `release_gates.yaml`)

| Gate ID | Description | Test ID | Status | Evidence |
|---------|-------------|---------|--------|----------|
| GATE-AOS-COV     | New AOS modules ≥ 85 % coverage. | `tests/release/test_aos_release_gate.py::coverage` | PASS | `357b3d1` |
| GATE-AOS-SR1     | SR-1 ratchet not raised by AOS additions. | existing | PASS | `357b3d1` |
| GATE-AOS-OFF     | `BENNY_OFFLINE=1` runs full SDLC pipeline e2e. | `tests/sdlc/test_offline_e2e.py` | PASS | `357b3d1` |
| GATE-AOS-SIG     | Manifest 1.1 carries valid signature; replay verifies. | `tests/release/test_aos_release_gate.py::sig` | PASS | `357b3d1` |
| GATE-AOS-POLICY-1 | `aos.policy.auto_approve_writes` MUST be `false` at release. | `tests/release/test_aos_release_gate.py::policy_off` | PASS | `357b3d1` |
| GATE-AOS-LEDGER  | Ledger HMAC chain verifies on `benny doctor --audit`. | `test_aos_f27_doctor_audit_chain` | PASS | `357b3d1` |
| GATE-AOS-PBR     | Default-on PBR yields ≥ 80 % token reduction on the test fixture. | `tests/sdlc/test_pbr_token_budget.py` | PASS | `357b3d1` |
| GATE-AOS-DISC    | Layer-1 disclosure ≤ 500 tokens. | `tests/sdlc/test_disclosure_budget.py` | PASS | `357b3d1` |
| GATE-AOS-RESUME  | Resume p95 ≤ 5 s. | `tests/sdlc/test_resume_latency.py` | PASS | `357b3d1` |
| GATE-AOS-BUNDLE  | UI bundle delta ≤ 250 KB gzipped. | `tests/release/test_aos_release_gate.py::bundle_delta` | PASS | `357b3d1` |

## Open questions — resolved 2026-04-26

| OQ ID | Status | Resolution / pointer |
|-------|--------|----------------------|
| OQ-1 | **DECIDED** | CUSTOM — fully configurable per-persona; default `qwen3.5-9b` for every persona today. See [open_questions.md OQ-1](open_questions.md#oq-1--approved-local-llms-for-planner--architect-personas-under-offline-mode). |
| OQ-2 | **DECIDED** | APPROVED — hybrid (host sandbox where available, Docker when configured, Policy-as-Code as primary boundary). See [open_questions.md OQ-2](open_questions.md#oq-2--vendor-bubblewrap--sandbox-exec-or-rely-on-host). |
| OQ-3 | **DECIDED** | APPROVED — vendor PROV-O under `vendor/prov-o/`. See [open_questions.md OQ-3](open_questions.md#oq-3--json-ld-context-vendor-prov-o-or-live-url). |
| OQ-4 | **DECIDED** | APPROVED — `benny bdd compile` in Phase 6 + opt-in pytest plugin in Phase 10 stretch. See [open_questions.md OQ-4](open_questions.md#oq-4--bdd-compilation-separate-command-pytest-plugin-or-both). |
| OQ-5 | **DECIDED** | APPROVED — Git orphan branch `benny/checkpoints/v1`. See [open_questions.md OQ-5](open_questions.md#oq-5--agent-action-ledger-git-branch-or-sidecar-journal). |
| OQ-6 | **DECIDED** | APPROVED — two-tier (constraint-adherence + offline hard; rest soft). See [open_questions.md OQ-6](open_questions.md#oq-6--process-metric-thresholds-soft-warnings-or-hard-release-gate-fails). |
| OQ-7 | **DECIDED** | APPROVED — replay framework artefacts via PBR; informational sub-test against `litert/gemma-4-E4B-it.litertlm`. See [open_questions.md OQ-7](open_questions.md#oq-7--is-temperature0--provider-seed-enough-for-comp5-byte-replay). |

---

## DPMO summary (Six-Sigma framing)

Total acceptance rows: **62** (31 functional + 12 NFR + 6 security + 5 compliance + 4 observability + 10 release gates - 6 hard duplicates already counted above = 62).

To meet the implicit 6σ target (≤ 3.4 defects per million opportunities) at the
**release-gate** level, every row in this matrix MUST pass on the merge commit
(0 defects observed against 62 opportunities → 0 DPMO at this scope). The
ratchet is preserved long-term via `tests/release/test_aos_release_gate.py`.

The DPMO target is **not** applied at the per-commit-during-development level —
only at release-merge-to-master. During development, the relevant gate is the
phase-exit gate documented in [project_plan.md §3](project_plan.md#3-phase-map).
