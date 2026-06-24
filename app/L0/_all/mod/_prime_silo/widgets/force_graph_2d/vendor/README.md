# Vendored: force-graph (2D)

`force-graph.module.js` is a **self-contained ESM bundle** of
[vasturiano/force-graph](https://github.com/vasturiano/force-graph), produced so
the Bridge's organic 2D graph renders **fully offline** — the desktop shell
serves it from `/mod/_prime_silo/widgets/force_graph_2d/vendor/` and the renderer
dynamic-imports it via a relative `import.meta.url`. No CDN, no network at
runtime (contrast `three_renderer`, which fetches `3d-force-graph` from esm.sh).

## Pin

- Package: `force-graph`
- Version: **1.51.4**
- Default export: the `ForceGraph` factory (curried: `ForceGraph()(domElement)`).

## How it was built

The published `dist/force-graph.mjs` has 15 bare imports (`d3-*`, `lodash-es`,
`@tweenjs/tween.js`, `kapsule`, `bezier-js`, …) that a browser can't resolve
offline, so it is bundled into a single dependency-free ESM file:

```sh
npm install force-graph@1.51.4
npx esbuild node_modules/force-graph/dist/force-graph.mjs \
  --bundle --format=esm --platform=browser --minify \
  --outfile=force-graph.module.js
```

To upgrade: bump the version, re-run the two commands, drop the result here, and
update the pin above. Keep it dependency-free (verify with
`grep -c "^import" force-graph.module.js` → `0`).

force-graph is MIT licensed (license headers are preserved in the bundle).
