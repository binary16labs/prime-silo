# Code 3D V2

This module owns the Anime.js-based `makeAnimeOrbRenderer`.

## Ownership
- `anime-orb-renderer.js`: The renderer exported to `bridge.js` to mount within `codegraph.canvas`.
- `code-3d-v2.css`: The styling for the 3D visual graph and SVG line overlay.

## Contracts
- Implements the `{ mount, update, dispose }` interface used by `codegraph.canvas`.
- Replaces the Three.js dependency with Anime.js `window.anime` for 3D layout manipulation.
- Dynamically extracts node architecture classification (Boundary, Control, Entity, Concept) on the frontend via map heuristics or Neo4j schema properties for layered Z-axis rendering.
