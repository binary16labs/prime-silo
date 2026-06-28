# VIS-001 — Acceptance Matrix

A phase is **done** only when every row for that phase is `PASS` with linked
evidence (test name, run id, or artefact path). `BLOCKED` rows must name the open
question or dependency holding them.

Status legend: ⬜ TODO · 🟡 IN PROGRESS · ✅ PASS · ⛔ BLOCKED

---

## Phase 0 — Structured DocModel (no VLM)

| Req | Acceptance criterion | Evidence | Status |
|-----|----------------------|----------|--------|
| VIS-F1 | DocModel JSON preserves type/page/bbox/reading-order for every element of a fixture PDF. | `scripts/docmodel_smoke.py` — 4 elements (section_header/text/picture/table), all bbox+page+ordered | ✅ PASS |
| VIS-F2 | A fixture table round-trips to structured JSON with correct rows/cols. | `test_df_to_table_json_shape_and_nan` + smoke (3x3 table → JSON) | ✅ PASS |
| VIS-F3 | Each picture element has a crop persisted, keyed by content-hash. | smoke: `crops/smoke/5d3d80faf0d60b80.png` on disk | ✅ PASS |
| VIS-F4 | `<source>.json` written via workspace helpers; re-run is idempotent (no dupes). | `test_build_docmodel_writes_artifact_and_is_idempotent` + smoke | ✅ PASS |
| VIS-F5 | Default ingest path unchanged when `vision` flag is absent. | `docmodel.py` is a separate module; `extraction.py`/`etl_routes.py` untouched | ✅ PASS |
| VIS-NFR1 | Phase 0 test suite passes with no Docling/LLM/network. | `tests/test_docmodel.py` — 12/12 pass in base env (no docling) | ✅ PASS |
| VIS-SEC2 | A crafted `../` source name cannot write outside `.benny/docmodel/`. | `test_safe_stem_strips_paths_and_traversal` + `get_workspace_path` guard | ✅ PASS |

## Phase 1 — Multimodal router

| Req | Acceptance criterion | Evidence | Status |
|-----|----------------------|----------|--------|
| OQ-1 | Documented: does FLM accept `image_url`? Primary VLM endpoint chosen. | `scripts/vision_spike.py` — FLM read blue/red/yellow via `image_url` object form (2026-06-28) | ✅ PASS — Lemonade/FLM primary |
| VIS-F6 | `call_model()` sends an image on BOTH the LiteLLM and local-executor branches without dropping the image block. | `test_executor_forwards_image_without_dropping` + `test_call_model_no_think_guard_preserves_image` (local path + shared §2b guard) | ✅ PASS |
| VIS-F7 | `qwen3vl` + `vision` role resolve local-first; honour `BENNY_OFFLINE=1`. | `test_qwen3vl_registry_entry_is_local` | ✅ PASS |
| VIS-F8 | Live image→text round-trip returns a description grounded in the image (not a refusal/blank). | `test_vision_roundtrip_live` (read blue/red/yellow via `call_model`) + `scripts/vision_spike.py` | ✅ PASS |
| VIS-SEC3 | No VLM path bypasses `call_model()`. | `vision.py` helpers build messages only; describe skill (Phase 2) calls `call_model` | 🟡 (enforced in Phase 2) |

## Phase 2 — Classifier + describers + validation

| Req | Acceptance criterion | Evidence | Status |
|-----|----------------------|----------|--------|
| VIS-F9 | Each element gets a treatment type before any describer runs. | classifier unit test | ⬜ |
| OQ-2 | Sub-classification mechanism + threshold chosen and recorded. | requirement OQ-2 resolved | ⛔ |
| VIS-F10 | A c5_test diagram becomes Mermaid/PlantUML that passes a headless parse. | validator output + artefact | ⬜ |
| OQ-3 | Diagram-as-code default + validator chosen. | OQ-3 resolved | ⛔ |
| VIS-F11 | A chart yields schema-valid JSON + description; a table yields valid JSON. | schema-validation test | ⬜ |
| VIS-F12 | An intentionally-broken generation degrades to a caption, never reported "success." | negative test | ⬜ |
| VIS-F13 | An unchanged crop on re-ingest triggers zero VLM calls (cache hit). | call-count assertion | ⬜ |

## Phase 3 — Graph integration

| Req | Acceptance criterion | Evidence | Status |
|-----|----------------------|----------|--------|
| VIS-F14 | Surrogates appear at the element's original reading-order position in the enriched doc. | order assertion test | ⬜ |
| VIS-F15 | A triple extracted from a figure cites its `Section` (node_id + page + bbox). | Neo4j query on c5_test | ⬜ |
| VIS-F16 | Visual surrogates retrievable as type-tagged chunks; deduped vs. section text. | Chroma query + dedupe test | ⬜ |
| VIS-SEC1 | DocModel/crop/surrogate writes emit lineage events. | Marquez/lineage log | ⬜ |
| VIS-NFR3 | Surrogates carry `model_id` + `validated` flag; excluded from SR-3 byte-equal gate. | schema + gate config | ⬜ |
| VIS-NFR4 | New modules ≥ 85 % coverage. | coverage report | ⬜ |
| VIS-NFR5 | No new SR-1 absolute-path violations. | `pytest tests/portability` | ⬜ |
