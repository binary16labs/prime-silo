# VIS-001 — Vision-Augmented Ingestion

> Turn the figures, diagrams, charts and tables that Benny's ingestion currently
> **throws away** into graph-ready, agent-readable surrogates — using a local
> vision model and a multi-model escalation ladder.

This folder is the requirements home for **ADR-003**
([../../../architecture/ADR-003-vision-augmented-ingestion.md](../../../architecture/ADR-003-vision-augmented-ingestion.md)).

## The one-paragraph version

Today [`extract_structured_text`](../../../benny/core/extraction.py) runs Docling,
flattens straight to markdown, and **drops every picture, diagram and chart** (and
reduces tables to flat markdown). VIS-001 inserts a vision-augmented pass *before*
the PageIndex spine (ADR-002): preserve Docling's element tree, **classify** each
visual element, **route** it (illustration→caption, diagram→Mermaid/PlantUML,
chart→JSON+description, table→JSON), **validate** the result, **stitch** it back in
reading order, and feed the now-complete document into the existing triple/Chroma
pipeline — with every surrogate anchored to its `Section` (page + bbox + crop).

## What this is — and isn't

- **Is:** *vision-augmented parsing* (Strategy A). The knowledge graph stays the
  source of truth; the VLM enriches the text that feeds it.
- **Isn't:** *vision-native retrieval* (Strategy B — [PixelRAG](https://github.com/StarTrail-org/PixelRAG)
  / ColPali, embed page images and retrieve them directly). That is a separate
  index and retriever, deliberately deferred (ADR-003 §7) — though the DocModel
  this project builds is exactly the substrate B would later reuse.

## The escalation ladder (cheapest first)

```
Docling layout ──► element tree (type, page, bbox, reading order, crop)
                     │
        ┌────────────┼───────────────┬──────────────┐
      table        formula         picture         text
        │            │           (classify)          │
     JSON         LaTeX     ┌──────┼───────┐      (passthrough)
   (+VLM verify  (no VLM)  illus. diagram chart
    if complex)             │       │      │
                         caption  Mermaid  JSON+desc
                                  /PlantUML
                                  (validate ─► caption on fail)
                     │
              stitch in reading order ──► enriched doc
                     │
        PageIndex spine (ADR-002) ──► triples + Chroma, Section-anchored
```

## Files

- [requirement.md](requirement.md) — normative VIS-Fn / NFR / SEC requirements + open questions.
- [project_plan.md](project_plan.md) — phase map, spikes, risk register, KPIs, tracker.
- [acceptance_matrix.md](acceptance_matrix.md) — per-phase acceptance rows + evidence.

## Decisions locked at kickoff (2026-06-28)

- **Strategy A only** for this project; B recorded as a future lane.
- **Lemonade/FLM (`qwen3vl-it-4b-FLM`) as the primary VLM target**, pending the
  OQ-1 spike that confirms FLM accepts `image_url` content; **lmstudio is the
  proven fallback**.
- **Deliverable:** this ADR + requirements set, *before* code. Recommended first
  build step is the OQ-1 multimodal round-trip spike.

## Key design anchors (don't relitigate)

- **Reuse ADR-002 `Section` provenance** for surrogates — do not invent a parallel
  provenance scheme.
- **All VLM calls via `call_model()`** — never a provider SDK (ADR-001 §1).
- **No hollow success** — a surrogate is only "successful" if its validator passed;
  otherwise it degrades to a caption.
- **Visual surrogates are not byte-reproducible** (ADR-003 §4) — they get a
  "validated + cached + model_id" guarantee, not the spine's replay guarantee.
