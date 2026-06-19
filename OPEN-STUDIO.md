# Open-Studio — integration plan & handover

> **Shareable, self-contained handover.** Any agent (including a smaller/cheaper one)
> can pick up a single phase below and execute it cold. Each phase lists its goal,
> exact files, steps, verification, and gotchas. Update the **Status** table when a
> phase lands.

## Vision

Fold two mature open-source tools into the existing `binary16` stack instead of building
those slices from scratch:

- **opencode** (sst/opencode) — a local-first coding agent → becomes a **third audited
  agent** in memo-ray, and (Phase 3) an **execution backend** Benny can delegate coding to.
- **open-notebook** (lfnovo/open-notebook) — the open NotebookLM alternative → a
  **knowledge source** that feeds memo-ray's lineage graph and (Phase 2b) Benny's RAG.

Two product moves on top:
1. **memo-ray = the universal local-agent audit layer.** Today it ingests + audits Claude,
   Gemini/Antigravity, opencode, and open-notebook through one repeatable 4-seam pattern.
2. **Benny = a floating German Shepherd** — an in-cockpit overlay (4a, done) and a
   standalone OS-level desktop pet (4b, done).

Decision log: target opencode + open-notebook; **extend memo-ray + prime-silo in place**
(no new repo); floating dog phased (overlay → desktop pet); Benny breed = German Shepherd.

## Repos & layout (all under `C:\Users\nsdha\OneDrive\binary16\`, which is NOT itself a git repo)

- `memo-ray/` (git) — Agent OS Dashboard. Node/Express server + Vite/React client. Port **3030**.
  - server: `agent-os-dashboard/server/` · client: `agent-os-dashboard/client/src/`
- `prime-silo/` (git) — Benny runtime (vendored, `runtime/`) + Space-Agent shell (`app/`, `server/`)
  + Electron desktop (`packaging/desktop/`).

## Status

| Phase | What | State | Verified |
|------|------|-------|----------|
| 1 | opencode audited in memo-ray | ✅ done | parser → 4 sessions/87 entities; capabilities OK; client builds |
| 2 | open-notebook ingested + audited in memo-ray | ✅ done | notebook+note → Session+Thought; 6 transformations audited; client builds |
| 2b | open-notebook sources → Benny RAG | ⏳ export done, ingest untested | bridge `scripts/openstudio-notebook-bridge.mjs`; export verified e2e vs mock; ingest POST needs live Benny |
| 3 | opencode as a Benny execution backend | ⏳ built, live run untested | adapter `tools/opencode.py` + route `POST /api/opencode/run`; compiles, plumbing tested; needs Benny+ollama for a live coding run |
| 4a | Benny overlay reskinned to dog (in-cockpit) | ✅ done | SVG renders; refs repointed; not run in live app |
| 4b | Standalone desktop-pet window | ✅ done | 4 desktop files `node --check` OK; not run in live Electron |
| 5 | Unify packaging/tray/release | ⏳ services + tray + skill done | `packaging/desktop/openstudio_services.js` + tray controls + per-install ON key; DevOps skill added; **desktop:pack build succeeds** (Space Agent.exe, pet files bundled). Full runtime-bundle of opencode/open-notebook = future |

## Architecture coordinates (memorize these)

| Thing | Where | Notes |
|------|-------|------|
| memo-ray API | `http://localhost:3030/api` | `/system/capabilities`, `/beta/overview`, `/setup/status`, `/sync` |
| memo-ray runtime config | `~/.memoray/memoray.config.js` | **auto-generated** from `server/lib/config.js`+`lib/detector.js`; the repo `memoray.config.js` is a template |
| memo-ray data | `~/.memoray/data/entities/*.json` + `index.json` | one JSON file per entity |
| opencode config | `~/.config/opencode/opencode.json` | providers/models/mcp/permission |
| opencode sessions | `~/.local/share/opencode/storage/{session,message,part}/…` | JSON tree (project→session→message→part) |
| open-notebook UI / API | `http://localhost:8502` / `http://localhost:5055` | docker-compose at `C:\Users\nsdha\docker-compose.yml` |
| open-notebook storage | SurrealDB `:8000` (root/root, ns+db `open_notebook`) | reach via the 5055 REST API, not the DB |
| Benny RAG ingest | `POST /api/runtime/rag/ingest` (space-agent proxy) → Benny `POST /rag/ingest` | **ingests files from the workspace `data_in/` dir**, NOT raw text in the body |
| Benny API auth | header `X-Benny-API-Key: benny-mesh-2026-auth` | required unless path whitelisted |
| Benny workspace data_in | `$BENNY_HOME/workspaces/<workspace>/data_in/` | drop files here, then ingest |

## The repeatable audit pattern (how to add ANY new local agent to memo-ray)

All four seams live in `memo-ray/agent-os-dashboard/server`:

1. **Paths** — add keys to the repo template `memoray.config.js` AND the generator in
   `lib/config.js` (`generateConfigContent`), so freshly-generated configs include them.
   Code should **fall back to a default** when the user's existing generated config lacks
   the key (existing installs won't have it).
2. **Detect** — `lib/detector.js`: add `PROBE_LISTS` + `GUIDES`, and register the key in
   `singleKeys`/`arrayKeys` inside `detectPaths()`. (URLs aren't filesystem paths — skip
   the detector for those; use a literal default instead, like `OPEN_NOTEBOOK_API_URL`.)
3. **Parse** — new `parsers/<agent>Parser.js`, modeled on `claudeParser.js` /
   `opencodeParser.js` (file tree) or `openNotebookParser.js` (HTTP client). Emit entities
   `{id,type,agent,timestamp,content,metadata,parent_id,children_ids}` with MD5 ids;
   types: `Session | User Input | Thought | Message | Tool Call | Tool Result | Artifact`.
   `agent` string lowercased becomes the overview "agentKey". Reuse the local `saveEntity`/
   `updateParentChild`/`loadIndex` helpers (each parser has its own copies).
4. **Audit + wire** — in `index.js`: `require` the parser, call its `sync*()` in
   `performSync()`, add a block to `/api/system/capabilities` (what the agent is allowed
   to do), add the agent key to `agentSummary` in `/api/beta/overview`, and add a column in
   `client/src/components/OverviewGrid.jsx` (+ `SetupWizard.jsx` for path-based agents).

Files already added this way: `parsers/opencodeParser.js`, `parsers/openNotebookParser.js`.

---

# Phase playbooks (remaining / reference)

## Phase 2b — open-notebook sources → Benny RAG

**Goal:** notebook sources land in Benny's knowledge graph (ChromaDB chunks + optional
Neo4j triples), reusing Benny's existing `/rag/ingest` — no new ingestion code in Benny.

**Key fact:** `runtime/benny/api/rag_routes.py :: /rag/ingest` ingests files already present
in `$BENNY_HOME/workspaces/<ws>/data_in/`. The request body is `{workspace, files?,
deep_synthesis, ...}` — it does **not** accept raw text. So the bridge is two steps:
**(A) export sources to files in `data_in/`**, then **(B) trigger ingest**.

**Implementation:** `prime-silo/scripts/openstudio-notebook-bridge.mjs` (Node, no deps).
- Env: `OPEN_NOTEBOOK_URL` (default `http://localhost:5055`), `BENNY_DATA_IN` (target
  `data_in` dir), `BENNY_INGEST_URL` (default `http://localhost:3000/api/runtime/rag/ingest`),
  `BENNY_API_KEY` (default `benny-mesh-2026-auth`), `BENNY_WORKSPACE` (default `default`).
- Step A: `GET /api/notebooks` → for each, `GET /api/sources?notebook_id=…`; for each source
  fetch full text (`source.full_text`, else `GET /api/sources/{id}`, else
  `GET /api/sources/{id}/download`); write `data_in/<safe-title>.md`.
- Step B (unless `--no-ingest`): `POST` ingest with `{workspace, deep_synthesis:true}`.

**Run / test:**
```
# export only (safe, no Benny needed):
node prime-silo/scripts/openstudio-notebook-bridge.mjs --data-in "<BENNY_HOME>/workspaces/default/data_in" --no-ingest
# then, with Benny running, trigger ingest:
node prime-silo/scripts/openstudio-notebook-bridge.mjs --data-in "<…>/data_in"
```
**Verify:** files appear in `data_in/`; ingest returns `{status:"completed", total_documents}`;
`GET /api/runtime/rag/status` shows the new sources; ask Benny a question grounded in them.

**Gotchas:** open-notebook list endpoints often return `content`/`full_text` = null — always
fall back to the per-source detail/download endpoint. Sanitize titles into safe filenames.
Benny only ingests `.txt/.md/.pdf/.docx/.pptx/.html`. Auth header required on the Benny API.

## open-notebook model configuration (config-driven)

open-notebook needs 7 model roles set before sources can be added/processed. This is
**config-driven** so the operator can change models without touching code:
- Config: `scripts/openstudio-models.config.json` — providers (LM Studio + Lemonade reached at
  `host.docker.internal` because open-notebook is containerized) + model registrations + the
  role→model map.
- Apply (idempotent): `node scripts/configure-open-notebook-models.mjs` — upserts credentials +
  models, sets the 7 defaults, tests chat + embedding. Re-run any time after editing the config.

Scanned + wired on this machine (combination of local engines):
- **LM Studio** (`:1234/v1`) for the heavy roles — `google/gemma-4-12b-qat` → chat, transformation,
  large-context; `text-embedding-nomic-embed-text-v1.5` → embedding (768-dim, tested OK).
- **Lemonade NPU** (`:13305/api/v1`) for the light roles — `Qwen3-8B-Hybrid` → tools; `kokoro-v1`
  → text-to-speech; `Whisper-Large-v3-Turbo` → speech-to-text.

**Gotchas:** open-notebook is in Docker → host tools MUST be `host.docker.internal`, not localhost;
and LM Studio must "serve on local network" / Lemonade bind 0.0.0.0 for the container to reach them.
Heavy models (gemma-12b) JIT-load on first request, so the built-in connectivity test can time out
while cold even though the wiring is correct — warm the model once and re-test. Embedding model must
stay consistent between ingest and query (re-embedding needed if you change it).

## Phase 3 — opencode as a Benny execution backend  (built; live run untested)

**Goal:** Benny delegates *coding* tasks to opencode instead of growing its own coding agent.

**Built:**
- `runtime/benny/tools/opencode.py` — stdlib-only adapter. `opencode_available()` +
  `run_opencode_task(prompt, cwd, model?, agent?, timeout?)`. Runs `opencode run <prompt>
  [-m provider/model] [--agent A]` headless in `cwd`, captures stdout/stderr/returncode, and
  (when `cwd` is a git repo) the `git diff` + changed-file list opencode produced.
- `runtime/benny/api/opencode_routes.py` — `GET /api/opencode/status` and
  `POST /api/opencode/run` `{prompt, workspace, subdir?, model?, agent?, timeout?}`. Confines
  the run to the workspace root (ADR-001 review zone; rejects `subdir` that escapes), creates a
  TaskManager task, and lineage-tracks start/complete/fail.
- Registered in `runtime/benny/api/server.py` (import + `include_router(..., prefix="/api/opencode")`).

**Free win:** opencode logs already land in memo-ray (Phase 1), so every Benny-dispatched
coding run is auto-lineage-tracked there too.

**Verify (needs Benny runtime + ollama up):**
```
curl localhost:<benny>/api/opencode/status -H "X-Benny-API-Key: benny-mesh-2026-auth"
curl -X POST localhost:<benny>/api/opencode/run -H "X-Benny-API-Key: benny-mesh-2026-auth" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"create hello.py that prints hi","workspace":"default","model":"ollama/gpt-oss:20b"}'
```
Expect `status:"completed"`, `output`, and a `git.changed_files` list (if the workspace is a git
repo). The opencode session also appears in memo-ray's lineage graph after its next sync.

**Follow-ups (not done):** wire this as a first-class swarm/manifest node type (the node executor
in `api/studio_executor.py` dispatches `trigger/llm/data/logic` — add an `opencode` tool path
there) and gate it behind an explicit HITL approval node for mutating runs.

## Phase 4 — floating dog (DONE; reference)

- **4a overlay:** assets `app/L0/_all/mod/_core/visual/res/chat/overlay/dog_no_bg.svg`
  (draggable avatar) + `dog_head_256.svg` (chat avatar), German Shepherd. Repointed in
  `_core/onscreen_agent/panel.html` (avatar `<img src>`) and `view.js` (`assistantAvatarPath`).
  CSS does `object-fit:contain` on a square cluster + float + scaleX flip + edge-hide rotate,
  so a square/centered/shadowless SVG drops in. Module is documentation-first — its
  `AGENTS.md` was updated.
- **4b desktop pet:** `packaging/desktop/pet.js` (frameless transparent alwaysOnTop
  BrowserWindow; create/destroy/toggle + ipc `space-desktop:pet-open-cockpit`/`pet-hide`),
  `pet-preload.js` (contextBridge `window.benny.openCockpit/hide`), `pet.html` (GSD inlined,
  `-webkit-app-region: drag`, hover chat-paw + close). Wired in `main.js` (require, tray opts
  `togglePet`/`isPetVisible`, `destroyDesktopPet()` in `prepareDesktopForQuit`) and a tray
  toggle in `tray.js`. `build.files` already globs `packaging/desktop/**/*` so they bundle.
- **Not yet run in a live build.** To verify: build the desktop app and toggle "Show Benny on
  desktop" from the tray.

## Phase 5 — unify packaging, tray & release  (services + tray + skill done)

**Built:**
- `packaging/desktop/openstudio_services.js` — start/stop `opencode serve`; start/stop
  open-notebook via `docker compose up -d/down`; `isOpencodeServeRunning` / `isOpenNotebookRunning`
  probes; `ensureEncryptionKey()` generates+persists a per-install `OPEN_NOTEBOOK_ENCRYPTION_KEY`
  (replaces the hardcoded `=benny`); `stopAllOpenStudioServices()` for quit.
- `packaging/desktop/tray.js` — tray entries (shown only when the tool is on PATH): opencode
  start/stop, open-notebook start/stop, "Open Notebook UI". `main.js` calls
  `stopAllOpenStudioServices()` in `prepareDesktopForQuit()`.
- **DevOps skill** at `.claude/skills/devops-pipeline/SKILL.md` — codifies build types,
  release flow, gates, and these services. Invoke for "build the app / cut a release / package".
- **Build verified:** `npm run desktop:pack` succeeds → `dist/desktop/windows/win-unpacked/
  Space Agent.exe` (~201 MB); all new desktop files (`pet.*`, `openstudio_services.js`) + dog
  SVGs confirmed bundled.

**Future (not done):** bundle opencode + open-notebook *inside* the installer (extend
`packaging/runtime-bundle/` + `runtime_supervisor.js` the way the Benny runtime is bundled), so a
zero-install user gets them without a separate `opencode`/`docker` install. Mind the release lesson:
push `main` before the tag or build jobs are skipped; validate with `desktop:localtest` before tagging.

---

## How to test the whole audit layer quickly

```
# memo-ray (port 3030):
cd memo-ray/agent-os-dashboard/server && npm start
curl localhost:3030/api/system/capabilities   # claude / antigravity / opencode / openNotebook blocks
curl localhost:3030/api/beta/overview          # agents: {claude, antigravity, opencode, opennotebook}
# open-notebook must be up for its audit block:  docker compose -f C:\Users\nsdha\docker-compose.yml up -d
```

memo-ray ingests on boot + every 30s; opencode/open-notebook entities appear in the lineage
graph and Setup page after a sync.

## Notes for the next agent

- Each memo-ray parser keeps its **own** copies of `saveEntity/loadIndex/hash/updateParentChild`
  — match that pattern; don't refactor into a shared module unless asked.
- When editing the heavily-documented `_core/onscreen_agent/`, update its `AGENTS.md` in the
  same change (documentation-first contract).
- Private running notes live in the author's memory file
  `project_open_studio_opencode_audit.md` (not in this repo) — this doc is the shareable copy.
