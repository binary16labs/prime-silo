# KG3D-001 — Acceptance Matrix

Each row is the **unit of acceptance**. A phase is not "done" until
every row in its phase group is `PASS` with a non-empty `Evidence`
pointer (test name, CI run id, or commit SHA).

Status legend: `TODO` · `IN-PROGRESS` · `PASS` · `FAIL` · `WAIVED
(requires user sign-off note)`.

## Functional (from [requirement.md §5](requirement.md#5-functional-requirements))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| KG3D-F1 | 0,1 | `test_kg3d_f1_fixture_counts`, `test_kg3d_f1_load_counts` | TODO | |
| KG3D-F2 | 2 | `test_kg3d_f2_metrics_contract`, `test_metrics_cache_invalidates_on_hash_change` | TODO | |
| KG3D-F3 | 1 | `test_migration_idempotent` | TODO | |
| KG3D-F4 | 3 | `test_api_ontology_round_trip`, `test_api_ontology_size_cap` | TODO | |
| KG3D-F5 | 4 | `synoptic-web.spec.ts::mounts-under-flag` | TODO | |
| KG3D-F6 | 4 | `synoptic-web.spec.ts::palette-and-emissive` | TODO | |
| KG3D-F7 | 4 | `synoptic-web.spec.ts::directed-particles` | TODO | |
| KG3D-F8 | 4 | `synoptic-web.spec.ts::warmup-cooldown` | TODO | |
| KG3D-F9 | 5 | `instancing.spec.ts::threshold-switch` | TODO | |
| KG3D-F10 | 5 | `instancing.spec.ts::draw-calls-le-100` | TODO | |
| KG3D-F11 | 5 | `instancing.spec.ts::worker-rate` | TODO | |
| KG3D-F12 | 5 | `instancing.spec.ts::lod-points` | TODO | |
| KG3D-F13 | 6 | `focus-context.spec.ts::aot-cut-layers` | TODO | |
| KG3D-F14 | 6 | `test_kg3d_f14_abstraction_constraint` | TODO | |
| KG3D-F15 | 6 | `focus-context.spec.ts::dim-non-path` | TODO | |
| KG3D-F16 | 6 | `semantic-zoom.spec.ts::collapse-expand` | TODO | |
| KG3D-F17 | 7 | `ipc.spec.ts::store-hydrates` | TODO | |
| KG3D-F18 | 7 | `ipc.spec.ts::symbol-detected-focus` | TODO | |
| KG3D-F19 | 7 | `ipc.spec.ts::camera-ease-600ms` | TODO | |
| KG3D-F20 | 4,7 | `unmount.spec.ts::teardown-le-250ms` | TODO | |
| KG3D-F21 | 9 | `webxr.spec.ts::silent-skip-when-absent` | TODO | |
| KG3D-F22 | 9 | `webxr.spec.ts::wim-anchor` | TODO | |
| KG3D-F23 | 9 | `webxr.spec.ts::grab-drag-release-visual-only` | TODO | |
| KG3D-F24 | 8 | `test_propose_offline_refusal` | TODO | |
| KG3D-F25 | 8 | `test_gcot_rejects_dag_violation`, `test_gcot_rejects_unknown_category` | TODO | |
| KG3D-F26 | 8 | `test_hitl_required_before_commit` | TODO | |
| KG3D-F27 | 8 | `test_api_sse_delta_after_approval` | TODO | |

## Non-functional (from [requirement.md §6](requirement.md#6-non-functional-targets))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| KG3D-NFR1 | 5,10 | `perf_budget.json::median-fps-ge-60` | TODO | |
| KG3D-NFR2 | 4,10 | `perf_budget.json::cold-load-le-3500ms` | TODO | |
| KG3D-NFR3 | 5,10 | `perf_budget.json::long-tasks-eq-0` | TODO | |
| KG3D-NFR4 | 3,8 | `test_sse_delta_latency_p95` | TODO | |
| KG3D-NFR5 | 4,7 | `test_no_memory_leak_20_cycles` | TODO | |
| KG3D-NFR6 | 7 | `ipc.spec.ts::keyboard-nav-5-keys` | TODO | |
| KG3D-NFR7 | all | `tests/safety/test_kg3d_no_network.py` | TODO | |
| KG3D-NFR8 | all | `tests/safety/test_sr1_no_absolute_paths.py` (existing) | TODO | |
| KG3D-NFR9 | 10 | `test_bundle_size_delta_le_450kb` | TODO | |
| KG3D-NFR10 | 10 | coverage run in `test_kg3d_release_gate.py` | TODO | |

## Security (from [requirement.md §8](requirement.md#8-security--privacy))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| KG3D-SEC1 | 4 | `test_webview_local_resource_roots` | TODO | |
| KG3D-SEC2 | 4 | `test_webview_csp_header` | TODO | |
| KG3D-SEC3 | 1,8 | `tests/safety/test_kg3d_no_cypher_interp.py` | TODO | |
| KG3D-SEC4 | 8 | `test_ingest_truncates_to_512kb` | TODO | |

## Observability

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| KG3D-OBS1 | 10 | `test_doctor_includes_kg3d_section` | TODO | |
| KG3D-OBS2 | all | `test_kg3d_logs_carry_component` | TODO | |
| KG3D-OBS3 | 10 | `perf-telemetry.spec.ts::fps-and-draw-calls` | TODO | |

## Release gates (hard blocks)

| Gate ID | Description | Test ID | Status | Evidence |
|---------|-------------|---------|--------|----------|
| GATE-HITL-1 | `kg3d.ingest.auto_approve` must be `false` at release. | `test_kg3d_release_gate.py::auto_approve_off` | TODO | |
| GATE-SR1 | SR-1 absolute-path ratchet not raised. | existing | TODO | |
| GATE-OFFLINE | `BENNY_OFFLINE=1` refuses cloud models in ingest. | `test_propose_offline_refusal` | TODO | |
| GATE-COVERAGE | Backend ≥ 92 %, frontend ≥ 85 % for `kg3d/**`. | release gate | TODO | |
| GATE-BUNDLE | Gzip delta ≤ 450 KB. | release gate | TODO | |

## Open questions (must be resolved before Phase 1 merges)

| OQ ID | Status | Resolution / pointer |
|-------|--------|----------------------|
| OQ-1 | OPEN | _fill in when legal signs off_ |
| OQ-2 | OPEN | default `qwen3-coder-30b` unless overridden |
| OQ-3 | OPEN | default Yes |
