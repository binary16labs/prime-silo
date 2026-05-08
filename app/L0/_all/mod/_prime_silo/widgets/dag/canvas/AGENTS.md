# AGENTS — `_prime_silo/widgets/dag/canvas/`

## Purpose

Unified DAG renderer for the deterministic shell — collapses the upstream
trio of canvases (`ManifestCanvas`, `PipelineCanvas`, `WorkflowCanvas`)
into one parameterised widget per ADR-001. Sixth migrated widget under
Phase C, and the **first `deterministic_only` widget** to land in the
shell — its main job, beyond rendering, is to validate the
authority-rejection path with real widget code.

## Files

| File           | Owns                                                          |
| -------------- | ------------------------------------------------------------- |
| `index.js`     | `createDagCanvasWidget(host, props, options)` factory.        |
| `canvas.css`   | SVG node/edge styling + rejected/error/empty states.          |

## Manifest mapping

Maps to widget id `dag.canvas` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        deterministic_only
frame_bindings:   []
props:
  mode:           "manifest" | "pipeline" | "workflow"  (required)
  data:           { nodes: [...], edges: [...] }        (required, supplied by host page)
  selectedNodeId: string                                (optional)
```

`onSelect` is a function prop — caller passes a callback in JS, not over
the wire. The widget delegates click events on `[data-node-id]` elements.

## Authority — defence-in-depth

`deterministic_only`. Two layers of rejection share one source of truth
(the manifest's `authority` field):

1. **Layout layer** — `widget-registry.js`'s `isAuthorityAgentSafe()`
   returns `false`, so an agent-authored layout cannot include this
   widget id at all.
2. **Widget layer** — `createDagCanvasWidget` checks
   `options.agentContext === true` and renders a refusal banner instead
   of a canvas. The widget will still expose `update`/`refresh`/`destroy`
   so callers don't crash, but they're no-ops.

The runtime's `AgentScopeMiddleware` is the final backstop on any state
mutation an agent might attempt against the underlying manifest/pipeline,
but this widget is read-only — there is no mutation surface. The two
layers above are about **composition**, not write-protection.

## Rendering

- **No fetch.** The widget does not call the runtime. The host
  deterministic-zone page fetches the manifest / pipeline / workflow and
  hands it in via `props.data`. Keeps the surface area small and matches
  how other dependency-free widgets compose.
- **Layout.** Longest-path layering — a node's column is one greater than
  the max column of its predecessors. Nodes that declare `wave` (manifest
  mode) take that column as a floor. Within a column, original input
  order is preserved.
- **Mode controls accent only.**
  - `manifest`: status colour (pending/running/completed/failed/skipped),
    sub-line shows `Wave N`.
  - `pipeline`: stage colour (bronze/silver/gold/raw/feature/governed),
    sub-line shows `Stage: X`, status chip on the right.
  - `workflow`: kind colour (trigger/llm/tool/logic/data/a2a/intervention),
    sub-line shows the kind.
- **Edges** are simple cubic Bézier paths, right-of-source to
  left-of-target. Self-loops and back-edges to nodes that don't exist are
  silently dropped — this is a renderer, not a manifest validator.

## Lifecycle

```js
import { createDagCanvasWidget } from "./index.js";

const handle = createDagCanvasWidget(hostEl, {
  mode: "pipeline",
  data: {
    nodes: [
      { id: "ingest", stage: "bronze", status: "completed", label: "Ingest trades" },
      { id: "trades", stage: "silver", status: "completed" },
      { id: "exposure", stage: "gold", status: "running" }
    ],
    edges: [
      { source: "ingest", target: "trades" },
      { source: "trades", target: "exposure" }
    ]
  },
  selectedNodeId: "exposure",
  onSelect: (nodeId) => console.log("clicked", nodeId)
});

// Re-bind to a fresh manifest after a rerun.
handle.update({ data: { nodes: [...], edges: [...] } });

// Tear down.
handle.destroy();
```

`handle.layout` exposes the computed `{ columns, colOf, edges }` after
the last render. Useful for sibling widgets that want to project onto the
same coordinate system without re-running the layout.
