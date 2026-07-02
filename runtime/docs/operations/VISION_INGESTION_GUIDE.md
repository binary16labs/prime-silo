# Vision-augmented ingestion (VIS-001) — run guide

A local vision model (`qwen3vl-it-4b-FLM`) reads each figure/diagram/chart in a
document into Mermaid diagram-as-code and each table into JSON, stitching an
**enriched markdown** into `data_in` before standard ingestion — so the
knowledge graph captures what the pictures say, not just the prose.

Design: [`architecture/ADR-003-vision-augmented-ingestion.md`](../../architecture/ADR-003-vision-augmented-ingestion.md)
(Strategy A, parse-enrich; whole-page fidelity cascade with vector-region crops
and a visual fidelity judge, best-wins by visual score).

## Prerequisites

- Lemonade serving `qwen3vl-it-4b-FLM` (check `http://127.0.0.1:13305/api/v1/models`).
- Source documents staged in the workspace (`staging/` or `data_in/`).

## Run — Bridge (recommended)

Bridge → Documents → select files → tick **"Vision ingest (figures →
diagrams)"** → Ingest. The vision pass runs first (slower; the note line shows
progress), then standard ingestion picks up the enriched documents. The result
summary reports diagrams / charts / tables / regions found, how many were
fidelity-judged, and caption fallbacks.

A vision failure degrades gracefully to standard ingest — it never blocks.

## Run — API

Per source document, before `/rag/ingest`:

```
POST /api/vision/docmodel?workspace=<ws>&source=<file>
POST /api/vision/enrich?workspace=<ws>&source=<file>&render_check=true
```

`render_check=true` enables the fidelity judge: each produced diagram is
rendered and scored against the original figure; best output wins, low scores
fall back to captions (advisory gate — nothing is silently dropped).

## Evaluate fidelity honestly

`scripts/vision_eval.py` is the funnel harness — it measures how many figures
became diagrams and at what visual score, instead of asserting success:

```powershell
cd prime-silo/runtime
python scripts/vision_eval.py --workspace <ws>
```

## Notes and limits

- Vision enrichment is per-figure LLM work — expect minutes per figure-heavy
  document. Run it on the documents where diagrams carry the signal.
- The enriched `.md` is newer than its source, so the staging converter skips
  re-conversion and the enrichment survives subsequent ingests.
- Pair with `deep_synthesis: true` on the ingest if you want the enriched
  content in the Neo4j graph, not just the vector store.
