# KG3D-001 — Implementation Plan (six-sigma safe)

**Audience:** an implementer agent, possibly a lesser model. Every
phase is self-contained and gated by a fixed test list. **No phase may
be marked complete until every listed test is green and the
corresponding row in [acceptance_matrix.md](acceptance_matrix.md) is
flipped to `PASS` with an evidence pointer.**

## Ground rules (repeat of README §Do-not-do list — do not deviate)

1. **TDD.** Red → green → refactor. Commit only on green.
2. **Master commits** land in the top-level checkout
   `C:\Users\nsdha\OneDrive\code\benny` via normal merge of this
   worktree branch, not by pushing directly from a worktree.
3. **Python interpreter:** `C:/Users/nsdha/miniconda3/python.exe`.
4. **Offline-safe tests.** Mock every network call.
5. **Stdlib-first.** New deps must be enumerated in the phase's
   "Dependencies" subsection and justified.
6. **One phase per PR.** Do not bundle phases.
7. **Tracker update.** After every phase passes its gate, tick its
   boxes in [plan_tracker.md](plan_tracker.md) and move the acceptance
   rows to `PASS`.

## Phase map

| Phase | Title | Primary artefact | Gate test file |
|-------|-------|------------------|----------------|
| 0 | Foundations & shared schema | `benny/graph/kg3d/schema.py`, `frontend/src/types/kg3d.ts`, fixture | `tests/graph/kg3d/test_schema.py` |
| 1 | Ontology loader + Neo4j migration | `benny/graph/kg3d/ontology.py`, migration | `tests/graph/kg3d/test_ontology.py` |
| 2 | Metrics pipeline + SQLite cache | `benny/graph/kg3d/metrics.py` | `tests/graph/kg3d/test_metrics.py` |
| 3 | REST + SSE transport | `benny/api/kg3d.py` | `tests/api/kg3d/test_endpoints.py` |
| 4 | Baseline 3D render (≤ INSTANCE_THRESHOLD) | `frontend/src/components/Studio/kg3d/SynopticWeb.tsx` | `frontend/tests/kg3d/synoptic-web.spec.ts` |
| 5 | Instanced + worker scalability | `InstancedNodes.tsx`, `kg3d_physics.worker.ts` | `frontend/tests/kg3d/instancing.spec.ts` |
| 6 | AoT + Peircean + Focus+Context + semantic zoom | `CutLayer.tsx`, `focusPath.ts` | `frontend/tests/kg3d/focus-context.spec.ts` |
| 7 | Studio IPC integration | `useKg3dStore.ts`, Monaco bus wiring | `frontend/tests/kg3d/ipc.spec.ts` |
| 8 | LLM ingestion with GCoT + HITL | `benny/graph/kg3d/ingest.py`, `gcot.py` | `tests/graph/kg3d/test_ingest.py` |
| 9 | WebXR + WIM (optional, flagged) | `SynopticWebXR.tsx` | `frontend/tests/kg3d/webxr.spec.ts` (headless mock) |
| 10 | Observability + release gate | `benny doctor` extension, perf panel | `tests/release/test_kg3d_release_gate.py` |

Phases 0–7 are mandatory for the feature to ship behind its flag.
Phases 8–10 may land in later PRs but MUST land before
`ui.kg3d_enabled` defaults to `true`.

---

## Phase 0 — Foundations & shared schema

### 0.1 Deliverables

1. `benny/graph/kg3d/__init__.py` — empty package marker.
2. `benny/graph/kg3d/schema.py` — dataclasses / pydantic models for
   `Node`, `Edge`, `Proposal`, `DeltaEvent` matching
   [requirement.md §4](requirement.md#4-data-contracts-normative).
   Include `validate_node`, `validate_edge`, `aot_layer_for(ratio)`.
3. `scripts/kg3d/emit_ts_types.py` — generates
   `frontend/src/types/kg3d.ts` from `schema.py`. Must be deterministic
   (sorted keys, LF line endings).
4. `tests/fixtures/kg3d/ml_knowledge_graph_v1.json` — canonical
   ontology (2081 nodes / 5149 edges). Produced by a one-shot script
   `scripts/kg3d/fetch_baseline.py` that reads a **vendored copy**
   committed under `vendor/cosmic-cortex/ml-knowledge-graph/` (no live
   download during CI).
5. `frontend/src/types/kg3d.ts` — generated; commit both the generator
   and its output.

### 0.2 Tests (author first, must fail)

- `tests/graph/kg3d/test_schema.py`
  - `test_kg3d_f1_fixture_counts` — fixture has exactly 2081 nodes,
    5149 edges.
  - `test_schema_aot_bins` — `aot_layer_for(0.0..1.0)` returns values
    1..5 with the exact bin thresholds `[0.8, 0.5, 0.25, 0.1]`.
  - `test_schema_reject_nan_metric` — NaN metric rejected.
  - `test_schema_reject_self_loop` — edge with `source_id == target_id`
    rejected.
- `tests/graph/kg3d/test_ts_sync.py`
  - Running the generator twice produces byte-identical output.
  - The committed `kg3d.ts` matches the freshly generated output.
- `tests/safety/test_sr1_no_absolute_paths.py` (existing) still passes.

### 0.3 Gate

`python -m pytest tests/graph/kg3d/test_schema.py tests/graph/kg3d/test_ts_sync.py tests/safety` → all green.

### 0.4 Rollback

Delete the `benny/graph/kg3d/` package and the generated TS file.
No runtime surface is yet exposed.

---

## Phase 1 — Ontology loader + Neo4j migration

### 1.1 Deliverables

1. `benny/graph/kg3d/ontology.py`
   - `load_default_ontology() -> Graph` (reads the fixture).
   - `content_hash(graph) -> str` (SHA-256 over canonical JSON).
2. `benny/graph/kg3d/migrations/001_create_mlconcept.cypher` — idempotent.
3. `benny/graph/kg3d/store.py` — `upsert_graph(driver, graph)` using
   parameterised MERGE, no string interpolation.

### 1.2 Tests

- `tests/graph/kg3d/test_ontology.py::test_kg3d_f1_load_counts`
- `tests/graph/kg3d/test_ontology.py::test_content_hash_stable`
- `tests/graph/kg3d/test_store.py::test_migration_idempotent` — runs
  the migration twice against the in-memory Neo4j test harness
  (`neo4j-fake` already used elsewhere in the repo; if not available,
  fall back to `tests.graph.fakes.FakeDriver` — do NOT pull in a new
  dep).
- `tests/safety/test_kg3d_no_cypher_interp.py` — scans `benny/graph/kg3d`
  for `f"...MATCH"` / `f"...MERGE"` / `% ` string formats inside `.cypher`
  or cypher-emitting functions; fails on any hit.

### 1.3 Gate

Green tests + `benny doctor --json` still reports no regression.

---

## Phase 2 — Metrics pipeline + SQLite cache

### 2.1 Deliverables

1. `benny/graph/kg3d/metrics.py`
   - `compute_all(graph) -> dict[node_id, NodeMetrics]` using stdlib
     only (`networkx` is already a dep — verify in `pyproject.toml`;
     if absent, write plain implementations of pagerank, degree,
     betweenness. Prefer `networkx` if present).
2. `benny/graph/kg3d/cache.py` — SQLite cache at
   `workspace/.benny/kg3d/metrics.sqlite`; invalidated on
   `content_hash` change.

### 2.2 Tests

- `test_kg3d_f2_metrics_contract` — every node has all six metrics and
  they are finite.
- `test_metrics_cache_invalidates_on_hash_change`.
- `test_metrics_deterministic_across_runs` — same seed → same numbers.

---

## Phase 3 — REST + SSE transport

### 3.1 Deliverables

1. `benny/api/kg3d.py` (FastAPI router):
   - `GET /api/kg3d/ontology`
   - `GET /api/kg3d/stream` (SSE)
   - `GET /api/kg3d/proposals` (list pending)
   - `POST /api/kg3d/proposals/{id}/approve`
   - `POST /api/kg3d/proposals/{id}/reject`
2. `benny/api/__init__.py` — register the router.

### 3.2 Tests

- `tests/api/kg3d/test_endpoints.py`
  - Ontology round-trip (schema validation on the wire).
  - SSE emits heartbeat ≤ 10 s.
  - Approve emits an `upsert_*` event with `seq` monotonic.
  - Offline mode: `BENNY_OFFLINE=1` blocks proposal endpoints with
    `OfflineRefusal`.

---

## Phase 4 — Baseline 3D render (≤ threshold)

### 4.1 Deliverables

1. `npm install 3d-force-graph three @react-three/fiber @react-three/drei`
   — already in `package.json`; verify, do not duplicate.
2. `frontend/src/components/Studio/kg3d/SynopticWeb.tsx`
3. `frontend/src/components/Studio/kg3d/palette.ts` — sixteen-colour
   map (declarative object, no dynamic generation).
4. Hook into `AppV2.tsx` behind `ui.kg3d_enabled`.

### 4.2 Tests

- `frontend/tests/kg3d/synoptic-web.spec.ts` (Vitest + @testing-library):
  - Mounts with < 300 nodes fixture; asserts `<canvas>` present.
  - Node colour for a known node matches palette entry.
  - AoT Y-axis ordering — node of layer 1 has greater Y than layer 5.
- `frontend/tests/kg3d/unmount.spec.ts` — unmount clears WebGL context
  (check for `webglcontextlost` event handler call and `renderer.dispose`).

---

## Phase 5 — Instanced + worker scalability

### 5.1 Deliverables

1. `frontend/src/components/Studio/kg3d/InstancedNodes.tsx`
2. `frontend/src/workers/kg3d_physics.worker.ts` — message protocol:
   - `init({ nodes, edges, config })`
   - `tick()` → posts `Float32Array` of positions (transferable).
3. LOD switch to `THREE.Points` sprites for distant/low-degree nodes.

### 5.2 Tests

- `frontend/tests/kg3d/instancing.spec.ts`
  - With 10 000-node fixture, `renderer.info.render.calls ≤ 100`.
  - Worker posts messages at ≤ 30 Hz (jest fake timers).
  - LOD downgrade happens when distance > `LOD_FAR`.

### 5.3 Perf budget check

Run `frontend/scripts/kg3d_bench.ts` and assert median FPS ≥ 60 on
the reference device. Budget stored in
`frontend/tests/kg3d/perf_budget.json`.

---

## Phase 6 — AoT + Peircean + Focus+Context + semantic zoom

### 6.1 Deliverables

1. `frontend/src/components/Studio/kg3d/CutLayer.tsx` — translucent
   volumetric boundary per AoT tier.
2. `frontend/src/components/Studio/kg3d/focusPath.ts` — transitive
   prerequisite closure computed on the main thread (bounded by
   depth cap `MAX_FOCUS_DEPTH = 8`).
3. `benny/graph/kg3d/constraints.py` — server-side DAG/abstraction
   checker that runs on every ingest.
4. Semantic-zoom prototype node collapse/expand
   (`PrototypeCluster.tsx`).

### 6.2 Tests

- `test_kg3d_f14_abstraction_constraint` — layout with an offending
  edge fails validation.
- `focus-context.spec.ts` — selecting a node dims non-path nodes to
  `α = 0.08`.
- `semantic-zoom.spec.ts` — crossing threshold collapses ≥ 25 siblings
  into a prototype; zooming past reverses.

---

## Phase 7 — Studio IPC integration

### 7.1 Deliverables

1. `frontend/src/hooks/useKg3dStore.ts`.
2. Subscription in `SynopticWeb.tsx` to the existing Monaco symbol bus.
3. Camera easing (`ease-in-out cubic`, 600 ms) in `cameraController.ts`.

### 7.2 Tests

- `ipc.spec.ts`
  - `symbol_detected: "Adam Optimizer"` triggers `setFocus`.
  - Unknown symbol is a no-op (no toast, no throw).
  - Rapid repeat events debounce to one camera transition per 600 ms.

---

## Phase 8 — LLM ingestion with GCoT + HITL

### 8.1 Deliverables

1. `benny/graph/kg3d/ingest.py` — `propose_from_document(doc) -> Proposal`
   routed via `benny.core.llm_router`.
2. `benny/graph/kg3d/gcot.py` — validator:
   - structural (DAG, unique names, category enum),
   - metric schema,
   - abstraction constraint (Phase 6).
3. HITL panel: `frontend/src/components/Studio/kg3d/ProposalPanel.tsx`.
4. `POST /approve` and `/reject` endpoints (already stubbed in Phase 3;
   wire the real commit path here).

### 8.2 Tests

- `test_propose_offline_refusal` — `BENNY_OFFLINE=1` → `OfflineRefusal`.
- `test_gcot_rejects_dag_violation`.
- `test_gcot_rejects_unknown_category`.
- `test_no_cypher_interpolation` — parameterised MERGE only.
- `test_hitl_required_before_commit` — auto-approve flag ignored.
- `proposal-panel.spec.ts` — UI approve triggers the correct POST.

---

## Phase 9 — WebXR + WIM (optional, flagged)

### 9.1 Deliverables

1. `SynopticWebXR.tsx` — gated by `ui.kg3d.webxr_enabled`.
2. WIM component at `player.chest + (0, -0.35 m, -0.45 m)`.
3. Controller raycast grab/drag/release (visual-only).

### 9.2 Tests

- Headless-XR mock (@webxr-input-profiles/motion-controllers for
  inputs; no real device required).
- `webxr.spec.ts` — session starts and exits cleanly; absence of
  WebXR silently skips (no UI error).

---

## Phase 10 — Observability + release gate

### 10.1 Deliverables

1. `benny doctor` extension — `kg3d` section per KG3D-OBS1.
2. Frontend perf telemetry — `perf.kg3d.fps`, `perf.kg3d.draw_calls`.
3. `docs/requirements/release_gates.yaml` — append KG3D gates.
4. `tests/release/test_kg3d_release_gate.py`:
   - coverage floor,
   - SR-1 unchanged,
   - bundle-size delta within KG3D-NFR9,
   - `kg3d.ingest.auto_approve` still `false`.

### 10.2 Gate

`python -m pytest tests/release/test_kg3d_release_gate.py`
`cd frontend && npm run build && npm run test:coverage`

---

## Cross-cutting guardrails

- **Every** commit message: `phase(<N>): <short title>` and references
  this requirement ID (`KG3D-001`).
- **No phase** adds a net-new top-level dependency without updating
  `pyproject.toml` / `package.json` **and** the corresponding lock file
  in the same commit.
- **No phase** touches V1 shells (`App.tsx` legacy paths) — changes are
  restricted to V2 surfaces and the new `Studio/kg3d/**` tree.
- **Proposal data** never bypasses `gcot.validate`. An implementer who
  finds a shortcut must stop and raise a HITL request.
