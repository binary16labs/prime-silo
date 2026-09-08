# Estate sitemap

Every surface the estate presents, grouped by the job it does. Generated from the code by
`scripts/sitemap_build.mjs` and checked both ways: each node resolves to a real panel,
view and endpoint, and every registered panel appears here. The build fails rather than
show a map that has drifted.

18 surfaces · 57 API routes · 25 commands

## Decide

### Gov — `#/_prime_silo/gov`

The signing queue — what Benny has proposed, what it rests on, and the decisions you have already made.

Calls: `/api/gov_proposals` · `/api/gov_sign`

Source: `app/L0/_all/mod/_prime_silo/gov`

### Release — `#/_prime_silo/release`

What the estate has published and whether anyone can install it — feed coverage per platform, and the signed decision that publishing requires.

Calls: `/api/gov_raise` · `/api/release_publish` · `/api/release_state`

Source: `app/L0/_all/mod/_prime_silo/release`

## Prove

### Benny Record — `#/_prime_silo/benny_record`

Replay how the pipeline produced any output — every model call, gate verdict, retrieval and ingest, step by step — with a token meter, gate chips, a model/ctx/commit badge, a live telemetry tail, and a lineage map that follows the current step.

Calls: `/api/longview_ledger` · `/api/longview_record`

Source: `app/L0/_all/mod/_prime_silo/benny_record`

### Lineage — `#/_prime_silo/lineage`

Total lineage — every subject the estate has recorded, its history step by step, and an honest measure of what is not recorded at all.

Calls: `/api/lineage_index` · `/api/lineage_trail`

Source: `app/L0/_all/mod/_prime_silo/lineage`

### Manifests — `#/_prime_silo/manifest_explorer`

Deterministic-zone manifest registry — inspect signed swarm manifests as DAGs.

Source: `app/L0/_all/mod/_prime_silo/manifest_explorer`

## Watch

### Bridge — `#/_prime_silo/bridge`

Mission control for the whole cognitive mesh — memory, documents, code, flows and runs on one page, with Benny in the dock.

Calls: `/api/config_defaults` · `/api/integration_audit` · `/api/longview_run` · `/api/longview_status` · `/api/longview_stop` · `/api/runtime` · `/api/workflows_run`

Source: `app/L0/_all/mod/_prime_silo/bridge`

### Deck — `#/_prime_silo/deck`

The estate on a wall — one glanceable surface for what is waiting, what is proven, which machines are reporting, and what ran without authorisation.

Calls: `/api/deck_speak` · `/api/deck_state` · `/api/deck_voice`

Source: `app/L0/_all/mod/_prime_silo/deck`

### Mission Control — `#/_prime_silo/mission_control`

The Command Center — live ecosystem rollup, system resources and capabilities, the file-memory heatmap, activity radar, and an omnibar across sessions, files, and actions.

Source: `app/L0/_all/mod/_prime_silo/mission_control`

## Recall

### Lifelog — `#/_prime_silo/lifelog`

A unified timeline of git commits and agent actions across all workspaces, with an activity radar that filters the feed by day.

Source: `app/L0/_all/mod/_prime_silo/lifelog`

### Memory — `#/_prime_silo/memory`

The memory graph — your Claude + Antigravity agent sessions X-rayed into an explorable lineage map.

Calls: `/api/integration_audit`

Source: `app/L0/_all/mod/_prime_silo/memory`

### Memory Setup — `#/_prime_silo/setup`

Configure where the memory graph scans for agent activity — Claude, Antigravity, Gemini, and opencode log and config paths — with auto-detect status.

Source: `app/L0/_all/mod/_prime_silo/setup`

### Session Graph — `#/_prime_silo/session_graph`

A full-canvas lineage explorer — pick a session and walk its recursive graph of inputs, thoughts, tool calls, and touched files.

Source: `app/L0/_all/mod/_prime_silo/session_graph`

## Replay

### Step-Through — `#/_prime_silo/step_through`

Replay a session one action at a time — what happened, why, and the change it made — with playback, narration, and a lineage map that follows the current step.

Source: `app/L0/_all/mod/_prime_silo/step_through`

### Time Travel — `#/time_travel`

Undo settings, spaces, and custom development changes.

Source: `app/L0/_all/mod/_core/time_travel`

## Ask

### Agent — `#/agent`

Basic information and personal prompt tuning for the browser agent.

Source: `app/L0/_all/mod/_core/agent`

## Hold

### Files — `#/file_explorer`

Browse and edit app files.

Source: `app/L0/_all/mod/_core/file_explorer`

## Think

### Local LLM — `#/huggingface`

Load and test local LLMs with WebGPU and Hugging Face.

Source: `app/L0/_all/mod/_core/huggingface`

## Operate

### User — `#/user`

Update your full name and sign-in password.

Source: `app/L0/_all/mod/_core/user`

## Operated from a terminal

Parts of the estate with no panel — run these directly.

- `node scripts/app_onboard.mjs` — Onboard an application — the governed path from "I want this" to "the estate can prove it".
- `node scripts/artifact.mjs` — Artifact CLI — download once, place anywhere, and record who said so.
- `node scripts/audit-integrations.mjs` — Phase M1 — headless integration conformance audit (and manifest signer).
- `node scripts/audit-registry.mjs` — Conformance audit (and signer) for the decentralized app registry.
- `node scripts/configure-open-notebook-models.mjs` — Configure open-notebook's model roles from openstudio-models.config.json.
- `node scripts/estate.mjs` — estate — the operator CLI for the governed estate.
- `node scripts/estate_backup.mjs` — estate_backup — content-addressed backup of RAW session and tool data to a
- `node scripts/estate_key.mjs` — estate registration key — generate / inspect the shared per-estate secret that gates
- `node scripts/estate_satellite_agent.mjs` — estate satellite agent — RUNS ON THE SATELLITE (the ASUS). Announces the machine to the
- `node scripts/estate_satellite_pull.mjs` — satellite-pull — the governed satellite -> hub session pull.
- `node scripts/evidence_pack.mjs` — Generate the estate evidence pack.
- `node scripts/flows_build.mjs` — Process flows — a graph, checked as a graph.
- `node scripts/heartbeat_estate.mjs` — The estate board — every node's heartbeat, folded into one view.
- `node scripts/heartbeat_run.mjs` — One heartbeat sweep. Designed to be run on a schedule and to do nothing interesting
- `node scripts/inventory_sweep.mjs` — Estate inventory sweep — look at the world, then hold the ledger to it.
- `node scripts/manual_build.mjs` — Operating manual — one source, three consumptions, none of them hand-maintained.
- `node scripts/manual_load.mjs` — Load the operating manual into the agent's memory — graph facts and retrievable chunks.
- `node scripts/offload-report.mjs` — 
- `node scripts/offload-runner.mjs` — Q0: single resolution path — env BENNY_API_KEY -> per-install keystore
- `node scripts/openstudio-notebook-bridge.mjs` — Open-Studio bridge (Phase 2b): open-notebook sources -> Benny RAG.
- `node scripts/release_raise.mjs` — Publish a release through the estate instead of through a browser — raise, sign, dispatch, record.
- `node scripts/robustness_build.mjs` — Robustness diagrams — ICONIX, with the method's own rules enforced.
- `node scripts/run-workflows.mjs` — Q0: single resolution path — env BENNY_API_KEY -> per-install keystore
- `node scripts/sitemap_build.mjs` — Estate sitemap — derived from the code, checked in both directions.
- `node scripts/usecases_build.mjs` — Use cases — checked against the sitemap, in both directions.

## Routes with no panel

Reachable from a command line, an agent or an external client, but not from any screen.
Listed because an endpoint nobody can reach from the UI is a fact worth knowing, not a fault.

- `/api/agent_api`
- `/api/cloud_share_clone`
- `/api/cloud_share_create`
- `/api/cloud_share_download`
- `/api/cloud_share_info`
- `/api/debug_path_index`
- `/api/deck_kindle`
- `/api/extensions_load`
- `/api/file_copy`
- `/api/file_delete`
- `/api/file_info`
- `/api/file_list`
- `/api/file_move`
- `/api/file_paths`
- `/api/file_read`
- `/api/file_write`
- `/api/folder_download`
- `/api/git_history_diff`
- `/api/git_history_list`
- `/api/git_history_preview`
- `/api/git_history_revert`
- `/api/git_history_rollback`
- `/api/guest_create`
- `/api/health`
- `/api/home`
- `/api/login`
- `/api/login_challenge`
- `/api/login_check`
- `/api/module_info`
- `/api/module_install`
- `/api/module_list`
- `/api/module_remove`
- `/api/password_change`
- `/api/password_generate`
- `/api/space_import`
- `/api/user_crypto_bootstrap`
- `/api/user_crypto_session_key`
- `/api/user_self_info`
- `/api/workflows_api`
