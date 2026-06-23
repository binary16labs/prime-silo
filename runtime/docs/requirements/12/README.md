# PIX-001 — PageIndex Vectorless Spine

**Phase:** 12 (succeeds Phase 11)
**Status:** DRAFT — Phase 0 shipped (pure spine module + tests green); Phases 1–4 open
**Author:** Benny Studio team
**Last updated:** 2026-06-23
**Decision record:** [ADR-002](../../../architecture/ADR-002-pageindex-vectorless-spine.md)

---

## Purpose

Turn a document into a **deterministic, vectorless spine** before anything else
touches it: build a PageIndex-style hierarchical "indexed abstract" (titles +
summaries + page ranges), load it into the knowledge graph for the human to see
and the agent to traverse, then fan small extractor agents out over the tree's
real sections so the parts compose into a connected whole.

This is **integration work, not a rewrite.** Vector RAG, the Adaptive RAG router,
`parallel_extract_triples`, the Neo4j knowledge graph and the lineage layer are
all *extended*. Nothing is replaced; the vector path remains the default.

### Why now (grounded in the shipped distribution)

The `prime_silo_self` workspace in the latest distribution ingested 4 markdown
docs and produced **48 flat ChromaDB chunks and nothing else** — no triples, no
Section graph, empty `.benny/wiki/`, and 4 of 5 ingest runs failed on file
discovery. The graph the Notebook is meant to render is empty in the real
product. PIX-001 is what makes it populate, reliably and reproducibly. See
[ADR-002 §1](../../../architecture/ADR-002-pageindex-vectorless-spine.md#1-context).

---

## Document set

| Document | Role |
|----------|------|
| [README.md](README.md) | This index. Ground rules + vocabulary + do-not-do list. |
| [requirement.md](requirement.md) | **Normative.** Every requirement uniquely addressable (PIX-F*, PIX-NFR*, PIX-SEC*). |
| [acceptance_matrix.md](acceptance_matrix.md) | Traceability: requirement ID → test → status → evidence. |
| [project_plan.md](project_plan.md) | Phase-by-phase plan, risk register, plan tracker. Updated end of every session. |

---

## Glossary

| Term | Definition |
|------|------------|
| **Spine** | The pure, LLM-free, DB-free tree operations in `benny/core/pageindex.py`. |
| **Indexed abstract** | The tree of `{node_id, title, summary, page_range}` — titles + summaries only, no body. The human map and the cheap retrieval payload. |
| **Leaf** | A tree node with no children that carries body text. The fan-out work unit for triple extraction. |
| **Deterministic fan-out** | One small extractor agent per leaf; same tree → same leaf set → reproducible triple extraction. |
| **Section node** | Neo4j `(:Section)` in a `(:Document)-[:HAS_SECTION]->(:Section)` hierarchy; the anchor for triple provenance. |
| **`structured` route** | Adaptive RAG route that does a single node-selection call over the abstract, then loads selected leaves (not N-hop traversal). |

Vocabulary collisions with earlier requirement folders resolve in this folder's favour.

---

## Do-not-do list (binding)

1. **Do not** call litellm or any provider SDK directly. Tree build and node
   selection go through `benny.core.models.call_model()` (offline mode, lineage,
   AER, cost telemetry all fire through it). ADR-001 rule 1.
2. **Do not** put LLM calls or a Neo4j driver in `benny/core/pageindex.py`. That
   module is the *pure* spine; impurity breaks the offline test guarantee.
3. **Do not** reintroduce a truncation cap on the fan-out (`chunks[:10]`). The
   whole document is covered.
4. **Do not** remove or default-disable the vector path. PIX is additive; the
   `structured` route is a per-query choice.
5. **Do not** introduce absolute paths. Use `${BENNY_HOME}` / workspace helpers
   (SR-1 ratchet is a hard gate).
6. **Do not** bundle phases. One phase per PR; the tracker ticks only after the
   phase gate is green.
7. **Do not** answer an open question (OQ-*) by guessing — raise a HITL request.

---

## Quick links into the codebase (where new work lands)

| Concern | Module path | Touch type |
|---------|-------------|------------|
| Pure spine (tree ops) | `benny/core/pageindex.py` | **new (Phase 0, shipped)** |
| Spine tests | `tests/test_pageindex_spine.py` | **new (Phase 0, shipped)** |
| Tree build from text (LLM) | `benny/core/pageindex_builder.py` (new) | new (Phase 1) |
| Ingest integration | [benny/api/rag_routes.py](../../../benny/api/rag_routes.py) | extend (Phase 1/2) |
| Triple fan-out | [benny/synthesis/engine.py](../../../benny/synthesis/engine.py) `parallel_extract_triples` | consume sections (Phase 2) |
| Section graph write | [benny/graph/triples.py](../../../benny/graph/triples.py), [benny/core/graph_db.py](../../../benny/core/graph_db.py) | extend (Phase 2) |
| Cross-doc summary pass | `benny/synthesis/cross_document.py` (new) | new (Phase 3) |
| `structured` retrieval route | [benny/core/adaptive_rag.py](../../../benny/core/adaptive_rag.py) | extend (Phase 4) |

---

## Reading order for a new agent

1. This README (vocabulary + do-not list).
2. [ADR-002](../../../architecture/ADR-002-pageindex-vectorless-spine.md) for the *why* and the local-NPU constraint.
3. [requirement.md](requirement.md) §functional.
4. [project_plan.md](project_plan.md) §phase map and §risk register.
5. [acceptance_matrix.md](acceptance_matrix.md) when picking up an open phase.
