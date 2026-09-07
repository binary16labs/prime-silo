# Estate sitemap

Every surface the estate presents, grouped by the job it does. Generated from the code by
`scripts/sitemap_build.mjs` and checked both ways: each node resolves to a real panel,
view and endpoint, and every registered panel appears here. The build fails rather than
show a map that has drifted.

16 surfaces · 51 API routes · 21 commands

## Decide

### Gov — `#/_prime_silo/gov`

The signing queue — what Benny has proposed, what it rests on, and the decisions you have already made.

Calls: `/api/gov_proposals` · `/api/gov_sign`

Source: `app/L0/_all/mod/_prime_silo/gov`

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

- `node scripts/app_onboard.mjs` — 
- `node scripts/artifact.mjs` — 
- `node scripts/audit-integrations.mjs` — 
- `node scripts/audit-registry.mjs` — 
- `node scripts/configure-open-notebook-models.mjs` — 
- `node scripts/estate.mjs` — 
- `node scripts/estate_backup.mjs` — shared workspace, with the quarantine boundary enforced at the copy edge.
- `node scripts/estate_key.mjs` — POST /api/estate/register.
- `node scripts/estate_satellite_agent.mjs` — hub so "just start prime-silo and it detects" becomes literal.
- `node scripts/estate_satellite_pull.mjs` — 
- `node scripts/evidence_pack.mjs` — 
- `node scripts/heartbeat_estate.mjs` — 
- `node scripts/heartbeat_run.mjs` — most of the time.
- `node scripts/inventory_sweep.mjs` — 
- `node scripts/manual_build.mjs` — 
- `node scripts/manual_load.mjs` — 
- `node scripts/offload-report.mjs` — 
- `node scripts/offload-runner.mjs` — ($BENNY_HOME/state/hmac-key) -> fail fast. No shipped default remains.
- `node scripts/openstudio-notebook-bridge.mjs` — 
- `node scripts/run-workflows.mjs` — ($BENNY_HOME/state/hmac-key) -> fail fast. No shipped default remains.
- `node scripts/sitemap_build.mjs` — 

## Routes with no panel

Reachable from a command line, an agent or an external client, but not from any screen.
Listed because an endpoint nobody can reach from the UI is a fact worth knowing, not a fault.

- `/api/agent_api`
- `/api/cloud_share_clone`
- `/api/cloud_share_create`
- `/api/cloud_share_download`
- `/api/cloud_share_info`
- `/api/debug_path_index`
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
- `/api/gov_raise`
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
