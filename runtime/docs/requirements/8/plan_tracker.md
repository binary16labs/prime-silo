# KG3D-001 — Plan Tracker

**Update rule:** Flip a box from `[ ]` to `[x]` only after the phase
gate in [implementation_plan.md](implementation_plan.md) is green AND
every acceptance row for that phase in
[acceptance_matrix.md](acceptance_matrix.md) is `PASS` with evidence
recorded. Record the commit SHA in the "Evidence" column.

## Phase 0 — Foundations & shared schema

- [ ] `benny/graph/kg3d/__init__.py` created
- [ ] `benny/graph/kg3d/schema.py` implemented
- [ ] `scripts/kg3d/emit_ts_types.py` implemented (deterministic)
- [ ] `frontend/src/types/kg3d.ts` generated and committed
- [ ] `vendor/cosmic-cortex/ml-knowledge-graph/` vendored
- [ ] `tests/fixtures/kg3d/ml_knowledge_graph_v1.json` 2081/5149 verified
- [ ] Tests green: `tests/graph/kg3d/test_schema.py`, `test_ts_sync.py`
- [ ] Evidence SHA: `________`

## Phase 1 — Ontology loader + Neo4j migration

- [ ] `ontology.py::load_default_ontology()` returns baseline graph
- [ ] `migrations/001_create_mlconcept.cypher` is idempotent
- [ ] `store.py::upsert_graph` uses parameterised MERGE
- [ ] Tests green: `test_ontology.py`, `test_store.py`, `test_kg3d_no_cypher_interp.py`
- [ ] Evidence SHA: `________`

## Phase 2 — Metrics pipeline + SQLite cache

- [ ] `metrics.py::compute_all` returns all six metrics
- [ ] `cache.py` invalidates on `content_hash` change
- [ ] Tests green: metrics contract, cache invalidation, determinism
- [ ] Evidence SHA: `________`

## Phase 3 — REST + SSE transport

- [ ] `GET /api/kg3d/ontology` schema-compliant
- [ ] `GET /api/kg3d/stream` heartbeats ≤ 10 s
- [ ] Proposal approve/reject endpoints wired
- [ ] `BENNY_OFFLINE=1` raises `OfflineRefusal` on proposal endpoints
- [ ] Tests green: `tests/api/kg3d/test_endpoints.py`
- [ ] Evidence SHA: `________`

## Phase 4 — Baseline 3D render

- [ ] `SynopticWeb.tsx` mounted behind `ui.kg3d_enabled`
- [ ] `palette.ts` declarative, 16 entries
- [ ] AoT Y-axis ordering visually verified
- [ ] Unmount cleanly disposes WebGL context
- [ ] Tests green: `synoptic-web.spec.ts`, `unmount.spec.ts`
- [ ] Evidence SHA: `________`

## Phase 5 — Instanced + worker scalability

- [ ] `InstancedNodes.tsx` used above `INSTANCE_THRESHOLD`
- [ ] `kg3d_physics.worker.ts` at ≤ 30 Hz
- [ ] LOD sprites for far / low-degree nodes
- [ ] Perf budget: 10 000 nodes → draw calls ≤ 100, median FPS ≥ 60
- [ ] Tests green: `instancing.spec.ts`, `perf_budget.json`
- [ ] Evidence SHA: `________`

## Phase 6 — AoT + Peircean + Focus+Context + semantic zoom

- [ ] `CutLayer.tsx` renders five translucent tiers
- [ ] `focusPath.ts` dims non-path nodes to α = 0.08
- [ ] `constraints.py` rejects abstraction violations
- [ ] Semantic zoom collapses ≥ 25 siblings into prototype
- [ ] Tests green: constraint, focus-context, semantic-zoom
- [ ] Evidence SHA: `________`

## Phase 7 — Studio IPC integration

- [ ] `useKg3dStore.ts` slice in place
- [ ] Monaco `symbol_detected` wired to `setFocus`
- [ ] Unknown symbol is a silent no-op
- [ ] Camera eases 600 ms ± 20 ms
- [ ] Tests green: `ipc.spec.ts`
- [ ] Evidence SHA: `________`

## Phase 8 — LLM ingestion with GCoT + HITL

- [ ] `ingest.py` routes through `benny.core.llm_router`
- [ ] `gcot.py` rejects DAG / category / schema violations
- [ ] `ProposalPanel.tsx` shows pending proposals
- [ ] HITL required before commit (auto-approve ignored)
- [ ] No Cypher string interpolation (lint green)
- [ ] Tests green: ingest suite, `proposal-panel.spec.ts`
- [ ] Evidence SHA: `________`

## Phase 9 — WebXR + WIM (optional, flagged)

- [ ] `SynopticWebXR.tsx` behind `ui.kg3d.webxr_enabled`
- [ ] WIM anchored at chest-relative offset
- [ ] Grab/drag/release is visual-only (no data mutation)
- [ ] Absence of WebXR is silent feature skip
- [ ] Tests green: `webxr.spec.ts` (headless mock)
- [ ] Evidence SHA: `________`

## Phase 10 — Observability + release gate

- [ ] `benny doctor --json` includes `kg3d` section
- [ ] Frontend emits `perf.kg3d.fps` / `perf.kg3d.draw_calls`
- [ ] `release_gates.yaml` updated with KG3D gates
- [ ] `test_kg3d_release_gate.py` green
- [ ] Coverage: backend ≥ 92 %, frontend ≥ 85 %
- [ ] Bundle-size delta ≤ 450 KB gzipped
- [ ] Evidence SHA: `________`

## Final cutover (do not tick until every phase above is fully green)

- [ ] Flip `ui.kg3d_enabled` default to `true` in `constants.ts`
- [ ] Release notes entry added
- [ ] Requirement archived: move this folder under
      `docs/requirements/archive/` and link from
      [docs/requirements/README.md](../README.md)
- [ ] Final SHA: `________`
