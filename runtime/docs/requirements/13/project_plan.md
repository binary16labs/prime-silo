# VIS-001 — Project Plan

Single tracking artefact for vision-augmented ingestion (ADR-003). Updated at the
end of every working session. One phase per PR; the tracker ticks only after the
phase gate is green.

---

## Phase map

| Phase | Outcome | Gate (exit criterion) | Status |
|-------|---------|-----------------------|--------|
| **0** | **Structured DocModel** — preserve Docling's element tree (type/page/bbox/reading-order), export tables→JSON, persist picture crops + `<source>.json` under `.benny/docmodel/`, behind a `vision`/`docmodel` flag. No VLM. | VIS-F1–F5, VIS-NFR1, VIS-SEC2. | ✅ **DONE** — `benny/core/docmodel.py`; 12/12 offline + live smoke PASS |
| **1** | **Multimodal router** — `call_model()` + local executor accept `image_url` content blocks (both branches); register `qwen3vl` + `vision` role; prove an image→text round-trip. | VIS-F6–F8, VIS-SEC3, **OQ-1 ✅ resolved**. | ✅ **DONE** — 8/8 tests pass, live round-trip green through `call_model` |
| **2** | **Classifier + describer ladder + multi-model review** — `vision_describe.py`: classify; illustration→caption, diagram→Mermaid, chart→JSON; structural pre-filter + **authoritative mmdc render-validation**; **qwen3-9b reviewer loop** (guides, doesn't author) with refine; caption fallback. | VIS-F9–F13, **OQ-2/OQ-3 resolved**. | ✅ **DONE** — eval-tuned on real TOGAF; 14 offline tests |
| **3** | **Orchestrator + stitch + API** — `vision_pipeline.py` (`enrich_docmodel`: describe all visuals, stitch enriched md/json in reading order with provenance) + `vision_routes.py` (`/api/vision/docmodel`,`/enrich`, wired into server). Section anchoring + typed Chroma via the downstream PageIndex ingest the enriched md feeds. | VIS-F14–F16, VIS-SEC1. | 🟡 stitch+API DONE; full TOGAF run + Chroma typing in progress |

Phases 1–3 each require resolving their owning open question (see
[requirement.md §6](requirement.md#6-open-questions-must-be-resolved-before-the-owning-phase-merges))
before merge.

---

## The workflow (runnable Benny manifest)

The whole pipeline is expressed as a schema-2.0 `benny enrich` task-DAG:
**[`manifests/templates/vision_ingestion_pipeline.json`](../../../manifests/templates/vision_ingestion_pipeline.json)**.
It is the **executable contract** for this project — each task maps to a phase
deliverable, and the vision stages *prepend* to the existing pipeline:

```
docmodel_extract → classify_elements → describe_visuals[VLM] → validate_surrogates → stitch_enriched ┐
                                                                                                      │
   rag_ingest ← ──────────────────────────────────────────────────────────────────────────────────┘
       └→ deep_synthesis → validate_vision → generate_report
```

- **New (VIS-001 Phases 0–3):** `docmodel_extract`, `classify_elements`,
  `describe_visuals`, `validate_surrogates`, `stitch_enriched`, `validate_vision`
  + their `/api/vision/*` endpoints.
- **Existing (reused unchanged):** `rag_ingest`, `deep_synthesis`, the report —
  they now consume *enriched* `.md` (figure surrogates + table JSON inline).
- **Phasing maps to waves:** ship a wave at a time; until a wave's skills land the
  manifest is a dry/inspect spec. `validate_surrogates` and `validate_vision` are
  the no-hollow-success gates baked into the DAG itself.
- Dispatch: `benny enrich --manifest manifests/templates/vision_ingestion_pipeline.json`
  (`--resume <run_id>` to reuse completed/cached waves). Set
  `vlm_model=${vlm_fallback}` (lmstudio) if OQ-1 shows FLM lacks `image_url`.

---

## Riskiest piece first (recommended spike before committing Phase 0)

The single biggest unknown is **multimodal `call_model`** + **whether FLM does
vision**. Before building the DocModel on top, run a one-off spike:

1. Send a single PNG crop + a prompt ("describe this image") through a temporary
   multimodal `call_model()` path to `qwen3vl` on Lemonade/FLM.
2. If FLM rejects `image_url` content → repeat against lmstudio (port 1234).
3. Record which endpoint works in **OQ-1**; that decides the Phase 1 primary VLM.

This de-risks Phases 1–3 in an afternoon and answers the load-bearing question.

---

## Validation spike (first real-corpus run, Phase 2/3)

Use the **c5_test** workspace — it already has UML/architecture PDFs in
`data_in/staging/` (per [runtime/CLAUDE.md]), so it is the natural target for a
diagram-heavy ingest:

1. Run the Phase 0 DocModel pass on one architecture PDF; eyeball the element tree
   and confirm diagrams/tables were captured (not dropped).
2. Run the describer ladder; confirm at least one diagram becomes valid Mermaid
   and at least one table becomes valid JSON.
3. Feed the enriched doc through the PageIndex spine; confirm new triples cite a
   `Section` whose source was a **figure**, not body text.
4. Compare graph richness against a text-only ingest of the same PDF.

No change to live default ingestion until VLM-pass latency is proven on the target
NPU hardware.

---

## Risk register (FMEA-style)

| Risk | Effect | RPN driver | Mitigation |
|------|--------|------------|------------|
| FLM has no vision support | Phase 1 blocked on primary VLM | high | OQ-1 spike first; lmstudio proven fallback already registered. |
| Multimodal content dropped in local-executor branch | Images silently ignored; "works" but blind | high | VIS-F6 requires both branches; round-trip test asserts the model saw the image. |
| VLM hallucinates a diagram that *parses* | Plausible-but-wrong Mermaid enters graph | med | Validator gates syntax only — pair with HITL review of surrogates; `model_id` provenance; confidence on classify. |
| Hollow success (surrogate "ok" but garbage) | Graph poisoned, repeat of token-audit lesson | med | VIS-F12: no success without validator pass; caption fallback. |
| VLM pass slow on local NPU | Ingest stalls | med | Opt-in, off-request, batched, content-hash cached. |
| Non-determinism breaks replay gate expectations | False SR-3 failures | low | VIS-NFR3 exempts surrogates from byte-equal; documented in ADR-003 §4. |
| docmodel/crop sprawl in workspace | Disk bloat | low | Content-hash dedupe; crops are the cache key, reused across re-ingest. |

---

## Plan tracker

- [x] ADR-003 drafted (`architecture/ADR-003-vision-augmented-ingestion.md`).
- [x] Requirements folder 13 created (README, requirement, project_plan, acceptance_matrix).
- [x] Workflow manifest `manifests/templates/vision_ingestion_pipeline.json` (schema 2.0, 9 tasks/8 waves; JSON + wave/dep consistency verified).
- [x] OQ-1 spike — `scripts/vision_spike.py`: **FLM vision CONFIRMED** (qwen3vl-it-4b-FLM on Lemonade, `image_url` object form, read blue/red/yellow correctly). Lemonade/FLM = primary VLM.
- [x] Phase 2 — DONE. `benny/core/vision_describe.py` (classify → describe ladder → structural pre-filter → **real mmdc render-validation** → **qwen3-9b reviewer** that GUIDES not authors → refine → best). Calibrated the structural validator against mmdc (dotted ids and `--|x|-->` actually render — removed those false-positive rejections; strip invalid `#` comments). Eval on real TOGAF: **ADM cycle (Fig 3-1) → valid Mermaid, reviewer 9/10**, captured all phases A-H + Requirements-Management hub; deliverables (Fig 3-2, nested containers) 4-6/10 (honest: simple diagrams excel, dense nested ones are mediocre → graceful caption fallback). Installed `@mermaid-js/mermaid-cli` in packaging for render-validation. Tests `tests/test_vision_describe.py` 14/14.
- [x] Phase 3 — orchestrator + API DONE. `benny/core/vision_pipeline.py` (`enrich_docmodel` runs the ladder over all visuals, reuses Phase-0 table JSON, stitches enriched markdown + JSON sidecar IN READING ORDER with `<!-- docmodel id/page -->` provenance + `figure_score`). `benny/api/vision_routes.py` (`/api/vision/docmodel`, `/api/vision/enrich`) wired into `server.py`. Tests `tests/test_vision_pipeline.py` 6/6. Enriched md feeds existing rag_ingest→PageIndex (Section anchoring) unchanged. TODO: type-tagged Chroma chunks (VIS-F16); full-TOGAF capstone run.
- [x] **DocModel backend → PyMuPDF default, Docling optional (2026-06-28).** Reversed the "bundle Docling" decision after the size/offline cost surfaced: `docmodel.py` now dispatches `backend="pymupdf"` (default, shipped — crops via extract_image, RULED tables via find_tables, text/reading-order + caption/heading heuristics, no torch, fully offline) vs `backend="docling"` (opt-in, not bundled). Removed docling/Pillow from `BUNDLE_RUNTIME_REQUIREMENTS` + assembler test; reverted mermaid-cli packaging bloat. TOGAF lean run: 1193 elements / 20 crops / 16 captions / 3.3s. Borderless tables stay as text (PyMuPDF text-strategy rejected — it shatters prose into fake tables); use docling backend for those. Tests: test_docmodel 16/16.
- [x] Phase 0 — DONE. `benny/core/docmodel.py` (`build_docmodel`: Docling element tree → type/page/bbox/reading-order; tables→JSON; content-hashed picture crops; `<stem>.json` under `.benny/docmodel/`; idempotent; text-only graceful fallback). Offline `tests/test_docmodel.py` **12/12**; live `scripts/docmodel_smoke.py` **PASS** (4 elements incl. detected table→JSON + persisted crop, degraded=False). Fixed a real `_df_to_table_json` NaN→None bug (astype(object) before where). Default ingest path untouched.
- [x] **Product-bundle docling gap FIXED + verified (2026-06-28).** `docling` was in `runtime/requirements.txt` but MISSING from `BUNDLE_RUNTIME_REQUIREMENTS` (the shipped `site/` source of truth) → the EXE silently fell back to basic fitz extraction. Added `docling>=2.4.0`+`Pillow>=10.0.0` to `packaging/scripts/assemble-runtime-bundle.js`, the assembler test guard, and `requirements.txt`. Verified on the product's exact Python (python-build-standalone 3.11.9 x64): clean install (exit 0), **full bundle co-resolves with docling — no conflicts** (pydantic 2.13.4, numpy 2.4.6, torch 2.12.1+cpu), co-import of the whole heavy stack OK. Full `site/` = **2.5 GB** (net +~1.5 GB: torch 532M, transformers 109M, opencv 109M, saxonc 104M). ⚠️ CAVEAT: docling fetches layout/table model weights from HF on FIRST USE → residual offline gap; pre-bake weights or gate behind fitz fallback (Phase 0 sub-task).
- [x] **Runtime bundle built + docling verified in-product (2026-06-28).** `node packaging/scripts/pack-runtime-bundle.js` → `dist/runtime-bundle/runtime-bundle-win32-x64.tar.gz` (**909 MB**, sha256 262ac869…), component hashes match pinned python/neo4j/jre. docling-2.107.0 + docling-ibm-models + torch-2.12.1 + Pillow-12.2.0 present in bundled `site/`; import via the BUNDLED python+site (what ships) succeeds (DocumentConverter + PyPdfium backend). Shell app also built/signed via `desktop:localtest` (201 MB). NOTE: `desktop:localtest` only builds the shell — the runtime bundle is a separate `pack-runtime-bundle.js` artifact (skill doc corrected).
- [x] Phase 1 — multimodal router DONE. `local_executor.py` (`_as_text`/`_is_multimodal`, list-form `prompt`), `models.py` (`qwen3vl` registry entry, `/no_think` + token-count guards for list content), `benny/core/vision.py` (`to_data_uri`/`vision_message`, FLM object form). Tests `tests/test_multimodal_call_model.py` — **8/8 pass** (offline guards + live round-trip via `call_model`). No regression (thinking-toggle 5/5; relevant files 16/16 together). NOTE: pre-existing whole-suite collection isolation bug (`NotImplementedError: Stub class`) hits ~20 unrelated files under broad `-k` — not introduced here.
- [ ] Phase 2 — classifier + describer ladder + validators + cache; c5_test diagram→Mermaid.
- [ ] Phase 3 — stitch + Section anchoring + (optional) typed Chroma chunks.

---

## KPI targets

| KPI | Baseline (today) | Target after Phase 3 |
|-----|------------------|----------------------|
| Visual elements reaching the graph | 0 | 100 % of detected figures/diagrams/charts/tables (validated) |
| Tables usable as data | flattened markdown | structured JSON |
| Diagrams usable by agents | none | parse-valid Mermaid/PlantUML, Section-anchored |
| Triple provenance for figure-derived facts | n/a (none exist) | Section + page + bbox + crop |
| VLM calls per document | n/a | proportional to figures, not pages (escalation ladder) |

---

**Last updated:** 2026-06-28 — ADR-003 + VIS-001 requirements drafted; all phases
open. Recommended next step: the OQ-1 multimodal/FLM spike.
