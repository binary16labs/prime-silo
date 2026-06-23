# PIX-001 — Requirements (Normative)

Every requirement has a unique ID and a one-sentence success criterion. A phase
is not done until every acceptance row for that phase is `PASS` with evidence
(see [acceptance_matrix.md](acceptance_matrix.md)).

Keywords MUST / SHOULD / MAY per RFC 2119.

---

## 1. Scope

In scope: a vectorless PageIndex spine — tree build, graph load, deterministic
triple fan-out, section provenance, cross-document candidate linking, and a
single-call `structured` retrieval route.

Out of scope (this phase): retiring vector RAG; agentic multi-hop tree
traversal; OCR/layout extraction changes (reuse existing `extract_structured_text`).

---

## 2. Actors

- **Operator (human)** — ingests documents; reads the indexed abstract graph.
- **Coordinator agent** — reads the abstract, dispatches extractors per section.
- **Extractor agent** — extracts triples from one leaf section.
- **Deterministic core** — `call_model()`, lineage, manifest signing, Neo4j.

---

## 3. Functional requirements

### Phase 0 — Pure spine (shipped with ADR-002)

- **PIX-F1** — `flatten_leaves(tree)` MUST return every text-bearing leaf with
  **no truncation cap**; the whole document is covered.
- **PIX-F2** — `tree_to_sections(tree)` MUST emit `{node_id, title, text}` per
  leaf (the `parallel_extract_triples` shape) so triple provenance survives the
  hand-off.
- **PIX-F3** — The leaf partition MUST be deterministic: same tree → identical
  section ordering on repeat.
- **PIX-F4** — `abstract_outline(tree)` MUST contain titles + summaries only and
  MUST NOT contain leaf body text.
- **PIX-F5** — `build_section_edges(doc, tree)` MUST produce a fully connected
  `(:Document)-[:HAS_SECTION]->(:Section)` hierarchy with no orphan nodes.
- **PIX-F6** — `validate_tree(tree)` MUST flag missing and duplicate `node_id`s
  (provenance keys must be unique) and pass a well-formed tree.

### Phase 1 — Tree build at ingest

- **PIX-F7** — A builder MUST turn extracted document text into a `TreeNode`
  tree **only** via `call_model()` (no direct provider SDK), at temperature 0.
- **PIX-F8** — The tree MUST persist to `workspace/.benny/pageindex/<source>.json`
  using workspace path helpers (no absolute paths).
- **PIX-F9** — `/rag/ingest` MUST accept a `strategy: "vectorless"` (or
  equivalent flag) that triggers tree build; default behaviour is unchanged.

### Phase 2 — Deterministic fan-out + Section graph

- **PIX-F10** — Triple extraction MUST fan out over `tree_to_sections(tree)`
  instead of `chunks[:10]`.
- **PIX-F11** — Each persisted triple MUST be anchored to its `Section`
  (`node_id` + page range), not only to a filename.
- **PIX-F12** — Section nodes MUST be written to Neo4j as the
  `build_section_edges` payload describes.

### Phase 3 — Cross-document linking

- **PIX-F13** — A pass MUST propose candidate `Section`↔`Section` links across
  documents from section **summaries** (abstract layer) before any full-text
  call.

### Phase 4 — `structured` retrieval route

- **PIX-F14** — The Adaptive RAG router MUST support a `structured` route that
  performs a **single** node-selection call over `abstract_outline`, then loads
  the selected leaves for generation (no N-hop traversal).

---

## 4. Non-functional targets

- **PIX-NFR1** — The spine module (`pageindex.py`) MUST import and run with **no
  LLM and no Neo4j**; its tests MUST pass under `BENNY_OFFLINE=1`.
- **PIX-NFR2** — `structured` retrieval MUST stay within **two** LLM round-trips
  (select + generate) to respect the local-NPU latency budget (ADR-002 §4).
- **PIX-NFR3** — Tree build MUST be reproducible: same input text + same model +
  temperature 0 → identical tree (byte-equal JSON) on the replay fixture.
- **PIX-NFR4** — New modules MUST meet the ≥ 85 % coverage release gate.
- **PIX-NFR5** — No new absolute-path violations (SR-1 ratchet).

---

## 5. Security / governance

- **PIX-SEC1** — Tree JSON and Section writes MUST emit triple lineage
  (`process/skill/data`) like any other authored artefact.
- **PIX-SEC2** — Persistence MUST reject path traversal outside
  `workspace/.benny/pageindex/`.

---

## 6. Open questions (must be resolved before the owning phase merges)

- **OQ-1** (Phase 1) — Tree-builder model + per-node token budget under offline
  mode (local reasoning model vs. cloud).
- **OQ-2** (Phase 2) — `Section` schema reconciliation with existing
  `Concept`/`Document` nodes and the `CORRELATES_WITH` enrichment overlay.
- **OQ-3** (Phase 3) — Cross-doc candidate-link mechanism on summaries:
  reasoning call vs. cheap clustering, and the threshold.
- **OQ-4** (Phase 1) — Trigger: auto-detect structured docs vs. explicit
  `strategy: "vectorless"` ingest flag.
