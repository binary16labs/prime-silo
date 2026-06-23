# PIX-001 — How to run it (the testable distribution)

Three ways to exercise the PageIndex vectorless spine, from "no services" to
"full graph + triples". All operate on a workspace's `data_in/` documents.

Set the home first (points at your portable `$BENNY_HOME`):

```bash
export BENNY_HOME=/path/to/.benny_home      # PowerShell: $env:BENNY_HOME="...\.benny_home"
```

---

## 1. Offline, no services — prove the spine (fast)

Builds the indexed-abstract tree per document and persists it. No embedding
server, no Neo4j, no LLM. Triples auto-skip when `BENNY_OFFLINE=1`.

```bash
cd runtime
BENNY_OFFLINE=1 python scripts/pageindex_demo.py --workspace prime_silo_self --outline
```

Expected (verified 2026-06-23 on the shipped `prime_silo_self` docs):

```
[GUIDE.md        ] sections=119  triples=0  graph=skipped(no neo4j)  json=GUIDE.md.json
[README.md       ] sections=14   triples=0  graph=skipped(no neo4j)  json=README.md.json
[ROADMAP.md      ] sections=5    triples=0  graph=skipped(no neo4j)  json=ROADMAP.md.json
[USER_GUIDE.md   ] sections=19   triples=0  graph=skipped(no neo4j)  json=USER_GUIDE.md.json
TOTAL  documents=4  sections=157  triples=0
```

Trees land in `$BENNY_HOME/workspaces/prime_silo_self/.benny/pageindex/*.json`.
Inspect one outline directly: `python scripts/pageindex_demo.py --outline` or
`GET /api/rag/pageindex/outline?source=USER_GUIDE.md&workspace=prime_silo_self`.

## 2. Full pipeline — graph + triples (needs services up)

With Neo4j and a local model running (`benny up`), the same run writes the
`Section` graph and fans triple extraction over every leaf:

```bash
cd runtime
python scripts/pageindex_demo.py --workspace prime_silo_self
# or via the CLI:
python benny_cli.py pageindex ingest --workspace prime_silo_self
# or via the API:
curl -X POST localhost:8000/api/rag/pageindex/ingest \
  -H "X-Benny-API-Key: benny-mesh-2026-auth" -H "Content-Type: application/json" \
  -d '{"workspace":"prime_silo_self"}'
```

This populates the knowledge graph that the shipped distribution currently
leaves **empty** — triples anchored to `Section` node_ids + page citations.

## 3. Retrieval — the `structured` route

Once trees exist, ask the Adaptive RAG router a document-navigation question; it
classifies to `structured`, does ONE node-select call over the abstract, loads
the chosen leaves, and answers (two LLM round-trips total):

```bash
curl -X POST localhost:8000/api/rag/chat \
  -H "X-Benny-API-Key: benny-mesh-2026-auth" -H "Content-Type: application/json" \
  -d '{"query":"What does the user guide say about the home directory?",
       "workspace":"prime_silo_self","mode":"adaptive"}'
```

---

## Run the tests

```bash
cd runtime
python -m pytest tests/test_pageindex_spine.py tests/test_pageindex_builder.py -v
# expected: 17 passed
```

## Build the desktop distribution

The desktop EXE bundles these modules automatically (they live under
`runtime/benny/core/`). To cut an installer, use the release flow in
[../../../DEVOPS.md](../../../DEVOPS.md) / the `devops-pipeline` skill — that is a
~30-minute multi-platform CI build and is a separate, explicit step.
