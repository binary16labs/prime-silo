# AGENTS — `_prime_silo/runs_explorer/`

## Purpose

ADR-001 Phase E expansion — second deterministic-zone shell page in the
fork. Paired with `manifest_explorer/`.

A read-only browser surface that lists executed swarm runs and renders
the selected one as the underlying manifest DAG, with each task coloured
by its execution status via `dag.canvas`'s **run overlay** path. The
page validates that the manifest_explorer pattern survives a second
deterministic-zone surface unchanged — the `runtimeFetch`-no-scope
path, the `dag.canvas` `deterministic_only` mount, the Alpine `x-data`
shell, the relative-import module graph that lets node tests resolve
the same files the browser does.

## Files

| File                | Owns                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `view.html`         | Routed page shell with Alpine `x-data="runsExplorer()"`. Topbar / run select / status / summary block / canvas host.                          |
| `runs-explorer.js`  | Page entry. Loads run list + selected run + manifest, builds the overlay, mounts `dag.canvas`. Pulls `runsExplorer()` onto `window`.          |
| `runs-mapping.js`   | Pure functions: `summariseRun`, `buildRunOverlay`, `extractManifestSnapshot`, `sortRunsForDisplay`, `formatDuration`. No DOM, no fetch.       |
| `runs-explorer.css` | Local layout + status-banner tones. Mirrors `manifest_explorer/manifest-explorer.css` with a small `[data-tone="error"]` override on summary. |

## Route

Resolves to `#/_prime_silo/runs_explorer` per the router contract.

Hash query string `?run_id=<id>` is honoured for deep-linking into a
specific run. Falls back to the first run in the sorted list when the
param is absent or doesn't match a known id.

## Data flow

```
init() →
  GET /manifests/runs        → sortRunsForDisplay(records)
                             → select run (?run_id= or list[0])
  GET /manifests/runs/<id>   → RunRecord
  (record.manifest_snapshot present?)
    YES → use the snapshot — matches what was actually executed
    NO  → GET /manifests/<record.manifest_id>
  summariseRun(record)       → header summary
  buildRunOverlay(record)    → { node_states: { task_id: status, ... } }
  mapManifestToDagData(manifest, { runOverlay: overlay })
                             → { nodes, edges }
  dag.canvas.mount({ mode: "manifest", data })
```

The mapping reuses `manifest_explorer/manifest-mapping.js` — there is no
parallel mapping function here, only an *overlay* on top of the manifest
mapping that already supports `options.runOverlay.node_states`.

## Why prefer `manifest_snapshot` over a fresh `/manifests/<id>` fetch

The planner snapshots a manifest at run creation. If the manifest is
later edited (renamed task, added wave, dropped edge), the live manifest
no longer matches what the run actually executed. Rendering against the
*snapshot* keeps the run's DAG honest: the layout matches the bytes
that ran. Falling back to a live fetch is the right answer when no
snapshot is present — better to render the current manifest than to
render nothing.

## Sort rules

`sortRunsForDisplay`:

1. Active runs (`pending`, `running`) float to the top.
2. Within a status bucket, newest `started_at` first.
3. Records with missing `started_at` sort last in their bucket.

This makes the dropdown land on the live thing when an operator opens
the page mid-execution; otherwise the most recent completed run.

## Authority — why this is the deterministic zone

Same three checks as `manifest_explorer/`:

1. **No agent context.** `runtimeFetch` runs with no active scope.
2. **No writes.** The page only reads `/manifests/runs`,
   `/manifests/runs/<id>`, and optionally `/manifests/<id>`.
3. **Composes only `deterministic_only` widgets.** `dag.canvas` rejects
   mount under `options.agentContext === true`; the registry's
   `isAuthorityAgentSafe` returns `false` for it.

## Local contracts

- `state` is one of `"loading" | "ready" | "empty" | "error"`.
- `runs` is the sorted RunRecord list; `activeRunId` is the currently
  selected run.
- `summary` is the return of `summariseRun(record)`; `durationDisplay`
  is the formatted duration string.
- `selectRun(id)` is idempotent for the same id — pulls a fresh
  RunRecord. Useful when an operator wants to refresh the overlay for a
  running task.
- `destroy()` tears down the widget handle.

## What this page does NOT do

- No live tailing. The page is a snapshot view; opening it again is the
  refresh mechanism. SSE-tailing of an in-flight run is a future
  Review-zone surface, not this one.
- No drill-down into a single task. The dag.canvas click handler is
  reserved for a future expansion that opens a `run.frame_inspector` or
  `run.reasoning_trace` side panel — neither is wired here.
- No filtering. The run list is everything the runtime returns from
  `/manifests/runs` (default limit = 100). Workspace filtering would
  go through a URL param + a re-fetch; not shipped this commit.

## Phase status

- **Phase E expansion (this commit)** — runs explorer shipped. Reuses
  `manifest_explorer/manifest-mapping.js` unchanged via the
  `options.runOverlay` path that was added to `mapManifestToDagData`
  during the original Phase E PR for exactly this case. The deterministic
  zone now has two grounded surfaces, both following the same module
  layout — `view.html`, `<page>.js`, `<page>-mapping.js`,
  `<page>.css`, `AGENTS.md`.
