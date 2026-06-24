# Prime-Silo Operating Manual

The operator-facing companion to [ROADMAP.md](ROADMAP.md) (what's built) and
[OPERATING_PLAN.md](OPERATING_PLAN.md) (how to build it). This manual covers:

1. **What** Prime-Silo is and how its pieces fit together.
2. **Setting it up** from a clean machine.
3. **Booting** the runtime and shell.
4. **Using** every shipped feature end-to-end — walkthroughs, not API reference.
5. **Operating the boundary** between deterministic and agent-zone surfaces.
6. **Updating** the vendored Benny tree.
7. **Diagnosing** the things that go wrong most often.

If you only have five minutes, read §1, §2, and §3 — that's enough to boot. The
rest you can pull up when you need it.

> **Conventions.** Commands assume PowerShell on Windows or bash on macOS/Linux.
> Both are shown when they diverge. `$BENNY_HOME` is set to `<repo>/.benny_home`
> by the dev launcher; assume that path unless overridden.

---

## 1. What Prime-Silo is

Prime-Silo is two open-source projects glued together with a hard architectural
boundary between them:

| Half        | Source                                                                                          | Role                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime** | [`skybluecycology/benny`](https://github.com/skybluecycology/benny) (vendored under `runtime/`) | FastAPI service that owns manifests, runs, knowledge/code graphs, governance, lineage, HMAC keys. Stateless from the shell's POV. |
| **Shell**   | [`agent0ai/space-agent`](https://github.com/agent0ai/space-agent) (forked)                      | Node.js + browser. Routing, theming, navigation, widget composition, agent runtime, view persistence.                             |

The runtime is the **deterministic substrate** — every output is typed, signed,
and lineage-tagged. The shell is the **adaptive surface** — composable widgets,
agent-authored Review-zone layouts, pinned `.aamp.view` bundles.

### The two zones (ADR-001)

Two zones live inside the same shell:

| Zone               | Surfaces                                                                    | Agent can write?                      | Determinism guarantee                                                             |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| **Deterministic**  | Manifest authoring, run execution, KG / code-graph mutation, skill registry | No. Drafts → HITL → `sign_manifest()` | Every accepted state change is a signed manifest run with full lineage.           |
| **Review (fluid)** | Drill-down, frame inspection, reasoning trace, audit query, analyst report  | Yes, but only inside `agent_sandbox/` | Pinned layouts are HMAC-signed `.aamp.view` files; replay verifies the signature. |

The boundary is **policy-enforced**, not convention-enforced. The runtime's
[`AgentScopeMiddleware`](../runtime/benny/api/agent_scope.py) inspects
`X-Benny-Agent-Scope` on every request:

| Scope value   | Reads | Writes outside `agent_sandbox/` | Writes inside `agent_sandbox/` |
| ------------- | :---: | :-----------------------------: | :----------------------------: |
| (none, human) |  ✅   |        per regular RBAC         |        per regular RBAC        |
| `read_only`   |  ✅   |             **403**             |            **403**             |
| `sandbox`     |  ✅   |             **403**             |               ✅               |

The browser never _originates_ the scope header for human flows. It rides only
when the in-browser agent runtime explicitly mounts an agent turn.

### Repo at a glance

```
prime-silo/
├── app/                              # space-agent — browser frontend
│   └── L0/_all/mod/_prime_silo/      # this fork's browser code
│       ├── runtime_client/           # /api/runtime/* fetch + scope chokepoint
│       ├── agent_runtime/            # mountAgentTurn — agent's call surface
│       ├── manifest_explorer/        # first deterministic-zone shell page (Phase E)
│       └── widgets/                  # eight migrated canvas widgets
│           ├── text/markdown/
│           ├── run/{reasoning_trace,lineage_timeline,drilldown_table,frame_inspector}/
│           ├── kg3d/synoptic_web/
│           ├── codegraph/canvas/
│           ├── dag/canvas/           # deterministic_only — manifest/pipeline/workflow modes
│           └── three_renderer/       # 3D drop-in for the two graph widgets
├── server/                           # space-agent — thin Node.js shell server + runtime proxy
├── space/                            # space-agent — browser-resident agent runtime
├── packaging/                        # space-agent — desktop builds
├── runtime/                          # vendored from skybluecycology/benny
│   ├── benny/                        #   FastAPI backend, Pypes, swarm, governance
│   ├── manifests/                    #   Pypes / swarm manifests
│   ├── tests/                        #   pytest suite (~200 tests)
│   ├── docs/                         #   benny's own operator manuals + ADRs
│   └── architecture/                 #   ADR-001 lives here
├── tests/                            # browser-side .mjs tests (node, no jsdom)
├── architecture/                     # shell-fork-level docs (this file)
│   ├── ROADMAP.md
│   ├── OPERATING_PLAN.md
│   └── OPERATING_MANUAL.md           # ← you are here
├── scripts/                          # prime-silo dev / launch scripts
└── README.md
```

The grouping that matters most for day-to-day work: anything in
`app/L0/_all/mod/_prime_silo/` is browser-side shell code this fork owns;
anything in `runtime/benny/` is the deterministic FastAPI service. The shell
talks to the runtime via `/api/runtime/*` proxied by
[`server/lib/runtime_proxy.js`](../server/lib/runtime_proxy.js).

---

## 2. Setup from scratch

Below is the cold-start path. Skip §2.1 if you already have a workstation
configured for Benny.

### 2.1 Prerequisites

| Tool                         | Version            | Notes                                                                                 |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| **Python**                   | 3.11 or 3.12       | Runtime is FastAPI + Pydantic v2. 3.10 may work; 3.11+ is the supported floor.        |
| **Node**                     | ≥ 18               | Required by `.mjs` tests (uses WHATWG `URL` global) and the shell server.             |
| **Git**                      | any modern release | Subtree pulls require git ≥ 2.7.                                                      |
| **PowerShell** _or_ **bash** | platform default   | Both dev launchers ship.                                                              |
| **Docker** (optional)        | latest             | Only needed if you want Neo4j / Marquez / Phoenix locally (knowledge graph features). |

> **No Three.js install needed.** The pluggable 3D renderer lazy-imports
> `3d-force-graph` from `https://esm.sh/3d-force-graph@1` on first mount. If
> you're operating offline, override the CDN URL via the renderer's
> `options.cdnUrl` (see §4.7) or self-host the bundle.

### 2.2 Clone the repo

```bash
git clone https://github.com/binary16labs/prime-silo.git
cd prime-silo
```

The vendored Benny tree is already present under `runtime/` — no submodule init
needed. Subtree pulls happen out-of-band (see §6).

### 2.3 Install Python dependencies

```bash
cd runtime
python -m pip install -e .
cd ..
```

`-e .` installs `benny` in editable mode against `runtime/pyproject.toml`. Any
in-place edits to `runtime/benny/...` are picked up on the next process boot.

### 2.4 Install Node dependencies

```bash
cd server
npm install
cd ..
```

The shell server only needs its own `node_modules`. There's no monorepo
workspace; the browser side imports directly from `app/L0/_all/mod/...` and is
served as static ESM.

### 2.5 Set the HMAC key

The runtime owns the HMAC key used to sign manifests **and** `.aamp.view`
bundles. The browser never sees this value.

**PowerShell (current session):**

```powershell
$env:BENNY_HMAC_KEY = "<64-hex-character key>"
```

**bash:**

```bash
export BENNY_HMAC_KEY="<64-hex-character key>"
```

Generate one locally if you don't have a shared team key yet:

**PowerShell:**

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
```

**bash:**

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

> **Production note.** The runtime falls back to a _dev_ key when
> `BENNY_HMAC_KEY` is unset. That key is documented in
> [`runtime/benny/api/views_signing.py`](../runtime/benny/api/views_signing.py)
> and is **not** suitable for any real deployment. Every host that signs or
> verifies `.aamp.view` bundles must share the same hex string.

### 2.6 Confirm install

```bash
# from prime-silo/
node tests/runtime_client_view_signing_test.mjs
node tests/widgets_three_renderer_test.mjs
```

Both should print `*_test: ok`. If you only see one, your Node version is
too old (re-check §2.1).

```bash
# from prime-silo/runtime/
python -m pytest tests/api/test_views_signing.py -q
```

Should print `37 passed` (Phases F + F2 + F2b combined).

You're set.

---

## 3. Booting the runtime and shell

### 3.1 Turnkey dev launcher (recommended)

The dev launcher starts the FastAPI runtime on `:8005` and the Node shell server
in parallel. Both stream to the foreground; `Ctrl+C` tears both down cleanly.

**PowerShell:**

```powershell
$env:BENNY_HMAC_KEY = "<your hex key>"
.\scripts\dev.ps1
```

**bash:**

```bash
export BENNY_HMAC_KEY="<your hex key>"
./scripts/dev.sh
```

The launcher sets `$BENNY_HOME` to `<repo>/.benny_home`, creating it if missing.
Workspaces, runs, audit logs, and pinned views all live under that path.

### 3.2 Boot the runtime only (Phase B style)

When you just want the API surface (no browser):

```bash
cd runtime
python -m benny.api.server
# → http://localhost:8005
```

The runtime exposes ~25 router modules — `manifests`, `views`, `widgets`,
`agent_sandbox`, `governance`, `pypes`, `agentamp`, etc. The full mount list is
at the bottom of [`runtime/benny/api/server.py`](../runtime/benny/api/server.py).

### 3.3 Smoke test the surfaces

```bash
# Direct (bypasses the shell proxy)
curl http://localhost:8005/api/agent_sandbox/health
curl http://localhost:8005/api/widgets
curl http://localhost:8005/api/manifests

# Through the shell proxy (when scripts/dev started both)
curl http://localhost:3000/api/runtime/agent_sandbox/health
curl http://localhost:3000/api/runtime/widgets
```

`/api/agent_sandbox/health` should return `{"status":"ok"}`. `/api/widgets`
returns the widget registry — eight entries today.

### 3.4 Health-check the determinism boundary

The agent boundary is enforceable from any curl command. Two probes:

```bash
# A read with read_only scope: allowed.
curl -H "X-Benny-Agent-Scope: read_only" http://localhost:8005/api/widgets

# A write outside agent_sandbox/ with sandbox scope: 403.
curl -X POST -H "X-Benny-Agent-Scope: sandbox" \
     -H "Content-Type: application/json" \
     -d '{"view":{"schema":"aamp.view/1","panels":[]}}' \
     http://localhost:8005/api/views/sign
```

The second call must return HTTP 403 with a detail mentioning `agent_sandbox`.
If it succeeds, the middleware is mis-mounted — file a regression.

---

## 4. Feature walkthroughs

This section is intentionally in **order of operator workflow**, not feature
introduction order. Each section is self-contained — you can jump straight to
the one you need.

### 4.1 Browsing registered manifests (the manifest explorer)

The manifest explorer is the first deterministic-zone shell page (Phase E). It
lists every `SwarmManifest` registered with the runtime and renders the
selected one as a DAG.

**Route:** open the shell at `http://localhost:3000/` and navigate to:

```
#/_prime_silo/manifest_explorer
```

The page resolves to
`/mod/_prime_silo/manifest_explorer/view.html` and mounts an Alpine.js
component whose JS entry is
[`app/L0/_all/mod/_prime_silo/manifest_explorer/manifest-explorer.js`](../app/L0/_all/mod/_prime_silo/manifest_explorer/manifest-explorer.js).

**What it does, in order:**

1. `GET /api/runtime/manifests` — fetches the list. No `X-Benny-Agent-Scope`
   header. This is a human-driven request.
2. Reads `?manifest_id=…` from the hash query (e.g.
   `#/_prime_silo/manifest_explorer?manifest_id=m42`). If present and known,
   selects that manifest; otherwise the first in the list.
3. `GET /api/runtime/manifests/<id>` — fetches the full envelope.
4. `mapManifestToDagData(manifest)` — pure transform from
   `manifest.plan.{tasks, edges, waves}` to `{nodes, edges}` consumable by
   `dag.canvas`. Wave indexes invert to `Map<task_id, wave_index>`; run
   overlays beat declared task status; tasks without ids and edges with
   missing endpoints are dropped defensively.
5. `dag.canvas` mounts in `manifest` mode against the result.

The page composes only `deterministic_only` widgets (just `dag.canvas` today).
The determinism boundary is enforced _twice_ here:

- No scope header → middleware applies regular RBAC.
- `dag.canvas` itself rejects mount under `options.agentContext === true` —
  so any agent-authored layout that names this widget id would already fail at
  the widget layer, before the runtime even sees a request.

### 4.2 Saving an agent draft view

Phase D3 ships three helpers on the runtime client:

```js
import { createAgentRuntimeClient } from "/mod/_prime_silo/runtime_client/runtime-client.js";

const client = createAgentRuntimeClient("sandbox");

await client.saveView("c5_test", "compose.aamp.view", {
  schema: "aamp.view/1",
  panels: [
    { widget: "run.reasoning_trace", run_id: "r_2026_05_08_q3" },
    { widget: "run.drilldown_table", run_id: "r_2026_05_08_q3" }
  ]
});

const drafts = await client.listViews("c5_test");
//   → ["compose.aamp.view"]

const loaded = await client.loadView("c5_test", "compose.aamp.view");
//   → { workspace, subdir, filename, relative_path, content, bytes, view }
```

Behind the scenes:

- `saveView` is a `POST` to `/api/runtime/agent_sandbox/views/save`.
- The bound client injects `X-Benny-Agent-Scope: sandbox` on every hop.
- The runtime forces `subdir="views"` server-side and validates the body
  parses as JSON, so a stray call cannot land in `notes/` or `drafts/`.
- The file lands at `$BENNY_HOME/workspaces/<ws>/agent_sandbox/views/<filename>`.

Drafts are agent-owned and **not signed**. They can be edited, listed, read, or
overwritten by the agent inside its sandbox. They are never executed and
nothing outside the sandbox will trust them.

### 4.3 Pinning a draft to a signed canonical view

Pinning is the **human action** that promotes an agent draft into a replayable,
HMAC-signed `.aamp.view`. The endpoint sits outside `/api/agent_sandbox/`, so
the `AgentScopeMiddleware` rejects any agent-originated POST with 403. Pinning
is human-only by middleware policy.

**Browser (Phase F2):**

```js
import { pinView } from "/mod/_prime_silo/runtime_client/runtime-client.js";

// Human call — no scope header.
const result = await pinView("c5_test", "compose.aamp.view", {
  pinnedBy: "operator@binary16"
  // targetFilename defaults to sourceFilename
});
// → {
//   workspace: "c5_test",
//   source_relative_path: "agent_sandbox/views/compose.aamp.view",
//   pinned_relative_path: "views/compose.aamp.view",
//   bytes_written: 384,
//   signature: { algorithm: "HMAC-SHA256", value: "...", signed_at: "..." }
// }
```

**curl equivalent:**

```bash
curl -X POST http://localhost:8005/api/views/pin \
     -H "Content-Type: application/json" \
     -d '{"workspace":"c5_test","source_filename":"compose.aamp.view","pinned_by":"operator@binary16"}'
```

**What happens server-side, in order:**

1. Validate filenames — no path separators, no leading dot, single component.
2. Resolve `agent_sandbox/views/<src>`; confirm the resolved path stays inside
   the sandbox subtree.
3. Read + parse the source as JSON. Non-JSON drafts return 400.
4. Sign the dict — HMAC-SHA256 over the canonical payload (sorted keys, no
   whitespace, `signature` field stripped).
5. **Embed the signature inline** under `signature` so the pinned file is
   self-describing.
6. Pretty-print + write to `$BENNY_HOME/workspaces/<ws>/views/<dst>`.
7. Emit a `VIEW_PINNED` audit event.

The pinned file looks like:

```json
{
  "panels": [ ... ],
  "schema": "aamp.view/1",
  "signature": {
    "algorithm": "HMAC-SHA256",
    "value": "a1b2c3...",
    "signed_at": "2026-05-11T09:35:00+00:00"
  }
}
```

That's the canonical form. The signing process strips the `signature` field
before hashing, so re-signing a pinned file produces the same tag — pinning is
idempotent up to timestamp drift.

### 4.4 Loading + verifying a pinned view (one round-trip)

Phase F2b ships `loadPinnedView` — the read-back companion to `pinView`. The
runtime reads the pinned file, extracts the inline signature, recomputes the
HMAC, and returns `{view, signature, valid}` in a single response.

**Browser:**

```js
import { loadPinnedView } from "/mod/_prime_silo/runtime_client/runtime-client.js";

const result = await loadPinnedView("c5_test", "compose.aamp.view");
if (!result.valid) {
  // The file's signature does not match its contents. Refuse to render.
  throw new Error("Pinned view failed integrity check.");
}
renderLayout(result.view);
```

**curl equivalent:**

```bash
curl http://localhost:8005/api/views/load/c5_test/compose.aamp.view
```

**Decision matrix the caller must respect:**

| Server response                   | Cause                                              | Caller action                                       |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| HTTP 200, `valid: true`           | File exists, JSON parses, signature matches.       | Render the layout.                                  |
| HTTP 200, `valid: false`          | Signature missing / malformed envelope / tampered. | **Refuse to render.** Surface tamper notice.        |
| HTTP 400, "not valid JSON"        | File is corrupt JSON.                              | Treat as missing; surface "corrupt artefact" error. |
| HTTP 400, "must be a JSON object" | Top-level is an array or scalar.                   | Same as above.                                      |
| HTTP 404, "does not exist"        | No such pinned file in the workspace.              | Tell the user; suggest re-pin from a draft.         |

Reads are **not** blocked by `AgentScopeMiddleware`. Bound agent clients can
replay pinned views even though they cannot create them — the runtime is still
the sole holder of `BENNY_HMAC_KEY`; the browser only consumes `valid`.

### 4.5 The eight migrated widgets

Phase C migrated eight canvases into the shell tree. Each lives at
`app/L0/_all/mod/_prime_silo/widgets/<scope>/<name>/`. All accept the same
shape:

```js
createXxxWidget(host, props, options);
// returns { update, refresh, destroy, get layout, ... }
```

| Widget id              | Authority            | What it shows                                                                                          | Notes                                                                                        |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `text.markdown`        | `read_only`          | Markdown body with safe HTML rendering.                                                                | The default analyst-report block.                                                            |
| `run.reasoning_trace`  | `read_only`          | Stepwise model reasoning extracted from a run record.                                                  | Drilldown into LLM router transcripts.                                                       |
| `run.lineage_timeline` | `read_only`          | Triple-lineage events (`process / skill / data`) on a horizontal timeline.                             | Pairs naturally with `frame_inspector`.                                                      |
| `run.drilldown_table`  | `read_only`          | Tabular CLP-annotated rows from a Pypes silver/gold stage.                                             | Click a row → calls `props.onSelect(rowId)`.                                                 |
| `run.frame_inspector`  | `read_only`          | Single Cognitive Frame view — typed body + withdrawal register + frame hash.                           | The audit-on-one-row widget.                                                                 |
| `kg3d.synoptic_web`    | `read_only`          | AoT-layered knowledge graph ontology (default 2D SVG).                                                 | Drop in `createThreeRenderer()` for a 3D `3d-force-graph` scene. See §4.7.                   |
| `codegraph.canvas`     | `read_only`          | Tree-Sitter-derived File/Class/Function/Concept graph banded left → right.                             | Same renderer hook as `kg3d.synoptic_web`.                                                   |
| `dag.canvas`           | `deterministic_only` | Three modes — `manifest`, `pipeline`, `workflow`. Longest-path layered layout with wave-floor pinning. | Rejects mount under `options.agentContext === true`. The manifest explorer mounts it (§4.1). |

Authority semantics:

- **`read_only`** widgets can appear in agent-composed Review-zone layouts.
- **`deterministic_only`** widgets can NOT. The widget registry's
  `isAuthorityAgentSafe()` is the layout-layer gate; the widget's own
  `options.agentContext` rejection is the renderer-layer gate. Two checks,
  both must pass.

Each widget folder ships its own `AGENTS.md` with the props it accepts and the
runtime endpoints it hits. Read that file before extending one.

### 4.6 Composing a Review-zone layout (sketch)

The agent runtime mounts a turn, then composes widgets through `runtimeClient`:

```js
import { mountAgentTurn } from "/mod/_prime_silo/agent_runtime/agent-runtime.js";
import { createReasoningTraceWidget } from "/mod/_prime_silo/widgets/run/reasoning_trace/index.js";
import { createDrilldownTableWidget } from "/mod/_prime_silo/widgets/run/drilldown_table/index.js";

const turn = mountAgentTurn("sandbox");

createReasoningTraceWidget(
  host1,
  { runId: "r_q3_2026" },
  {
    runtimeClient: turn.runtimeClient
  }
);
createDrilldownTableWidget(
  host2,
  { runId: "r_q3_2026" },
  {
    runtimeClient: turn.runtimeClient
  }
);

// On turn end:
turn.dispose();
```

Every fetch the widgets make rides through the bound runtime client, so the
`X-Benny-Agent-Scope: sandbox` header is on the wire. If the agent tries to
mount `dag.canvas` via this route, the widget's `agentContext` check rejects
it before any network call — the boundary catches before it costs.

Saving the resulting layout is `saveView` (§4.2). A human pins it via `pinView`
(§4.3). Replay is `loadPinnedView` (§4.4).

### 4.7 Enabling the 3D renderer for graph widgets

Both graph widgets (`kg3d.synoptic_web`, `codegraph.canvas`) accept
`options.renderer = { mount, update, dispose }`. The 2D SVG fallback is the
default. The 3D drop-in lives at
`app/L0/_all/mod/_prime_silo/widgets/three_renderer/`.

```js
import { createSynopticWebWidget } from "/mod/_prime_silo/widgets/kg3d/synoptic_web/index.js";
import { createThreeRenderer } from "/mod/_prime_silo/widgets/three_renderer/index.js";

createSynopticWebWidget(
  host,
  { workspace: "c4_test" },
  {
    renderer: createThreeRenderer({
      backgroundColor: "#0b1220",
      onNodeClick: (id) => console.log("clicked", id)
      // cdnUrl defaults to https://esm.sh/3d-force-graph@1
    })
  }
);
```

**Behaviour:**

- The factory is cheap — no network, no Three.js touched.
- On `mount()`, the renderer kicks off a dynamic `import()` of
  `3d-force-graph` from the CDN URL. Synchronous handle returned immediately.
- Updates that arrive before the import resolves are stashed and replayed
  once the library activates.
- `dispose()` before the import resolves cancels activation cleanly.
- A failed CDN fetch surfaces as an inline error inside the host (not a
  silent blank canvas).

**Offline / self-hosted scenarios:** pass `options.cdnUrl` pointing at a
self-hosted bundle, or pass `options.loader = () => Promise<ForceGraph3D>` for
full control over how the module is resolved.

### 4.8 Running the test suite

Two surfaces. From the repo root:

```bash
# Browser-side .mjs tests (no jsdom; each file is self-contained).
node tests/runtime_proxy_test.mjs
node tests/widget_registry_test.mjs
node tests/runtime_client_agent_scope_test.mjs
node tests/runtime_client_saved_views_test.mjs
node tests/runtime_client_view_signing_test.mjs
node tests/runtime_client_pin_view_test.mjs
node tests/runtime_client_load_pinned_view_test.mjs
node tests/agent_runtime_test.mjs
node tests/manifest_explorer_test.mjs
node tests/widgets_text_markdown_test.mjs
node tests/widgets_run_reasoning_trace_test.mjs
node tests/widgets_run_lineage_timeline_test.mjs
node tests/widgets_run_drilldown_table_test.mjs
node tests/widgets_run_frame_inspector_test.mjs
node tests/widgets_kg3d_synoptic_web_test.mjs
node tests/widgets_codegraph_canvas_test.mjs
node tests/widgets_dag_canvas_test.mjs
node tests/widgets_three_renderer_test.mjs
```

Each prints `<name>_test: ok` on success. Anything else is a failure.

```bash
# Runtime-side pytest (from runtime/).
cd runtime
python -m pytest tests/api/test_views_signing.py -q     # Phase F + F2 + F2b
python -m pytest tests/api/test_agent_sandbox.py -q     # Phase A / D2
python -m pytest tests/api/ -q                          # full API surface
```

> **The full runtime test suite has pre-existing collection errors** in modules
> unrelated to ADR-001 (kg3d image gen, rag, workflows). These pre-date the
> fork. The per-file commands above pin to the surfaces this fork touches and
> reliably collect.

For a one-shot regression covering everything Prime-Silo adds:

```bash
for t in runtime_proxy widget_registry \
         runtime_client_agent_scope runtime_client_saved_views \
         runtime_client_view_signing runtime_client_pin_view \
         runtime_client_load_pinned_view agent_runtime manifest_explorer \
         widgets_text_markdown widgets_run_reasoning_trace \
         widgets_run_lineage_timeline widgets_run_drilldown_table \
         widgets_run_frame_inspector widgets_kg3d_synoptic_web \
         widgets_codegraph_canvas widgets_dag_canvas widgets_three_renderer; do
  echo "--- $t ---"
  node "tests/${t}_test.mjs" || echo "FAIL: $t"
done
```

---

## 5. Operating the determinism boundary

The whole point of ADR-001 is that the runtime is the **single enforcement
point** for the determinism boundary, and the boundary survives shell bugs.
This section is the operator's checklist for that property.

### 5.1 The three rules the runtime enforces

1. **No `X-Benny-Agent-Scope` header → human RBAC.** Same as any other Benny
   deployment. Per-route auth applies.
2. **`X-Benny-Agent-Scope: read_only` → reads only, anywhere.** Any mutating
   verb (`POST`/`PUT`/`PATCH`/`DELETE`) is 403, regardless of path.
3. **`X-Benny-Agent-Scope: sandbox` → reads anywhere; writes only inside
   `/api/agent_sandbox/`.** A POST to `/api/manifests`, `/api/views/sign`,
   `/api/views/pin`, or any other prefix is 403.

### 5.2 The two browser-side patterns

```js
// Long-running agent turn (preferred for actual agent loops).
const turn = mountAgentTurn("sandbox");
// Pass turn.runtimeClient to every spawned skill / widget / tool.
turn.dispose();

// Short, synchronous flow.
import { runWithAgentContext } from "/mod/_prime_silo/agent_runtime/agent-runtime.js";
await runWithAgentContext("read_only", async () => {
  // Direct runtimeFetch in this scope picks up the header.
  await runtimeFetch("/governance/audit/recent");
});
```

The runtime client never _originates_ the scope header — only the agent
runtime modules above do. A shell bug that accidentally drops the header
surfaces as a 403, never as silent privilege escalation.

### 5.3 The two zone gates for widgets

| Gate                                 | Where                                                     | Checks                                                                                  |
| ------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Layout layer**                     | `isAuthorityAgentSafe(authority)` in `widget-registry.js` | Rejects `deterministic_only` widgets before they're placed in an agent-authored layout. |
| **Renderer layer**                   | Widget itself checks `options.agentContext === true`      | `dag.canvas` refuses to mount; the host shows the deterministic-only refusal banner.    |
| **Network layer** (defence in depth) | `AgentScopeMiddleware` on the runtime                     | Any write outside `/api/agent_sandbox/` from a scoped caller is 403.                    |

A correctly-functioning system trips the layout-layer gate first; the other
two are belt and suspenders.

### 5.4 Auditing the boundary

The runtime emits `process=agent_authorship` lineage events for every accepted
sandbox write, and a `VIEW_PINNED` event for every pin operation. Both flow
through the standard Benny audit log:

```bash
curl http://localhost:8005/api/governance/audit/recent?limit=20
```

If you see a sandbox write you cannot explain, the agent that owns the scope
will be named in the event payload.

---

## 6. Updating the vendored Benny tree

`runtime/` is a git **subtree** pulled from
[`skybluecycology/benny`](https://github.com/skybluecycology/benny). It is not
a submodule and not a worktree — the files are physically present in this
repo and committed as part of normal commits.

### 6.1 One-time setup

```bash
git remote add benny https://github.com/skybluecycology/benny.git
```

### 6.2 Pull upstream changes

```bash
git checkout main
git pull origin main
git subtree pull --prefix=runtime benny master --squash
```

The `--squash` keeps the merge commit clean — upstream history collapses to a
single Prime-Silo commit. Resolve any conflicts in `runtime/`, then commit.

### 6.3 Push fixes back upstream

Fixes that originate inside `runtime/benny/` belong upstream. Cherry-pick the
commit into a clone of `skybluecycology/benny` and raise a PR there — do **not**
use `git subtree push`, which conflates the histories.

The fork's commit message convention for runtime edits names the upstream PR
when it eventually lands, so the subtree pull picks up the squashed version.

### 6.4 What the fork owns versus what's upstream

| File / path                                         | Lives in                          | Edit in                  |
| --------------------------------------------------- | --------------------------------- | ------------------------ |
| `runtime/benny/api/views_routes.py`, etc.           | this repo (vendored)              | here, mirror upstream    |
| Migrated React widgets (`app/L0/.../widgets/...`)   | this repo only                    | here                     |
| `app/L0/.../runtime_client/`, `agent_runtime/`      | this repo only                    | here                     |
| `architecture/ROADMAP.md`, `OPERATING_MANUAL.md`    | this repo only                    | here                     |
| `runtime/architecture/ADR-001-...`                  | this repo (canonical for the ADR) | here                     |
| `runtime/docs/operations/BENNY_OPERATING_MANUAL.md` | upstream                          | benny, then subtree-pull |

---

## 7. Diagnostic playbook

The most common things that go wrong, in rough order of how often they hit.

### 7.1 `node tests/*.mjs` fails with `URL is not defined`

Your Node is too old. Tests require ≥ 18. Confirm with `node --version`. The
.mjs tests use the WHATWG `URL` global without a polyfill on purpose.

### 7.2 `pytest` can't import `benny`

Run from `runtime/`, not the repo root. The runtime's `pyproject.toml` sets
the rootdir there:

```bash
cd runtime
python -m pytest tests/api/test_views_signing.py -q
```

### 7.3 `pytest` reports collection errors in `test_kg3d_api.py`,

`test_rag_routes.py`, `test_workflows_endpoints.py`

Pre-existing on main, unrelated to this fork's surfaces. Scope to the file
you care about:

```bash
python -m pytest tests/api/test_views_signing.py -q
```

### 7.4 `loadPinnedView` returns `valid: false`

The pinned file failed integrity. Three branches:

1. `signature` field missing or malformed → file was hand-edited or
   pre-Phase-F2.
2. Body tampered while signature left in place → real integrity failure.
3. `BENNY_HMAC_KEY` rotated between pin and load → re-pin or restore the key.

Either way, **refuse to render**. The runtime treats this as advisory, not
fatal — `valid: false` is a 200 response, not a 4xx — but the caller must
inspect the field.

### 7.5 Widget shows blank

- Default 2D SVG renderer: the widget host element is probably missing.
  Tests construct one via `createFakeHost(...)`; in dev, mount on a real
  `HTMLElement` with measurable size.
- Three.js renderer: check the host's `innerHTML` for the inline error block
  (`prime-silo-three-renderer__error`). If a CDN fetch failed, the message
  is there.

### 7.6 `git push` hangs on Windows

Git Credential Manager (GCM) is waiting for an interactive sign-in popup.
Alt-tab to GCM and click through. When running pushes from a script,
background them with notification so the foreground stays responsive — the
[OPERATING_PLAN.md](OPERATING_PLAN.md) §"Common gotchas" section covers the
pattern.

### 7.7 A pinned view round-trips locally but 404s in another workspace

`loadPinnedView` looks under
`$BENNY_HOME/workspaces/<ws>/views/<filename>`. The most common cause is a
mismatched workspace id — the agent saved to `c5_test`, you pinned in
`default`. Confirm with:

```bash
ls "$BENNY_HOME/workspaces/c5_test/views/"
```

The dev-launcher default is `$BENNY_HOME = <repo>/.benny_home`.

### 7.8 Agent writes succeed when they should not

Three checks, in order:

1. Are you actually sending the scope header? `curl -v` on the failing call.
2. Is the runtime _seeing_ the header on the upstream side? Check the
   shell's runtime-proxy log; it preserves `X-Benny-Agent-Scope`.
3. Is `AgentScopeMiddleware` mounted? It's added in
   [`runtime/benny/api/server.py`](../runtime/benny/api/server.py) right
   after `GovernanceMiddleware`. The boundary smoke test in §3.4 catches
   regressions here.

If all three are green and the write still succeeds, the route is mis-mounted
inside `/api/agent_sandbox/` — that's the only way a write reaches the path
gate. File a regression and pin to the misbehaving route.

---

## 8. Where to read more

- **Phase status** — [ROADMAP.md](ROADMAP.md) (rolling, updated every merge).
- **Dev loop / branch + commit conventions** — [OPERATING_PLAN.md](OPERATING_PLAN.md).
- **Architectural rationale** — [`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](../runtime/architecture/ADR-001-prime-silo-shell-fork.md).
- **Per-module behaviour** — `AGENTS.md` files inside each folder under
  `app/L0/_all/mod/_prime_silo/`.
- **Benny's own operator manual** —
  [`runtime/docs/operations/BENNY_OPERATING_MANUAL.md`](../runtime/docs/operations/BENNY_OPERATING_MANUAL.md)
  (covers the substrate features that don't surface in the shell yet —
  Pypes, AgentAmp skin packs, swarm executor).

If a question isn't answered here or in those, the AGENTS.md file closest to
the code you're touching is usually right.

---

_Prime-Silo — engineered by Binary 16._
