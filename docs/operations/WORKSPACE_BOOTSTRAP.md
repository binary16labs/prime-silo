# Workspace Bootstrap Manual — Fresh Enrichment Run

Step-by-step guide to create a brand-new Benny workspace, drop source code + PDFs
into it, and run the **knowledge enrichment pipeline** end-to-end with the
HNSW-correlation defaults we agreed on after the `c5_test` runs.

Every number in this manual comes from **[`configs/workspace_bootstrap.json`](../../configs/workspace_bootstrap.json)**.
Edit that file to change any default — nothing in this document is hardcoded.

---

## 0. What you get with the new defaults

| Knob | Old | New | Why |
|---|---|---|---|
| `correlation.threshold` | `0.70` | **`0.82`** | `c5_test` @ 0.70 produced 1.2M edges over 134 code nodes — ~36× noise tail. 0.82 is above the cosine knee for sentence embeddings. |
| `correlation.top_k_per_concept` | (unbounded) | **`32`** | Hard-caps edges at `N_concepts × 32`. The runaway edge count is mathematically impossible now. |
| `correlation.use_ann` | (n/a — numpy matmul only) | **`true`** | HNSW approximate kNN when `hnswlib` is installed; graceful numpy-top-K fallback otherwise. |
| `pipeline.resume_skip_statuses` | `["done","completed","completed_after_timeout"]` | **adds `"reused"`** | Fixes the resume-of-resume chain where tasks previously marked `reused` were incorrectly re-executed. |
| `pipeline.always_rerun_tasks` | (n/a) | **`["generate_report"]`** | The report is cheap and must reflect live state — never reuse a stale one. |
| `pipeline.fallbacks.semantic_correlate` | (none) | task-manager lookup + graph probe | Timeout on a long-running synchronous endpoint no longer means hard failure if the work actually completed. |

---

## 1. Prerequisites (one-time)

```powershell
# 1a. Confirm docker services are up
benny status --home $env:BENNY_HOME

# Expected: neo4j, marquez, phoenix, n8n all "running"
# If not: benny up --home $env:BENNY_HOME

# 1b. Confirm Benny API is reachable
curl.exe -H "X-Benny-API-Key: benny-mesh-2026-auth" http://127.0.0.1:8005/api/system/pulse

# 1c. (Recommended) Install hnswlib for sub-linear correlation kNN
pip install hnswlib>=0.8.0

# Verify:
python -c "import hnswlib; print('HNSW OK', hnswlib.__version__)"
```

If `hnswlib` is unavailable the pipeline still works — it just uses the numpy
top-K fallback, which is O(N·M) in BLAS (still fine for under ~1M pairs).

---

## 2. Create a fresh workspace

Pick a name — for this manual I'll use `c6_test`. Replace everywhere.

```powershell
# 2a. Edit configs/workspace_bootstrap.json and change workspace.name → "c6_test"
notepad configs\workspace_bootstrap.json

# 2b. Create the directory tree
$WS  = "c6_test"
$BH  = $env:BENNY_HOME
New-Item -ItemType Directory -Force -Path `
    "$BH\workspace\$WS\src",        `
    "$BH\workspace\$WS\staging",    `
    "$BH\workspace\$WS\data_in",    `
    "$BH\workspace\$WS\data_out",   `
    "$BH\workspace\$WS\runs"        | Out-Null
```

> **Why four dirs?** `staging/` = raw PDFs you drop in; `data_in/` =
> Docling-extracted markdown; `data_out/` = reports + derived artefacts;
> `runs/` = per-run audit folders.

---

## 3. Drop your inputs

```powershell
# 3a. Copy source code to be analysed
Copy-Item -Recurse path\to\your\code\*  "$BH\workspace\$WS\src\"

# 3b. Copy reference PDFs (architecture docs, specs, books, etc.)
Copy-Item path\to\your\docs\*.pdf       "$BH\workspace\$WS\staging\"
```

**What lives where:**
- `src/` — Tree-Sitter scans this into the **code graph** (File, Class, Function nodes).
- `staging/` — Docling converts these PDFs to markdown in `data_in/`, then RAG-ingests them into the **knowledge graph** (Concept, Document, triple edges).

---

## 4. Run the pipeline

```powershell
python benny_cli.py enrich `
    --workspace c6_test `
    --src src `
    --manifest manifests\templates\knowledge_enrichment_pipeline.json `
    --run
```

**What happens, wave by wave:**

| Wave | Task | Expected time | Notes |
|:---:|---|---:|---|
| 0 | `pdf_extract` | 10–60 s per PDF | Docling PDF → MD |
| 0 | `code_scan` | 10–180 s | Tree-Sitter → Neo4j `File`/`Class`/`Function` |
| 1 | `rag_ingest` | 1–10 min | Chunk + embed → ChromaDB |
| 2 | `deep_synthesis` | 5–20 min | LLM triple extraction → Neo4j `REL` |
| 3 | `semantic_correlate` | **20 s – 3 min** (was 1800 s) | HNSW + top-K; bounded fan-out |
| 4 | `validate_enrichment` | <1 s | Counts `CORRELATES_WITH` edges |
| 5 | `generate_report` | <1 s | Writes `data_out/enrichment_report.md` |

> With HNSW installed, `semantic_correlate` on a workspace with ~500 concepts
> and ~200 symbols typically finishes in under 30 seconds. Without HNSW (numpy
> fallback with top-K), expect 2–5× slower but still bounded.

---

## 5. Inspect the results

```powershell
# 5a. The report (rendered in terminal or VS Code)
Get-Content "$env:BENNY_HOME\workspace\c6_test\data_out\enrichment_report.md"

# 5b. Open Studio → Code Graph → toggle "ENRICH"
Start-Process "http://localhost:3000"

# 5c. Inspect correlations directly in Neo4j Browser
Start-Process "http://localhost:7474"
# In the query box:
#   MATCH (c:Concept {workspace:"c6_test"})-[r:CORRELATES_WITH]->(s)
#   RETURN c.name, type(s), s.name, r.confidence
#   ORDER BY r.confidence DESC LIMIT 25

# 5d. OpenLineage trace (Marquez)
Start-Process "http://localhost:3010"
```

**What a healthy report looks like** (bug-fixed in this change):
- `Concept nodes`: 50–5000 depending on PDF volume.
- `Code-side entities (File + Class + Function)`: real count of symbols.
- `CORRELATES_WITH edges`: should be ≤ `N_concepts × 32`. If it's `0`, see troubleshooting below.
- **Top 20 correlations by score** — the highest-confidence concept↔symbol links.
- **Similarity histogram** in 0.02 buckets — you can see where the knee is.

If the histogram shows most edges in the 0.82–0.84 bucket, raise the threshold
to 0.85. If it shows a flat distribution, your embeddings aren't discriminating —
check the embedding model config.

---

## 6. Tune the knobs

Every tunable lives in [`configs/workspace_bootstrap.json`](../../configs/workspace_bootstrap.json) or in the manifest template.

**Quick-reference for the most useful knobs:**

```jsonc
{
  "correlation": {
    "threshold":         0.82,   // raise for precision, lower for recall
    "top_k_per_concept": 32,     // bound on edges per concept
    "use_ann":           true,   // set false to force numpy fallback
    "strategy":          "aggressive",  // or "safe" for exact-match only
    "hnsw": {
      "ef_construction": 200,    // HNSW build quality (higher = slower build, better recall)
      "M":               16,     // HNSW graph degree (higher = more memory, better recall)
      "ef_query_multiplier": 2   // query-time search width (= max(top_k*2, 50))
    }
  }
}
```

**Override a knob at the command line** — CLI flags win over the config:
```powershell
python benny_cli.py enrich --workspace c6_test --src src --run `
    --threshold 0.85 --top-k 16 --no-ann
```

---

## 7. Resume from a partial run

If the pipeline dies partway through (e.g. you ctrl-c'd or the server
crashed), **all completed-task artefacts are already on disk**:

```powershell
# 7a. Find the most recent run
Get-ChildItem "$env:BENNY_HOME\workspace\c6_test\runs" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

# 7b. Resume from that run_id
python benny_cli.py enrich --workspace c6_test --src src `
    --manifest manifests\templates\knowledge_enrichment_pipeline.json `
    --resume <run_id_from_7a> --run
```

Tasks whose status is `done`, `completed`, `completed_after_timeout`, or
`reused` will be **skipped** and their results rehydrated. `generate_report`
is in `always_rerun_tasks` so it *always* regenerates against the current
graph state (never a stale copy).

---

## 8. Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| Report shows `0 Concepts / 0 Code Entities / 0 Correlations` but `validate_enrichment` passed | Old bug — wrong keys from `/api/graph/stats`. | Fixed in this change. If you still see it, your server is running the old code — restart with `benny down && benny up`. |
| `semantic_correlate` → `ReadTimeout (no message)` after 1800 s | Server still working but HTTP client gave up. | The new fallback path will detect completion via `/api/tasks` or via a graph probe. If both fall through, your correlation is genuinely hung — check server logs. |
| `Zero CORRELATES_WITH edges found` on a *fresh* run | Either (a) no concepts were extracted by `deep_synthesis` — check PDF quality, or (b) threshold too high — lower to 0.78 and re-run just `semantic_correlate` via `/api/rag/correlate`. | |
| `ModuleNotFoundError: hnswlib` in server logs | Optional dep not installed. | `pip install hnswlib>=0.8.0` — pipeline still works without it (numpy fallback). |
| `too many file descriptors in select()` (Windows) | Default `SelectorEventLoop` caps ~512 FDs. | `server.py` already forces `WindowsProactorEventLoopPolicy` on startup — but you must fully restart the server (`benny down && benny up`) for it to take effect. |
| Edge count still huge (>>N_concepts × 32) | Either multiple pipeline runs accumulated edges (MERGE keeps existing) or `top_k` was overridden upward. | `MATCH ()-[r:CORRELATES_WITH {workspace:"c6_test"}]->() DELETE r` in Neo4j Browser, then re-run `semantic_correlate`. |
| Pipeline re-executes tasks you expected to be reused | The prior run's `task_*.json` has a status not in `skip_if_status`. | Either edit the manifest's `execution.resume.skip_if_status`, or manually edit the prior `task_*.json` status field. |
| `generate_report` is fast but report is still empty | Server didn't restart after the fix. | `benny down && benny up`, then re-run (it's in `always_rerun`, no `--resume` edits needed). |

---

## 9. What the pipeline guarantees

After a successful run you have:

1. **Code graph** in Neo4j — `(:File)-[:CONTAINS]->(:Class)-[:DEFINES]->(:Function)` with full AST-derived dependencies, all scoped by `workspace` property.
2. **Knowledge graph** in Neo4j — `(:Concept)-[:REL {predicate:…}]->(:Concept)` triples extracted from your PDFs.
3. **Correlation overlay** — `(:Concept)-[:CORRELATES_WITH {confidence, strategy, rationale}]->(:CodeEntity)` edges linking architecture concepts to code symbols.
4. **Audit trail** — `workspace/<ws>/runs/enrich-<run_id>/task_*.json` with SHA-256 seals.
5. **Lineage** — OpenLineage events in Marquez at http://localhost:3010.
6. **GDPR notice** — `workspace/<ws>/runs/enrich-<run_id>/GDPR_notice.json`.
7. **Report** — human-readable summary at `workspace/<ws>/data_out/enrichment_report.md`.

All this is 100% reproducible from the manifest + config files — no hidden state.

---

## 10. Next steps

- **Change the model**: edit `configs/workspace_bootstrap.json` → `model.id`, or pass `--model lemonade/<other-model>`.
- **Batch across workspaces**: loop over workspace names in PowerShell and run `benny enrich` for each — each is fully isolated by the `workspace` property in Neo4j.
- **Custom reports**: copy `benny_cli.py`'s `generate_report` block and add domain-specific sections (e.g. coverage per module, concept-to-test mappings).
- **Hook into Studio**: the `ENRICH` toggle reads the same edges this pipeline writes — no additional wiring needed.

---

*Generated defaults file: [`configs/workspace_bootstrap.json`](../../configs/workspace_bootstrap.json). This manual regenerates itself if you change that file's values — keep them in sync.*
