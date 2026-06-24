# AGENTS — `_prime_silo/widgets/three_renderer/`

## Purpose

Drop-in 3D renderer for the graph widgets (`kg3d.synoptic_web`,
`codegraph.canvas`). Slots into the **Phase C pluggable-renderer hook**
those widgets expose:

```js
createSynopticWebWidget(host, props, { renderer: createThreeRenderer() });
createCodeGraphCanvasWidget(host, props, { renderer: createThreeRenderer() });
```

The widget cores stay dependency-free — they emit a 2D SVG by default and
hand the renderer object the same `{positions, edges, …}` layout they
would have painted themselves. Three.js is never bundled into the shell;
it loads from a CDN ESM endpoint on first mount.

## Files

| File           | Owns                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.js`     | `createThreeRenderer(options)` factory + `layoutToGraphData(layout)` normaliser. No top-level import of Three.js or `3d-force-graph` — the dependency is dynamically imported on first mount. |
| `renderer.css` | Visual styling for the inline error fallback rendered when the CDN fetch fails.                                                                                                               |

## Boundary

- **No top-level Three.js import.** Importing this module from anywhere
  in the shell is free — neither Three.js nor `3d-force-graph` is touched
  until a widget actually mounts the renderer. A page that imports the
  module but never enables the renderer pays no bundling cost.
- **No widget changes.** The renderer is contract-compatible with the
  Phase C hook. Adding it does not modify `kg3d/synoptic_web/index.js` or
  `codegraph/canvas/index.js`. Callers opt in by passing
  `options.renderer`.
- **No widget agentContext awareness.** Neither graph widget is
  `deterministic_only`, and the renderer doesn't introduce determinism
  semantics of its own — it's a presentation choice, not a security
  surface.

## Local contracts

- `createThreeRenderer(options) → { mount }` — factory. The factory is
  cheap; it does not touch the network.
- `mount(host, layout, props) → { update, dispose }` — synchronous mount.
  Kicks off the dynamic CDN import; while it's in flight, the latest
  `update(layout, props)` call is stashed and replayed when the import
  resolves. `dispose()` cancels the activation if it fires before the
  import resolves.
- Multiple `mount` calls off the same factory are independent — each
  gets its own `3d-force-graph` instance and its own dispose path.
- `options.loader` — `() => Promise<ForceGraph3D constructor>`. Default
  loader does `import(cdnUrl)`. Tests pass a stub loader so the node
  runner never touches the CDN.
- `options.cdnUrl` — overrides the default CDN URL. Useful for self-
  hosting `3d-force-graph` or pinning a specific version.
- `options.backgroundColor` / `options.nodeRelSize` / `options.linkColor`
  — passthroughs to `3d-force-graph` so callers can theme the scene
  without reaching into the instance.
- `options.onNodeClick(nodeId, node)` — wires the renderer's click
  handler back to the widget's `props.onSelect`. The renderer itself
  doesn't know about the widget's selection model; the caller threads it
  in.

## Layout normalisation

The two graph widgets emit slightly different layout shapes; the
renderer's `layoutToGraphData(layout)` handles both:

| Widget              | Position entries carry                 | Edge entries carry                       |
| ------------------- | -------------------------------------- | ---------------------------------------- |
| `kg3d.synoptic_web` | `{ x, y, radius, layer, color, node }` | `{ id, source, target, kind, weight }`   |
| `codegraph.canvas`  | `{ x, y, radius, type,  color, node }` | `{ id, source, target, type, metadata }` |

The normaliser:

- pins `fx` / `fy` from the SVG-layout x/y so the 3D solver settles
  Z while keeping the visual grouping recognisable;
- carries `layer` / `type` through to the resulting graph nodes;
- preserves the widget's original node payload on `node._original` so a
  caller-supplied click handler can read the upstream metadata without
  re-keying through the layout.

## Phase status

- **Phase C follow-up (this commit)** — `createThreeRenderer` shipped.
  Validates the Phase C pluggable-renderer hook. Three.js is no longer
  an open architectural question for `kg3d.synoptic_web` and
  `codegraph.canvas`; it's a drop-in.
