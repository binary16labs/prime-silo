# Memo-Ray → Prime-Silo merge — integration plan & handover

> **Shareable, self-contained handover.** Any agent (including a smaller/cheaper one)
> can pick up a single phase below and execute it cold. Each phase lists its goal,
> exact files, steps, verification, and gotchas. Update the **Status** table when a
> phase lands.

## Vision

Stop maintaining **two** applications. Fold **memo-ray** (the Agent OS Dashboard /
memory graph) into **prime-silo** so there is exactly one repo, one release pipeline,
one installer, and one app the user runs — **with no loss of memo-ray features**.

Chosen strategy (decided with the owner, 2026-06-27):

- **Merge depth = Option A — bundle memo-ray's server as a child service** inside
  prime-silo. memo-ray stays CommonJS and runs as its own process on a local port;
  prime-silo's existing proxy already points at it. Lowest risk, fastest path to "one
  app." (Option B, an in-process merge, and Option C, full native absorption, remain
  open as later refactors behind the same proxy seam — not required for one-app.)
- **Client + MCP** — **port the remaining memo-ray client views** into prime-silo's
  shell UI (so nothing is lost when the standalone Vite client is retired), and
  **fold memo-ray's MCP server** into prime-silo.

Why this is cheap: prime-silo **already** treats memo-ray as a first-class subsystem.
The integration seam exists and is signed. We are mostly wiring memo-ray onto rails
that are already there (the same rails the Open-Studio companion services use).

## Repos & layout (all under `C:\Users\nsdha\OneDrive\binary16\`, which is NOT itself a git repo)

- `memo-ray/` (git) — Agent OS Dashboard. Node/Express server + Vite/React client + MCP server. Port **3030**.
  - server: `agent-os-dashboard/server/` · client: `agent-os-dashboard/client/src/` · mcp: `mcp-server/`
- `prime-silo/` (git) — Benny runtime (vendored, `runtime/`) + Space-Agent shell (`app/`, `server/`), Electron desktop (`packaging/desktop/`).
  - **vendored memo-ray lands at `prime-silo/memoray/`** (this plan).

## What already exists in prime-silo (do NOT rebuild)

The integration is architected and signed. Single source of truth:
`manifests/integrations/memoray.integration.json` (schema `aamp.integration/1`),
held against `GET /api/integration_audit`.

| Seam | Owner path (prime-silo) | Status |
| --- | --- | --- |
| Shell proxy `/api/memoray/*` → `127.0.0.1:3030` | `server/lib/memoray_proxy.js` | ✅ done |
| Browser client helpers | `app/L0/_all/mod/_prime_silo/memoray_client/memoray-client.js` | ✅ done |
| Command Center widget | `app/L0/_all/mod/_prime_silo/widgets/memoray/overview_cards/` | ✅ done |
| Lineage graph widget | `app/L0/_all/mod/_prime_silo/widgets/memoray/lineage_graph/` | ✅ done |
| Memory review page | `app/L0/_all/mod/_prime_silo/memory/view.html` | ✅ done |
| `memory-recall` agent skill | `app/L0/_all/mod/_prime_silo/memoray_client/ext/skills/memory-recall/` | ✅ done |
| `node space memory` CLI | `commands/memory.js` | ✅ done |
| Conformance audit | `server/api/integration_audit.js` | ✅ done |
| Dev boot of the sibling checkout | `scripts/memoray.ps1` (+ `scripts/dev.ps1` auto-boot) | ✅ done (points at `../memo-ray`) |

What lives **only** in memo-ray and must come over:

- **Backend** — `agent-os-dashboard/server/` (Express server, parsers for Claude /
  Antigravity / opencode / open-notebook, entity store, system metrics).
- **Standalone React client** — `agent-os-dashboard/client/` (Command Center grid,
  omnibar search, entity inspector, Setup wizard). Prime-silo has re-skinned *some*
  of this as widgets; the rest is the Phase 2 port target.
- **MCP server** — `mcp-server/` (memory graph over MCP).

## Architecture coordinates (memorize these)

| Thing | Where | Notes |
| --- | --- | --- |
| memo-ray API | `http://127.0.0.1:3030/api` | `/system/capabilities`, `/beta/overview`, `/sessions`, `/graph/{id}`, `/lifelog`, `/sync` |
| memo-ray runtime config | `~/.memoray/memoray.config.js` | **auto-generated** from `server/lib/config.js` + `lib/detector.js`; repo `mem0ray.config.js` is a template |
| memo-ray data | `~/.memoray/data/entities/*.json` + `index.json` | one JSON file per entity; in-memory store cached by `index.json` mtime |
| Port discovery | `apps.lock.json` (binary16 registry) | server reads its resolved port at boot; prime-silo proxy reads the same lock → always agree |
| Proxy URL resolution | `server/lib/memoray_proxy.js :: resolveMemoraySettings` | precedence: runtime param `MEMORAY_BASE_URL` → `prime-silo.config.json` `memoray` block → `apps.lock.json` → default `:3030` |
| Sync cadence | memo-ray ingests on boot + every 30s | opencode/open-notebook entities appear after a sync |
| Module system | memo-ray = **CommonJS** (`require`); prime-silo server = **ESM** (`import`) | Option A keeps memo-ray a separate process → **no conversion needed** |

## Companion-service rails to reuse (the precedent)

prime-silo already starts/stops sidecar processes from the desktop app. Model the
memo-ray child service on these:

- `packaging/desktop/openstudio_services.js` — start/stop opencode + open-notebook;
  `which()` PATH probe; spawn + `on('exit'/'error')`; `stopAll…()` on quit.
- `packaging/desktop/runtime_supervisor.js` + `runtime_fetch.js` + `packaging/runtime-bundle/`
  — how the Benny runtime (Python/Neo4j/JRE) is supervised / zero-install fetched.
- `packaging/desktop/main.js` — wires services: `require(...)` near line 15–17,
  `stopAllOpenStudioServices()` in `prepareDesktopForQuit()` (~line 1055).
- `packaging/desktop/tray.js` — tray entries for service start/stop.
- `package.json` `build.files` — glob of what ships in the installer (currently
  `app/`, `server/`, `commands/`, `scripts/`, `packaging/desktop/**`, … — **not**
  `runtime/`, which is fetched at first launch).

## Status

| Phase | What | State | Verified |
| ----- | ---- | ----- | -------- |
| 0 | Vendor memo-ray into `prime-silo/memoray/` (server + mcp-server) | ✅ done | vendored server boots from new home; `/api/beta/overview` → 3223 nodes |
| 1 | Boot memo-ray as a bundled child service (dev + desktop + tray) | ✅ done (live packaged build untested) | `node --check` + eslint clean on memoray_service.js / main.js / tray.js; service resolves vendored entry; `memoray_proxy_test` green; ps1 scripts parse OK |
| 2 | Make ALL memo-ray screens native prime-silo pages | ✅ done | All 5 screens (lifelog, mission_control, setup, session_graph, **step_through**) **verified in-shell**, earth-tone theme sticks, 0 console errors. Manifest v1.3.0 re-signed, conformance tests green. |
| 3 | Fold memo-ray MCP server into prime-silo's MCP config | ✅ done | Vendored mcp-server data-path fixed (reads ~/.memoray/data), registered via prime-silo/.mcp.json; smoke-tested (returns live sessions). |
| 4 | Zero-install bundle (Electron-as-node + extraResources) | ✅ done | `desktop:pack` ships server + 68 deps (sample data excluded); bundled copy boots `200`; build-time dep guard. **Repo-retire decided AGAINST — standalone memo-ray repo kept (intentional vendored fork; may drift).** |

> **Phase 1 remaining verification:** run `npm run desktop:pack`, launch `Space Agent.exe`,
> confirm Memo-Ray auto-starts (Memory page populated), the tray Start/Stop toggle works,
> and the child is killed on quit. The `extraResources` entry in `package.json` ships
> `memoray/server` to `resources/memoray/server` for the packaged path.

---

# Phase playbooks

## Phase 0 — Vendor memo-ray into prime-silo

**Goal:** the memo-ray backend + MCP server live inside the prime-silo repo, self-contained.

**Steps:**

1. Copy `memo-ray/agent-os-dashboard/server/` → `prime-silo/memoray/server/`
   (preserve `lib/`, `parsers/`, `data_model_abstract.md`, `icon.ico`, `package.json`,
   `package-lock.json`). Keep CommonJS as-is.
2. Copy `memo-ray/mcp-server/` → `prime-silo/memoray/mcp-server/`.
3. Copy the config template `memo-ray/mem0ray.config.js` → `prime-silo/memoray/mem0ray.config.js`.
4. Decide on `node_modules`: copy them over for an instant-runnable vendor, **or** run
   `npm install` in `prime-silo/memoray/server` and `…/mcp-server`. Either works; a
   fresh `npm install` is cleaner for git hygiene (add `prime-silo/memoray/**/node_modules`
   to `.gitignore`).
5. Do **not** copy the standalone Vite client yet — Phase 2 ports its views. (The
   client is only needed if you want memo-ray's own UI served standalone; the plan is
   to retire it.)

**Verify:** `node prime-silo/memoray/server/index.js` boots and
`curl 127.0.0.1:3030/api/beta/overview` returns the rollup; `node --check` passes on the
server entry.

**Gotchas:** the server resolves its port from `apps.lock.json` via `lib/registry.js`
under the key `mem0ray` / `memory-graph` — keep that key. Its data/config still live at
`~/.memoray/` (per-user), so vendoring the code does not move user data.

## Phase 1 — Boot memo-ray as a bundled child service

**Goal:** launching prime-silo (dev or desktop) starts memo-ray automatically; quitting stops it. One app to the user.

**Steps:**

1. **`packaging/desktop/memoray_service.js`** (new) — modeled on `openstudio_services.js`:
   - `startMemoray()` — spawn `node <appRoot>/memoray/server/index.js` with
     `stdio:"ignore"`, track the child, handle `exit`/`error`. Resolve the server path
     for both dev (repo) and packaged (resources) layouts.
   - `stopMemoray()` / `isMemorayRunning()`.
   - `stopAllMemorayServices()` for quit.
2. **`packaging/desktop/main.js`** — `require("./memoray_service")` beside the other
   service requires (~line 15); call `startMemoray()` during desktop startup; call
   `stopMemoray()` inside `prepareDesktopForQuit()` (~line 1055, beside
   `stopAllOpenStudioServices()`).
3. **`packaging/desktop/tray.js`** — add "Start/Stop Memo-Ray" + "Open Memory" tray
   entries (mirror the opencode/open-notebook entries).
4. **`scripts/memoray.ps1`** — repoint the default `MEMORAY_DIR` from the sibling
   `../memo-ray` to the vendored `prime-silo/memoray` (and its `server/` subdir). Keep
   `MEMORAY_DIR` override working so an external checkout can still be used. Drop or
   guard the Vite client launch (the client is being retired; only the server is needed).
   `scripts/dev.ps1` auto-boot then picks up the vendored copy with no change.
5. **`package.json` `build.files`** — add `"memoray/server/**/*"` (and
   `"memoray/mcp-server/**/*"` if shipping MCP now) so the child is present in packaged
   builds. Exclude `node_modules` you don't need; include the ones the server requires
   (express, cors, systeminformation, systray2 if used).

**Verify:**
- Dev: `scripts/dev.ps1` (or `scripts/memoray.ps1`) boots the vendored server; the
  Bridge Pulse / Command Center widgets render live data through the proxy;
  `node space memory status` reports connected.
- `GET /api/integration_audit` (or `node space memory audit`) still passes — the proxy
  owner path is unchanged, so conformance should be green.
- Desktop: `npm run desktop:pack`, launch `Space Agent.exe`, confirm memo-ray starts on
  its own (Memory page populated) and the tray toggles work; quitting kills the child.

**Gotchas:**
- The proxy needs **no** change — it already resolves the URL from `apps.lock.json`.
- In a packaged app, `node` may not be on PATH. Spawn via Electron's bundled node
  (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`) the way `runtime_supervisor.js`
  launches node-based children — don't assume a system `node`.
- Ensure the registry resolver has run so `apps.lock.json` exists before the server
  boots, or the server falls back to `:3030` (fine for single-instance).

## Phase 2 — Make ALL memo-ray screens native (owner directive 2026-06-27)

**Goal:** every memo-ray screen is a **native prime-silo page** (not just the Bridge,
and not an embedded React app), so the standalone Vite client is retired with zero
feature loss.

**Decoupled architecture (the pattern every screen follows).** prime-silo pages are
**Alpine.js views**, not React. The decoupling the owner asked for = split each
memo-ray screen into three layers, all in the one app:

1. **Data layer (shared):** `app/L0/_all/mod/_prime_silo/memoray_client/memoray-client.js`
   — `memorayFetch` / `readMemorayJson` / `isMemorayOffline` / `isMemorayDisabled`.
   Every screen + widget goes through this; nothing calls `:3030` directly (the shell
   proxy at `/api/memoray/*` is the one CORS/policy chokepoint).
2. **Widget layer (reusable, vanilla):** `widgets/memoray/<name>/index.js` factories
   `createXWidget(host, props, { memorayClient })` returning `{ update, refresh, destroy }`
   + a sibling `.css`. All DOM + rendering lives here.
3. **Page layer (thin Alpine view):** `mod/_prime_silo/<page>/` = `view.html`
   (`x-data="<page>()"`, `x-init`, `x-destroy`) + `<page>.js`
   (`window.<page> = function(){ return { state, init(), destroy(), … } }`) + `<page>.css`,
   registered in the shell nav via `<page>/ext/panels/<page>.yaml`
   (`name / path / description / icon / color`). Pages compose widgets + the data layer;
   they hold view state only.

**Screen map (memo-ray React → native prime-silo target):**

| memo-ray screen (client/src) | Native target | Status |
| --- | --- | --- |
| `App.jsx` Setup gate + `SetupWizard.jsx` | `mod/_prime_silo/setup/` page over `/setup/*` | ✅ Phase 2c |
| `BetaDashboard.jsx` "Mission Control" (landing) | `mod/_prime_silo/mission_control/` (reuses `overview_cards` + `heatmap_radar` + omnibar, live sync) | ✅ Phase 2b landing |
| `BetaDashboard.jsx` step-through *player* (playback / gamepad / narrator / diff / current-step graph) | `mod/_prime_silo/step_through/` (reuses `lineage_graph`; highlights current node via `data-node-id`) | ✅ done |
| `AgentLifelog.jsx` + `HeatmapRadar.jsx` | `mod/_prime_silo/lifelog/` + `widgets/memoray/heatmap_radar/` | ✅ Phase 2a |
| `UnifiedDashboard.jsx` + `OrganicGraph.jsx` "Session Graph" | standalone `mod/_prime_silo/session_graph/` (reuses `lineage_graph`) | ✅ Phase 2d |
| `OverviewGrid.jsx` | already ported → `widgets/memoray/overview_cards` | ✅ pre-existing |

**Theme (owner directive):** the memo-ray palette (earth tones; dyslexia/ADHD-friendly
muted contrast, roomy line-height; Anthropic restraint) was being washed out by the
shell. Fixed with a shared scoped theme
`memoray_client/memoray-theme.css` (`.mray-theme`) that re-binds both memo-ray's own
vars and the generic shell token names within each memo-ray page subtree. Every native
memo-ray page (memory, lifelog, mission_control, setup, session_graph) opts in via the
`mray-theme` class — verified the tokens (`--accent`/`--sage`/Inter/heat ramp) resolve
to the earth-tone palette in-shell.

**Widget UX fix:** `overview_cards` + `heatmap_radar` gained a silent `refresh(true)` so
Mission Control's live 10s sync swaps fresh data in place instead of flashing the
loading state.

**Re-sign / conformance:** `memoray.integration.json` bumped to v1.2.0 with the new
endpoints (`heatmap_stats`, `setup_status`, `setup_save`, `open_folder`) + process_map
nodes (theme, heatmap_radar, lifelog, mission_control, setup, session_graph, mcp_server)
and re-signed. **Sign with the real key**: `BENNY_HMAC_KEY` lives in `prime-silo/.env`
and the running server verifies with it — re-sign via
`BENNY_HMAC_KEY=$(grep ^BENNY_HMAC_KEY= .env | cut -d= -f2-) node scripts/audit-integrations.mjs --sign`
(signing without it uses a fallback key → live signature drift). Gating tests
(integration_audit, integration_manifest, memoray_proxy, widgets_overview_cards) all green.

**Step-Through Audit player (`mod/_prime_silo/step_through/`)** — full faithful port of
BetaDashboard's step-through: timeline grouping (read-tool collapsing), hero-text caption,
"Why?" (nearest preceding Thought), raw/diff content, downsampled milestone scrubber (≤600
segs), playback (play/pause + 1–20× speed), ←/→ keyboard, gamepad (bumpers/D-pad), optional
speech narrator, and the `lineage_graph` map highlighting + (when Tracking) scrolling to the
current node via its `data-node-id`. Deep-linkable `?session_id=`; session-picker fallback;
"▶ Step through this session" button added to the Session Graph page. Verified in-shell:
"Step 3 of 800", hero/scrubber/highlight all track on navigation, 0 console errors. (The
React original's organic-vs-layered toggle is preserved — see the adaptive graph below.)

**Adaptive lineage graph (owner request):** `lineage_graph` now takes
`layoutMode: auto|linear|force` (+ `forceThreshold`, default 60). `auto` renders the
calm layered **SVG** for small sessions and swaps to the free-floating **force graph**
(the existing `widgets/force_graph_2d` — glow, trace particles, minimap, the "Memo-Ray
drilldown" look) above the threshold. Highlight + camera-tracking work in both (SVG:
`.is-current` + `scrollIntoView`; force: rust glow + `centerAt`, added via a
`props.track` path in force_graph_2d). The Step-Through player drives it through the
widget (`update({highlightIds, track, layoutMode})`) and exposes an **Auto / Linear /
Free-floating** toggle. Default `layoutMode` is `linear`, so Memory + Session Graph
pages are unchanged. Verified in-shell: 800-node session → auto-force (canvas+minimap),
toggle → linear SVG, highlight tracks in both, 0 console errors. (Backward-compat:
`widgets_memoray_lineage_graph_test` + `widgets_force_graph_2d_test` green.)

**Known flake (pre-existing, not from this work):** the audit `health` probe of
`/ecosystem/manifest` can exceed its 5s timeout on a cold large dataset (~12s cold,
~0.15s warm) and report a false "unreachable". Warm it (one prior call) or raise the
audit timeout; memo-ray is up.

**Headless verify gotchas:** (1) the shell gates every page behind `/enter` — set
`sessionStorage['space.enter.tab-access']='1'` *on the served origin* then navigate.
(2) `node space serve` resolves its own PORT via the registry and will bump off a taken
port (e.g. 3000→3020), so the preview's assigned proxy port may not match — read the
"listening at …" line (preview_logs) and drive the browser at the actual port.

**Endpoints note:** `/heatmap-stats` and `/setup/*` exist on the server (`memoray/server/index.js`)
but are NOT yet declared in `memoray.integration.json` — add them to `endpoints` +
`process_map` and re-sign in Phase 2d so the conformance audit covers the new screens.

**Steps per screen:** build the three layers above → register the panel yaml →
deep-link/teleport via `window.location.hash` (e.g. lifelog rows jump to
`#/_prime_silo/memory?session_id=<id>`) → lint (`eslint`) → verify data shape against a
booted `memoray/server` → add a gating test beside `tests/widgets_memoray_*` /
`tests/memory_page_test.mjs`.

**Phase 2a (done):** `widgets/memoray/heatmap_radar/{index.js,heatmap_radar.css}` +
`mod/_prime_silo/lifelog/{view.html,lifelog.js,lifelog.css,ext/panels/lifelog.yaml}`.
Verified: eslint clean; server serves `/lifelog` (200 items: id/sessionId/type/agent/
project/timestamp/content) + `/heatmap-stats` (days + stats) with the exact shapes the
code consumes. **In-shell live render still unverified** (needs `node space serve` +
the booted memo-ray child).

**Final:** update `memoray.integration.json` `process_map` with all new pages/widgets +
the `/heatmap-stats` `/setup/*` endpoints, then **re-sign** via
`scripts/audit-integrations.mjs --sign`; `GET /api/integration_audit` green.

## Phase 3 — Fold in the MCP server

**Goal:** the memory graph is reachable over MCP from the one app.

**Steps:**

1. Vendored at `prime-silo/memoray/mcp-server/` (Phase 0). Confirm it reads the same
   `~/.memoray/data` / API the dashboard server uses.
2. Register it in prime-silo's MCP configuration so prime-silo exposes (or consumes)
   the memory-graph MCP tools from a single place.
3. Optionally start/stop it alongside the dashboard server in `memoray_service.js`.

**Verify:** MCP client lists the memo-ray tools and a memory query returns results.

## Phase 4 — Zero-install bundle ✅ (repo-retire step still open)

**Goal:** a double-click user gets memo-ray with no separate Node/install.

**How it works (simpler than the Python/Neo4j runtime bundle):** memo-ray is plain
Node, and `packaging/desktop/memoray_service.js` already spawns it via
`process.execPath` + `ELECTRON_RUN_AS_NODE=1` — Electron **is** the Node runtime, so
there is nothing to download. The server + its deps ship inside the installer via
`extraResources`; the supervisor isn't needed.

**What landed:**

1. `package.json` `build.extraResources` ships the server to `resources/memoray/server`:
   - one entry for the source (`filter: ["**/*","!data/**","!node_modules/**","!**/*.log"]` —
     the per-user entity store at `~/.memoray/data` is the real data, so the in-repo
     sample `data/` is excluded), and
   - **a SEPARATE entry for `memoray/server/node_modules`** — electron-builder's parent
     glob does NOT descend into a nested `node_modules`, so it must be its own
     `extraResources` entry or the shipped server can't `require('express')`. (Learned
     the hard way: the first build shipped index.js but no deps.)
2. `packaging/scripts/desktop-builder.js :: ensureMemorayServerDeps()` runs
   `npm install --omit=dev` in `memoray/server` before packaging when `node_modules` is
   absent (gitignored → missing on a clean CI clone), so the bundle is always complete.
3. `memoray_service.resolveServerEntry()` already prefers `resourcesPath/memoray/server`.

**Verified:** `npm run desktop:pack` (`--dir`) succeeds → `win-unpacked/Space Agent.exe`
present; `resources/memoray/server` has index.js + node_modules (68 pkgs incl.
express/cors/systeminformation), sample `data/` excluded; running the **bundled** server
copy standalone returns `200` on `/api/beta/overview` (self-contained). Launching the GUI
EXE to confirm auto-boot is the one manual step left (the spawn path matches the proven
Benny runtime supervisor pattern).

**Repo-retire — DECIDED AGAINST (owner, 2026-06-27): keep the standalone `memo-ray`
repo.** People may want a standalone memory-graph without prime-silo, so the original
repo stays published and is **not** archived. Consequence: `prime-silo/memoray/` is now
an **intentional vendored fork** — a point-in-time snapshot of `memo-ray/agent-os-dashboard/server`
(+ `mcp-server`), not a live link. The two **will drift**.

- **To pull upstream memo-ray fixes into the merged app:** re-vendor — re-copy
  `memo-ray/agent-os-dashboard/server` → `prime-silo/memoray/server` (and `mcp-server`),
  keeping the prime-silo-only edit to `memoray/mcp-server/data-reader.js` (the
  `~/.memoray/data` resolution — see Phase 3). Then re-run conformance + a `desktop:pack`.
- **To run the standalone version instead of the vendored child** (dev): set
  `MEMORAY_DIR` to the external checkout — `scripts/memoray.ps1` and `scripts/dev.ps1`
  both honour it (vendored `<dir>/server` and upstream `<dir>/agent-os-dashboard/server`
  layouts are auto-detected). The standalone repo keeps its own Vite client + tray.
- `apps.registry.json` / `apps.lock.json` keep memo-ray as a discoverable app (the
  port key is shared by both the standalone server and the bundled child — no conflict
  since only one runs at a time on a given port).

**Gotchas (release):** push `main` **before** the tag or the build jobs are skipped;
validate with `npm run desktop:localtest` before tagging (lesson from v1.2.8 → v1.2.9).

---

## How to test the memory layer quickly

```
# vendored memo-ray server (port 3030):
cd prime-silo/memoray/server && node index.js
curl 127.0.0.1:3030/api/system/capabilities   # claude / antigravity / opencode / openNotebook blocks
curl 127.0.0.1:3030/api/beta/overview          # agents rollup

# through the prime-silo proxy (shell running):
curl <shell>/api/memoray/beta/overview
node space memory status
node space memory audit
```

## Notes for the next agent

- memo-ray's 4-seam audit pattern (paths / detect / parse / audit, all under
  `server/`) is unchanged by this merge — see `OPEN-STUDIO.md` for how to add a new
  audited agent.
- Each memo-ray parser keeps its **own** copies of `saveEntity/loadIndex/hash/
  updateParentChild` — match that; don't refactor into a shared module unless asked.
- Re-sign `memoray.integration.json` after any `process_map` edit, or the conformance
  audit fails.
- Private running notes live in the author's memory files (`project_open_studio_*`,
  `memo_ray_token_audit_validation.md`) — this doc is the shareable copy.
