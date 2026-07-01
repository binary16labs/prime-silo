# Plan: Home Unification, UI Status Surfacing, and Guide Cleanup

**Date:** 2026-07-01 · **Status:** Proposed · **Related:** ADR-001 (determinism boundary), PBR-001 (portable home), HOME-DIRECTORY.md

---

## 1. Problem statement (grounded in the current code)

### 1.1 Four competing "homes"

The app resolves *where its data lives* in four independent ways, and they only
agree by accident:

| # | Mechanism | Set by | Read by | Default |
|---|-----------|--------|---------|---------|
| 1 | `config.homeDir` in `%APPDATA%\Prime-Silo\prime-silo-config.json` | Tray "Configure Home Directory…" (`packaging/desktop/tray.js:70`) | IPC `space-desktop:get-home-directory` (`packaging/desktop/main.js:2347`) | `null` ("not configured") |
| 2 | `config.bennyHome` (same config file, **different key**) | Tray "Configure Benny Home…" (`tray.js:318-339`) | `runtime_supervisor.js:56 resolveManagedBennyHome()` → exported as `BENNY_HOME` | per-user default passed by shell |
| 3 | `CUSTOMWARE_PATH` | env var / `node space set` / serve args (`commands/supervise.js:236`) | Space server (Node) | packaged: `userData/customware` (`main.js:825`); dev: whatever the shell has |
| 4 | Repo-relative fallbacks | nobody (implicit) | `runtime/benny/core/workspace.py:18` falls back to `Path("workspace")` when `BENNY_HOME` unset; `benny init` seeds `benny.bat`/`benny.sh` into the repo root (`portable/home.py:432`) | the git checkout itself |

Consequences visible today:

- The repo contains a populated `prime-silo/home/` tree (agentamp, kg3d_cache,
  runs, workspaces…) and a `workspace/` dir — dev runs silently wrote state
  **into the git checkout** instead of the declared home.
- `runtime/` is polluted with run debris: `run_output*.txt`, `fix_ports*.py`,
  `debug_out.txt`, `lineage_test.txt`, `test_*.py|pdf|md`, `extracted_outputs*.json`.
- The tray shows "Home" and "Benny Home" as two unrelated settings; changing
  one does not move the other, and `CUSTOMWARE_PATH` follows neither.
- HOME-DIRECTORY.md documents only mechanism #1 and never mentions
  `bennyHome` or `CUSTOMWARE_PATH`.

### 1.2 UI does not reflect process status

The backend already has what we need:

- SSE streams: `runtime/benny/api/live_routes.py` (`/live/enrich/events/{run_id}`),
  plus SSE in `rag_routes.py`, `graph_routes.py`, `studio_executor.py`,
  `workflow_endpoints.py`, `kg3d.py`.
- Lineage per run: `/live/runs/{ws}/{run_id}/lineage`, CLP drilldown, and the
  widgets `widgets/run/lineage_timeline`, `widgets/run/drilldown_table`,
  `widgets/run/reasoning_trace`.

But the frontend consumes none of the SSE. Every screen rolls its own polling:
`mission_control.js:52` (`setInterval liveSync`), `lifelog.js:37`,
`bridge.js:1676 pollDeepProduce` (2.5–3 s timeouts), `bridge.js:1832
pollStudioCell`. There is no global "what is running right now" surface — a run
kicked off in one screen is invisible everywhere else until the user navigates
to the right panel and its poller happens to fire. Status vocabulary and badge
colors also differ per screen.

### 1.3 Guides

Docs are plentiful but describe the *old* fragmented reality (HOME-DIRECTORY.md,
GUIDE.md, QUICKSTART-EXE.md, CLAUDE.md each explain a different slice of path
config), and there is no in-app answer to "where is my data / what is running".

---

## 2. Target model

**One declared home, one resolver, everything derived.**

```
PRIME_SILO_HOME/                  ← the single declared home
├── customware/                   ← CUSTOMWARE_PATH (Space server L1/L2)
├── benny/                        ← BENNY_HOME (portable runtime: bin, config,
│                                    data, workspaces, models, logs, state…)
└── home.json                     ← provenance marker (schema ver, created-by)
```

Resolution precedence (highest wins), identical in every process:

1. `PRIME_SILO_HOME` env var (explicit operator override — CI, docker, dev)
2. `homeDir` in `prime-silo-config.json` (tray-configured)
3. Per-user default: `app.getPath("userData")/prime-silo-home` (packaged) —
   **never** a repo-relative path.

Explicit overrides of the derived paths (`BENNY_HOME`, `CUSTOMWARE_PATH` env)
remain honored for advanced setups, but the resolver *logs a divergence
warning* when they point outside the declared home.

---

## 3. Implementation phases

### Phase 0 — Repo hygiene (½ day, zero risk)

1. Delete/relocate scratch from `runtime/`: `run_output*.txt`, `debug_out.txt`,
   `lineage_test.txt`, `fix_ports*.py`, `fix_manifests.py`, `check_mp.py`,
   `test_*.py|pdf|md|txt`, `extracted_outputs*.json`, `summary.csv`,
   `debug_workflows_utf8.json` → `scratch/` (already gitignored) or delete.
2. Move the accidentally-populated `prime-silo/home/` and `prime-silo/workspace/`
   state out of the repo (offer to migrate into the declared home in Phase 1's
   migration step; for now archive to `scratch/legacy-home/`).
3. `.gitignore`: add `home/`, `workspace/`, `runtime/run_output*`,
   `runtime/scratch*` so regressions can't be committed.
4. Stop `benny init` writing wrappers into the repo root
   (`portable/home.py:_seed_project_entry_points`, called at `home.py:432`):
   seed them into `$BENNY_HOME/bin/` only; keep repo wrappers as committed,
   static files if still wanted for dev.

**Verify:** `git status` clean after a full `benny init` + dev boot; SR-1
portability suite still green (`pytest tests/portability`).

### Phase 1 — Single home authority (2–3 days)

1. **Node resolver** — new `packaging/desktop/home_resolver.js` (also consumed
   by `commands/` via a shared lib): `resolveHome()` returns
   `{ root, customwarePath, bennyHome, source: "env"|"config"|"default", warnings[] }`.
   - `main.js:825` stops hardcoding `userData/customware` → uses resolver.
   - `runtime_supervisor.js:resolveManagedBennyHome` → uses resolver;
     `config.bennyHome` becomes a *legacy* input (see migration).
   - `commands/supervise.js` / `serve.js`: when `CUSTOMWARE_PATH` is not
     explicitly given, derive from resolver instead of erroring.
2. **Python resolver** — `runtime/benny/portable/home.py` gains
   `resolve_home()`; `core/workspace.py:18` **drops the `Path("workspace")`
   fallback**: unset `BENNY_HOME` → resolve via `PRIME_SILO_HOME`, else fail
   loud with a message naming the tray menu / env var. No silent repo writes.
3. **One tray entry** — collapse "Configure Home Directory…" and "Configure
   Benny Home…" into a single "Configure Home…" that sets `homeDir`; show
   `Home: <path> (source: config)` with the derived benny/customware paths as
   read-only children. Restart-runtime prompt on change.
4. **Migration on boot** — if legacy `config.bennyHome` or old-style
   `config.homeDir` exist and diverge from the new layout: keep honoring them,
   surface a one-time tray notification + Setup-screen banner offering
   "Adopt unified home" (moves/links `benny/` + `customware/` under the
   declared root, then clears legacy keys).
5. **Introspection** — `/api/home` (Space server) returns the resolved triple +
   provenance; `benny doctor` prints the same and flags divergence (env
   override pointing outside declared home, legacy keys still active,
   repo-relative state detected).

**Verify:** matrix test — packaged EXE fresh install, packaged with legacy
config, dev `node space serve`, bare `benny` CLI — all four report the same
resolved home via `/api/home` and `benny doctor`; new unit tests for both
resolvers (precedence, divergence warnings); grep-gate test asserting no
module outside the resolvers reads `BENNY_HOME`/`CUSTOMWARE_PATH` env directly.

### Phase 2 — UI run/process status (3–4 days)

1. **Unified activity feed (backend)** — add `/live/events` SSE on the runtime
   aggregating run lifecycle events (queued/planning/running/stage-completed/
   succeeded/failed/cancelled) across pypes, enrich, studio, deep-produce;
   heartbeat every 15 s. Reuse the emitters behind the existing per-feature
   SSE routes in `live_routes.py`/`studio_executor.py` — this is fan-in, not
   new instrumentation. Lineage stage counts ride along so progress = stages
   done / total.
2. **Shared status store (frontend)** — one module
   `app/L0/_all/mod/_prime_silo/runtime_client/activity-store.js`: single
   `EventSource` with automatic reconnect + poll fallback (`/api/runs?limit=…`)
   when SSE is unavailable; publishes to subscribers. Migrate
   `bridge.js pollDeepProduce/pollStudioCell`, `mission_control.js liveSync`,
   `lifelog.js pollLifelog` to subscribe instead of owning timers.
3. **Global activity indicator** — persistent element in the Bridge cockpit
   chrome (and mission_control header): N running (spinner + current stage),
   toasts on completion/failure, badge for unseen failures. Click-through →
   the run's `lineage_timeline` / `drilldown_table` / `reasoning_trace` view,
   fixing the current "lineage exists but only after manual drill-in" gap.
4. **Status vocabulary + theming** — one canonical enum
   (`pending|planning|running|succeeded|failed|cancelled`) mapped once in the
   scoped earth-tone `colors.css`; all badges/chips consume it. Normalize any
   API responses that emit variant strings.
5. **Home visibility in UI** — Setup and Mission Control show the resolved
   home + provenance from `/api/home`, with a warning chip when the runtime's
   `BENNY_HOME` diverges from the shell's declared home (the exact class of
   bug Phase 1 eliminates, kept visible as a tripwire).

**Verify:** launch a pypes run from Bridge → indicator appears everywhere
within 1 event, progresses per stage, failure produces toast + working
drill-through; kill the SSE connection → poll fallback keeps status moving;
no screen owns a bare `setInterval` for run status anymore.

### Phase 3 — Guides (1–2 days, after 1–2 land)

1. Rewrite **HOME-DIRECTORY.md** as the single home reference: the unified
   layout, precedence rules, migration path, `benny doctor` / `/api/home`
   introspection. Fold the path fragments out of GUIDE.md, QUICKSTART-EXE.md,
   CLI.md, CLAUDE.md into links to it.
2. **First-run experience**: Setup screen gains a "Home" step — shows the
   default, lets the user relocate before anything writes; replaces the
   current "(not configured)" dead-end.
3. **In-app "Where is my data?"** panel (Setup): resolved paths, open-folder
   buttons, disk usage per subtree — reusing `/api/home`.
4. Update `INDEX.md` and agent docs (AGENT-AWARENESS.md, both CLAUDE.md files)
   so agents query `/api/home` instead of the three legacy patterns currently
   documented.

---

## 4. Ordering, risk, effort

| Phase | Effort | Risk | Depends on |
|-------|--------|------|-----------|
| 0 hygiene | ~½ day | none | — |
| 1 home authority | 2–3 days | medium (packaged-app migration) | 0 |
| 2 UI status | 3–4 days | low (additive; pollers removed screen-by-screen) | ships alone, but home chip needs 1 |
| 3 guides | 1–2 days | none | 1, 2 |

Biggest risk is Phase 1 step 4 (existing installs with `config.bennyHome`
pointing at a lived-in home). Mitigation: never move data automatically —
honor legacy keys indefinitely, migrate only on explicit user action, and keep
`benny doctor` divergence reporting so the state is always inspectable.
