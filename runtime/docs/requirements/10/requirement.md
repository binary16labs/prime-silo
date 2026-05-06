# AOS-001 — Requirement Specification

**Document status:** Normative. Overrides any conflicting prose in the source brief
or in earlier requirement folders. Every requirement below is uniquely addressable
by its ID and is verified by at least one test enumerated in
[acceptance_matrix.md](acceptance_matrix.md). Failures of any **NFR**, **SEC**,
**COMP**, or **GATE** row block release.

---

## 1. Scope

Build, **inside the existing Benny repo**, an Agentic Operating System for the
Software Development Life Cycle that:

1. Extends the existing `SwarmManifest` schema (1.0 → 1.1) so a single signed
   manifest can drive an **end-to-end SDLC**: requirement → PRD → BDD acceptance
   criteria → architecture → implementation → review → release. Every wave is
   gated by a deterministic quality check.
2. Maps the manifest's wave structure onto **TOGAF ADM phases A–D** with
   auto-generated **Architecture Decision Records (ADRs)** per phase boundary.
3. Eliminates context-window saturation through a **content-addressed
   pass-by-reference (PBR) artefact store** and a **three-layer progressive
   disclosure** mechanism for tools, schemas, and documentation.
4. Generates **Mermaid** (and optional PlantUML) diagrams for C4, sequence,
   activity, and entity-relationship views directly from the manifest's plan +
   skill registry.
5. Adds a **`benny run --resume <run_id>`** harness that recovers any signed
   workflow from its last good checkpoint, including across machines on the
   portable drive.
6. Introduces a **VRAM-aware worker pool** with backpressure, per-task time
   budgets, and per-node iteration caps to keep local LLM execution within
   physical hardware limits.
7. Adds a **`benny req`** front door — a Requirements Analyst persona that
   converts a free-text requirement into a PRD plus Gherkin BDD scenarios, then
   compiles those scenarios into deterministic `pytest`-stub acceptance tests.
8. Adds a **Policy-as-Code** governance layer that intercepts every state-
   mutating tool call before execution and records cryptographic intent proofs
   to an immutable Git ledger branch (`benny/checkpoints/v1`).
9. Extends `governance/lineage.py` to emit **JSON-LD provenance** per artefact
   and **column-level lineage** in pypes, satisfying SOX 404 and BCBS 239
   Principles 3, 4, and 6.
10. Adds a **`benny sandbox`** runner that executes a single SDLC manifest
    against multiple LLMs and reports **process-centric metrics** (tool
    selection accuracy, iteration latency, constraint adherence) — distinct
    from outcome benchmarks.
11. Ships behind feature flags (`aos.*`, all default `false`) so the existing
    Phase 0–9 surfaces are never regressed.

**Out of scope for AOS-001:** rewriting the LangGraph swarm executor;
replacing Neo4j; introducing a new front-end; replacing pypes; building a
GUI for the SDLC pipeline (CLI is the primary surface, per the Brief §2.2).

---

## 2. Glossary overrides

The terms in [README.md §Glossary](README.md#glossary) apply. Where the source
Brief uses looser phrasing (e.g. "Agentic OS" sometimes meaning the runtime,
sometimes the entire toolchain), this document's definitions are authoritative.

---

## 3. Actors & surfaces

| Actor | Surface | Interaction |
|-------|---------|-------------|
| Operator (CLI) | `benny_cli.py` (extended) | `benny req`, `benny plan`, `benny run`, `benny run --resume`, `benny sandbox` |
| Studio user | React app (`frontend/src`) | New "SDLC" tab consumes the same SSE event bus; read-only in this phase |
| Planner agent | `benny/graph/manifest_runner.py` | Produces an SDLC manifest from a PRD |
| Architect agent | `benny/sdlc/togaf.py` | Emits Conceptual / Logical / Physical models per Brief §7 |
| Implementer agents (fan-out) | `benny/graph/swarm.py` (extended worker pool) | Execute Wave-3 tasks under quality gates |
| Reviewer agent | New skill `bdd_reviewer` | Runs Gherkin → pytest stubs against built artefacts |
| Policy enforcer | `benny/governance/policy.py` (new) | Intercepts every state-mutating tool call |
| Lineage emitter | `benny/governance/lineage.py` (extended) | Writes OpenLineage events + JSON-LD provenance |
| Sandbox runner | `benny/sdlc/sandbox_runner.py` (new) | Executes the same manifest against multiple LLMs and produces a metrics report |
| Auditor | Read-only consumer | Reads `benny/checkpoints/v1` Git branch + `data_out/lineage/*.jsonld` |

All HTTP API calls require `X-Benny-API-Key: benny-mesh-2026-auth` unless the
path is in `GOVERNANCE_WHITELIST`. The whitelist is **not** widened by AOS-001.

---

## 4. Data contracts (normative)

All schemas live in `benny/core/manifest.py` (extended) and the new module
`benny/sdlc/contracts.py`. Pydantic models are the single source of truth.
A test (`test_aos_schema_ts_sync`) enforces the JSON Schema export at
`schemas/aos/v1_1.schema.json` matches the live Pydantic models byte-for-byte.

### 4.1 Manifest schema extensions (1.0 → 1.1)

`SwarmManifest.schema_version` becomes `"1.1"`. New optional fields are added
**non-destructively** — every 1.0 manifest continues to validate.

```jsonc
{
  "schema_version": "1.1",
  "id": "...",
  "name": "...",
  "requirement": "...",
  "workspace": "...",
  "config": { ... },                    // unchanged
  "plan": {
    "tasks": [ ... ],                   // unchanged
    "edges": [ ... ],                   // unchanged
    "waves": [ ... ],                   // unchanged
    "ascii_dag": "...",                 // unchanged
    "mermaid": "graph TD\n  ..."        // NEW (AOS-F11)
  },
  "inputs":  { ... },                   // unchanged
  "outputs": { ... },                   // unchanged
  "runs":    [ ... ],                   // unchanged

  // ─── new top-level fields ──────────────────────────────────────────────
  "sdlc": {                             // present iff this is an SDLC manifest
    "togaf_phase_map": {                // AOS-F2
      "wave_0": "vision",
      "wave_1": "business",
      "wave_2": "information_systems",
      "wave_3": "technology"
    },
    "bdd_scenarios": [                  // AOS-F20 / AOS-F21
      {
        "id": "BDD-1",
        "feature": "...",
        "given": [ "..." ],
        "when":  [ "..." ],
        "then":  [ "..." ],
        "covers_requirements": [ "PRD-3", "PRD-4" ]
      }
    ],
    "quality_gates": [                  // AOS-F3
      {
        "id": "QG-1",
        "after_wave": 2,
        "checks": [
          { "kind": "linter",      "tool": "ruff",   "args": ["--select","E,F"] },
          { "kind": "typechecker", "tool": "pyright" },
          { "kind": "bdd",         "scenarios": ["BDD-1","BDD-2"] },
          { "kind": "schema",      "path": "schemas/aos/v1_1.schema.json" },
          { "kind": "custom",      "command": "pytest -k aos_smoke -q" }
        ],
        "on_failure": "halt"            // halt | retry | escalate
      }
    ],
    "adrs": [                           // AOS-F4 (auto-populated)
      {
        "id": "ADR-001",
        "phase": "information_systems",
        "title": "...",
        "context": "...",
        "decision": "...",
        "consequences": [ "..." ],
        "captured_at": "2026-04-26T17:00:00Z"
      }
    ]
  },

  "policy": {                           // AOS-F25
    "allowed_tools_per_persona": {
      "implementer": ["fs.write","fs.read","git.commit"],
      "reviewer":    ["fs.read","pytest.run"]
    },
    "deny_network": true,               // AOS-SEC2
    "auto_approve_writes": false        // hard gate (GATE-AOS-POLICY-1)
  },

  "memory": {                           // AOS-F5..F10
    "pbr_threshold_tokens": 1024,
    "disclosure_layer_default": 1,
    "artifact_store": "${BENNY_HOME}/workspaces/${workspace}/artifacts"
  }
}
```

Invariants (enforced by `aos.contracts.validate_manifest_v1_1`):

- `sdlc.togaf_phase_map` keys MUST reference existing waves in `plan.waves`.
- `sdlc.quality_gates[*].after_wave` MUST reference an existing wave index.
- Every `bdd_scenarios[*].covers_requirements` ID MUST appear in
  `inputs.context.prd.requirement_ids`.
- `policy.auto_approve_writes` MUST be `false` (hard gate).
- `memory.pbr_threshold_tokens` MUST be in `[256, 8192]`.

### 4.2 Artefact reference (PBR)

```jsonc
{
  "kind":   "artifact_ref",
  "uri":    "artifact://${sha256}",
  "media_type": "application/json|text/plain|application/parquet|...",
  "byte_size":  12345,
  "token_estimate": 678,
  "created_by_task": "task_2",
  "created_at": "ISO-8601 UTC",
  "summary": "≤ 200 chars human-readable preview"
}
```

Invariants (`benny.core.artifact_store.put`):

- `sha256` is computed over the canonical bytes; collisions are impossible
  within a single run.
- The artefact store path resolves under `${BENNY_HOME}` (SR-1 compliant).
- Artefacts above `aos.pbr.gc_age_days` (default 30) are eligible for
  garbage collection by `benny doctor --gc`.

### 4.3 Disclosure registry

```jsonc
{
  "tool_name": "graph.cypher_query",
  "layer1": { "summary": "Run a parameterised Cypher query." },
  "layer2": { "schema": { ...JSON Schema... } },
  "layer3": { "examples": [ "..." ], "docs_uri": "artifact://${sha256}" }
}
```

The full Layer 1 index for **all** registered tools MUST fit in **≤ 500 tokens**
(`AOS-NFR-PD1`).

### 4.4 JSON-LD provenance envelope

```jsonc
{
  "@context": "https://w3id.org/prov-o#",
  "@type":    "prov:Activity",
  "@id":      "urn:benny:run:${run_id}:task:${task_id}",
  "prov:startedAtTime": "ISO-8601",
  "prov:endedAtTime":   "ISO-8601",
  "prov:wasAssociatedWith": {
    "@id": "urn:benny:agent:${persona}",
    "model": "lemonade/qwen3-coder-30b",
    "model_hash": "sha256:..."
  },
  "prov:used":      [ "artifact://${input_sha}" ],
  "prov:generated": [ "artifact://${output_sha}" ],
  "benny:prompt_hash":   "sha256:...",
  "benny:reasoning_hash":"sha256:...",
  "benny:adr_refs":      [ "ADR-001" ],
  "benny:policy_decision": "approved | denied",
  "benny:cde_refs":      [ "trade.notional", "trade.counterparty_id" ]
}
```

### 4.5 Process-metric record

```jsonc
{
  "run_id":              "...",
  "model":               "...",
  "tool_selection_accuracy": 0.93,   // AOS-F28
  "tool_efficiency":         0.81,   // tools_actually_used / minimum_required
  "context_efficiency":      0.74,   // unique_tokens / total_tokens
  "iteration_latency_ms_p95": 4200,
  "loop_count_p95":           3,
  "constraint_adherence":     1.0,   // 1.0 = no JSON-schema drift
  "captured_at":              "ISO-8601"
}
```

---

## 5. Functional requirements

Each requirement has the form `AOS-F{N}` and is covered by at least one test
of the form `test_aos_f{n}_*` listed in
[acceptance_matrix.md](acceptance_matrix.md).

### 5.1 Manifest extensions (Brief §4, §7, §8)

- **AOS-F1** — `SwarmManifest` schema_version 1.1 adds the `sdlc`, `policy`,
  and `memory` top-level objects per §4.1. Every 1.0 manifest still validates
  against the 1.1 model (zero-regression migration).
- **AOS-F2** — `aos.contracts.TogafPhase` is an enum with exactly the values
  `vision | business | information_systems | technology`. The `togaf_phase_map`
  field maps wave indices to enum values; unmapped waves default to
  `technology`.
- **AOS-F3** — `aos.contracts.QualityGate` supports check kinds `linter`,
  `typechecker`, `bdd`, `schema`, `custom`. A wave does not advance until the
  gate's checks return success or its `on_failure` policy escalates explicitly.
- **AOS-F4** — On every TOGAF phase boundary, the orchestrator writes an ADR
  to `data_out/adr/ADR-${seq}.md`. The ADR includes context, decision,
  consequences, and back-references to the manifest's task IDs that
  contributed to it. ADR sequence numbers are monotonic per workspace.

### 5.2 Pass-by-reference (Brief §11.1)

- **AOS-F5** — `benny.core.artifact_store` exposes `put(bytes, media_type)
  -> ArtifactRef` and `get(uri) -> bytes`. Storage is a content-addressed
  directory under `${BENNY_HOME}/workspaces/${workspace}/artifacts/<sha[:2]>/<sha>`.
- **AOS-F6** — When a tool result's token estimate exceeds
  `memory.pbr_threshold_tokens`, the orchestrator stores the result via
  `artifact_store.put` and substitutes an `ArtifactRef` summary
  (≤ 200 chars + URI) into the LLM context.
- **AOS-F7** — When the agent emits `${artifact://<sha>}` inside a tool
  invocation, the executor resolves it before the tool sees the call. No
  bytes ever traverse the LLM context twice.

### 5.3 Progressive disclosure (Brief §11.2)

- **AOS-F8** — `benny.core.disclosure` ships a 3-layer registry. **Layer 1**
  (metadata only) for the entire registered tool set MUST fit in ≤ 500 tokens
  (cl100k tokeniser). Verified by `test_aos_f8_layer1_token_budget`.
- **AOS-F9** — Calling `disclosure.activate(tool_name)` returns the JSON
  Schema for that tool. The schema is loaded lazily and cached per run.
- **AOS-F10** — Calling `disclosure.examples(tool_name)` returns the Layer 3
  payload (examples + docs artefact ref). Layer 3 is only loaded when the
  agent explicitly requests it; never by default.

### 5.4 Diagram generation (Brief §7.2)

- **AOS-F11** — `benny.graph.diagrams.to_mermaid(manifest) -> str` emits a
  Mermaid `graph TD` representation of the plan's DAG with one node per
  task, edges from `plan.edges`, and wave grouping via `subgraph`. The
  output is also persisted to `manifest.plan.mermaid`.
- **AOS-F12** — `benny.graph.diagrams.to_plantuml(manifest) -> str` emits
  the same DAG in PlantUML syntax. Selected via `--diagram plantuml` on
  `benny plan`.
- **AOS-F13** — For each `bdd_scenarios[*]`, `to_activity_diagram(scenario)`
  emits a Mermaid `flowchart` showing Given → When → Then transitions.

### 5.5 Durable execution / resume (Brief §10)

- **AOS-F14** — `benny run --resume <run_id>` reads the `LangGraph`
  checkpointer state (`benny/persistence/checkpointer.py`) and re-enters the
  state machine at the last completed task. Already-completed tasks are not
  re-executed; their outputs are rehydrated from the checkpoint.
- **AOS-F15** — A run paused for HITL review serialises its full state
  (manifest snapshot + checkpoint row + artefact refs) to
  `${BENNY_HOME}/workflows/${run_id}/pause.json`. The portable drive can be
  unplugged and replugged on a different host; `benny run --resume` continues
  to work.
- **AOS-F16** — Each task carries a `time_budget_seconds` (default 600)
  and an `iteration_budget` (default 5). Exceeding either escalates per the
  task's `on_failure` policy.

### 5.6 Concurrency & worker pool (Brief §5.2)

- **AOS-F17** — `benny.graph.worker_pool.WorkerPool` exposes a semaphore
  whose capacity is computed from
  `min(SWARM_MAX_CONCURRENCY, available_vram_gb / model_vram_gb)`.
  Resolved per-run, never globally.
- **AOS-F18** — When the queue depth equals capacity, `dispatcher_node` blocks
  before issuing further `Send` envelopes. No more than `capacity` worker
  agents execute simultaneously.
- **AOS-F19** — A task's `iteration_budget` caps the reasoner→executor loop
  count. Exceeding it raises `IterationBudgetExceeded` and emits the
  `quality_gate_violation` SSE event.

### 5.7 BDD requirements pipeline (Brief §6)

- **AOS-F20** — `benny req "<requirement>"` invokes the `requirements_analyst`
  skill, which produces a PRD JSON document at
  `data_out/prd/${slug}.json` plus a Gherkin file at
  `data_out/prd/${slug}.feature`. Both artefacts are signed and registered
  in the manifest's `inputs.context.prd`.
- **AOS-F21** — `benny.sdlc.bdd.compile_to_pytest(feature_file) -> str`
  produces a `pytest`-compatible test stub file. Stubs are deterministic
  (sorted, stable hashes) — re-running the compiler on the same feature
  produces byte-identical output.
- **AOS-F22** — The PRD JSON is validated against
  `schemas/aos/prd_v1.schema.json`. Validation failure halts the workflow and
  emits the `prd_invalid` SSE event.

### 5.8 Compliance & policy (Brief §9)

- **AOS-F23** — Every artefact persisted by `artifact_store.put` triggers a
  JSON-LD record at `data_out/lineage/${artifact_sha}.jsonld` per §4.4.
- **AOS-F24** — Pypes `silver`/`gold` steps emit a column-level lineage
  block (`prov:used` / `prov:generated`) referencing CDEs declared in the
  pypes manifest.
- **AOS-F25** — Before any `fs.write`, `git.commit`, or `pypes.run` tool
  invocation, `benny.governance.policy.evaluate(intent, persona, manifest)`
  returns `approved | denied | escalate`. `denied` propagates to the user
  surface; `escalate` pauses the workflow for HITL.
- **AOS-F26** — Approved actions append a record to the immutable Git ledger
  branch `benny/checkpoints/v1` containing: prompt hash, reasoning hash,
  diff, persona, timestamp, manifest signature. The branch is HMAC-protected
  and ratchet-only (no rewinds).
- **AOS-F27** — On each ledger append, the SOX 404 cryptographic intent
  proof is computed as
  `HMAC(secret, prompt_hash || diff_hash || prev_ledger_hash)` and written
  alongside the ledger entry. `benny doctor --audit` verifies the chain.

### 5.9 Process telemetry & sandbox (Brief §12)

- **AOS-F28** — During every run, `benny.sdlc.metrics` records the
  process-metric record per §4.5 and persists it to
  `data_out/metrics/${run_id}.json`.
- **AOS-F29** — `benny sandbox <manifest> --models a,b,c` executes the same
  manifest against each model in sequence, in the same workspace, and
  outputs a side-by-side comparison report at
  `data_out/sandbox_reports/${manifest_id}_${ts}.md`.
- **AOS-F30** — The sandbox report includes per-model: tool-selection
  accuracy, tool efficiency, context efficiency, iteration latency p95,
  loop count p95, constraint adherence, total cost, total tokens.
- **AOS-F31** — Process metrics are exposed in Phoenix via OTLP attributes
  on the existing workflow span (no new endpoint).

---

## 6. Non-functional targets

Reference device: Ryzen AI 9 HX 370, 32 GB RAM, integrated Radeon 890M,
Windows 11, Python 3.11. Where applicable, NFRs are budget-checked by
`tests/release/test_aos_release_gate.py` (Phase 10).

| ID | Target | Measurement |
|----|--------|-------------|
| AOS-NFR1 | PBR reduces total context tokens ≥ **80 %** for tool outputs ≥ 1024 tokens. | `tests/sdlc/test_pbr_token_budget.py` |
| AOS-NFR2 | `benny run --resume` median latency ≤ **5 s** to first task dispatch. | `tests/sdlc/test_resume_latency.py` |
| AOS-NFR3 | `benny req` end-to-end (LLM mocked) ≤ **2.5 s** p95. | `tests/sdlc/test_req_latency.py` |
| AOS-NFR4 | Mermaid render of a 50-task manifest ≤ **50 ms**. | `tests/sdlc/test_diagrams_perf.py` |
| AOS-NFR5 | Worker pool prevents OOM on the reference device under a 70 B model SDLC manifest with default budgets. | `tests/sdlc/test_worker_pool_oom.py` (mocked VRAM) |
| AOS-NFR6 | Coverage ≥ **85 %** on `benny/sdlc/**` and on the AOS-touched modules in `benny/core/**`, `benny/governance/**`. | `tests/release/test_aos_release_gate.py::coverage` |
| AOS-NFR7 | SR-1 ratchet not raised; no new absolute paths. | existing `tests/portability/test_no_absolute_paths.py` |
| AOS-NFR8 | `BENNY_OFFLINE=1` runs the full SDLC pipeline against a local model end-to-end. | `tests/sdlc/test_offline_e2e.py` |
| AOS-NFR9 | Soak: 10× consecutive successes of `benny sandbox` against `model_comparison_smoke.json`. | `tests/sdlc/test_sandbox_soak.py` |
| AOS-NFR10 | Bundle-size delta on the existing UI ≤ **250 KB gzipped**. | `tests/release/test_aos_release_gate.py::bundle_delta` |
| AOS-NFR11 | JSON-LD lineage emission adds ≤ **5 ms** p95 per task (measured by Phoenix span deltas). | `tests/sdlc/test_lineage_overhead.py` |
| AOS-NFR12 | Layer 1 disclosure for the full tool registry ≤ **500 tokens** (cl100k). | `tests/sdlc/test_disclosure_budget.py` |

---

## 7. Feature flags & configuration

All flags live in `benny/core/config.py` (extended). Defaults are listed below.

| Flag | Default | Purpose |
|------|---------|---------|
| `aos.pbr.enabled` | `false` until Phase 1 lands; `true` after | Pass-by-reference store. |
| `aos.pbr.gc_age_days` | `30` | Garbage-collect age for unreferenced artefacts. |
| `aos.disclosure.enabled` | `false` until Phase 2 lands; `true` after | Progressive disclosure. |
| `aos.diagrams.format` | `mermaid` | Diagram format. Allowed: `mermaid`, `plantuml`. |
| `aos.resume.enabled` | `false` until Phase 4 lands | `benny run --resume`. |
| `aos.worker_pool.vram_aware` | `true` | VRAM ceiling enforcement. |
| `aos.bdd.enabled` | `false` until Phase 6 lands | `benny req` + Gherkin compiler. |
| `aos.sdlc.enabled` | `false` until Phase 7 lands | TOGAF mapping + ADR emission. |
| `aos.policy.mode` | `warn` | `warn` \| `enforce`. Flips to `enforce` after Phase 9. |
| `aos.policy.auto_approve_writes` | `false` | **MUST remain `false`**; hard gate (GATE-AOS-POLICY-1). |
| `aos.lineage.jsonld` | `false` until Phase 8 lands | JSON-LD emission. |
| `aos.sandbox.os_isolation` | `auto` | `auto` \| `bubblewrap` \| `sandbox-exec` \| `none`. |

Flipping `aos.policy.auto_approve_writes` to `true` is a hard block at the
release gate — see [acceptance_matrix.md](acceptance_matrix.md) ID
`GATE-AOS-POLICY-1`.

---

## 8. Security & privacy

- **AOS-SEC1** — The policy enforcer rejects any tool invocation whose
  `tool_name` is not in `policy.allowed_tools_per_persona[persona]`. Rejection
  emits the `policy_denied` SSE event and the AER record for the task is
  marked `policy_violation`.
- **AOS-SEC2** — When `policy.deny_network` is `true` (default for SDLC
  manifests), only the local LLM endpoint(s) and the Marquez/Phoenix emitters
  may receive outbound TCP. Verified by
  `tests/safety/test_aos_no_unexpected_egress.py` using a stubbed socket.
- **AOS-SEC3** — Filesystem writes are restricted to the manifest's
  `workspace` directory. Path traversal (`..`) is rejected at
  `policy.evaluate` time.
- **AOS-SEC4** — `benny doctor --json` reports `aos.sandbox` indicating
  whether `bubblewrap` or `sandbox-exec` is available and whether the current
  process inherits its constraints.
- **AOS-SEC5** — Artefact store paths MUST resolve under `${BENNY_HOME}`. A
  symlink escape attempt fails the put with `ArtifactPathEscape`.
- **AOS-SEC6** — The Git ledger branch `benny/checkpoints/v1` is
  append-only. Any rewind attempt (`push --force`, `git reset`) is detected
  by `benny doctor --audit` and reported as `ledger_rewind_detected`.

---

## 9. Compliance — SOX 404 & BCBS 239 (Brief §9)

- **AOS-COMP1** *(SOX 404, internal control over reporting code)* — Every
  approved policy decision is recorded with: prompt hash, diff hash, prior
  ledger hash, persona, model, model hash, timestamp. The chain is verifiable
  by `benny doctor --audit`.
- **AOS-COMP2** *(BCBS 239 P3 — Accuracy & Integrity)* — Every CDE referenced
  in a pypes manifest carries a JSON-LD lineage record that connects its
  source columns to its destination columns through the transformation graph.
- **AOS-COMP3** *(BCBS 239 P4 — Completeness)* — The lineage graph for a
  given run has no orphan edges: every `prov:used` traces to a `prov:Entity`
  that exists in the run's artefact store; every `prov:generated` traces to
  an emitted artefact. Verified by `test_aos_comp3_no_orphans`.
- **AOS-COMP4** *(BCBS 239 P6 — Adaptability)* — `benny diff` (new
  sub-command) shows a structural and semantic diff between two manifests,
  including their lineage graphs. Adaptability is the ability for an auditor
  to inspect the impact of a manifest change before approval.
- **AOS-COMP5** — Audit replay: re-running a signed manifest with the same
  inputs and the same model + model hash MUST produce the same set of
  artefact SHAs. (LLM non-determinism is bounded by `temperature=0` plus
  seed pinning where the provider supports it; the test asserts SHA equality
  on a fixture local model.)

---

## 10. Observability

- **AOS-OBS1** — `benny doctor --json` gains an `aos` section reporting:
  PBR store size, oldest artefact age, last resume attempt, pending HITL
  count, ledger head SHA, last process-metric record per active workspace.
- **AOS-OBS2** — Structured logs emitted by `benny/sdlc/**` and the
  AOS-touched modules carry `component="aos"` and follow the existing LLM-log
  schema (Phase 6).
- **AOS-OBS3** — SSE events are extended with: `quality_gate_started`,
  `quality_gate_passed`, `quality_gate_failed`, `adr_emitted`, `policy_denied`,
  `prd_invalid`, `pbr_promoted`. Schemas live in
  `benny/core/event_bus.py`.
- **AOS-OBS4** — Phoenix spans are extended with attributes
  `aos.persona`, `aos.togaf_phase`, `aos.iteration_index`, and
  `aos.policy_decision`.

---

## 11. Process metrics — formal definitions

Used by `benny sandbox` (AOS-F29) and the release-gate report.

| Metric | Formula | Healthy band |
|--------|---------|--------------|
| Tool selection accuracy | `correct_tool_calls / total_tool_calls` (correct = the tool that resolved the task without retry) | ≥ 0.85 |
| Tool efficiency | `min_required_tools / actual_tools_used` | ≥ 0.70 |
| Context efficiency | `unique_input_tokens / total_input_tokens` over a run | ≥ 0.60 |
| Iteration latency p95 | percentile-95 of `executor_finish - reasoner_start` per task | ≤ 6 s on local 7B-class |
| Loop count p95 | percentile-95 of reasoner→executor loops per task | ≤ 5 |
| Constraint adherence | `1 - (json_schema_drift_events / total_tool_calls)` | ≥ 0.99 |
| Cost per run | sum of `cost_per_1k * tokens` from `benny/core/models.py` | manifest-dependent |

---

## 12. Rollback

Every phase ships behind its `aos.*` flag, default `false`. Rolling back a
phase = reverting its merge commit; no schema migration is destructive
(every `SwarmManifest` 1.0 manifest still validates against 1.1). The Git
ledger branch is additive and can be left in place even if all `aos.*`
flags are flipped back to `false`.

The four irreversible-on-merge surfaces — and how to undo each — are:

| Surface | Undo |
|---------|------|
| `SwarmManifest.schema_version = "1.1"` | Migration is additive; 1.0 manifests validate. Revert sets `schema_version` default back to `"1.0"`. |
| Git ledger branch | Branch is append-only; orphaning it has no effect on the codebase. |
| Pypes column-level lineage | Optional emission. Disable via `aos.lineage.jsonld=false`. |
| Worker-pool semaphore in `swarm.py` | Behind `aos.worker_pool.vram_aware`; flip false to restore unbounded pre-Phase-5 behaviour. |

---

## 13. Open questions — RESOLVED 2026-04-26

All seven OQs are **DECIDED**. The full pro/con analysis and rationale lives
in [open_questions.md](open_questions.md). Binding values are summarised below;
see each OQ block in that file for the supporting reasoning.

| OQ ID | Resolution | Phase impact |
|-------|------------|---------------|
| OQ-1 | **CUSTOM** — architecture is fully configurable per-persona via a new `ManifestConfig.model_per_persona` field plus the existing `ManifestTask.assigned_model`. Default model for every persona today is `qwen3.5-9b` (exact registry identifier confirmed at wire-up; fallback `local_lemonade`). | Phase 0 adds the config field, the resolution-order helper, and the registry entry. |
| OQ-2 | **APPROVED — hybrid.** Host sandbox where available, Docker when `aos.sandbox.os_isolation=docker`, Policy-as-Code (Phase 9) as the real boundary. `benny doctor` reports availability honestly. | Phase 9 carries the hard guarantee; AOS-SEC4 unchanged. |
| OQ-3 | **APPROVED — vendor PROV-O** under `vendor/prov-o/`; JSON-LD `@context` rewritten to a `file://${BENNY_HOME}/vendor/prov-o/...` URI at emit time. | Phase 8 adds vendored file (~6 KB) + rewrite logic. |
| OQ-4 | **APPROVED — both.** Phase 6 ships `benny bdd compile` (explicit, deterministic). Phase 10 ships an opt-in pytest plugin (`pytest --benny-bdd`) only if budget allows. | Phase 6 mandatory; Phase 10 stretch. |
| OQ-5 | **APPROVED — Git orphan branch** `benny/checkpoints/v1`, append-only, HMAC-chained per AOS-F26 / AOS-F27. | Phase 9. R12 (force-push) mitigated via `benny doctor --audit` + documented pre-receive hook. |
| OQ-6 | **APPROVED — two-tier.** Hard gates: AOS-NFR12 (constraint adherence ≥ 0.99) and AOS-NFR8 / `GATE-AOS-OFF` (offline e2e). All other §11 metrics ship as informational warnings; promote to hard via a follow-up issue once ≥ 10 sandbox-runner runs exist. | Phase 10 release-gate set calibrated. |
| OQ-7 | **APPROVED — replay framework artefacts** via PBR. AOS-COMP5 asserts artefact-lineage byte-equality on replay (LLM outputs are stored, not re-prompted). A non-gating informational sub-test `test_aos_llm_determinism_oracle` runs against `litert/gemma-4-E4B-it.litertlm` to detect inference-stack regressions. | Aligns with Phase 1 PBR + Phase 4 resume designs. |

An agent encountering a future open question (OQ-8+) MUST pause and raise a
HITL request; it MUST NOT invent an answer.

---

## 14. References

- The Brief — *Architecting a Deterministic, Portable Agentic Operating
  System for the Software Development Life Cycle* (committed verbatim as
  `source_brief.md`).
- [architecture/SAD.md](../../../architecture/SAD.md) — current Benny
  architecture.
- [docs/operations/PYPES_TRANSFORMATION_GUIDE.md](../../../docs/operations/PYPES_TRANSFORMATION_GUIDE.md)
- [docs/requirements/8/requirement.md](../8/requirement.md) — KG3D-001
  precedent for six-sigma requirement structure.
- TOGAF 9.2 ADM (The Open Group, 2018).
- BCBS 239 *Principles for effective risk data aggregation and risk
  reporting* (Bank for International Settlements, 2013).
- SOX § 404 *Management assessment of internal controls* (Public Law
  107-204, 2002).
- W3C PROV-O *The PROV Ontology* (W3C, 2013).
