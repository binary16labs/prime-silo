# ADR-002: PageIndex Vectorless Spine — a Deterministic Document Backbone for Triple Fan-out and Cross-Document Reasoning

| Field      | Value                                                                 |
| ---------- | --------------------------------------------------------------------- |
| Status     | Proposed                                                              |
| Date       | 2026-06-23                                                            |
| Authors    | Binary 16 (engineering authority)                                     |
| Supersedes | —                                                                     |
| Related    | ADR-001 (determinism boundary), PIX-001 (docs/requirements/12), [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) |

---

## 1. Context

Benny's document surface is RAG-first: `/rag/ingest` extracts text, splits it on
blank lines, and upserts flat chunks into a per-workspace ChromaDB collection
(`benny/api/rag_routes.py`). Two structural weaknesses follow from this design,
and both are visible in the **shipped distribution**, not just in theory.

**Observed state — `prime_silo_self` workspace (latest distribution):**

- Four source docs (`GUIDE/README/ROADMAP/USER_GUIDE.md`, ~60 KB total).
- One successful ingest run (`306a222c`) → 48 flat chunks → ChromaDB (1.8 MB).
- Four of five ingest runs **failed** outright ("No supported files found").
- `reports/` empty, `.benny/wiki/` empty, **zero triples, zero Section graph.**
  `deep_synthesis` was off, so nothing reached Neo4j. The knowledge graph the
  Notebook is meant to render is, in the real product, empty.

**Weakness 1 — the embedding provider is a single point of failure.** The
vector path requires a live local embedding server (LM Studio / Lemonade /
Ollama). When it is down, upserts silently store zero-vectors; an entire class
of remediation code exists only because of this (`get_embedding_sync("ping")`
preflight, `heal_collection_dimension`, the 768-vs-384 dimension fix). For a
zero-install desktop EXE this is the dominant ingestion failure mode.

**Weakness 2 — the triple fan-out partition is arbitrary and truncated.** When
`deep_synthesis` *does* run, `parallel_extract_triples` is fed
`chunks[:10]` — blank-line paragraph splits, hard-capped at 10, titled
"Part 1/2/3…". The partition is non-reproducible and silently drops everything
past the 10th paragraph. Triples are anchored only to a **filename**
(`save_knowledge_triples(workspace, triples, file_path.name)`), so there is no
section/page provenance, and cross-document linking falls back to concept-
embedding cosine similarity (`run_full_correlation_suite`, threshold 0.82) —
vectors again.

PageIndex ([VectifyAI](https://github.com/VectifyAI/PageIndex)) proposes a
**vectorless, reasoning-based** index: a document becomes a hierarchical tree
(a table-of-contents of titled nodes with summaries and page ranges), and
retrieval is LLM tree-traversal rather than vector similarity. The user's
insight is to use that tree not merely for retrieval but as a **deterministic
spine**: build the abstract first, load it into the graph for the human to see
and the agent to traverse, then fan small extractor agents out over the tree's
real sections so the parts compose into a connected whole.

## 2. Decision

Adopt the PageIndex tree as a **parallel ingestion strategy and a structural
backbone for synthesis** — not a replacement for vector RAG, and not (in this
ADR) an agentic multi-hop retriever. Specifically:

1. **Introduce a pure spine module** `benny/core/pageindex.py` holding the
   indexed-abstract tree and the deterministic operations over it
   (`flatten_leaves`, `tree_to_sections`, `abstract_outline`,
   `build_section_edges`, `validate_tree`). It contains **no LLM call and no
   Neo4j driver**, so completeness/provenance/reproducibility are unit-testable
   offline. (Phase 0 — shipped with this ADR.)

2. **Build the tree at ingest** from the existing extracted text via
   `call_model()` (ADR-001 rule: never bypass the model router). Persist it to
   `workspace/.benny/pageindex/<source>.json` and as a Neo4j `Section`
   hierarchy: `(:Document)-[:HAS_SECTION]->(:Section)-[:HAS_SECTION]->...`.

3. **Fan triple extraction out over tree leaves, not `chunks[:10]`.**
   `tree_to_sections(tree)` yields exactly the `[{node_id, title, text}]` shape
   `parallel_extract_triples` already accepts — a clean drop-in with no
   signature change — and covers the whole document with no cap.

4. **Anchor triples to their Section** (node_id + page range), giving every
   extracted relationship section/page provenance instead of just a filename.

5. **Add a cheap cross-document pass** over section *summaries* (the abstract
   layer) to propose candidate `Section`↔`Section` links across documents
   *before* spending full-text LLM calls — the "greater than the sum of the
   parts" step.

6. **Add a `structured` retrieval route** to the Adaptive RAG router
   (`benny/core/adaptive_rag.py`) that, for tree-backed documents, does a
   **single** node-selection call over `abstract_outline(tree)` then loads the
   selected leaves — explicitly *not* an N-hop agentic traversal (see §4).

## 3. Why this fits the determinism boundary (ADR-001)

The spine slots into the existing two-zone model rather than fighting it.

| Concern                | Spine behaviour                                                                 |
| ---------------------- | ------------------------------------------------------------------------------- |
| Deterministic fan-out  | Same document → same tree (temperature 0) → same leaf set → same triple work units. Reproducible by construction. |
| Provenance / audit     | Triples carry `node_id` + page range; every Section write is a lineage event, matching the "agent authorship is auditable" stance of ADR-001 §5. |
| Vectorless path        | Tree build + node-select use `call_model()`; **no embedding server**, so the entire zero-vector failure class disappears for tree-backed docs. |
| Coexistence            | Vector RAG remains the default; `structured` is a router choice per query. No existing collection or route is removed. |

## 4. The local-NPU constraint (and why retrieval stays single-call)

`adaptive_rag.py` already documents that agentic, multi-call loops on a local
12B NPU model "run for minutes" and drop the caller's connection — which is why
`self_check=False` is the default lean pipeline. PageIndex's reference retriever
is agentic tree traversal (many reasoning calls); ported naively it reintroduces
exactly that latency.

**Resolution:** the tree's abstract (titles + summaries only) is small and fits
in context, so retrieval is **one** node-selection call + generation — two LLM
round-trips total, matching the lean pipeline. The expensive tree *construction*
is one-time at ingest, batchable and async, off the request path.

## 5. Consequences

### Positive

- **Populates a graph that is currently empty** in the shipped distribution.
- **Kills the embedding-server failure class** for tree-backed documents.
- **Deterministic, complete triple fan-out** — removes the `chunks[:10]` cap and
  the arbitrary partition; reproducible under the SR-1 / replay gates.
- **Section/page provenance** for every triple; cross-doc links proposed from a
  cheap summary layer instead of concept-embedding cosine.
- **A human-navigable abstract** (the indexed table-of-contents) that doubles as
  the agent's cheap planning map.

### Negative

- **Tree build is LLM-bound** at ingest; slow on a local NPU for large corpora
  (mitigated: one-time, async, batched).
- **Second index to maintain** alongside ChromaDB for tree-backed docs.
- **Quality depends on the tree builder** — a bad tree yields a bad partition.
  Mitigated by `validate_tree` invariants and a deterministic re-build.

### Neutral

- Vector RAG, `single_step`/`multi_hop` routes, and the existing collections are
  untouched. The spine is additive.

## 6. Alternatives considered

- **Replace vector RAG wholesale with PageIndex.** Rejected — vector recall is
  genuinely better for fuzzy lookups across many small notes; PageIndex wins on
  long *structured* docs. Hybrid is what PageIndex itself recommends.
- **Vendor the upstream PageIndex library directly.** Rejected for the LLM half
  — it is LiteLLM/OpenAI-wired and would bypass `call_model()` (ADR-001 rule 1,
  offline mode, lineage). We port its prompts onto the router instead; PDF
  parsing we already own (`fitz` / Docling).
- **Keep `chunks[:10]` but raise the cap.** Rejected — still arbitrary, still
  non-reproducible, still no provenance.

## 7. Open questions

1. **Tree-builder model + token budget per node** under offline mode (local
   reasoning model vs. cloud). → PIX open_questions OQ-1.
2. **`Section` schema reconciliation** with the existing `Concept`/`Document`
   knowledge-graph nodes and the enrichment `CORRELATES_WITH` overlay. → OQ-2.
3. **Cross-document candidate-link threshold** on summaries — reasoning call vs.
   cheap clustering. → OQ-3.
4. **Trigger policy** — auto-detect "structured" docs (PDF with real TOC) vs. an
   explicit `strategy: "vectorless"` ingest flag. → OQ-4.

---

*ADR-002 — PageIndex vectorless spine — Binary 16 — for review. Phase 0
(pure spine module + tests) shipped with this ADR; Phases 1–4 tracked in
[docs/requirements/12/project_plan.md](../docs/requirements/12/project_plan.md).*
