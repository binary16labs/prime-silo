# Benny Documentation

**Deterministic Graph Workflow Platform with Multi-Model AI Orchestration**

---

## Start Here

New to Benny? Read in this order:

1. **[Operating Manual](operations/BENNY_OPERATING_MANUAL.md)** — install, start, stop, plan, run, diagnose
2. **[SAD](../architecture/SAD.md)** — system architecture, C4 diagrams, dual-graph design, swarm lifecycle
3. **[Log & Lineage Guide](operations/LOG_AND_LINEAGE_GUIDE.md)** — how to observe, trace, and debug everything

---

## Operations

| Document | Description |
|----------|-------------|
| [BENNY_OPERATING_MANUAL.md](operations/BENNY_OPERATING_MANUAL.md) | **Primary run book** — init, up, down, plan, run, doctor, migrate, uninstall, release gates, troubleshooting |
| [PORTABLE_INSTALL_MANUAL.md](operations/PORTABLE_INSTALL_MANUAL.md) | **Portable / external-drive install** — one-command bootstrap onto an external SSD, env var reference, drive relocation, multi-machine use |
| [PYPES_TRANSFORMATION_GUIDE.md](operations/PYPES_TRANSFORMATION_GUIDE.md) | `benny pypes` — declarative, DAG-based transformation engine with CLP lineage, checkpoints, drill-down, and financial-risk reports |
| [AGENTAMP_GUIDE.md](operations/AGENTAMP_GUIDE.md) | `benny agentamp` — skinnable cockpit: scaffold, pack, sign, and install `.aamp` skin packs; HMAC signing; release gates |
| [KNOWLEDGE_ENRICHMENT_WORKFLOW.md](operations/KNOWLEDGE_ENRICHMENT_WORKFLOW.md) | `benny enrich` pipeline — extract docs → synthesise triples → correlate to code → enable Studio ENRICH toggle |
| [LOG_AND_LINEAGE_GUIDE.md](operations/LOG_AND_LINEAGE_GUIDE.md) | All log files, SSE events, Marquez lineage, Phoenix tracing, AER audit records, end-to-end process trace |
| [manifest_operating_manual.md](operations/manifest_operating_manual.md) | Manifest execution and planning detail |
| [local_llm_setup.md](operations/local_llm_setup.md) | Configuring Lemonade, Ollama, LMStudio, LiteRT |
| [marquez_setup.md](operations/marquez_setup.md) | OpenLineage / Marquez setup and configuration |

---

## Architecture

| Document | Description |
|----------|-------------|
| [SAD.md](../architecture/SAD.md) | Software Architecture Document — C4 diagrams, dual-graph architecture, enrichment toggle design, swarm-based SAD generation |
| [WORKSPACE_GUIDE.md](../architecture/WORKSPACE_GUIDE.md) | Workspace structure, c4_test and c5_test guide, graph surfaces |
| [GRAPH_SCHEMA.md](../architecture/GRAPH_SCHEMA.md) | Neo4j node/edge schema — CodeEntity, Concept, Document, CORRELATES_WITH, REL |
| [PAIN_POINTS_AND_VISION.md](../architecture/PAIN_POINTS_AND_VISION.md) | Strategic direction and known friction points |
| [concepts/SWARM_VS_STUDIO.md](../architecture/concepts/SWARM_VS_STUDIO.md) | Design comparison: swarm vs studio execution models |
| [guides/AUDIT_TRACING.md](../architecture/guides/AUDIT_TRACING.md) | Governance audit protocol |
| [guides/DEBUG_WORKFLOWS.md](../architecture/guides/DEBUG_WORKFLOWS.md) | Workflow debugging techniques |

---

## Requirements & Phase History

| Document | Description |
|----------|-------------|
| [PBR-001_CONTINUATION_PLAN.md](requirements/PBR-001_CONTINUATION_PLAN.md) | Phase roadmap and history (Phases 0–8) |
| [PORTABLE_BENNY_REQUIREMENTS.md](requirements/PORTABLE_BENNY_REQUIREMENTS.md) | Full Phase 0–8 technical specification |
| [requirements/10/](requirements/10/README.md) | **AOS-001 — Agentic OS for the SDLC** ✅ SHIPPED `357b3d1`. Manifest 1.1, PBR artefact store, progressive disclosure, Mermaid/PlantUML diagrams, durable resume, VRAM-aware worker pool, BDD pipeline (`benny req`), TOGAF phase mapping + ADR emission, JSON-LD PROV-O lineage, policy-as-code + HMAC ledger (SOX 404), multi-model sandbox runner. 62/62 acceptance rows PASS. See [CHANGELOG.md](../CHANGELOG.md) for the full release notes. |
| [requirements/11/](requirements/11/README.md) | **AAMP-001 — AgentAmp: Skinnable, Pluggable Agentic Cockpit** 🚧 IN PROGRESS. Winamp-inspired skin packs (`.aamp`), AgentVis WebGL plugins, DSP-A spectrum, Equalizer panel, Textual TUI, `skin_designer` LLM skill, marketplace. **Phases 1–6 SHIPPED `a0f822e`** (skin packs + signing + scaffold CLI; AgentVis sandbox; DSP-A pipeline; TUI mini-mode; Equalizer manifest write; Playlist + enqueue + Layout DSL + user-state portability). 9 phases total; requirements in [requirement.md](requirements/11/requirement.md), acceptance rows in [acceptance_matrix.md](requirements/11/acceptance_matrix.md). |

---

## Quick Reference

```bash
# Daily workflow
benny up --home $BENNY_HOME                          # start all services
benny status --home $BENNY_HOME                      # check health
benny plan "Summarise PDFs in data_in/" --workspace c4_test --save
benny run manifests/latest.manifest.json --json
benny runs ls --limit 10
benny down --home $BENNY_HOME

# Pypes — declarative transformation engine (bronze → silver → gold + CLP)
benny pypes inspect manifests/templates/financial_risk_pipeline.json
benny pypes run     manifests/templates/financial_risk_pipeline.json --workspace pypes_demo
benny pypes drilldown <run_id> gold_exposure --workspace pypes_demo
benny pypes rerun    <run_id> --from silver_trades --workspace pypes_demo

# Knowledge enrichment (Studio ENRICH toggle)
benny enrich --workspace c5_test --src src/dangpy --out plans/enrich.json  # build manifest (inline mode)
benny enrich --workspace c5_test --src src/dangpy --run                    # build + run (inline mode)
benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json \
             --workspace c5_test --src src/dangpy --run                    # declarative mode (preferred)
benny enrich --manifest manifests/templates/knowledge_enrichment_pipeline.json \
             --workspace c5_test --src src/dangpy \
             --resume <prior_run_id> --run                                  # resume a partial run
benny enrich --help                                                         # full options

# AgentAmp — skinnable cockpit (Phases 1–6 shipped)
benny agentamp scaffold-skin my-skin                              # create draft skin (Phase 1)
benny agentamp pack   $BENNY_HOME/agentamp/drafts/my-skin --out my-skin.aamp
benny agentamp sign   my-skin.aamp                               # HMAC-SHA256 (uses BENNY_HMAC_KEY)
benny agentamp install my-skin.aamp --workspace default
benny agentamp enqueue manifest.json --workspace W               # enqueue manifest via API (Phase 6)
benny agentamp export-cockpit cockpit.aamp.cockpit               # export user state + EQ (Phase 6)
benny agentamp import-cockpit cockpit.aamp.cockpit               # restore user state + EQ (Phase 6)

# AOS-001 — SDLC pipeline (manifest 1.1)
benny req "Add payment retry logic" --workspace my_ws --save   # PRD + BDD scenarios
benny bdd compile --workspace my_ws                            # compile scenarios → pytest
benny run manifests/sdlc_pipeline.json --json                  # run SDLC manifest
benny doctor --json | jq '.aos'                                # AOS health section

# Observe a run in real time
curl -N -H "Accept: text/event-stream" \
     -H "X-Benny-API-Key: benny-mesh-2026-auth" \
     http://127.0.0.1:8005/api/workflows/execute/<manifest_id>

# Logs
tail -f $BENNY_HOME/logs/api.log
grep '"ok": false' $BENNY_HOME/logs/llm_calls.jsonl | jq .

# Lineage & tracing (requires docker compose up -d marquez-db marquez-api marquez-web phoenix)
open http://localhost:3010    # Marquez lineage UI
open http://localhost:6006    # Phoenix tracing UI
```
