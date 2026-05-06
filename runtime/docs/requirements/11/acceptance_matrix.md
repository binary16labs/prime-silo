# AAMP-001 — Acceptance Matrix

Each row is the **unit of acceptance**. A phase is not "done" until every
row in its phase group is `PASS` with a non-empty `Evidence` pointer (test
name, CI run id, or commit SHA).

Status legend: `TODO` · `IN-PROGRESS` · `PASS` · `FAIL` · `WAIVED (requires
user sign-off note)`.

Phases group AAMP-001 work into nine landings, retiring the highest-RPN
risks first (signing & sandboxing before marketplace; offline before remote
pull):

| Phase | Theme |
|-------|-------|
| 0 | Schemas, contracts, feature flags, scaffolding |
| 1 | Skin pack format + theme engine |
| 2 | AgentVis SDK + sandbox + CSP |
| 3 | DSP-A pipeline (deterministic) |
| 4 | Mini-mode (Textual TUI) |
| 5 | Equalizer panel + manifest write path |
| 6 | Playlist & enqueue + layout DSL |
| 7 | Effects pipeline + lineage emission |
| 8 | Marketplace (local registry; opt-in remote pull) |
| 9 | Release-gate hardening (compliance pillar §11) |

---

## Functional (from [requirement.md §5](requirement.md#5-functional-requirements))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AAMP-F1  | 1 | `test_aamp_f1_skin_load_signed`, `test_aamp_f1_unsigned_rejected` | TODO | — |
| AAMP-F2  | 1 | `test_aamp_f2_tokens_to_css_vars`, `test_aamp_f2_no_react_remount` | TODO | — |
| AAMP-F3  | 2 | `test_aamp_f3_sdk_mount_iframe_csp`, `test_aamp_f3_unmount_clean` | IN-PROGRESS | `tests/agentamp/test_agentvis_sdk.py` |
| AAMP-F4  | 2 | `test_aamp_f4_event_filter_by_permissions` | IN-PROGRESS | `tests/agentamp/test_agentvis_sdk.py` |
| AAMP-F5  | 3 | `test_aamp_f5_dsp_pure_transform` | IN-PROGRESS | `tests/agentamp/test_dsp.py` |
| AAMP-F6  | 3 | `test_aamp_f6_spectrum_vu_loop` | IN-PROGRESS | `tests/agentamp/test_dsp.py` |
| AAMP-F7  | 4 | `test_aamp_f7_tui_palette_from_skin` | IN-PROGRESS | `tests/agentamp/test_tui.py` |
| AAMP-F8  | 4 | `test_aamp_f8_minimode_size_floor` | IN-PROGRESS | `tests/agentamp/test_tui.py` |
| AAMP-F9  | 5 | `test_aamp_f9_eq_write_signs_manifest` | IN-PROGRESS | `tests/agentamp/test_equalizer.py` |
| AAMP-F10 | 5 | `test_aamp_f10_per_task_picker`, `test_aamp_f10_knob_lock_persists` | IN-PROGRESS | `tests/agentamp/test_equalizer.py` |
| AAMP-F11 | 6 | `test_aamp_f11_playlist_reads_runs` | IN-PROGRESS | `tests/agentamp/test_playlist.py` · `a0f822e` |
| AAMP-F12 | 6 | `test_aamp_f12_enqueue_uses_runs_endpoint` | IN-PROGRESS | `tests/agentamp/test_playlist.py` · `a0f822e` |
| AAMP-F13 | 7 | `test_aamp_f13_effect_chain_skip_on_deny` | TODO | — |
| AAMP-F14 | 7 | `test_aamp_f14_shader_uses_shared_gl_context` | TODO | — |
| AAMP-F15 | 8 | `test_aamp_f15_local_registry_install_use` | TODO | — |
| AAMP-F16 | 8 | `test_aamp_f16_remote_pull_metadata_only` | TODO | — |
| AAMP-F17 | 8 | `test_aamp_f17_doctor_reports_aamp` | TODO | — |
| AAMP-F18 | 6 | `test_aamp_f18_user_state_under_benny_home` | IN-PROGRESS | `tests/agentamp/test_user_state.py` · `a0f822e` |
| AAMP-F19 | 6 | `test_aamp_f19_export_import_cockpit_roundtrip` | IN-PROGRESS | `tests/agentamp/test_user_state.py` · `a0f822e` |
| AAMP-F20 | 6 | `test_aamp_f20_layout_snap_zones_clamp` | IN-PROGRESS | `tests/agentamp/test_layout.py` · `a0f822e` |
| AAMP-F21 | 6 | `test_aamp_f21_layout_event_envelope` | IN-PROGRESS | `tests/agentamp/test_layout.py` · `a0f822e` |
| AAMP-F22 | 9 | `test_aamp_f22_signature_required_outside_devmode` | TODO | — |
| AAMP-F23 | 9 | `test_aamp_f23_routes_require_api_key` | TODO | — |
| AAMP-F24 | 9 | `test_aamp_f24_offline_default_path_works`, `test_aamp_f24_remote_pull_offline_refusal` | TODO | — |
| AAMP-F25 | 9 | `test_aamp_f25_no_direct_litellm_in_aamp` (AST scan) | TODO | — |
| AAMP-F26 | 9 | `test_aamp_f26_policy_intents_evaluated` | TODO | — |
| AAMP-F27 | 7 | `test_aamp_f27_jsonld_per_plugin_invocation` | TODO | — |
| AAMP-F28 | 9 | `test_aamp_f28_ledger_entry_on_install` | TODO | — |
| AAMP-F29 | 0 | `tests/portability/test_no_absolute_paths.py` (scope: `benny/agentamp/**`, `frontend/src/agentamp/**`, fixture packs) | TODO | — |
| AAMP-F30 | 9 | `test_aamp_f30_phoenix_attributes_emitted` | TODO | — |
| AAMP-F31 | 9 | `test_aamp_f31_doctor_aamp_section_shape` | TODO | — |
| AAMP-F32 | 0 | `test_aamp_f32_default_flags_disabled` | TODO | — |
| AAMP-F33 | 1 | `test_aamp_f33_scaffold_creates_draft`, `test_aamp_f33_scaffold_deterministic`, `test_aamp_f33_signature_null_in_stub` | TODO | — |
| AAMP-F34 | 8 | `test_aamp_f34_designer_emits_unsigned_draft`, `test_aamp_f34_designer_uses_call_model` (AST scan), `test_aamp_f34_designer_offline_e2e`, `test_aamp_f34_next_steps_complete`, `test_aamp_f34_no_registry_writes` | TODO | — |
| AAMP-F35 | 1 | `test_aamp_f35_install_rejects_unsigned`, `test_aamp_f35_install_rejects_invalid_sig`, `test_aamp_f35_no_bypass_flag` | TODO | — |

## Non-functional (from [requirement.md §6](requirement.md#6-non-functional-targets))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AAMP-NFR1  | 1 | `tests/agentamp/test_skin_apply_perf.py`        | TODO | — |
| AAMP-NFR2  | 1 | `tests/agentamp/test_skin_switch_no_flash.py`   | TODO | — |
| AAMP-NFR3  | 3 | `tests/agentamp/test_dsp_throughput.py`         | IN-PROGRESS | `tests/agentamp/test_dsp.py` |
| AAMP-NFR4  | 3 | `tests/agentamp/test_dsp_determinism.py`        | IN-PROGRESS | `tests/agentamp/test_dsp.py` |
| AAMP-NFR5  | 8 | `tests/agentamp/test_install_perf.py`           | TODO | — |
| AAMP-NFR6  | 4 | `tests/agentamp/test_tui_first_paint.py`        | IN-PROGRESS | `tests/agentamp/test_tui.py` |
| AAMP-NFR7  | 9 | `tests/release/test_aamp_release_gate.py::coverage` | TODO | — |
| AAMP-NFR8  | all | existing `tests/portability/test_no_absolute_paths.py` | TODO | — |
| AAMP-NFR9  | 9 | `tests/agentamp/test_telemetry_overhead.py`     | TODO | — |
| AAMP-NFR10 | 9 | `tests/agentamp/test_offline_e2e.py`            | TODO | — |
| AAMP-NFR11 | 9 | `tests/release/test_aamp_release_gate.py::bundle_delta` | TODO | — |
| AAMP-NFR12 | 2 | `tests/agentamp/test_plugin_watchdog.py`        | IN-PROGRESS | `tests/agentamp/test_agentvis_sdk.py` |

## Security (from [requirement.md §8](requirement.md#8-security--privacy))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AAMP-SEC1 | 2 | `test_aamp_sec1_iframe_sandbox_attrs`            | IN-PROGRESS | `tests/agentamp/test_agentvis_sdk.py` |
| AAMP-SEC2 | 2 | `test_aamp_sec2_csp_grammar`, `test_aamp_sec2_connect_src_none` | IN-PROGRESS | `tests/agentamp/test_agentvis_sdk.py` |
| AAMP-SEC3 | 1 | `test_aamp_sec3_zip_path_traversal_rejected`     | TODO | — |
| AAMP-SEC4 | 1 | `test_aamp_sec4_signature_uses_shared_key_path`  | TODO | — |
| AAMP-SEC5 | 5 | `test_aamp_sec5_eq_write_policy_evaluated`       | IN-PROGRESS | `tests/agentamp/test_equalizer.py` |
| AAMP-SEC6 | 2 | `test_aamp_sec6_event_filter_subset`             | IN-PROGRESS | `tests/agentamp/test_agentvis_sdk.py` |
| AAMP-SEC7 | 8 | `test_aamp_sec7_doctor_reports_drift`            | TODO | — |

## Compliance — integration with AOS-001 (from [requirement.md §9](requirement.md#9-compliance--integration-with-aos-001-governance))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AAMP-COMP1 | 5 | `test_aamp_comp1_eq_write_ledger_entry`         | IN-PROGRESS | `tests/agentamp/test_equalizer.py` |
| AAMP-COMP2 | 5 | `test_aamp_comp2_previous_signatures_preserved` | IN-PROGRESS | `tests/agentamp/test_equalizer.py` |
| AAMP-COMP3 | 7 | `test_aamp_comp3_jsonld_per_plugin`             | TODO | — |
| AAMP-COMP4 | 9 | `test_aamp_comp4_doctor_audit_completeness`     | TODO | — |
| AAMP-COMP5 | 3 | `test_aamp_comp5_dsp_replay_byte_identical`     | IN-PROGRESS | `tests/agentamp/test_dsp.py` |

## Observability (from [requirement.md §10](requirement.md#10-observability))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| AAMP-OBS1 | 9 | covered by `test_aamp_f31_doctor_aamp_section_shape` | TODO | — |
| AAMP-OBS2 | 0 | `test_aamp_obs2_log_component_field`                  | TODO | — |
| AAMP-OBS3 | 7 | `test_aamp_obs3_sse_event_schemas`                    | TODO | — |
| AAMP-OBS4 | 9 | covered by `test_aamp_f30_phoenix_attributes_emitted` | TODO | — |

## Release gates — hard blocks (extends `docs/requirements/release_gates.yaml`)

| Gate ID | Description | Test |
|---------|-------------|------|
| `GATE-AAMP-POLICY-1` | `aamp.policy.auto_load_remote_skins` MUST be `false` at release. | `test_aamp_release_gate_policy_remote_off` |
| `GATE-AAMP-DEVMODE-1` | `aamp.dev_mode` MUST be `false` at release. | `test_aamp_release_gate_devmode_off` |
| `GATE-AAMP-CSP-1`    | `aamp.sandbox.csp_strict` MUST be `true` at release. | `test_aamp_release_gate_csp_on` |
| `GATE-AAMP-AUTOSIGN-1` | `aamp.designer.auto_sign` MUST be `false`; `benny agentamp install` MUST reject unsigned packs unconditionally; the `skin_designer` skill MUST emit `signature: null` drafts only. | `test_aamp_release_gate_autosign_off` |
| `G-AAMP-COV`         | Coverage ≥ 85 % on `benny/agentamp/**` and `frontend/src/agentamp/**`. | `test_aamp_release_gate.py::coverage` |
| `G-AAMP-OFF`         | `BENNY_OFFLINE=1` end-to-end smoke (default skin + default visualizers + DSP-A). | `tests/agentamp/test_offline_e2e.py` |
| `G-AAMP-SR1`         | SR-1 ratchet not raised by AAMP-001 surfaces. | `tests/portability/test_no_absolute_paths.py` |
| `G-AAMP-SIG`         | All shipped reference skins/plugins verify under HMAC at boot. | `test_aamp_release_gate_signatures` |
| `G-AAMP-BUNDLE`      | UI bundle delta ≤ 350 KB gzipped. | `test_aamp_release_gate.py::bundle_delta` |
| `G-AAMP-LEDGER`      | Every loaded skin/plugin in the smoke session has a ledger entry. | `test_aamp_release_gate_ledger_completeness` |

---

## How to update this matrix

1. When a test for an `AAMP-F*` / `AAMP-NFR*` / `AAMP-SEC*` / `AAMP-COMP*` /
   `AAMP-OBS*` row lands, change `TODO` → `IN-PROGRESS` (test exists, not
   passing) or `PASS` (test passing on `master`).
2. Populate `Evidence` with the merge commit SHA or CI run id.
3. A `WAIVED` row requires a one-line note immediately below the table,
   signed by the user (e.g., `WAIVED 2026-05-12 by @darkhorsecreators-jpg
   pending OQ-2 resolution`).
4. A phase is not "done" until every row in its phase group is `PASS`
   **and** the corresponding gate test in
   `tests/release/test_aamp_release_gate.py` is green on `master`.
