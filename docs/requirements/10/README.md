# AOS-001 — Agentic Operating System for the SDLC

**Phase:** 10 (succeeds Phase 9 / pypes)
**Status:** DRAFT — pending OQ resolutions in [requirement.md §13](requirement.md#13-open-questions-must-be-resolved-before-phase-1-merges)
**Author:** Benny Studio team
**Last updated:** 2026-04-26

---

## Purpose

Phase 10 closes the loop between Benny's three capability surfaces (documents, code, tabular data) and turns Benny into a **deterministic, portable Agentic Operating System for the entire Software Development Life Cycle (SDLC)**. The driving artefact is the architectural brief *"Architecting a Deterministic, Portable Agentic Operating System for the Software Development Life Cycle"* (the **Brief**, attached to this folder as `source_brief.md` once committed).

Where Phase 9 (pypes) made tabular data first-class, Phase 10 makes the **agentic SDLC itself** a first-class citizen of the manifest schema:

- Requirements → PRD → BDD acceptance criteria → manifest → execution → audit, all governed by one signed, replayable artefact.
- TOGAF ADM phases (A–D) become deterministic waves with hard quality gates between them.
- SOX 404 and BCBS 239 lineage become release-gated invariants, not afterthoughts.

This is **integration work**, not a rewrite. Every existing module — `SwarmManifest`, `swarm.py`, `manifest_runner.py`, `models.py`, `governance/`, `pypes/`, `persistence/checkpointer.py` — is extended, never replaced.

---

## Document set

| Document | Role |
|----------|------|
| [README.md](README.md) | This index. Ground rules, vocabulary, do-not-do list. |
| [requirement.md](requirement.md) | **Normative.** Functional, non-functional, security, observability, and compliance requirements. Every claim is uniquely addressable. |
| [acceptance_matrix.md](acceptance_matrix.md) | Traceability matrix: every requirement ID → at least one test → status → evidence (SHA / CI run / file path). |
| [project_plan.md](project_plan.md) | The single tracking artefact: phase-by-phase plan, FMEA-style risk register, plan tracker checkboxes, KPI dashboard. Updated at the end of every session. |
| [open_questions.md](open_questions.md) | Pro/con analysis and recommendation for every OQ-* item before Phase 1 opens. Edit inline as decisions are taken. |
| `source_brief.md` (to be added) | Verbatim copy of the originating architectural brief, frozen for reference. |

---

## Glossary

| Term | Definition |
|------|------------|
| **Agentic OS** | Benny's deterministic execution environment for AI agents. The "OS" boundary is the signed manifest + LangGraph state machine + governance middleware. |
| **SDLC manifest** | A `SwarmManifest` (schema_version ≥ 1.1) whose plan maps onto TOGAF ADM phases A–D and embeds BDD acceptance criteria as quality gates. |
| **Pass-by-reference (PBR)** | Tool outputs above `PBR_THRESHOLD_TOKENS` are stored in the artefact store and replaced in the LLM context with `${artifact://<sha>}`. |
| **Progressive disclosure** | Three-layer context loading (metadata → schema → full) governed by `benny/core/disclosure.py`. |
| **Quality gate** | A deterministic check (linter, type checker, BDD test, schema validator) that **must** return success before a wave advances. |
| **ADR** | Architecture Decision Record — auto-generated per SDLC phase under `data_out/adr/`. |
| **CDE** | Critical Data Element (BCBS 239 vocabulary). |
| **JSON-LD provenance** | An RDF-compatible JSON document recording prompt, model, inputs, outputs, hash chain, and ADR backlinks. |
| **Policy-as-Code** | Pre-execution intent check codified in `benny/governance/policy.py`. |

Vocabulary collisions between this folder and earlier requirement folders are resolved in this document's favour.

---

## Six-Sigma framing (why this folder is heavier than usual)

Phase 10 touches financial-compliance code paths and the agent's ability to mutate the host filesystem. We adopt the same DPMO discipline that earlier phases used informally:

1. **Define** — every requirement has a unique ID and a one-sentence success criterion ([requirement.md](requirement.md)).
2. **Measure** — every requirement has at least one test in [acceptance_matrix.md](acceptance_matrix.md) and a numeric or boolean target.
3. **Analyse** — failure modes are enumerated in the [risk register section of project_plan.md](project_plan.md#5-risk-register-fmea-style).
4. **Improve** — phases are ordered to retire the highest-RPN risks first.
5. **Control** — release gates `G-AOS-*` are appended to `docs/requirements/release_gates.yaml` and enforced by `tests/release/test_aos_release_gate.py`.

A phase is **not done** until every acceptance row for that phase is `PASS` with a non-empty `Evidence` pointer **and** the relevant gate test is green on `master`.

---

## Do-not-do list (binding for any implementer agent or human)

1. **Do not** call `litellm.completion` or any provider SDK directly. Always go through `benny.core.models.call_model()`. This is how `BENNY_OFFLINE=1`, lineage emission, AER capture, and cost telemetry fire.
2. **Do not** introduce new absolute paths to manifests, fixtures, configs, or tests. The SR-1 ratchet (≤ 408 violations) is a hard gate.
3. **Do not** bypass `sign_manifest()` / `verify_signature()`. Every manifest persisted under `$BENNY_HOME/workflows/` carries a HMAC-SHA256 signature.
4. **Do not** silently swallow `OfflineRefusal`. Cloud calls in offline mode must propagate to the user surface.
5. **Do not** widen `GOVERNANCE_WHITELIST`. New endpoints require `X-Benny-API-Key`.
6. **Do not** mutate run audit data from the sandbox layer (planner / agent-report / chat / sandbox runner). The deterministic core remains byte-replay-identical.
7. **Do not** check in `logs/`, `brain/`, or `$BENNY_HOME/`. They are git-ignored for good reason.
8. **Do not** flip `policy.auto_approve_writes` to `true`. It is reserved as a hard release-gate trip-wire (see [acceptance_matrix.md](acceptance_matrix.md) `GATE-AOS-POLICY-1`).
9. **Do not** bundle phases. One phase per PR. The plan tracker only ticks after the gate is green.
10. **Do not** answer an open question (OQ-*) by guessing. Pause and raise a HITL request.

---

## Quick links into the codebase (where new work lands)

| Concern | Module path | Touch type |
|---------|-------------|------------|
| SDLC manifest fields | [benny/core/manifest.py](../../../benny/core/manifest.py) | additive |
| Pass-by-reference store | `benny/core/artifact_store.py` (new) | new |
| Progressive disclosure | `benny/core/disclosure.py` (new) | new |
| Mermaid / PlantUML emit | [benny/graph/wave_scheduler.py](../../../benny/graph/wave_scheduler.py), `benny/graph/diagrams.py` (new) | extend + new |
| Resume harness | [benny_cli.py](../../../benny_cli.py), [benny/persistence/checkpointer.py](../../../benny/persistence/checkpointer.py) | extend |
| Worker pool / backpressure | [benny/graph/swarm.py](../../../benny/graph/swarm.py), `benny/graph/worker_pool.py` (new) | extend + new |
| BDD pipeline | `benny/sdlc/requirements.py` (new), `benny/sdlc/bdd.py` (new) | new |
| TOGAF mapping | `benny/sdlc/togaf.py` (new), template at `manifests/templates/sdlc_pipeline.json` (new) | new |
| Policy-as-Code | [benny/governance/permission_manifest.py](../../../benny/governance/permission_manifest.py), `benny/governance/policy.py` (new) | extend + new |
| JSON-LD lineage | [benny/governance/lineage.py](../../../benny/governance/lineage.py), `benny/governance/jsonld.py` (new) | extend + new |
| Process metrics | `benny/sdlc/sandbox_runner.py` (new), `benny/sdlc/metrics.py` (new) | new |
| Release gates | [tests/release/test_release_gates.py](../../../tests/release/test_release_gates.py), new `tests/release/test_aos_release_gate.py` | extend + new |

---

## Reading order for a new agent

1. This README (vocabulary + do-not list).
2. [requirement.md](requirement.md) §1–§3 (scope, actors, contracts).
3. [project_plan.md](project_plan.md) §3 (phase map) and §5 (risk register).
4. The Brief (`source_brief.md`) for the *why*.
5. [acceptance_matrix.md](acceptance_matrix.md) when picking up an open phase.
