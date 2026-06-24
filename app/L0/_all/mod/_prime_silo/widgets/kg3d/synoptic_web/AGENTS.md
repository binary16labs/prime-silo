# AGENTS — `_prime_silo/widgets/kg3d/synoptic_web/`

## Purpose

Read-only synoptic web of knowledge-graph concepts and edges, layered by
the AoT (Abstraction-of-Thought) depth (1 = abstract, 5 = concrete).
Seventh migrated widget under ADR-001 Phase C; the second graph-shaped
widget after `dag.canvas` and the first to fetch from
`/kg3d/ontology` through the proxy.

## Files

| File               | Owns                                                     |
| ------------------ | -------------------------------------------------------- |
| `index.js`         | `createSynopticWebWidget(host, props, options)` factory. |
| `synoptic_web.css` | Layered SVG styling, layer guides, node halo.            |

## Manifest mapping

Maps to widget id `kg3d.synoptic_web` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        read_only
frame_bindings:   [ { field: "concepts", required: false } ]
props:
  workspace:      string  (default "default")
  focusedLayer:   integer (1..5; spotlight one AoT layer)
  selectedNodeId: string  (highlight one concept)
  data:           { nodes, edges } — optional inline override of the fetch
```

## Three.js / 3D-rendering decision

The upstream `runtime/frontend/src/components/Studio/kg3d/SynopticWeb.tsx`
uses `react-force-graph-3d` + Three.js. Bundling either dependency into
the dependency-free shell would be a meaningful step — too meaningful for
the _first_ migration of this widget. The shell port takes a pragmatic
path:

1. **Default renderer is a 2D SVG layered web** — pure ES + DOM. Nodes
   bucket by `aot_layer`; within a layer they're spaced evenly across the
   width. Pagerank scales the radius. Click delegation through
   `[data-node-id]` mirrors `dag.canvas`. No CDN, no build step.
2. **Renderer is pluggable.** `options.renderer` accepts a `{ mount,
update, dispose }` object. A future `three-renderer.js` can lazy-load
   Three.js (or `3d-force-graph`) from a CDN ESM and slot in without
   changing the widget contract. Tests inject a stub renderer through the
   same hook, which is how we keep the test suite Node-only.

This is not yet a 3D synoptic web in the shell by default — but the
follow-up landed: [`../../three_renderer/`](../../three_renderer/AGENTS.md)
exposes `createThreeRenderer()`, which slots into this widget's
`options.renderer` hook unchanged. Pass it in and the SVG fallback is
replaced by a `3d-force-graph` scene with `AoT layer` carried through to
node metadata. The widget id keeps the historic name because the
**ontology contract** (categories, AoT layers, edges, metrics) is
identical — what the widget renders changes; what it _means_ doesn't.

## How it talks to the runtime

```
widget.load() →
  runtimeFetch("/kg3d/ontology?workspace=…")
    → shell proxy strips /api/runtime, injects X-Benny-API-Key
    → runtime kg3d.get_ontology()
    → JSON { nodes: [...], edges: [...] }
  → widget computes layered layout → paints (default SVG / custom renderer)
```

The widget **does not** use `fetchAsAgent`. Browsing the ontology is
human inspection; no agent scope header.

## Lifecycle

```js
import { createSynopticWebWidget } from "./index.js";

const handle = createSynopticWebWidget(hostEl, {
  workspace: "c4_test",
  focusedLayer: 2
});

// Pin a concept (e.g. when the user clicks one elsewhere).
handle.update({ selectedNodeId: "neural_networks" });

// Manual reload after a kg3d ingest run.
await handle.refresh();

// Tear down — also disposes the custom renderer if one was injected.
handle.destroy();
```

`handle.layout` exposes `{ positions, edges, width, height, buckets }`
from the last paint. Useful for sibling widgets that want to project on
top of the same canvas without re-running the layout pass.

## Authority

`read_only` — composable into agent-authored layouts.
