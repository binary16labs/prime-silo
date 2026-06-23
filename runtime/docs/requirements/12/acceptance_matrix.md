# PIX-001 — Acceptance Matrix

Each row is the unit of acceptance. A phase is not "done" until every row in its
phase group is `PASS` with a non-empty `Evidence` pointer (test name, CI run id,
or commit SHA).

Status legend: `TODO` · `IN-PROGRESS` · `PASS` · `FAIL` · `WAIVED (requires
user sign-off note)`.

Phase column references [project_plan.md §Phase map](project_plan.md#phase-map).

---

## Functional (from [requirement.md §3](requirement.md#3-functional-requirements))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| PIX-F1  | 0 | `tests/test_pageindex_spine.py::test_flatten_leaves_covers_whole_document` | PASS | local: 9 passed (2026-06-23) |
| PIX-F2  | 0 | `tests/test_pageindex_spine.py::test_sections_preserve_provenance` | PASS | local: 9 passed (2026-06-23) |
| PIX-F3  | 0 | `tests/test_pageindex_spine.py::test_partition_is_deterministic`, `::test_empty_leaves_are_skipped` | PASS | local: 9 passed (2026-06-23) |
| PIX-F4  | 0 | `tests/test_pageindex_spine.py::test_abstract_outline_excludes_body_text` | PASS | local: 9 passed (2026-06-23) |
| PIX-F5  | 0 | `tests/test_pageindex_spine.py::test_section_edges_connect_every_node_no_orphans` | PASS | local: 9 passed (2026-06-23) |
| PIX-F6  | 0 | `tests/test_pageindex_spine.py::test_validate_tree_passes_on_good_tree`, `::test_validate_tree_flags_duplicate_node_ids`, `::test_validate_tree_flags_missing_node_id` | PASS | local: 9 passed (2026-06-23) |
| PIX-F7  | 1 | `test_markdown_build_is_nested_and_valid`, `::test_branch_prose_preserved_as_overview_leaf`, `::test_no_heading_uses_generic_builder` | PASS (deterministic build) | local: 17 passed (2026-06-23). LLM `enrich_summaries` path implemented; live-model test TODO. |
| PIX-F8  | 1 | `test_persist_and_load_roundtrip` | PASS | local (2026-06-23) |
| PIX-F9  | 1 | `/rag/pageindex/ingest` route + `benny pageindex ingest` CLI | IN-PROGRESS | code landed; route test TODO |
| PIX-F10 | 2 | `test_fanout_stamps_section_provenance` (whole-doc, no cap) | PASS | local (2026-06-23) |
| PIX-F11 | 2 | `test_fanout_stamps_section_provenance` (fragment_id + citation) | PASS | local (2026-06-23) |
| PIX-F12 | 2 | `test_save_section_tree_degrades_without_neo4j`; live write `save_section_tree` | PASS | local degrade test (2026-06-23) + LIVE Neo4j 5.23: prime_silo_self → 4 Documents, 207 Sections, 4+203 HAS_SECTION edges (2026-06-23) |
| PIX-F13 | 3 | `test_pix_f13_cross_doc_candidates_from_summaries` | TODO | — |
| PIX-F14 | 4 | `retrieve_structured` node wired into `build_adaptive_rag_graph` | IN-PROGRESS | code landed; live single-call test TODO |

## Non-functional (from [requirement.md §4](requirement.md#4-non-functional-targets))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| PIX-NFR1 | 0 | `tests/test_pageindex_spine.py` runs with no LLM/Neo4j import | PASS | local: 9 passed (2026-06-23) |
| PIX-NFR2 | 4 | `test_pix_nfr2_structured_two_roundtrips_max` | TODO | — |
| PIX-NFR3 | 1 | `test_pix_nfr3_tree_build_byte_replay` | TODO | — |
| PIX-NFR4 | all | `tests/release` coverage gate ≥ 85 % on new modules | TODO | — |
| PIX-NFR5 | all | existing `tests/portability/test_no_absolute_paths.py` | TODO | — |

## Security (from [requirement.md §5](requirement.md#5-security--governance))

| Req ID | Phase | Test ID(s) | Status | Evidence |
|--------|-------|------------|--------|----------|
| PIX-SEC1 | 2 | `test_pix_sec1_section_write_emits_lineage` | TODO | — |
| PIX-SEC2 | 1 | `test_pix_sec2_pageindex_path_traversal_rejected` | TODO | — |

---

## Release gates (hard blocks — extend `docs/requirements/release_gates.yaml`)

| Gate ID | Description | Test ID | Status | Evidence |
|---------|-------------|---------|--------|----------|
| GATE-PIX-COV    | New PIX modules ≥ 85 % coverage. | `tests/release/...::coverage` | TODO | — |
| GATE-PIX-SR1    | SR-1 ratchet not raised by PIX additions. | existing | TODO | — |
| GATE-PIX-OFF    | Spine tests pass under `BENNY_OFFLINE=1`. | `tests/test_pageindex_spine.py` | PASS | local (2026-06-23) |
| GATE-PIX-NOCAP  | Fan-out covers whole doc (no `chunks[:10]`). | `::test_flatten_leaves_covers_whole_document` | PASS | local (2026-06-23) |
| GATE-PIX-LAT    | `structured` retrieval ≤ 2 LLM round-trips. | `test_pix_nfr2_structured_two_roundtrips_max` | TODO | — |

---

## Notes

Phase 0 (the pure spine + its 9 tests) is **PASS** locally — run
`python -m pytest tests/test_pageindex_spine.py -v`. CI evidence (commit SHA /
run id) replaces the "local" markers once merged. Phases 1–4 rows are `TODO`
placeholders; their test IDs are the contract those phases must satisfy.
