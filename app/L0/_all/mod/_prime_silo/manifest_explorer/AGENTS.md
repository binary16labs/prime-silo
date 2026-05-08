# AGENTS — `_prime_silo/manifest_explorer/`

## Purpose

ADR-001 Phase E — first deterministic-zone shell page in the fork.

A read-only browser surface that lists registered swarm manifests and
renders the selected one as a DAG via the `dag.canvas` widget. The page
exists primarily to validate the deterministic-zone pattern end-to-end:

- Multi-segment hash route resolution (`#/_prime_silo/manifest_explorer`
  → `/mod/_prime_silo/manifest_explorer/view.html`).
- `runtimeFetch` with **no** active agent scope = clean human-driven
  read of `/api/manifests` and `/api/manifests/<id>`.
- `dag.canvas` (the only `deterministic_only` widget) mounting on a real
  shell page rather than just under unit tests.

## Files

| File                    | Owns                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `view.html`             | Routed page shell with Alpine `x-data="manifestExplorer()"`. Topbar / select / status / canvas host. |
| `manifest-explorer.js`  | Page entry. Loads list + selected manifest, mounts `dag.canvas`. Pulls `manifestExplorer()` onto `window` so the Alpine attribute resolves. |
| `manifest-mapping.js`   | Pure functions `mapManifestToDagData(manifest, options?)` and `summariseManifest(manifest)`. No DOM, no fetch — fully unit-testable. |
| `manifest-explorer.css` | Local layout + status-banner tones. |

## Route

Resolves to `#/_prime_silo/manifest_explorer` per the router contract in
[`_core/router/AGENTS.md`](../../../_core/router/AGENTS.md):

> a multi-segment route such as `#/author/repo/path` resolves to
> `/mod/author/repo/path/view.html`.

The hash query string `?manifest_id=<id>` is honoured for deep-linking
into a specific manifest. Falls back to the first manifest in the list
when the param is absent or doesn't match a known id.

## Authority — why this is the deterministic zone

Three facts make this a *deterministic-zone* surface, not a Review-zone
surface:

1. **No agent context.** `manifest-explorer.js` calls `runtimeFetch`
   from `_prime_silo/runtime_client/runtime-client.js` without first
   entering `withAgentScope` or constructing a bound agent client. The
   active agent scope is therefore `null` and the request goes out
   without `X-Benny-Agent-Scope`. `AgentScopeMiddleware` lets it through
   unchanged.
2. **No writes.** The page only reads — `GET /manifests` and
   `GET /manifests/<id>`. There is no save or pin path here. A human
   editing a manifest goes through the runtime CLI (`benny plan`,
   `benny run`), not this page.
3. **Composes only `deterministic_only` widgets.** `dag.canvas` is
   authority `deterministic_only`. By construction it cannot land in
   an agent-authored layout (the registry's `isAuthorityAgentSafe`
   returns `false`), and even if it could, the widget rejects mounting
   under `options.agentContext === true` with a refusal banner.

## Local contracts

- The canvas host element is exposed via `x-ref="canvas"`. Tests that
  exercise the page lifecycle should target that ref.
- `state` is one of `"loading" | "ready" | "empty" | "error"`. The
  status banner reads off `state` + `error`; the canvas only mounts
  when `state === "ready"`.
- `selectManifest(id)` is idempotent — calling it with the current
  active id reloads from the runtime, which is the expected behaviour
  when the user wants a fresh fetch.
- `destroy()` is wired through Alpine's `x-destroy`. The widget handle
  is torn down to release SVG nodes and event listeners.

## What this page does NOT do

- No editing. Manifests come from the runtime; this surface is read-only.
- No agent integration. A future Phase E2 might add a side panel that
  composes a Review-zone agent commentary widget, but that lives in a
  separate module so the deterministic-zone purity here is preserved.
- No persistent state. Hash query string is the only stickiness; nothing
  is stored in `localStorage`/`sessionStorage` from this page.

## Phase status

- **Phase E (this commit)** — manifest explorer shipped. First and
  currently only deterministic-zone surface. Adds zero coupling between
  Phase D2's agent context machinery and the static-page path: the same
  `runtimeFetch` helper handles both, so a future deterministic page
  can copy this module's pattern without learning agent semantics.
