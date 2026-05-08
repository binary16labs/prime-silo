# ADR-001: Fork space-agent as the Prime-Silo Shell, Restrict Agent Writes to a Workspace Sandbox

| Field          | Value                                              |
| -------------- | -------------------------------------------------- |
| Status         | Accepted                                           |
| Date           | 2026-05-06                                         |
| Authors        | Binary 16 (engineering authority)                  |
| Supersedes     | —                                                  |
| Related        | Prime-Silo PRD v0.6.0-draft, Prime-Silo NFR v1.0.0 |

---

## 1. Context

Benny today has four parallel UI metaphors with no shared shell:

- **AgentAmp** — Winamp-style cockpit (skinnable, HMAC-signed `.aamp` packs, phases 1–6 shipped)
- **Notebook** — KG canvas + chat + synoptic web + analysis (RAG-first)
- **Studio** — 50+ components, five overlapping canvases (`ManifestCanvas`, `PipelineCanvas`, `WorkflowCanvas`, `SwarmCanvas3D`, `CodeGraphCanvas`)
- **Admin / Marketplace / LLMManager** — bolted on at the top level

Two App entrypoints (`App.tsx`, `AppV2Beta.tsx`) confirm an in-flight v2 attempt with no convergence story. Users cannot tell which canvas to use for which question, and there is no shared model for theming, navigation, run history, or workspace selection.

Separately, the Prime-Silo PRD v0.6 imposes a substrate-grade contract on every output (typed Cognitive Frame, mandatory withdrawal register, JCS-hashed `frame_hash`, triple lineage `process/skill/data`, sandbox/promotion protocol, observational mode). The deterministic core of Benny — Pypes (Layer 0), the swarm executor (Layer 1), Marquez lineage, manifest signing — already aligns closely with that contract. The UI is what is missing.

Two forces converge: the user wants UI cohesion, and the architecture wants a typed, auditable surface for the agent to act through.

## 2. Decision

We will:

1. **Fork [`agent0ai/space-agent`](https://github.com/agent0ai/space-agent)** into a new repo, working name **`prime-silo`**. Space-agent is a browser-resident agent runtime with adaptive canvas behaviour and puzzle-piece module modularity — the right shell shape for what Benny needs.
2. **Vendor the entire Benny Python backend** (`benny/`, `tests/`, `manifests/`, `architecture/`, `docs/`) into the fork as `runtime/` (or equivalent subtree). The deterministic substrate moves wholesale; nothing is rewritten.
3. **Restrict agent write authority** to a single per-workspace subtree, `$BENNY_HOME/workspaces/<ws>/agent_sandbox/`. The agent has full read access to everything else; writes outside the sandbox are rejected by middleware.
4. **Promote AgentAmp from "skin pack" to "trust envelope"**. Every saved adaptive layout becomes an `.aamp.view` bundle, HMAC-signed using the existing skin-pack signing path. Replaying a layout is deterministic and auditable.
5. **Consolidate Studio's five canvases** into one parameterised DAG canvas registered as a single widget, plus a typed widget registry for the remaining surfaces (KG, code graph, drill-down, frame inspector, lineage timeline).
6. **Constrain the agent to a typed JSON layout DSL** (extending the existing pypes manifest schema where possible), not free-form embedded JS. Free-form JS waits for a sandboxed-iframe trust story.
7. **Route every agent LLM call through `call_model()`** rather than letting space-agent's browser-resident agent call its own LLM client. We keep offline-mode, lineage, and logging guarantees; we lose some of space-agent's elegance.

## 3. The Determinism Boundary

The substrate splits cleanly into two zones. The agent has different authority in each.

| Zone               | Surfaces                                                                                                    | Agent authority                                              | UI shape                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| **Deterministic**  | Manifest authoring, run execution, KG/code graph mutation, L3 writes, skill registry                        | Read-only. Drafts → HITL → `sign_manifest()` → run.          | Static React canvases, signed widgets |
| **Review (fluid)** | Post-run drill-down, frame inspection, reasoning trace, audit query results, agent-composed analyst reports | Read-only on data; write to `agent_sandbox/` for layouts/notes/drafts | Adaptive canvas, agent-composed views |

The Review zone is where space-agent's adaptive canvas lives. The agent composes views from the typed widget registry, parameterised against frozen Pypes outputs. Users cannot accidentally mutate L3 state from a fluid view; the agent literally cannot.

## 4. The Sandbox Layout

```
$BENNY_HOME/workspaces/<ws>/agent_sandbox/
├── views/        # agent-composed layouts (.aamp.view JSON, signable)
├── notes/        # agent markdown
├── drafts/       # draft manifests — never executed without HITL promotion
└── skills/       # space-agent-style markdown skill files
```

Promotion to the deterministic zone follows the existing path:

```
draft (agent_sandbox/drafts/) 
  → HITL review 
  → sign_manifest() 
  → manifests/ (signed, immutable) 
  → pypes run / benny run
```

This matches Prime-Silo PRD §11 (Sandbox and Promotion Protocol) and §16 (observational mode).

## 5. Enforcement Mechanism

A new FastAPI middleware, `agent_scope_guard`, runs after `GovernanceMiddleware` and inspects `X-Benny-Agent-Scope`:

| Header value | Read access     | Write access                                                                |
| ------------ | --------------- | --------------------------------------------------------------------------- |
| absent       | per existing RBAC | per existing RBAC (human user)                                               |
| `sandbox`    | full            | only requests resolving to `…/agent_sandbox/{views,notes,drafts,skills}/…` |
| `read_only`  | full            | rejected                                                                    |

Every sandbox write emits a `process=agent_authorship, skill=<agent_id>, data=<sandbox_path>` triple lineage event. The agent's authoring history is itself auditable — the same epistemic guarantee Prime-Silo demands of any operation.

## 6. Trust Envelope: `.aamp.view` Bundles

When the user pins an agent-composed layout, it becomes an `.aamp.view` bundle: a manifest JSON describing `{widgets, layout_dsl, frame_bindings, parameters}`, HMAC-signed using `benny.agentamp.signing.sign_skin_pack`'s canonical-payload approach. A pinned view replays deterministically against any compatible run output. Users can share, version, and audit views the same way they share signed skin packs today.

## 7. Canvas Reuse and Consolidation

The existing 50+ Studio components do not get rewritten. They move under `frontend/src/widgets/` and each exports a manifest:

```ts
{
  id: "kg3d.synoptic_web",
  schema_version: "1.0.0",
  props: { /* JSON Schema */ },
  frame_bindings: [{ field: "concepts", required: true }],
  authority: "read_only" | "read_write_sandbox" | "deterministic_only",
  defaults: { /* sensible starting layout */ }
}
```

The agent composes by selecting widget IDs and binding props to Frame fields. It does not generate widget code. Five canvases collapse to one parameterised DAG widget with three modes (`manifest`, `pipeline`, `workflow`).

## 8. Phased Delivery

| Phase | Outcome                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| **A** | Backend prep in Benny: sandbox path helpers, `agent_scope_guard` middleware, `agent_authorship` lineage emitter, widget manifest contract |
| **B** | Fork `agent0ai/space-agent` → `prime-silo`. Vendor Benny under `runtime/`. One workspace boots end-to-end                  |
| **C** | Port the 5 highest-value canvases (KG3d, ManifestCanvas-as-DAG, DrillDownTable, FrameInspector, LineageTimeline) into the widget registry |
| **D** | Agent composes Review-zone layouts over completed Pypes runs (read-only, deterministic-zone untouched)                    |
| **E** | Deterministic zone — manifest authoring + run execution rendered as static (non-agent-mutable) shell pages                |
| **F** | AgentAmp `.aamp` pack format absorbs space-agent skill files; saved views become `.aamp.view` signable bundles            |
| **G** | Canvas consolidation — retire ManifestCanvas/PipelineCanvas/WorkflowCanvas duplication                                    |

This ADR commits to Phase A. Phases B–G are tracked as follow-on work; B requires creating the new external repository, which is out of scope for this branch.

**Implementation status (rolling):**
- **A, B, C, D** ✅ shipped in `binary16labs/prime-silo`.
- **D2** ✅ — agent-context chokepoint on the runtime client (`createAgentRuntimeClient`, `withAgentScope`).
- **D3** ✅ — agent saved-views helpers (`saveView`/`loadView`/`listViews`) ride the chokepoint; the sandbox write path is exercised end-to-end through `/api/agent_sandbox/views/save`.
- **F** ✅ — `.aamp.view` HMAC chokepoint (`POST /api/views/sign` + `POST /api/views/verify`) implemented in [`runtime/benny/api/views_signing.py`](../../runtime/benny/api/views_signing.py) and [`runtime/benny/api/views_routes.py`](../../runtime/benny/api/views_routes.py). Mounted *outside* `/api/agent_sandbox/`, so `AgentScopeMiddleware` 403s every agent-scoped POST — the policy "agents draft, humans pin" is enforced by middleware, not convention. The persistence half (`pinView` = sign + write to a canonical location + emit lineage) is intentionally a follow-up so the signing technique locks in before the storage shape does.
- **E, G** — not started.

## 9. Consequences

### Positive

- **One shell, one nav, one theme system.** AgentAmp's primitives (skins, EQ, playlist, layout DSL, signed packs, user-state portability) extend over every surface.
- **Adaptive review without compromising determinism.** The agent reshapes views; it does not reshape state.
- **Existing canvas investment preserved.** 50+ React components keep working as registered widgets.
- **Audit story extends to agent authorship.** Every layout the agent emits is lineage-emitted and signable — a Prime-Silo §A.7 alignment.
- **Closer to Prime-Silo §16 observational mode.** The agent runs against existing systems without write authority, exactly as Prime-Silo's adoption model prescribes.

### Negative

- **Fork maintenance.** We track upstream space-agent; we own the divergence.
- **Opinionated shell metaphor.** AgentAmp's Winamp framing extends across surfaces that don't naturally have "playlists."
- **Constrained DSL is more work upfront** than letting the agent emit free JS, but the trust story is genuinely necessary.
- **Two App entrypoints become three temporarily** during the migration (App, AppV2Beta, fork shell) before convergence.

### Neutral

- The deterministic core (`benny/core/`, `benny/pypes/`, `benny/graph/`, `benny/governance/`) is untouched by this fork. All NFR-02 (determinism) guarantees survive intact.

## 10. Open Questions

1. **Fork repo name.** Working name `prime-silo`. Final TBD.
2. **Deprecation of `AppV2Beta.tsx`.** Recommend retiring during Phase E once the new shell is hosting Studio surfaces.
3. **Cross-workspace agent authority.** Initial scope: one agent, one workspace. Multi-workspace agent reasoning is out of scope until Phase G.
4. **Free-form JS in iframe.** Deferred until trust envelope is proven on the typed-DSL path.

---

*ADR-001 — Prime-Silo shell fork — Binary 16 — for review*
