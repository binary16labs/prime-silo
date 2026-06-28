# VIS-001 — Requirements (Normative)

Every requirement has a unique ID and a one-sentence success criterion. A phase
is not done until every acceptance row for that phase is `PASS` with evidence
(see [acceptance_matrix.md](acceptance_matrix.md)).

Keywords MUST / SHOULD / MAY per RFC 2119.

---

## 1. Scope

In scope: **vision-augmented parsing (Strategy A)** — preserve Docling's element
tree, classify visual elements, route them through a multi-model describer ladder
(illustration→caption, diagram→diagram-as-code, chart→JSON+description,
table→JSON), validate every surrogate, stitch surrogates back in reading order,
and feed the enriched document into the existing PageIndex spine (ADR-002) and
triple/Chroma pipeline with Section-anchored provenance.

Out of scope (this project): vision-native page-image retrieval (PixelRAG /
ColPali, "Strategy B"); replacing Docling; replacing vector RAG or the spine;
agentic multi-hop retrieval changes; cloud VLMs (the VLM is local-first).

---

## 2. Actors

- **Operator (human)** — ingests documents with `vision: true`; reviews surrogates.
- **Layout pass** — Docling element-tree extraction (deterministic, no LLM).
- **Classifier** — assigns a treatment type to each visual element.
- **Describer agents** — per-type VLM calls (caption / diagram-as-code / chart JSON).
- **Validator** — gates each surrogate (parse/schema) before it enters the graph.
- **Deterministic core** — `call_model()`, lineage, Neo4j, the PageIndex spine.

---

## 3. Functional requirements

### Phase 0 — Structured DocModel (no VLM)

- **VIS-F1** — A structured pass MUST preserve, per element, its **type**
  (text/table/picture/formula/code), **page index**, **bounding box** and
  **reading-order position**; the markdown-only flatten MUST no longer be the only
  output.
- **VIS-F2** — Tables MUST be exported to **structured JSON** (a markdown
  rendering MAY also be kept for the LLM).
- **VIS-F3** — Each picture element MUST have a **crop image** persisted, keyed by
  element content-hash, under `workspace/.benny/docmodel/` (traversal-guarded).
- **VIS-F4** — The pass MUST emit `workspace/.benny/docmodel/<source>.json` using
  workspace path helpers (no absolute paths) and MUST be re-runnable idempotently.
- **VIS-F5** — The default ingest path MUST be unchanged when `vision` is not set.

### Phase 1 — Multimodal router

- **VIS-F6** — `call_model()` MUST accept OpenAI-style multimodal content (list of
  `{type:"text"}` / `{type:"image_url"}` blocks) on **both** the LiteLLM branch
  and the local-executor short-circuit, without dropping image blocks.
- **VIS-F7** — A `qwen3vl` model entry and a `vision` role MUST be registered;
  resolution MUST be local-first and honour `BENNY_OFFLINE=1`.
- **VIS-F8** — An image→text round-trip MUST be proven end-to-end against a local
  endpoint (Lemonade/FLM if it supports vision per OQ-1, else lmstudio).

### Phase 2 — Classifier + describers + validation

- **VIS-F9** — Each visual element MUST be classified into a treatment type
  (illustration / diagram / chart / table / formula) before any describer runs.
- **VIS-F10** — Diagrams MUST be rendered as **diagram-as-code** (Mermaid or
  PlantUML) and that code MUST be validated by a headless parse; on failure the
  element MUST fall back to a plain caption.
- **VIS-F11** — Charts MUST yield data-series **JSON** validated against a schema,
  plus a description; tables MUST yield validated JSON; on failure, caption fallback.
- **VIS-F12** — A surrogate MUST NOT be reported as successful unless it passed its
  validator (no "hollow success").
- **VIS-F13** — Surrogates MUST be cached by element content-hash; an unchanged
  crop MUST NOT trigger a repeat VLM call.

### Phase 3 — Graph integration

- **VIS-F14** — Surrogates MUST be stitched into the document at the element's
  original reading-order position, producing the enriched document the spine consumes.
- **VIS-F15** — Each surrogate MUST anchor to its PageIndex `Section` (node_id +
  page + bbox), and triples extracted from a surrogate MUST inherit that provenance.
- **VIS-F16** — Visual surrogates SHOULD be retrievable as type-tagged chunks (so
  an agent can query e.g. "the architecture diagrams"), deduped against the
  section text that already embeds them (see OQ-4).

---

## 4. Non-functional targets

- **VIS-NFR1** — The Phase 0 DocModel pass MUST run with **no LLM** and pass under
  `BENNY_OFFLINE=1`.
- **VIS-NFR2** — The vision pass MUST be opt-in and off the request path
  (one-time at ingest, batched), respecting the local-NPU latency budget (ADR-003 §5).
- **VIS-NFR3** — Visual surrogates are explicitly **exempt from the SR-3 byte-equal
  replay gate**; they MUST instead carry `model_id` provenance and a "validated"
  flag (ADR-003 §4).
- **VIS-NFR4** — New modules MUST meet the ≥ 85 % coverage release gate.
- **VIS-NFR5** — No new absolute-path violations (SR-1 ratchet).

---

## 5. Security / governance

- **VIS-SEC1** — DocModel JSON, crop images and surrogate artefacts MUST emit
  triple lineage (`process/skill/data`) like any other authored artefact.
- **VIS-SEC2** — Crop/docmodel/cache persistence MUST reject path traversal
  outside `workspace/.benny/docmodel/`.
- **VIS-SEC3** — VLM calls MUST go through `call_model()` only (no provider SDK),
  so the offline guard and lineage cannot be bypassed.

---

## 6. Open questions (must be resolved before the owning phase merges)

- **OQ-1** (Phase 1) — ✅ **RESOLVED 2026-06-28.** `qwen3vl-it-4b-FLM` on Lemonade
  (`127.0.0.1:13305/api/v1`) accepts the OpenAI `image_url` **object** form
  (`image_url:{url:data-uri}`) and correctly read an unguessable band order
  (blue/red/yellow) → genuine vision. **Lemonade/FLM is the primary VLM; no
  lmstudio fallback needed.** Reproduce: `python scripts/vision_spike.py`.
- **OQ-2** (Phase 2) — Picture sub-classification: Docling picture classifier vs.
  VLM routing prompt vs. both; the diagram-vs-illustration confidence threshold.
- **OQ-3** (Phase 2) — Diagram-as-code default (Mermaid vs. PlantUML) and the
  headless validator used to gate acceptance.
- **OQ-4** (Phase 3) — Element-level Chroma chunking for surrogates and how it
  dedupes against the embedding section text that already contains them.
