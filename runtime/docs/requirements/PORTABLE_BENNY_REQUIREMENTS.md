# Portable Benny — Requirements & Implementation Plan

**Document ID:** PBR-001
**Version:** 1.0
**Date:** 2026-04-18
**Status:** Draft for review
**Owner:** repo owner (nsdha)
**Quality target:** 6σ-safe (≤ 3.4 defects per million operations on declared invariants: data integrity, path portability, run reproducibility, credential isolation)

**Configuration placeholders** (set once at install, referenced everywhere):

| Placeholder | Meaning | Set at |
|---|---|---|
| `<SSD_ROOT>` | Absolute mount path of the external SSD. **Resolved: `D:/optimus`** (Windows: `D:\optimus`). | `benny init --home D:/optimus` |
| `<HOST_ID>` | Stable id of the current host, derived from OS + machine-id. | Auto at first `benny up` |
| `<DEVICE_ID>` | Stable id of the SSD volume, derived from its serial. | Auto at `benny init` |

Everywhere in this document the string `<SSD_ROOT>` means `$BENNY_HOME`. Only this placeholder needs resolution at install time.

This document is intentionally **declarative** and **model-agnostic**. Any capable coding model (Claude, a future model, or a local LLM acting as executor) must be able to pick it up, read the acceptance criteria, execute the test matrix, and deliver the system without additional tribal knowledge.

---

## 0. Glossary

| Term | Meaning |
|---|---|
| `BENNY_HOME` | Root directory of the portable install (on the external SSD). Single source of truth for config, data, venv, models, workspaces, runs. |
| `Host` | The physical machine Benny is currently plugged into. |
| `Manifest` | The unified JSON contract (see memory: Benny Studio product direction) that declares a workflow. |
| `Run` | One execution of a manifest. |
| `LLM-Router` | The component that decides whether a task goes to Claude (cloud), a local LLM, or another configured provider. |
| `Claude-as-Orchestrator` | Claude (via API or Claude Code CLI) invoking Benny to plan, then delegating per-node execution to a local LLM. |

---

## 1. Problem Statement

1.1 The current Benny install lives on the C: drive inside OneDrive and is bloating the host disk with workspaces, models, vector stores, and run artifacts.
1.2 Workspaces and artifacts are comingled with user home directories, making backup, reset, and machine-migration painful.
1.3 There is no declarative switch to route work between cloud Claude and local LLMs, which blocks cost-controlled experimentation and offline operation.
1.4 There is no first-class integration path for Claude (API or CLI) to *drive* Benny and then *hand off* sub-tasks to the local LLM.
1.5 The project must be re-runnable later by a different model/agent without losing behavior guarantees.

---

## 2. Goals & Non-Goals

### 2.1 Goals (in priority order)

- **G1 — Portability:** entire runtime lives on an external SSD. Unplug, move to another Windows/macOS/Linux host, plug in, `benny up` works.
- **G2 — Local-first:** default path requires no internet. Cloud providers are optional accelerators.
- **G3 — Declarative Claude integration:** Claude (API or CLI) can plan a manifest, submit it, and monitor runs through a stable contract.
- **G4 — Cloud↔Local hand-off:** any node in a manifest can declare a `role` (resolved via workspace `model_roles`) or an `executor_override`; the resolver in [benny/core/models.py](benny/core/models.py) honors it deterministically.
- **G5 — Reproducibility:** a manifest + its pinned input set produces the same run graph on any host, modulo non-deterministic model calls which are recorded in lineage.
- **G6 — 6σ safety on declared invariants** (see §8).

### 2.2 Non-Goals

- N1 — Replacing the existing manifest/planner work (direction already set in memory).
- N2 — Supporting mobile hosts.
- N3 — Multi-user concurrent access to the same SSD (single-writer model).
- N4 — Network-attached operation of the SSD (no SMB/NFS support in v1).

---

## 3. Users & Scenarios

| Persona | Scenario |
|---|---|
| Owner (solo dev) | Plugs SSD into laptop, runs `benny up`, opens studio in browser, picks a workflow. |
| Claude (API) | Given a requirement, calls `POST /api/workflows/plan` → reviews manifest → `POST /api/workflows/run` → streams events. |
| Claude Code (CLI) | Uses slash commands / MCP tools wired to Benny (`benny plan`, `benny run`, `benny tail`). |
| Local LLM | Receives per-node prompts routed by the LLM-Router, returns completions with lineage tags. |
| Future Model | Reads this doc + the manifest schema, reproduces the system without human hand-holding. |

---

## 4. Functional Requirements

Requirement IDs are stable: **FR-*** is functional, **NFR-*** is non-functional, **SR-*** is safety/6σ.

### 4.1 Portable Install

- **FR-1** The installer creates a single self-contained tree under `$BENNY_HOME` (== `<SSD_ROOT>`) with this shape:
  ```
  $BENNY_HOME/                    # == D:/optimus
    bin/                          # launchers (benny, benny-ui, benny-llm)
    app/                          # `app` profile only
      image.tar                   # pinned OCI image of the Benny app
      compose.yml                 # declares services + volume mounts to ../data, ../models, ../config, ../workspaces
      VERSION                     # pinned image tag
    runtime/                      # `native` profile only
      python/                     # embedded python (Windows) or venv (POSIX)
      node/                       # embedded node for UI
      neo4j/                      # Neo4j server binaries (native profile)
    config/
      benny.toml                  # portable config (paths relative to $BENNY_HOME)
      voices.json                 # TTS voice registry (closes the hardcoded af_sky gap)
      server_ops_allowlist.json   # allowlisted local-LLM server-ops
      profile                     # "app" | "native"
      secrets.env.enc             # age-encrypted secrets (never git-committed)
    data/
      runs/                       # run artifacts
      lineage/                    # Marquez/OpenLineage local store
      vector/                     # ChromaDB
      graph/                      # Neo4j **server** data dir (dbms, transactions, logs)
    workspaces/                   # user workspaces — SEPARATE from app; survives reinstall
    models/                       # local LLM weights — side-loaded via `benny models pull`
    logs/
    tmp/
    state/
      device-id                   # uuid bound to this SSD volume serial
      schema-version
      profile-lock                # records which profile initialised this SSD
  ```
- **FR-2** No absolute paths outside `$BENNY_HOME` may appear in any config, manifest, run artifact, or log written by Benny.
- **FR-3** `benny doctor` detects and reports any config or artifact that violates FR-2.
- **FR-4** `benny up` and `benny down` are idempotent. Re-running `up` when already up is a no-op that returns healthy.
- **FR-5** The same `$BENNY_HOME` tree, when moved to a different host (same OS family), starts without modification. Cross-OS (Win↔POSIX) requires `benny migrate --from windows --to posix` which only rewrites launchers + line endings, never data.

### 4.2 Unified JSON Manifest (reaffirms prior direction)

- **FR-6** Manifest is the one source of truth for plan, UI render, run, and audit. No parallel `WorkflowRequest` / executor node schema.
- **FR-7** Every node declares `role` (one of: `chat`, `swarm`, `stt`, `tts`, `graph_synthesis`, plus new roles added in §4.4), optionally `model_hint` and `executor_override`. Resolution uses the workspace manifest's `model_roles` map + the global fallback chain defined in [benny/core/models.py](benny/core/models.py) — no parallel routing file.
- **FR-8** The planner emits fan-out/accumulate nodes when the output spec warrants it. This is a planner heuristic, not a separate agent.
- **FR-9** Manifest is versioned (`schema_version`), signed (content hash stored alongside), and immutable once a run references it.

### 4.3 Plan → Approve → Run

- **FR-10** `POST /api/workflows/plan` accepts a requirement + input refs, returns a manifest (no execution).
- **FR-11** `POST /api/workflows/run` accepts a manifest (by id or body), starts a run, returns a `run_id`.
- **FR-12** `GET /api/runs/{run_id}/events` is an SSE stream of lineage-tagged node events.
- **FR-13** The CLI surfaces the same three verbs: `benny plan`, `benny run`, `benny tail`.
- **FR-14** A manifest accepted by `run` must have a valid plan signature OR be marked `--unsafe-adhoc`.

### 4.4 LLM / TTS / STT configuration (use current LLM Manager shape)

The portable install **reuses** the LLM Manager config that already exists — no new `providers.toml` is introduced. The config lives in three places, each with a single responsibility:

1. **Global provider registry** — `LOCAL_PROVIDERS` in [benny/core/models.py](benny/core/models.py:23). Declares every local service (base URL, probe endpoint, default model, startup command). Lemonade is first-class.
2. **Global model registry** — `MODEL_REGISTRY` in [benny/core/models.py](benny/core/models.py:78). Maps logical model ids → `{model, provider, cost_per_1k, use_for}`.
3. **Per-workspace overrides** — `model_roles` in each workspace's `manifest.yaml` (schema: [benny/core/schema.py](benny/core/schema.py:160) `WorkspaceManifest`). Assigns a concrete model to each role.

Resolution order (already implemented in `get_active_model()` at [benny/core/models.py](benny/core/models.py:266)):
`workspace.model_roles[role]` → `workspace.default_model` → probe local providers in priority order (`lmstudio` → `lemonade` → `ollama` → `fastflowlm`) → cloud if configured → fail closed if `--offline`.

- **FR-15** All provider/model/role config lives in the three locations above. No additional routing file is created. Portable-install work only ensures these files + the workspaces directory live under `<SSD_ROOT>`.
- **FR-15a** Roles supported (current + added for portable Claude-as-orchestrator):
  - existing: `chat`, `swarm`, `stt`, `tts`, `graph_synthesis`
  - added: `plan`, `code_edit_small`, `doc_summarize`, `embed`, `server_ops`, `manifest_dryrun`, `rag_retrieve`, `git_ops_read`, `long_form_gen`
- **FR-15b** `stt` and `tts` routes ([benny/api/audio_routes.py](benny/api/audio_routes.py)) stay as-is — they already resolve through `get_active_model(workspace, role="stt"|"tts")` and call Lemonade's `/api/v1/audio/transcriptions` and `/api/v1/audio/speech`. Portability work adds a TTS **voice registry** under `<SSD_ROOT>/config/voices.json` to close gap #1 from the audit (currently `af_sky` is hardcoded).
- **FR-15c** The hardcoded `qwen3-tk-4b-FLM` in `NotebookChat.tsx:80` is replaced by a `get_active_model(workspace, role="chat")` resolution (closes gap #6 from the audit).
- **FR-16** A workspace can pin any role to any provider/model by editing its `model_roles`. Manifest nodes may carry `executor_override` to force a specific provider id for a single node; this override is honored over `model_roles`.
- **FR-17** Every model call writes an `LLMCallFacet` (already implemented in [benny/governance/lineage.py](benny/governance/lineage.py)): provider, model id, role, tokens in/out, latency, cost estimate, initiator (`user` | `claude` | `local-agent`).
- **FR-18** `benny --offline` sets an env flag that causes `call_model()` to refuse cloud providers and fail closed if no local fallback matches the requested role.

#### 4.4.1 Lemonade as the worked example (verbatim, matches current code)

This is exactly the shape that ships today. Lemonade is the reference local provider; everything else (Ollama, FastFlowLM, LM Studio, LiteRT) follows the same pattern.

**Provider registration** ([benny/core/models.py](benny/core/models.py:23) `LOCAL_PROVIDERS["lemonade"]`):

```python
"lemonade": {
    "kind":         "openai-compat",
    "base_url":     "http://127.0.0.1:13305/api/v1",
    "check_url":    "http://127.0.0.1:13305/api/v1/models",
    "api_key":      "not-needed",
    "default_model":"openai/deepseek-r1-8b-FLM",
    "port":         13305,
    "startup_cmd":  "LemonadeServer.exe serve --port 13305",
    # portable-install addition:
    "data_dir":     "<SSD_ROOT>/models/lemonade",
    "health_path":  "/api/v1/models",
}
```

**Model registry entries that use Lemonade** ([benny/core/models.py](benny/core/models.py:78) `MODEL_REGISTRY`):

```python
"local_lemonade": {
    "model": "openai/deepseek-r1-8b-FLM",
    "provider": "lemonade",
    "cost_per_1k": 0.0,
    "use_for": ["offline", "sensitive_data", "testing"],
},
"voice_speed": {
    "model": "openai/qwen3-tk-4b-FLM",
    "provider": "lemonade",
    "cost_per_1k": 0.0,
    "use_for": ["voice", "speed", "high_speed", "low_latency"],
},
```

**Default workspace `model_roles`** (ships in the default workspace `manifest.yaml`, matches [useWorkspaceStore.ts](frontend/src/hooks/useWorkspaceStore.ts) defaults):

```yaml
version: "1.0.0"
llm_timeout: 300.0
default_model: null
model_roles:
  chat:            "lemonade/qwen3-tk-4b-FLM"
  swarm:           "lemonade/qwen3-tk-4b-FLM"
  stt:             "lemonade/Whisper-Large-v3-Turbo"
  tts:             "lemonade/kokoro-v1"
  graph_synthesis: "lemonade/qwen3-tk-4b-FLM"
  # new portable roles (all default to Lemonade; Claude overrides per-workspace if desired)
  plan:            "lemonade/qwen3-tk-4b-FLM"
  code_edit_small: "lemonade/qwen3-tk-4b-FLM"
  doc_summarize:   "lemonade/qwen3-tk-4b-FLM"
  embed:           "lemonade/qwen3-tk-4b-FLM"
  server_ops:      "lemonade/qwen3-tk-4b-FLM"
  manifest_dryrun: "lemonade/qwen3-tk-4b-FLM"
  rag_retrieve:    "lemonade/qwen3-tk-4b-FLM"
  git_ops_read:    "lemonade/qwen3-tk-4b-FLM"
  long_form_gen:   "lemonade/qwen3-tk-4b-FLM"
embedding_provider: "local"
```

**A "Claude-assisted" workspace** flips the roles Claude should own, leaving everything else on Lemonade:

```yaml
model_roles:
  plan:          "anthropic/claude-opus-4-7"   # top-level planning
  long_form_gen: "anthropic/claude-opus-4-7"   # 10k-word outputs
  # all other roles inherit Lemonade defaults
```

**TTS / STT** (already wired, stays as-is):
- `POST /api/audio/speech` → `get_active_model(workspace, role="tts")` → Lemonade `/api/v1/audio/speech` ([benny/api/audio_routes.py:40](benny/api/audio_routes.py:40))
- `POST /api/transcribe` → `get_active_model(workspace, role="stt")` → Lemonade `/api/v1/audio/transcriptions` ([benny/api/audio_routes.py:20](benny/api/audio_routes.py:20))
- New `<SSD_ROOT>/config/voices.json` enumerates supported voices per provider (replaces the hardcoded `af_sky`).

**Config-surface gaps the portable install closes** (from the LLM-Manager audit):

| Gap | Fix | Where |
|---|---|---|
| Hardcoded TTS voice `af_sky` | `voices.json` registry + API param | `<SSD_ROOT>/config/voices.json`, [audio_routes.py](benny/api/audio_routes.py) |
| No STT language param | Pass `language` from workspace config to `/audio/transcriptions` | [audio_routes.py](benny/api/audio_routes.py) |
| `activeLLMProvider` UI-only | Persist under `workspace.metadata.active_provider` | [WorkspaceManifest](benny/core/schema.py:160) |
| Voice Chat Hub hardcoded model | Replace with `get_active_model(role="chat")` | [NotebookChat.tsx:80](frontend/src/components/Notebook/NotebookChat.tsx:80) |
| Lemonade `/models` response not typed | Add a Pydantic schema and cache the response under `<SSD_ROOT>/state/lemonade-models.json` | [benny/core/models.py](benny/core/models.py) |

### 4.5 Claude as Orchestrator

- **FR-19** Ship an **MCP server** (`benny-mcp`) that exposes the three verbs (`plan`, `run`, `tail`) plus `get_manifest`, `list_runs`, `delegate_to_local`. Claude Code registers this server and can drive Benny directly.
- **FR-20** Provide a minimal **Python SDK** (`benny_sdk`) with the same surface for programmatic Claude (API) use.
- **FR-21** `delegate_to_local(task_spec)` is a first-class tool: Claude can hand off a typed sub-task (code edit, shell workflow, doc summarization) to the local LLM. Result comes back typed and lineage-tagged.
- **FR-22** Claude-initiated runs are tagged with `initiator: claude` in lineage; local-LLM-executed nodes are tagged `executor: local` with provider fingerprint.

### 4.6 Local LLM Capabilities (v1 scope)

- **LC-1** Basic code functions: format, lint-fix, small refactor, docstring generation.
- **LC-2** Shell/server workflow execution from a declarative spec (start, stop, health-check local services — bounded by an allowlist under `<SSD_ROOT>/config/server_ops_allowlist.json`).
- **LC-3** Document chunking, summarization, embedding.
- **LC-4** Manifest validation / dry-run cost estimation.

Out of scope for v1: architectural design, cross-file reasoning over > 50k tokens, planning top-level manifests (that stays with Claude by policy default).

### 4.7 Observability

- **FR-23** Every node emits OpenLineage events to the local Marquez store.
- **FR-24** A single `benny logs <run_id>` call produces a complete, linear, timestamped view of the run across all providers.
- **FR-25** `benny doctor` health-checks: SSD mount, `$BENNY_HOME` integrity, providers reachable, disk headroom, schema version.

---

## 5. Non-Functional Requirements

- **NFR-1 Startup:** cold `benny up` ≤ 20 s on a USB 3.2 SSD, ≤ 60 s on USB 2.0.
- **NFR-2 Throughput:** local node execution (7B-class model, code task) ≥ 15 tok/s on the reference host.
- **NFR-3 Disk:** baseline install ≤ 8 GB (excluding model weights). Weights are opt-in per model.
- **NFR-4 Portability:** `$BENNY_HOME` size is bounded only by SSD capacity; no host-side state.
- **NFR-5 Security:** secrets at rest are age-encrypted; no plaintext secret ever written to disk under `$BENNY_HOME`.
- **NFR-6 Recoverability:** corrupt run state is isolated to `data/runs/<run_id>/` and removable without touching other runs.
- **NFR-7 Determinism:** given the same manifest and the same pinned inputs, the *graph shape* is identical across hosts; model outputs are tagged non-deterministic and captured.
- **NFR-8 Offline:** `--offline` mode has zero outbound network calls. Verified by an egress-blocking test.

---

## 5A. Claude-as-User-of-Benny (how Claude harnesses this setup)

This section turns Benny into a **force multiplier for Claude itself** when operating across workspaces, projects, branches, code, text, and data. It is grounded in primitives that already exist in the repo — the job is to *expose* them cleanly, not invent them. File references are evidence, not wishful thinking.

### 5A.1 Capabilities Claude gains

| Capability | Why Claude is slow today | How Benny fixes it | Backed by |
|---|---|---|---|
| **Persistent cross-session memory per workspace** | Each Claude session starts cold; `MEMORY.md` is per-user, not per-project. | A workspace carries its own `SOUL.md`/`MIND.md`/`SKILLS.md` + ChromaDB; Claude reads them via `GET /api/workspaces/{id}/manifest`. | [benny/core/workspace.py](benny/core/workspace.py), [benny/tools/knowledge.py](benny/tools/knowledge.py) |
| **Pre-indexed codebase graph** | Claude re-reads files every session; large repos blow context. | Neo4j holds a code graph with LOD zoom; Claude asks `POST /api/graph/code/lod` for the minimum slice it needs. | [benny/core/graph_db.py](benny/core/graph_db.py), `/api/graph/code/lod` |
| **Scoped RAG over project docs/data** | Manual grep across 100s of files. | Workspace-scoped ChromaDB + `/api/rag/adaptive-query` returns a ranked evidence set with citations. | [benny/tools/knowledge.py](benny/tools/knowledge.py), [benny/synthesis/engine.py](benny/synthesis/engine.py) |
| **Cross-branch / cross-workspace diffing** | Comparing two branches or two workspaces is fully manual today. | A `manifest_diff` tool: given two manifest ids (same workflow, different branches/runs), return a structured delta. | Planned extension to [benny/core/manifest.py](benny/core/manifest.py) |
| **Plan-then-delegate for cheap work** | Claude spends tokens on lint-fixes, renames, file-scan tasks. | Claude plans, then `delegate_to_local(task_spec)` runs it on **Lemonade** for free. | [benny/core/models.py](benny/core/models.py), `providers.local` |
| **Deterministic replay** | "What exactly did I do last Tuesday?" is guesswork. | Every run is a `RunRecord` with manifest hash + full OpenLineage trace; Claude re-reads `/api/runs/{id}` and the audit log. | [benny/governance/lineage.py](benny/governance/lineage.py), [benny/core/manifest.py](benny/core/manifest.py) |
| **Parallel fan-out** | Sequential file-by-file edits. | Planner emits `dispatcher_node` + `executor_node` waves; Claude submits a single manifest and N nodes run in parallel. | [benny/graph/swarm.py](benny/graph/swarm.py), [benny/graph/wave_scheduler.py](benny/graph/wave_scheduler.py) |
| **Typed skill invocation** | Reinventing "call this tool" prompt-by-prompt. | `Skill` registry exposes OpenAI-tool-schema JSON; Claude picks from a curated set per workspace. | [benny/core/skill_registry.py](benny/core/skill_registry.py) |
| **Agent-to-agent handoffs** | No way to spin up a sub-agent with isolated context. | A2A endpoints (`/a2a/tasks/send`) let Claude dispatch a scoped task to a local sub-agent and await result. | [benny/a2a/server.py](benny/a2a/server.py) |
| **Safe write boundary** | Claude can scribble anywhere on the host. | Workspace-scoped paths (`get_workspace_path`) traversal-check every write; RBAC gates destructive tools. | [benny/core/workspace.py](benny/core/workspace.py), skills RBAC |

### 5A.2 The Claude↔Benny contract (MCP surface, v1)

Claude (API or Claude Code CLI via the `benny-mcp` server from §4.5) gets exactly these tools. Small, typed, composable:

| Tool | Purpose | Maps to |
|---|---|---|
| `workspaces.list` / `workspaces.open(id)` | Enumerate and attach to a workspace. | `/api/workspaces`, `/api/workspaces/{id}` |
| `context.brief(workspace, topic)` | Returns a bounded pack: manifest summary + top-k RAG hits + graph slice at requested LOD. | composes `/api/workspaces/{id}/manifest`, `/api/rag/adaptive-query`, `/api/graph/code/lod` |
| `plan(requirement, inputs)` | Build a manifest, do not execute. | `/api/manifests/plan` |
| `manifests.save` / `manifests.diff(a,b)` | Persist / compare manifests across branches. | `/api/manifests`, new `manifest_diff` |
| `run(manifest_id)` / `tail(run_id)` | Execute + stream events. | `/api/manifests/{id}/run`, `/api/workflows/execute/{id}/events` |
| `runs.list` / `runs.show(id)` | History + artifacts. | `/api/runs/{id}` |
| `delegate_to_local(task_spec)` | Hand off typed sub-task to Lemonade. | Router with `executor=local` (FR-19..22) |
| `skills.list(workspace)` / `skills.invoke(id, args)` | Typed tool invocation with RBAC. | [skill_registry.py](benny/core/skill_registry.py) |
| `lineage.query(run_id or manifest_hash)` | Get the full audit trace for reasoning about past work. | [lineage.py](benny/governance/lineage.py) |
| `graph.neighbors(concept, hops)` | Pull a small knowledge-graph slice on demand. | `/api/graph/neighbors/{concept}` |

This surface is the **only** thing Claude needs to know. Everything else is implementation.

### 5A.3 Default delegation policy (what Claude pushes to Lemonade)

Delegation is expressed the same way everything else is: **per-role model assignments in the workspace `manifest.yaml`** (see §4.4). A workspace that wants Claude orchestration just pins the Claude-owned roles; everything else stays on Lemonade.

Canonical "Claude-assisted" workspace stanza:

```yaml
model_roles:
  # Claude owns:
  plan:            "anthropic/claude-opus-4-7"   # top-level planning
  long_form_gen:   "anthropic/claude-opus-4-7"   # 10k-word outputs
  cross_file_reason: "anthropic/claude-opus-4-7" # > 2 files of context

  # Lemonade handles (defaults — omit to inherit):
  chat:            "lemonade/qwen3-tk-4b-FLM"
  swarm:           "lemonade/qwen3-tk-4b-FLM"
  stt:             "lemonade/Whisper-Large-v3-Turbo"
  tts:             "lemonade/kokoro-v1"
  code_edit_small: "lemonade/qwen3-tk-4b-FLM"
  doc_summarize:   "lemonade/qwen3-tk-4b-FLM"
  embed:           "lemonade/qwen3-tk-4b-FLM"
  server_ops:      "lemonade/qwen3-tk-4b-FLM"   # allowlisted start/stop/health
  manifest_dryrun: "lemonade/qwen3-tk-4b-FLM"
  rag_retrieve:    "lemonade/qwen3-tk-4b-FLM"
  git_ops_read:    "lemonade/qwen3-tk-4b-FLM"   # status/diff/log — read-only
```

Per-node `executor_override` still wins over `model_roles`; every decision is written to the `LLMCallFacet` in lineage (§4.4 FR-17).

### 5A.4 Cross-workspace / cross-branch efficiency

- **Manifest pinning:** every manifest is content-hashed (§7 I-1). Claude can reference "workspace A's run #42 manifest" from workspace B without copying files.
- **Branch-aware workspaces:** a workspace may declare `git.branch` in its manifest; `benny doctor` flags drift.
- **Portable knowledge:** ChromaDB, Neo4j data, and lineage all live under `<SSD_ROOT>/data/`, so moving the SSD moves Claude's accumulated context with it.

### 5A.5 New acceptance criteria for 5A

- **AC-5A-1** *Given* a workspace with indexed code + docs, *when* Claude calls `context.brief(workspace, topic)`, *then* the response is ≤ 8k tokens and includes manifest summary, top-k RAG hits with citations, and an LOD graph slice.
- **AC-5A-2** *Given* two manifest ids, *when* `manifests.diff(a, b)` is called, *then* the response lists added/removed/changed nodes and edges as a structured JSON delta.
- **AC-5A-3** *Given* Claude calls `delegate_to_local` for a `code_edit_small` task, *when* lineage is queried, *then* it shows `initiator=claude, executor=local, provider=lemonade` and zero Anthropic calls for that node.
- **AC-5A-4** *Given* the SSD is moved to a second host, *when* Claude calls `context.brief` on the same workspace, *then* the same manifest + RAG results are returned (modulo model-call nondeterminism).

### 5A.6 Phase placement

5A does not add phases — it constrains Phase 4 (MCP surface) and Phase 5 (local executor capabilities). Specifically, the tools in 5A.2 **are** the Phase 4 deliverable; the delegation policy in 5A.3 **is** the Phase 5 acceptance baseline.

---

## 6. Architecture (Target)

```
┌───────────────────────── External SSD ($BENNY_HOME) ─────────────────────────┐
│                                                                              │
│   ┌──────────┐   ┌────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│   │  CLI     │   │  Studio UI │   │ MCP Server   │   │  Python SDK      │    │
│   │ benny_*  │   │  (React)   │   │ benny-mcp    │   │  benny_sdk       │    │
│   └────┬─────┘   └─────┬──────┘   └──────┬───────┘   └────────┬─────────┘    │
│        └───────────────┴─────────────────┴────────────────────┘              │
│                                  │                                           │
│                          ┌───────▼────────┐                                  │
│                          │  FastAPI core  │  ← /plan /run /runs /events      │
│                          └───────┬────────┘                                  │
│                                  │                                           │
│        ┌─────────────────────────┼─────────────────────────┐                 │
│        ▼                         ▼                         ▼                 │
│  ┌───────────┐          ┌─────────────────┐       ┌────────────────┐         │
│  │ Planner   │          │  Run Engine     │       │  LLM Router    │         │
│  │ (manifest)│          │  (LangGraph)    │       │  claude|local  │         │
│  └─────┬─────┘          └────────┬────────┘       └──┬─────────┬───┘         │
│        │                         │                   │         │             │
│        ▼                         ▼                   ▼         ▼             │
│  ┌───────────┐          ┌─────────────────┐   ┌─────────┐ ┌─────────┐        │
│  │  Neo4j    │          │  OpenLineage    │   │ Claude  │ │ Local   │        │
│  │ (graph)   │          │  Marquez        │   │ API     │ │ LLM     │        │
│  └───────────┘          └─────────────────┘   └─────────┘ └─────────┘        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Model (invariants only)

- **I-1** A Manifest is the immutable triplet `(schema_version, content_hash, body)`.
- **I-2** A Run is the triplet `(run_id, manifest_hash, started_at)` plus an append-only event log.
- **I-3** A Provider call is `(run_id, node_id, provider_id, model_id, tokens_in, tokens_out, latency_ms, cost_est_usd, outcome)`.
- **I-4** All timestamps are UTC, ISO-8601, millisecond precision.
- **I-5** All paths stored in data are `$BENNY_HOME`-relative.

---

## 8. 6σ Safety — Declared Invariants & Controls

The quality target applies to these four invariants; each has automated detection and an enforcement gate.

| ID | Invariant | Detection | Gate |
|---|---|---|---|
| **SR-1** | No absolute host path in any persisted artifact | regex scan at write-time + nightly sweep | reject write; CI fails on match |
| **SR-2** | No run references a manifest hash that doesn't exist | foreign-key check on event insert | 500 on API; run refuses to start |
| **SR-3** | No plaintext secret under `$BENNY_HOME` | entropy + known-prefix scan (AKIA, sk-, ghp_, etc.) in pre-commit and at `benny doctor` | block write/commit |
| **SR-4** | Offline mode makes zero outbound calls | iptables/Windows Filtering Platform test harness | test suite fails the release |

### 8.1 DMAIC mapping

- **Define:** invariants SR-1..SR-4 above.
- **Measure:** defect-per-million-opportunities (DPMO) tracked per release via the test matrix in §10; target ≤ 3.4.
- **Analyze:** every SR-* failure spawns a root-cause entry in `docs/requirements/PBR-postmortems/`.
- **Improve:** control-chart the DPMO across the last 10 releases; any upward trend blocks the next release.
- **Control:** the §10 test matrix is the permanent control plan; pre-commit hooks + CI enforce it.

---

## 9. Acceptance Criteria (per requirement)

Format: **Given / When / Then**, all automatable.

### 9.1 Portability

- **AC-FR1..5-a** *Given* an SSD with `$BENNY_HOME` populated, *when* the SSD is moved to a second host of the same OS family and `benny up` is invoked, *then* `benny doctor` returns `ok` within 30 s with no writes outside `$BENNY_HOME`.
- **AC-FR1..5-b** *Given* any run artifact, *when* scanned, *then* zero matches for regex `^[A-Za-z]:\\|^/home/|^/Users/` outside documented allowlist.
- **AC-FR1..5-c (profile parity)** *Given* the same manifest + inputs, *when* executed once under `--profile app` and once under `--profile native`, *then* the resulting DAG, node ids, and artifact hashes are identical; only execution metadata (container id vs. pid) differs.
- **AC-FR1..5-d (workspace durability)** *Given* the app is reinstalled (`benny uninstall --keep-data && benny init --profile app`), *when* `benny up` runs, *then* all workspaces under `<SSD_ROOT>/workspaces/` remain intact and queryable.

### 9.2 Manifest & Plan-Run

- **AC-FR6..9-a** *Given* a requirement + input refs, *when* `POST /plan` is called, *then* response body is a valid manifest (JSON-schema-validated) and no run exists.
- **AC-FR10..14-a** *Given* a planned manifest, *when* `POST /run` is called, *then* `run_id` is returned and the first event appears on SSE within 2 s.
- **AC-FR10..14-b** *Given* two identical planned manifests on two hosts, *when* run with the same pinned inputs, *then* the DAG structure (node ids, edges) is byte-identical.

### 9.3 Routing & Claude Integration

- **AC-FR15..18-a** *Given* a node resolved to a local provider via `model_roles` or `executor_override`, *when* the run executes that node, *then* the `LLMCallFacet` shows `provider=lemonade` (or other local) and no outbound Anthropic call is made.
- **AC-FR15..18-b** *Given* `--offline` and a manifest that requires `claude`, *when* run, *then* it fails closed with exit code 78 and a clear error.
- **AC-FR19..22-a** *Given* Claude Code connected to `benny-mcp`, *when* Claude calls `delegate_to_local` with a code-edit task, *then* the local LLM returns a result and lineage records `initiator=claude, executor=local`.

### 9.4 Observability & Recovery

- **AC-FR23..25-a** *Given* a completed run, *when* `benny logs <run_id>` is run, *then* every node appears exactly once in temporal order with provider tag.
- **AC-NFR6-a** *Given* a corrupted `data/runs/<run_id>`, *when* deleted, *then* all other runs remain queryable and `benny doctor` returns `ok`.

### 9.5 6σ Gates

- **AC-SR1-a** Pre-commit hook rejects a commit that introduces an absolute path in a tracked artifact.
- **AC-SR3-a** Pre-commit hook rejects a commit that introduces a plaintext secret matched by the known-prefix scanner.
- **AC-SR4-a** Offline test harness blocks all egress; the test suite runs green.

---

## 10. Test Strategy (Test-Driven)

Tests are the specification. Code exists to make them pass. Order: write tests first, watch them fail, then implement.

### 10.1 Test pyramid

| Layer | Count target | Tooling | Must pass before |
|---|---|---|---|
| Unit | majority | pytest, vitest | every PR |
| Contract (JSON-schema, OpenAPI) | ~30 | schemathesis, ajv | every PR |
| Integration (API + local LLM + lineage) | ~40 | pytest + docker-compose for Marquez + Ollama | every PR |
| Portability (move SSD simulation) | ~10 | scripted on CI runner matrix (win-latest, ubuntu-latest, macos-latest) | every release |
| 6σ invariant (SR-*) | 1 per SR-* | dedicated harness | every release; failure blocks merge |
| End-to-end (Claude-as-orchestrator) | ~8 | recorded Anthropic API cassettes + live smoke | every release |

### 10.2 Key test cases (names locked in; implementers create these files first)

- `tests/portability/test_no_absolute_paths.py::test_scan_finds_none`
- `tests/portability/test_move_ssd_simulation.py::test_second_host_starts_clean`
- `tests/manifest/test_schema_roundtrip.py::test_plan_output_is_valid`
- `tests/routing/test_executor_honored.py::test_local_node_never_calls_claude`
- `tests/routing/test_offline_fails_closed.py::test_offline_refuses_claude_node`
- `tests/claude/test_mcp_server_surface.py::test_plan_run_tail_delegate`
- `tests/claude/test_delegate_to_local.py::test_lineage_tags_initiator_and_executor`
- `tests/safety/test_secrets_scanner.py::test_blocks_aws_openai_github_tokens`
- `tests/safety/test_egress_blocked.py::test_offline_has_zero_outbound`
- `tests/observability/test_logs_linear_ordering.py::test_every_node_once_in_order`

### 10.3 6σ test budget

At release, run the SR-* harness for 10,000 iterations per invariant. Allowed defects: `ceil(3.4e-6 * 10_000) = 1` per invariant, across the rolling 10 releases. Any release that breaches the budget is blocked.

---

## 11. Implementation Plan (phased, declarative, each phase ends on green tests)

Every phase has: **Deliverable**, **Tests written first**, **Exit criteria**. No phase "completes" until its tests are green.

### Phase 0 — Safety nets (no feature work)
- **Deliverable:** pre-commit hooks for SR-1, SR-3; CI wiring; test scaffolding.
- **Tests-first:** `test_no_absolute_paths`, `test_secrets_scanner`.
- **Exit:** hooks run locally and in CI; sample offending commit is rejected.

### Phase 1a — `$BENNY_HOME` layout, config loader, init/doctor/uninstall  ✅ **done**
- **Deliverable:** directory layout (FR-1), `benny.portable.home` with `init/validate/uninstall`, `benny.portable.config` with FR-2 enforcement using the Phase 0 scanner, CLI subcommands `benny init/doctor/uninstall`. Seeds `config/benny.toml`, `voices.json`, `server_ops_allowlist.json`. Profile lock (`state/profile-lock`) refuses cross-profile re-init. `uninstall --keep-data` preserves workspaces, data, models, config, state.
- **Tests-green:** `test_benny_home_layout` (7), `test_config_refuses_absolute_paths` (4), `test_move_ssd_simulation` (1), `test_profile_parity` (3), `test_workspace_survives_reinstall` (2). All 17 Phase 1a tests + the 22 Phase 0 tests passing.
- **Exit:** `benny init --home <root> --profile {app|native}` creates a valid tree; `benny doctor` returns ok; moving the tree to a second location still validates without edits.

### Phase 1b — Service boot + portable launchers (pending)
- **Deliverable:** `bin/benny`, `bin/benny-ui`, `bin/benny-llm` launchers that resolve paths relative to themselves; `benny up`/`benny down` that actually start Neo4j (server mode), Lemonade (port 13305), FastAPI, and the UI under both profiles; `app/compose.yml` template; `app/image.tar` build pipeline.
- **Tests-first:** `test_benny_up_reports_healthy`, `test_benny_down_cleans_pids`, `test_neo4j_server_reachable_both_profiles`.
- **Exit:** unplug SSD, plug into second host, `benny up` returns healthy on both profiles within NFR-1 budget.

### Phase 2 — Manifest schema + plan/run endpoints
- **Deliverable:** `SwarmManifest` Pydantic schema, JSON-schema artifact, `POST /plan`, `POST /run`, SSE events, content-hash + signature.
- **Tests-first:** `test_schema_roundtrip`, `test_plan_output_is_valid`.
- **Exit:** UI and CLI both consume the same manifest; parallel schemas removed.

### Phase 3 — Role resolver hardening + portability of LLM Manager config
- **Deliverable:** harden `get_active_model()` ([benny/core/models.py](benny/core/models.py:266)) with the new roles from §4.4 FR-15a; add `executor_override` honoring; persist `activeLLMProvider` into `WorkspaceManifest.metadata`; ship `<SSD_ROOT>/config/voices.json` and `server_ops_allowlist.json`; replace the hardcoded chat model in [NotebookChat.tsx:80](frontend/src/components/Notebook/NotebookChat.tsx:80); add `--offline` enforcement in `call_model()`.
- **Tests-first:** `test_local_node_never_calls_claude`, `test_offline_refuses_claude_node`, `test_role_resolution_order`, `test_executor_override_wins`.
- **Exit:** a manifest with mixed roles (Claude for `plan`/`long_form_gen`, Lemonade for everything else) runs correctly; `LLMCallFacet` shows correct provider/model/role per node; no code references the removed `providers.toml`.

### Phase 4 — MCP server + Python SDK for Claude
- **Deliverable:** `benny-mcp` (stdio MCP server), `benny_sdk` package, documented tool surface (plan/run/tail/get_manifest/list_runs/delegate_to_local).
- **Tests-first:** `test_mcp_server_surface`, `test_delegate_to_local`.
- **Exit:** Claude Code registered against the MCP server can plan, run, tail, and delegate.

### Phase 5 — Local LLM executor capabilities (LC-1..LC-4)
- **Deliverable:** typed task specs (`code_edit_small`, `server_ops`, `doc_summarize`, `manifest_dryrun`) with local handlers and allowlists.
- **Tests-first:** one per LC-*, plus an allowlist escape test.
- **Exit:** Claude can hand off all four task types; allowlist violations fail closed.

### Phase 6 — Observability & doctor
- **Deliverable:** `benny logs`, `benny doctor`, Marquez on `$BENNY_HOME/data/lineage`, linear log merger.
- **Tests-first:** `test_every_node_once_in_order`, `test_doctor_reports_violations`.
- **Exit:** single-call diagnostic of a misconfigured install pinpoints the issue.

### Phase 7 — 6σ release gates
- **Deliverable:** SR-* harness runners in CI; release script that refuses to tag when DPMO > target.
- **Tests-first:** harness self-tests (inject a known defect, confirm the gate fires).
- **Exit:** first "clean release" passes all four SR-* budgets.

### Phase 8 — Migration tooling
- **Deliverable:** `benny migrate` (rewrites launchers + line endings for cross-OS moves), `benny import-legacy` (pulls current C-drive Benny data into `$BENNY_HOME`).
- **Tests-first:** `test_migrate_win_to_posix`, `test_import_legacy_idempotent`.
- **Exit:** the user's current install is imported without loss.

---

## 12. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | SSD unplug mid-run | M | H | run engine writes append-only WAL per node; `benny doctor` detects stale locks and offers safe resume |
| R-2 | Python/Node runtime tied to host | H | H | embed runtimes under `runtime/`; never rely on system `PATH` |
| R-3 | Cross-OS line-ending / path-separator drift | M | M | `benny migrate` as the only supported cross-OS path |
| R-4 | Claude API key leakage into SSD | L | H | age-encrypt; secret scanner in pre-commit; SR-3 gate |
| R-5 | Local LLM hallucination on server-ops tasks | M | H | allowlist + dry-run + require explicit confirmation for mutating ops |
| R-6 | Model drift between Claude versions | M | M | pin concrete model ids in `MODEL_REGISTRY` + workspace `model_roles`; record model id in every `LLMCallFacet` |
| R-7 | OneDrive sync collides with `$BENNY_HOME` | H (if left on OneDrive path) | H | `benny doctor` refuses to start if `$BENNY_HOME` is inside a known sync root |

---

## 13. Open Questions

All open questions are now closed.

- **Q-1 ✅ Local LLM runtime = Lemonade** (AMD NPU, port 13305, already wired in [manage_llm.bat](manage_llm.bat) and [benny/core/models.py](benny/core/models.py) `LOCAL_PROVIDERS`). Ollama/llama.cpp retained as *optional* fallbacks, not defaults.
- **Q-2 ✅ Neo4j server mode** on the SSD. Neo4j runs as a managed service (container in `app` profile, native service in `native` profile), data under `<SSD_ROOT>/data/graph/`. Chosen for large-graph performance; data stays portable with the SSD.
- **Q-3 ✅ Two install profiles + containerised app with workspaces kept separate.**
  - **`--profile app` (newbie):** the Benny app ships as a **packaged OCI image** (Docker Desktop or `podman`) that mounts `<SSD_ROOT>/data/`, `<SSD_ROOT>/workspaces/`, `<SSD_ROOT>/models/`, `<SSD_ROOT>/config/` as volumes. One command up, one command down. The image is the unit of release and is version-pinned.
  - **`--profile native` (expert):** services run natively from `<SSD_ROOT>/runtime/` for hot-reload, debugging, and direct Lemonade/NPU access. Same data layout, same manifests, same APIs — just no container boundary.
  - **Workspaces are always outside the app boundary.** They live under `<SSD_ROOT>/data/workspaces/` and survive app-image upgrades or full reinstalls. The app is disposable; the workspaces are the asset.
- **Q-4 ✅ Always side-load via `benny models pull`.** Base install stays ≤ 8 GB; model weights live under `<SSD_ROOT>/models/` and are fetched on demand. The installer never bundles weights.
- **Q-5 ✅ `<SSD_ROOT>` = `D:/optimus`** (volume name: *Optimus*). `benny init --home D:/optimus --profile app|native`.

---

## 14. Definition of Done (for the whole project)

1. All acceptance criteria in §9 pass in CI on the portability matrix (win / ubuntu / macos).
2. 6σ gates (§8) green for the most recent release and the previous nine.
3. A naive reader (human or model) can follow this document + the test suite and reproduce the system on a fresh SSD in ≤ 2 hours.
4. The existing C-drive Benny install is fully migrated via `benny import-legacy` with zero data loss.
5. Claude Code, via `benny-mcp`, can plan, run, tail, and delegate without any repo-specific context beyond this document.

---

## 15. Appendix — Canonical commands (contract-level)

```bash
# Setup (once per SSD) — pick one profile
benny init --home D:/optimus --profile app       # newbie: pulls pinned OCI image into D:/optimus/app/
# or
benny init --home D:/optimus --profile native    # expert: installs runtime under D:/optimus/runtime/

benny providers check                            # probes LOCAL_PROVIDERS (Lemonade first); validates workspace model_roles
benny models pull qwen2.5-coder-7b               # side-load local LLM weights into D:/optimus/models/

# Daily use (same verbs, both profiles)
benny up                                         # app: docker compose up; native: spawns services directly
benny plan  requirements.md -o plan.json
benny run   plan.json
benny tail  <run_id>
benny logs  <run_id>
benny doctor
benny down

# Claude-as-orchestrator
#   register benny-mcp in Claude Code settings; then from Claude:
#     plan(requirement, inputs) -> manifest
#     run(manifest) -> run_id
#     tail(run_id) -> events
#     delegate_to_local(task_spec) -> result
```

---

*End of PBR-001.*
