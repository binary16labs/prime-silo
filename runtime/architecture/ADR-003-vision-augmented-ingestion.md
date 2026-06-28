# ADR-003: Vision-Augmented Ingestion — a Multi-Model Pipeline that Turns Figures, Diagrams, Charts and Tables into Graph-Ready Surrogates

| Field      | Value                                                                 |
| ---------- | --------------------------------------------------------------------- |
| Status     | Proposed                                                              |
| Date       | 2026-06-28                                                            |
| Authors    | Binary 16 (engineering authority)                                     |
| Supersedes | —                                                                     |
| Related    | ADR-001 (determinism boundary), ADR-002 (PageIndex Section spine), VIS-001 (docs/requirements/13), [StarTrail-org/PixelRAG](https://github.com/StarTrail-org/PixelRAG) |

---

## 0. Update (2026-06-28) — DocModel backend: PyMuPDF default, Docling optional

The original decision (below) made Docling the DocModel extractor. Implementation +
eval changed that: Docling pulls a torch/transformers stack (~+1.5 GB) and fetches
HF model weights on first use — doubling the runtime bundle and breaking the
zero-install/offline promise, for structure quality the **VLM largely makes
redundant** (the vision model reads each figure regardless). So the DocModel
backend is now **pluggable**:

- **`backend="pymupdf"` (DEFAULT, shipped)** — figure crops via `extract_image`,
  ruled tables via `find_tables`, text in reading order with font-size heading +
  caption heuristics. No torch, no download, fully offline. On the 124-page TOGAF
  standard: 1193 elements, 20 figure crops, captions correctly typed, **3.3 s**.
- **`backend="docling"` (OPTIONAL, not bundled)** — higher-accuracy ML layout +
  TableFormer for borderless tables; install `docling` to opt in.

Trade-off accepted: PyMuPDF detects only **ruled** tables (borderless tables stay
as text — PyMuPDF's text-alignment strategy was rejected because it shatters prose
into fake columns). Docling backend is the answer when structured borderless tables
matter. `docling`/`Pillow` were removed from `BUNDLE_RUNTIME_REQUIREMENTS`
accordingly (§2.1 below is superseded on this point).

## 1. Context

Benny's ingestion is **visually blind**. [`extract_structured_text`](../benny/core/extraction.py)
runs Docling with `do_table_structure=True` and `do_ocr=False`, then immediately
calls `export_to_markdown()` and discards everything else. Two consequences
follow, both present in the shipped pipeline:

1. **Every non-text element is lost.** Figures, diagrams, schematics, charts and
   photographs never reach the markdown. A technical PDF whose meaning lives in
   its architecture diagrams is ingested as if those pages were blank. Tables
   survive only as flattened markdown tables — usable for reading, useless as
   queryable data.
2. **The graph inherits the blindness.** [`synthesis/engine.py`](../benny/synthesis/engine.py)
   extracts triples from text only; an empty figure contributes zero triples and
   zero chunks. The knowledge graph the Notebook renders cannot cite "Figure 3."

Meanwhile the model router ([`core/models.py`](../benny/core/models.py)) is
**text-only by construction**: every `messages[].content` is a `str`, and the
local-executor short-circuit (`call_model` §5) pulls `user_msg` out as a string.
There is no path to send an image to a model, no vision model registered, and no
`vision` role.

The operator is downloading **`qwen3vl-it-4b-FLM`** (a Qwen3-VL build for the
local FastFlowLM/Lemonade stack) and wants to leverage it. The insight is right
but the design must be precise: a vision model is only useful if visual elements
are (a) detected, (b) **classified** so the right treatment is applied, (c)
converted to a faithful **textual surrogate**, (d) **validated**, and (e)
**stitched back in reading order** so the surrounding context survives.

### Two philosophies — and which one this ADR adopts

[PixelRAG](https://github.com/StarTrail-org/PixelRAG) and the ColPali/ColQwen
family represent **vision-native retrieval**: embed page *images* directly,
retrieve whole pages by visual+semantic similarity, hand crops to a VLM at query
time — no intermediate text, a parallel index. This is the *opposite* paradigm
from what the operator described.

This ADR adopts **vision-augmented parsing (Strategy A)**: a VLM turns each
visual element into a textual surrogate (caption / diagram-as-code / JSON), and
the enriched document flows into the **existing** PageIndex → triple → Chroma
pipeline. The knowledge graph stays the source of truth. Vision-native retrieval
(Strategy B / PixelRAG) is explicitly **out of scope** here and recorded as a
future parallel lane (§6), because it diverges from the current architecture and
would not reuse the Section provenance ADR-002 just established.

## 2. Decision

Add a **vision-augmented ingestion pipeline** that sits *before* the PageIndex
spine (ADR-002) and feeds it a visually-complete document. Specifically:

1. **Preserve Docling's element tree instead of early-flattening.** A new
   structured pass keeps element **type** (text / table / picture / formula /
   code), **bounding box**, **page index**, **reading order**, and a **crop**
   per visual element, emitted as an intermediate `workspace/.benny/docmodel/<source>.json`.
   Tables are exported to **structured JSON** (plus a markdown rendering for the
   LLM). *No VLM in this phase* — this is a strict improvement on its own and
   de-risks everything after.

2. **Add a multimodal path to the model router.** `call_model()` and the local
   executor learn to accept OpenAI-style multimodal content (a list of
   `{type:"text"}` / `{type:"image_url"}` blocks). A `vision` role and a
   `qwen3vl` registry entry are added. **All** VLM calls go through `call_model()`
   — never a provider SDK directly (ADR-001 rule 1: offline guard, lineage,
   routing).

3. **Classify each visual element, then route by type** — the escalation ladder,
   cheapest first:
   - **Table** → already structured by Docling → JSON (VLM only to *verify*
     merged-cell / rotated tables).
   - **Picture** → sub-classify (decorative illustration/photo vs. technical
     diagram vs. chart/plot):
     - **Illustration / photo** → short caption.
     - **Diagram / flowchart / architecture / schematic** → **diagram-as-code**
       (Mermaid or PlantUML), which agents can read *and edit*.
     - **Chart / plot** → extracted data series as JSON **plus** a description.
   - **Formula** → Docling's LaTeX (no VLM).

4. **Validate every generated surrogate.** Mermaid/PlantUML MUST parse; chart and
   table JSON MUST validate against a schema. On failure, **fall back to a plain
   caption** rather than poison the graph — directly answering the "hollow
   success" failure mode this team has hit before. A surrogate is never emitted
   as "successful" unless it passed its validator.

5. **Stitch surrogates back in reading order** at the element's original position,
   producing an enriched document. The surrogate replaces the element *in place*
   so the section context that gives a diagram meaning is preserved.

6. **Anchor surrogates to the PageIndex `Section` (ADR-002), not a new scheme.**
   Each surrogate carries `node_id` + page + bbox + crop path, so a triple
   extracted from "Figure 3" cites its Section and the UI can surface the crop.
   The enriched text is what `tree_to_sections` → `parallel_extract_triples`
   already consume — **no synthesis signature change**.

7. **Make it opt-in and idempotent.** A `vision: true` (or `strategy: "vision"`)
   ingest flag triggers the pass; default behaviour is unchanged. Surrogates are
   cached by **element content-hash**, so re-ingest is stable and a VLM is never
   re-run on an unchanged crop — mirroring the mtime/hash guard already in
   [`promote_staged_files`](../benny/api/etl_routes.py).

The "multi-model aggregate" the operator described is realised as this
**router + escalation ladder** (cheap pass → VLM only where needed → optional
second-model *verify* on high-value tables/diagrams). The aggregate is the
enriched document, not a literal merge of model outputs.

## 3. Why this fits the determinism boundary (ADR-001) and the spine (ADR-002)

| Concern               | Behaviour                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Router discipline     | Every VLM call is `call_model()` → offline guard, lineage, endpoint routing all fire (ADR-001 §1). |
| Provenance            | Surrogates anchor to ADR-002 `Section` (node_id + page + bbox); each is a lineage event (ADR-001 §5). |
| Spine reuse           | Enriched text feeds `tree_to_sections` unchanged; the spine partitions a *visually complete* doc.   |
| Offline               | `qwen3vl` is a **local** model → the vision pass runs under `BENNY_OFFLINE=1`; no cloud dependency.  |
| Portability           | docmodel/crop/cache paths use workspace helpers — no absolute paths (SR-1).                          |
| Coexistence           | Default ingest is untouched; vision is a per-ingest opt-in. Vector RAG and the spine are additive.   |

## 4. The honest determinism caveat

ADR-002's spine claims **byte-equal reproducibility** (temperature 0 → identical
tree). **A VLM cannot make that claim** — vision models are not byte-deterministic
even at temperature 0, and a caption/diagram will vary run to run. This ADR does
**not** pretend otherwise. The mitigations are:

- **Content-hash caching** — once a crop is described, the surrogate is frozen;
  re-ingest reuses it, so a *given workspace* is stable after first pass.
- **Validation gates** — a surrogate enters the graph only if it parsed/validated,
  bounding the blast radius of a bad generation.
- **`model_id` provenance** on every surrogate, so non-determinism is traceable.

This means vision-augmented docs sit *outside* the SR-3 replay gate's byte-equal
guarantee; they get a weaker "validated + cached" guarantee instead. That trade
is deliberate and is the price of seeing the figures at all.

## 5. The local-VLM latency constraint

ADR-002 §4 already records that multi-call loops on a local NPU "run for minutes."
A VLM pass is heavier still (image encode + decode per element). Therefore:

- The vision pass is **one-time at ingest, off the request path**, batched, and
  cached — never on a query.
- It is **opt-in** so the default zero-install ingest stays fast.
- The escalation ladder spends the VLM **only** on elements that need it (tables
  and formulas mostly avoid it), keeping the call count proportional to figures,
  not pages.

## 6. Consequences

### Positive
- **Figures, diagrams, charts and tables become first-class** graph content with
  Section/page/bbox provenance — the graph can finally cite "Figure 3, p.12."
- **Diagram-as-code is agent-native** — an agent can read, reason over, and
  regenerate a Mermaid/PlantUML diagram, not just a prose description of it.
- **Tables become queryable JSON**, not flattened markdown.
- **Reuses the spine and synthesis path** — no fork of the triple pipeline.
- **Unlocks the local VLM** the operator is already provisioning, fully offline.

### Negative
- **Not byte-reproducible** for visual surrogates (§4) — a real step down from the
  spine's guarantee, mitigated by cache + validation.
- **VLM pass is slow** on local NPU/CPU (mitigated: opt-in, off-request, cached).
- **New multimodal surface in `call_model`** — the riskiest plumbing; must thread
  through *both* the LiteLLM branch and the local-executor short-circuit (§5 of
  models.py currently drops non-string content).
- **FLM vision support is unverified.** `qwen3vl-it-4b-FLM` may not expose vision
  over the OpenAI-compatible `/chat/completions` `image_url` contract. lmstudio is
  the proven fallback. Gated as OQ-1 before Phase 2.
- **A third artefact to maintain** (`docmodel.json`) alongside the tree and Chroma.

### Neutral
- Vector RAG, the PageIndex spine, and existing collections are untouched. The
  vision pass is purely additive and behind a flag.

## 7. Alternatives considered

- **Use Docling's built-in `PictureDescriptionVlmOptions` / describe pipeline.**
  Rejected as the primary mechanism — it yields generic captions and would bypass
  `call_model()` (ADR-001 rule 1). We want **type-routed** output (Mermaid/JSON),
  not one-size captions, and we want the call on our router. (We may still use
  Docling's *picture classifier* as a cheap first-pass type hint.)
- **Strategy B / PixelRAG (vision-native page-image retrieval).** Deferred, not
  rejected. It is a different index and retriever that would not reuse the Section
  spine; recorded as a future parallel lane once Strategy A is proven. The
  docmodel (page images + bbox) is deliberately the substrate B would also need,
  so adopting A does not foreclose B.
- **Describe everything with the VLM (no classifier, no ladder).** Rejected —
  wastes the heaviest model on decorative images and well-structured tables, and
  blows the local latency budget.
- **Append surrogates as an appendix instead of stitching in place.** Rejected —
  destroys the reading-order context a diagram depends on; triples would lose the
  section that explains the figure.

## 8. Open questions (resolve before the owning phase merges)

- **OQ-1** (Phase 1) — Does `qwen3vl-it-4b-FLM` accept `image_url` content over
  the Lemonade/FLM OpenAI-compatible endpoint? If not, lmstudio is primary. →
  VIS-001 OQ-1.
- **OQ-2** (Phase 2) — Picture sub-classification mechanism: Docling's picture
  classifier vs. a VLM routing prompt vs. both — and the confidence threshold for
  "diagram" vs. "illustration." → OQ-2.
- **OQ-3** (Phase 2) — Diagram-as-code target: Mermaid vs. PlantUML default, and
  the validator (headless parse) that gates acceptance. → OQ-3.
- **OQ-4** (Phase 3) — Element-level Chroma chunking: do visual surrogates get
  their own typed chunks (so an agent can query "the architecture diagrams"), and
  how do they dedupe against the section text that already embeds them? → OQ-4.

---

*ADR-003 — Vision-augmented ingestion — Binary 16 — for review. Phases tracked in
[docs/requirements/13/project_plan.md](../docs/requirements/13/project_plan.md).*
