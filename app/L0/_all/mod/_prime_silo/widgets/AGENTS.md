# AGENTS — `_prime_silo/widgets/`

## Purpose

Browser-side home for the **typed widget registry** that ADR-001 collapses Studio's overlapping canvases into. Each widget id registered by [`runtime/benny/api/widget_routes.py`](../../../../runtime/benny/api/widget_routes.py) maps to a sibling folder here that owns the actual React/canvas implementation.

## Files

| File                  | Owns                                                                          |
| --------------------- | ----------------------------------------------------------------------------- |
| `widget-registry.js`  | Fetches the registry from the runtime, caches it, exposes `getWidget(id)` and `isAuthorityAgentSafe(authority)`. JSDoc mirrors [`runtime/frontend/src/widgets/contracts.ts`](../../../../runtime/frontend/src/widgets/contracts.ts). |

## Layout (Phase C — incoming)

```
widgets/
├── widget-registry.js
├── kg3d/
│   └── synoptic_web/      # widget id: kg3d.synoptic_web
├── codegraph/
│   └── canvas/            # widget id: codegraph.canvas
├── dag/
│   └── canvas/            # widget id: dag.canvas (deterministic_only)
├── run/
│   ├── drilldown_table/
│   ├── frame_inspector/
│   ├── lineage_timeline/
│   └── reasoning_trace/
└── text/
    └── markdown/
```

## Authority gate

Before composing a widget into an agent-authored layout, callers MUST check:

```js
import { getWidget, isAuthorityAgentSafe } from "./widget-registry.js";

const widget = getWidget(layoutTile.widget_id);
if (!widget || !isAuthorityAgentSafe(widget.authority)) {
  // The agent is not allowed to place this widget. Reject the layout
  // before it reaches the renderer.
  throw new Error(`Widget ${layoutTile.widget_id} is not agent-composable.`);
}
```

`deterministic_only` widgets (currently `dag.canvas`) are reachable **only** from static shell pages that humans drive directly. The runtime would reject any agent-attempted state mutation regardless, but rejecting at the layout layer surfaces the constraint earlier and keeps Review-zone layouts clean.

## Phase status

- **Phase A** ✅ — manifest schema + Phase A registry committed in the runtime.
- **Phase D (this commit)** — registry client scaffolded; `loadRegistry()` proves the proxy chain end-to-end.
- **Phase C (next)** — port the five highest-value canvases listed above.
- **Phase G** — collapse `ManifestCanvas`/`PipelineCanvas`/`WorkflowCanvas` into the single `dag.canvas` widget.
