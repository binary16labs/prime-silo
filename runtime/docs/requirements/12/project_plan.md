# PIX-001 — Project Plan

Single tracking artefact for the PageIndex vectorless spine. Updated at the end
of every working session. One phase per PR; the tracker ticks only after the
phase gate is green.

---

## Phase map

| Phase | Outcome | Gate (exit criterion) | Status |
|-------|---------|-----------------------|--------|
| **0** | **Pure spine** — `benny/core/pageindex.py` + `tests/test_pageindex_spine.py`. Tree ops (`flatten_leaves`, `tree_to_sections`, `abstract_outline`, `build_section_edges`, `validate_tree`) with no LLM / no Neo4j. | PIX-F1–F6, PIX-NFR1, GATE-PIX-OFF/NOCAP green. | ✅ **DONE** (9/9 tests pass) |
| **1** | **Tree build at ingest** — `pageindex_builder.py` builds a tree (deterministic markdown/heading path + generic fallback; LLM `enrich_summaries` via `call_model()`); persists JSON to `workspace/.benny/pageindex/` (traversal-guarded); `/rag/pageindex/ingest` route + `benny pageindex` CLI. | PIX-F7–F9, PIX-SEC2. | 🟡 **MOSTLY DONE** — deterministic build + persist + traversal-guard tested; LLM-summary + ingest-route tests TODO. |
| **2** | **Deterministic fan-out + Section graph** — `pageindex_pipeline.py` fans the per-section extractor over `flatten_leaves` (whole doc, no cap); anchors triples to `Section` (node_id + page citation); writes `(:Document)-[:HAS_SECTION]->(:Section)` to Neo4j (degrades gracefully if down). | PIX-F10–F12, PIX-SEC1. | 🟡 **MOSTLY DONE** — fan-out + provenance + graceful-degrade tested; live Neo4j write needs `benny up`. |
| **3** | **Cross-document linking** — `cross_document.py` proposes `Section`↔`Section` candidates from summaries before full-text calls. | PIX-F13. | ⬜ TODO |
| **4** | **`structured` retrieval route** — `retrieve_structured` node wired into `build_adaptive_rag_graph`: single node-select call over `abstract_outline` + load leaves; router classifies tree-backed docs to it. | PIX-F14, PIX-NFR2, GATE-PIX-LAT. | 🟡 **CODE LANDED** — node + routing wired; live single-call latency test TODO. |

Phases 1–4 each require resolving their owning open question (see
[requirement.md §6](requirement.md#6-open-questions-must-be-resolved-before-the-owning-phase-merges))
before merge.

---

## The runnable test (Phase 0 gate)

```bash
cd runtime
python -m pytest tests/test_pageindex_spine.py -v
# expected: 9 passed
```

This proves the spine's load-bearing claims offline, no LLM or DB:

- **completeness** — `flatten_leaves` covers all 13 fixture leaves (>10, so the
  legacy `chunks[:10]` cap would fail this row);
- **provenance** — `node_id` survives into the fan-out sections;
- **determinism** — repeated partition is byte-identical;
- **cheap abstract** — `abstract_outline` carries no body text;
- **connected graph** — `build_section_edges` leaves no orphan node;
- **unique keys** — `validate_tree` flags duplicate/missing `node_id`.

---

## Validation spike (recommended first real-corpus run, Phase 1/2)

Use the existing **`prime_silo_self`** workspace (4 markdown docs already on
disk; its graph is currently empty, so any result is a visible win):

1. Build a tree for `USER_GUIDE.md` via `call_model()` and persist it.
2. Render `abstract_outline` — eyeball the indexed table-of-contents.
3. Fan `parallel_extract_triples` over `tree_to_sections(tree)`.
4. Compare the resulting Section graph + triples against today's (empty) graph.

No change to live default ingestion until tree-build latency is proven on the
target NPU hardware.

---

## Risk register (FMEA-style)

| Risk | Effect | RPN driver | Mitigation |
|------|--------|------------|------------|
| Tree build slow on local NPU | Ingest stalls; caller times out | high (latency) | Build async/off-request; batch; cache JSON; one-time per doc. |
| Bad tree → bad partition | Low-quality triples | med | `validate_tree` invariants; deterministic re-build; HITL review of abstract. |
| `Section` vs `Concept` schema drift | Graph confusion / double nodes | med | Resolve OQ-2 before Phase 2; reuse existing `Document` node, add `Section` beneath it. |
| Ingest file-discovery already flaky | Spine layered on a broken scan | med | Fix the `data_in` glob (4/5 `prime_silo_self` runs failed) **before** Phase 1. |
| Embedding-provider habit creeps into spine | Reintroduces zero-vector failure class | low | PIX-NFR1 forbids embeddings in `pageindex.py`; offline test gate. |

---

## Plan tracker

- [x] ADR-002 drafted (`architecture/ADR-002-pageindex-vectorless-spine.md`).
- [x] Requirements folder 12 created (README, requirement, acceptance_matrix, project_plan, DEMO).
- [x] Phase 0 module `benny/core/pageindex.py` + test — **9/9 green**.
- [x] Phase 1 builder `benny/core/pageindex_builder.py` (markdown + generic + LLM summaries + persist/guard).
- [x] Phase 2 pipeline `benny/core/pageindex_pipeline.py` (fan-out + provenance + Section graph + degrade).
- [x] Phase 1/2 tests `tests/test_pageindex_builder.py` — **8/8 green** (17 total with spine).
- [x] CLI `benny pageindex build|ingest|show`; API `/rag/pageindex/ingest` + `/outline`.
- [x] Phase 4 `retrieve_structured` node wired into `adaptive_rag.py` graph + router.
- [x] Demo runner `scripts/pageindex_demo.py` — verified on `prime_silo_self` (157 sections, 4 docs).
- [x] Live Neo4j Section-graph write verified (Neo4j 5.23 bundle): prime_silo_self → 4 Documents, 207 Sections, 207 HAS_SECTION edges (2026-06-23).
- [x] **Live triple fan-out — FIXED and verified.** Root cause was a pre-existing synthesis↔reasoning-model bug (the `model_thinking="off"` toggle never reached extraction): `extract_directed_triples_from_section` didn't pass `workspace` to `call_llm`, `call_llm`/`call_model` didn't thread `workspace_id`, and `_thinking_disabled` compared the prefixed vs bare model id. Fixes: (1) `extract_directed_triples_from_section` passes `workspace=workspace`; (2) `call_llm` + `call_model` thread `workspace_id`; (3) `_thinking_disabled` matches on the bare model id. Live result against Lemonade NPU `Qwen3-8B-Hybrid`: README §0.0.1 → **5 triples, all anchored to the section (doc_fragment_id), persisted as 5 RELATES_TO edges in Neo4j**. Regression test: `tests/test_thinking_toggle.py` (5 tests). This was also the reason the shipped distribution's graph was empty.
- [ ] `structured` retrieval answer — code wired; quick to verify now that the model path works (deferred, low risk).
- [ ] Default-safe thinking for reasoning models without an operator toggle (follow-up: auto-detect thinking-capable models for synthesis, respecting the "/no_think empties some FLM models" caveat in models.py).
- [ ] Resolve OQ-3, then Phase 3 (cross-doc linking).
- [ ] Add ingest-route + live single-call latency tests (PIX-F9 / PIX-F14 acceptance rows).

---

## KPI targets

| KPI | Baseline (shipped distro) | Target after Phase 2 |
|-----|---------------------------|----------------------|
| Triples in `prime_silo_self` graph | 0 | > 0, anchored to Sections |
| Document coverage of fan-out | ≤ 10 paragraphs (`chunks[:10]`) | 100 % of leaves |
| Ingest paths requiring an embedding server | all | tree-backed docs: none |
| Triple provenance granularity | filename | section + page range |

---

**Last updated:** 2026-06-23 — Phase 0 complete and green; Phases 1–4 open.
