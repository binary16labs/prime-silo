# EP-K — Knowledge over the estate (metadata, vectorless RAG, vector RAG, graph RAG, and the sizing to buy for)

**Objective:** O2 (+ O3) · **Milestone:** M12 (`delivery/milestones/M12-knowledge.md`, written 2026-10-17) · **Status:** signed by the owner
as written, 2026-10-11 (owner questions answered by the recommendations)
**Builds on:** EP-U (consolidation: catalogues, the replicated ledger, copies, store roles), EP-S's
librarian (S21–S24), and Benny's existing retrieval stack (below).

Owner direction (2026-10-11): "that is what I want to build for consolidate: have all the meta data
and knowledge management solutions with RAG and, vectorless RAG and GRAPH RAG and then understand
how much data I need to manage to start purchasing a setup for managing this all."

**The one idea:** consolidation tells the estate *where* everything is; EP-K tells Benny *what* it
is. Every piece of content is indexed **once, by fingerprint**, however many copies exist, through
the retrieval stack Benny already has. Benny can then answer by metadata, by document structure,
by meaning, or by relationship. And before anything is bought, a capacity report says how much
data there really is to manage.

## What already exists (reused, not rebuilt)

| Style | In Benny today | Where |
| --- | --- | --- |
| Vector RAG | ingest, chunks and embeddings into Chroma; `/rag/ingest`, `/rag/query` | `runtime/benny/api/rag_routes.py` |
| Vectorless RAG | **PageIndex**: deterministic document trees, LLM-navigated, no embeddings; Docling structure | `runtime/benny/core/pageindex*.py`, `docmodel.py`; `/rag/pageindex/*` |
| Graph RAG | Neo4j knowledge graph (Source, Concept, Section), multi-hop traversal; `/rag/graph-upsert` | `runtime/benny/core/graph_db`, `api/graph_routes.py` |
| Routing between them | adaptive RAG: a router chooses none, single-step or multi-hop retrieval, then grades and checks the answer | `runtime/benny/core/adaptive_rag.py`; `/rag/adaptive-query` |
| Metadata | the S21–S23 catalogues (names, sizes, dates, kinds, fingerprints), S24's EXIF, U0's registry | `server/coordination/lib/library.mjs` and U-tasks |

## Measured on the T480 (2026-10-11, Windows and Everything's index, totals only)

| | Size | Notes |
| --- | --- | --- |
| F: (WD Elements) | **1.56 TB used of 5.0 TB** (1,117,018 files) | 3.4 TB free |
| … unique content on F: | **between 1.03 and 1.55 TB** | 1.03 TB is certain (files whose size nothing else on F: has); the rest depends on duplicates S23 will measure |
| … media on F: | JPEG 499 GB, Nikon RAW 352 GB, MP4 389 GB, MOV 134 GB, others | media is ~90% of F: |
| C: | **453 GB used of 511 GB (89% full)** | ~184 GB is OS and applications |
| … the owner's data on C: | known folders 136 GB (Pictures 79, Downloads 40, Documents 16) + OneDrive's rest 55 GB (mostly code) | Downloads is very likely almost all not on F: |
| **Text documents (what RAG indexes)** | **F: 12,570 files, 0.7 GB; C: user roots 12,222 files, 0.6 GB** | they look largely like copies of each other (the same 290 emails and 6 slide decks on both) |

**What this means:**
- **The knowledge layer is small.** About 25,000 text documents (1.3 GB, perhaps half of them
  duplicates) give a few hundred MB of extracted text. That is on the order of 1 GB of vectors and
  a graph of around 100,000 nodes. Indexes take single-digit GB, and the T480's eGPU can embed
  them in hours. Photo understanding (captions or visual search over about 160,000 images) is the
  one heavy option, days of eGPU time; it is K6, optional.
- **Storage need is driven by media and by copies, not by knowledge.** Known unique content today is
  roughly **1.1–1.7 TB**. Not yet measured: the ASUS, the backup drives, the Pi, the overlap between
  C: and F:, and growth per month.
- **Preliminary purchasing shape (to be confirmed by K0):**
  - **Primary store:** F:'s 5 TB already holds about 3× today's known unique content, so it can
    serve as the first primary.
  - **Replica store:** one more drive of at least F:'s used size plus headroom, i.e. about 4–5 TB,
    as the offline mirror (EP-U store roles). That is likely the first purchase.
  - **Always-on:** an SSD for the Pi's ledger, which needs only a small amount of space.
  - **C:** is 89% full. Moving Downloads' 40 GB onto F:, once it is verified there, relieves it.
  - **Any larger setup** (for example a NAS with two mirrored disks as primary, F: as replica, and
    an offline mirror) should wait for K0's measured unique size and growth rate. Buying before
    the backup drives are catalogued risks sizing for duplicates.

## Principles (normative for every EP-K contract)

1. **Index by content, link by location.** A document's text, PageIndex tree and embeddings are made
   once per fingerprint. Every copy (drive, folder, machine) links to that one entry, so
   de-duplication is free and the index never double-counts.
2. **Incremental from the catalogue.** New, changed and removed content comes from catalogue changes
   (S23 rescans, U4 summaries). The indexes never walk a disk themselves.
3. **Privacy first (R31 and training-data privacy).**
   - Files the quarantine rules match (CV and job material among them) never enter a shared index,
     never reach LONGVIEW, and never become training data.
   - Location metadata (EXIF GPS) stays on the node that owns the file and is never written to
     the ledger.
   - Benny's answers name files only on the machine that holds them (EP-U invariant 2).
4. **Indexes are derived, so they are rebuildable.** They live on the main node, backed up as
   rebuildable data. They are not ledger: the ledger records only which content was indexed, and
   at which index version.
5. **Answers cite.** Every answer names the file locations it drew on (locally) and the retrieval
   style used, so the owner can check it.

## Phases → task contracts (M12; K0 authored, K1–K6 to be authored)

- [ ] `K0` — **capacity report** (first, because purchasing waits on it):
  - total, unique and duplicated bytes, by kind, drive and machine;
  - copies under the policy and replica-store coverage;
  - growth per month from catalogue history;
  - projected capacity for the primary and each replica store at 1, 2 and 3 years;
  - index sizes from document counts.
  A preliminary T480-only report follows U1, and the full report follows U6 _(agent-ok — report only)_
- [ ] `K1` — **metadata index**:
  - one queryable surface over catalogue names, kinds, dates, EXIF (camera, capture time) and tags;
  - a full-text keyword index (SQLite FTS5) for instant "find", the cheapest vectorless retrieval;
  - photos by date and camera.
  _(agent-ok)_
- [ ] `K2` — **documents in**:
  - owner-scope text documents extracted once per fingerprint (Docling);
  - PageIndex trees for long documents (vectorless RAG);
  - quarantined files never extracted.
  _(human-signed — reads document contents)_
- [ ] `K3` — **vector RAG**: chunks and embeddings into Chroma through Benny's ingest, in an
  "estate" workspace, on the T480 eGPU; incremental by fingerprint _(agent-ok)_
- [ ] `K4` — **graph RAG** in Neo4j:
  - content → drive and folder → machine;
  - document → concept;
  - photo → capture date and camera;
  - links to LONGVIEW's sessions and projects where the same files appear.
  _(agent-ok)_
- [ ] `K5` — **Benny answers across all of it**: the adaptive router chooses metadata, PageIndex,
  vector or graph retrieval; the S22 librarian skill is extended; every answer cites
  _(agent-ok)_
- [ ] `K6` — optional, later: **media understanding**: photo captions and visual search through
  Benny's vision pipeline, sized and scheduled by K0 _(human-signed — days of GPU time)_

## Owner questions (answer at signature)

1. **K0 first**, with a preliminary T480 report straight after U1 and the full report after U6?
   Recommendation: yes. It is what the purchase decision needs.
2. **Private documents.** Recommendation: excluded from every shared index. A private, local-only
   index for Benny on the owning machine can be a later contract if wanted.
3. **Photo understanding (K6).** Recommendation: later, once K0 shows its cost. Metadata (EXIF) and
   the duplicate rules cover photos well first.
4. **Buy the replica-store drive now, or wait for K0?** Recommendation: wait for the preliminary
   K0 (soon after U1). If F:'s safety worries you before then, a second drive of at least 2 TB is
   the minimum to mirror today's used space.

## Exit

All phase gates green and verified by a non-author agent. K0's report (with measured numbers,
including what could not be measured) is in the owner's hands before any purchase. Benny answers a
set of owner-chosen questions across metadata, PageIndex, vector and graph retrieval, each with
citations, and no quarantined file appears in any index.
