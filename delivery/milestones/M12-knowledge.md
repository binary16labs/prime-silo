# M12 — Knowledge over the estate → **v1.27.0**

**Scope (signed by the owner 2026-10-11 as EP-K, design source `delivery/epics/EP-K.md`):** EP-K
K0–K5 (K6 optional, later). Consolidation tells the estate _where_ everything is; this milestone
tells Benny _what_ it is. Every piece of content is indexed **once, by fingerprint**, however many
copies exist, through the retrieval stack Benny already has — metadata and FTS5, PageIndex
(vectorless), Chroma (vector), Neo4j (graph) and the adaptive router that chooses between them.
Nothing in the stack is rebuilt. And before anything is bought, a capacity report says how much
data there really is to manage.

This file is the milestone the signed epic and task K0 already pointed at (`milestone: M12`,
"milestone M12 to be written"); it records that scope, it does not add to it.

**Trigger:** the owner's direction of 2026-10-11 — have the metadata and knowledge-management
solutions with RAG, vectorless RAG and graph RAG, then understand how much data there is to manage
before purchasing a setup for it.

**Order, as signed:** **K0 first**, because purchasing waits on it — a preliminary T480-only report
straight after U1, the full estate-wide report after U6. Then K1 metadata and keyword index, K2
documents in (human-signed: reads document contents), K3 vector RAG on the eGPU, K4 graph RAG, K5
Benny answering across all of it with citations. K6 (photo captions and visual search) is optional
and waits for K0 to price it.

**Dependencies out:** EP-U U1 (the owner's data catalogued) and U6 (estate-wide copies) for K0's
two reports; EP-S S21–S24 (the librarian and its catalogues) for every index; Benny's existing
`rag_routes`, `pageindex`, `graph_db` and `adaptive_rag`.

**Human-signed stops:** K2 (reads document contents), K6 (days of GPU time, optional).

**Measured at signature (T480, 2026-10-11):** F: 1.56 TB used of 5.0 TB, unique between 1.03 and
1.55 TB, ~90% media; C: 453 GB of 511 GB (89% full); the text corpus RAG actually indexes is tiny —
F: 12,570 files / 0.7 GB and C: user roots 12,222 files / 0.6 GB, largely copies of each other. So
the knowledge layer is small (single-digit GB of indexes) and storage need is driven by media and
duplicates, not by knowledge. The replica-store purchase waits for the preliminary K0.

**Exit:** every phase gate green and verified by a non-author agent; K0's report, including what
could not be measured, in the owner's hands before any purchase; Benny answers a set of
owner-chosen questions across metadata, PageIndex, vector and graph retrieval, each with citations,
and no quarantined file appears in any index. VISION-CHECK as EP-K.
