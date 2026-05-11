# AGENTS — `_prime_silo/widgets/codegraph/canvas/`

## Purpose

Read-only Tree-Sitter-derived file/class/function graph for a workspace.
**Eighth migrated widget under ADR-001 Phase C — closes the canvas
migration.** Sourced from `/graph/code` through the runtime proxy. Same
renderer-pluggability pattern as `kg3d.synoptic_web`.

## Files

| File           | Owns                                                         |
| -------------- | ------------------------------------------------------------ |
| `index.js`     | `createCodeGraphCanvasWidget(host, props, options)` factory. |
| `canvas.css`   | Banded SVG styling, edge dash/colour rules.                  |

## Manifest mapping

Maps to widget id `codegraph.canvas` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        read_only
frame_bindings:   []
props:
  workspace:       string  (default "default")
  snapshotId:      string  (optional — pin to one scan)
  pathFilter:      string  (optional — passed as ?path= prefix)
  selectedNodeId:  string  (optional — highlight)
  visibleTypes:    string[] (subset of Folder/File/Module/Class/Function/Concept)
  data:            { nodes, edges } (optional inline override of the fetch)
```

## Renderer dependency decision

Same trade-off as `kg3d.synoptic_web`: the upstream `CodeGraphCanvas.tsx`
is a Three.js R3F scene, far too heavyweight for a first migration into
the dependency-free shell. This widget ships:

1. **Default 2D SVG layered renderer.** Bands left → right by node type
   (Folder, File, Module, Class, Function, Concept). Within a band,
   nodes are stable-sorted by `path` for diff-friendly layouts. Edge
   styles match the upstream palette: DEFINES = white, INHERITS = green,
   CALLS = orange (dashed), DEPENDS_ON = cyan (dashed),
   CORRELATES_WITH = magenta (dashed), REL = neutral.
2. **Pluggable renderer** via `options.renderer = { mount, update,
   dispose }`. The 3D drop-in shipped as a separate module —
   [`../../three_renderer/`](../../three_renderer/AGENTS.md) exposes
   `createThreeRenderer()`, which honours both this widget's layout
   shape and kg3d's. Tests inject stubs through the same hook.

The widget id keeps the historic name because the **graph contract**
(node types, edge types, metadata) is identical — what we render
changes, what it *means* doesn't.

## How it talks to the runtime

```
widget.load() →
  runtimeFetch("/graph/code?workspace=…&snapshot_id=…&path=…")
    → shell proxy strips /api/runtime, injects X-Benny-API-Key
    → runtime graph_routes.fetch_code_graph()
    → JSON { nodes: [...], edges: [...] }
  → widget filters by visibleTypes → layers → paints
```

The widget **does not** use `fetchAsAgent`. Code-graph browsing is
human inspection.

## Lifecycle

```js
import { createCodeGraphCanvasWidget } from "./index.js";

const handle = createCodeGraphCanvasWidget(hostEl, {
  workspace: "c5_test",
  visibleTypes: ["File", "Class", "Function"],
});

// Pin to a snapshot when investigating a regression.
handle.update({ snapshotId: "20260507-c5-scan" });

// Toggle off Functions to declutter.
handle.update({ visibleTypes: ["File", "Class"] });

// Manual reload after a `benny enrich` run.
await handle.refresh();

// Tear down — also disposes the custom renderer if one was injected.
handle.destroy();
```

`handle.layout` exposes the computed layout; `handle.rawGraph` exposes
the unfiltered `{ nodes, edges }` payload. Useful for sibling widgets
that want to count edges or render a different lens without re-paying
the proxy cost.

## Authority

`read_only` — composable into agent-authored layouts.
