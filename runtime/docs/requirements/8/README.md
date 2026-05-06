# KG3D-001 — 3D Machine Learning Knowledge Graph Cognitive Mesh

**Status:** Proposed · **Owner:** Benny Studio core · **Target branch:** `master`
**Created:** 2026-04-19 · **Related:** [7/UI_UX_VISION.md](../7/UI_UX_VISION.md),
[PBR-001](../PBR-001_CONTINUATION_PLAN.md), [2/knowledge_graph_engine_workflow_studio.md](../2/knowledge_graph_engine_workflow_studio.md)

## Why this exists

A downstream agent (possibly a lesser model) must be able to execute this
work end-to-end without re-reading the originating conversation, the
source report, or the session transcript. Every deliverable below is
**declarative, test-driven, and bounded by explicit acceptance criteria**.
No step depends on human judgement beyond the HITL gates explicitly
called out in [implementation_plan.md](implementation_plan.md).

## Source of truth

The canonical problem statement and theoretical framing is the
"Adaptations and Enhancements for 3D Machine Learning Knowledge Graphs
in Code Studio Environments" brief dated 2026-04-19. The full scope is
captured, normalised, and de-ambiguated in [requirement.md](requirement.md);
if the two disagree, **requirement.md wins**.

## Files in this folder

| File | Purpose | Consumer |
|------|---------|----------|
| [README.md](README.md) | Entry point, navigation, glossary. | Humans + agents. |
| [requirement.md](requirement.md) | Functional + non-functional requirements with unique IDs (`KG3D-Fx`, `KG3D-NFRx`) and acceptance criteria. | Test authors, reviewers. |
| [implementation_plan.md](implementation_plan.md) | Nine phases with TDD gates, file-level deliverables, dependencies, rollback. | Implementer agent. |
| [plan_tracker.md](plan_tracker.md) | Flat checkbox tracker. Update after every phase gate passes. | All agents. |
| [acceptance_matrix.md](acceptance_matrix.md) | Requirement-ID → test-ID → evidence-artefact mapping. | CI, release gate. |

## Glossary (authoritative)

| Term | Meaning in this requirement |
|------|-----------------------------|
| **KG3D** | This requirement (3D Knowledge Graph). |
| **Node** | A concept vertex in the ML knowledge graph (e.g. "Adam Optimizer"). |
| **Edge** | A directed prerequisite/dependency relationship between nodes. |
| **Ontology** | Typed schema of concept categories, metrics, and relations defined in `benny/graph/kg3d/ontology.py`. |
| **AoT layer** | Abstraction-of-Thought tier (`A1` highest, `Ak` lowest). Encoded as node attribute `aot_layer ∈ {1..k}`. |
| **Focus+Context** | Render mode that dims non-focus nodes and emphasises a query path. |
| **InstancedMesh** | `THREE.InstancedMesh` buffer-backed rendering path used when `node_count ≥ INSTANCE_THRESHOLD` (default 2500). |
| **WIM** | World-in-Miniature, used only in the WebXR phase. |
| **GCoT** | Grounded Chain-of-Thought — LLM reasoning that must produce a structured placement proposal before a node is ingested. |
| **Lesser agent** | Any LLM weaker than Opus 4.7, including Haiku-class models. All steps must be executable by such an agent. |

## Do-not-do list (applies to every phase)

1. **Do not** introduce any new absolute host paths — the SR-1 ratchet
   (`tests/safety/test_sr1_no_absolute_paths.py`) will fail the build.
2. **Do not** add network dependencies to unit tests; mock
   `httpx.AsyncClient`, `litellm.completion`, and every subprocess call.
3. **Do not** import WebXR, `three`, or `@react-three/*` into Python
   tests; the frontend and backend test suites are strictly separated.
4. **Do not** rebase or amend existing commits on `master`. Always add a
   new commit.
5. **Do not** skip the red→green TDD loop. Tests are authored first,
   **must fail**, then code is written to pass them.
6. **Do not** invent model names. The only approved LLM IDs are those
   already present in `lemonade_models.json` and `benny/core/llm_router.py`.
7. **Do not** claim a phase is "done" until **all** acceptance IDs in
   that phase appear as `PASS` in [acceptance_matrix.md](acceptance_matrix.md).

## Entry checklist (run before starting any phase)

- [ ] Read [requirement.md](requirement.md) in full.
- [ ] Read the current phase section of [implementation_plan.md](implementation_plan.md) in full.
- [ ] Verify the full test suite is green on `master`: `python -m pytest tests`.
- [ ] Verify the frontend builds: `cd frontend && npm run build`.
- [ ] Verify `benny doctor --json` reports no failing checks.

If any of the above fails, **stop and fix before proceeding** — never
start a phase on a red baseline.
