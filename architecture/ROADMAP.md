# Prime-Silo Roadmap

Living status of the ADR-001 phased delivery in `binary16labs/prime-silo`.
Update on every merge.

Cross-references:
- [ADR-001 — Prime-Silo Shell Fork](../runtime/architecture/ADR-001-prime-silo-shell-fork.md) — the source of truth for *why* each phase exists.
- [OPERATING_PLAN.md](OPERATING_PLAN.md) — *how* to run tests, dev loop, branch conventions.
- [OPERATING_MANUAL.md](OPERATING_MANUAL.md) — *what each shipped feature does* and how to operate it end-to-end (setup from scratch, walkthroughs, diagnostic playbook).

## Phase status (rolling)

| Phase | State | Outcome |
| ----- | ----- | ------- |
| **A** | ✅ shipped | Backend prep in Benny: sandbox path helpers, `agent_scope_guard` middleware, `agent_authorship` lineage emitter, widget manifest contract. |
| **B** | ✅ shipped | Forked `agent0ai/space-agent` → `binary16labs/prime-silo`. Vendored Benny under `runtime/`. One workspace boots end-to-end. |
| **C** | ✅ shipped | Eight canvases ported into `app/L0/_all/mod/_prime_silo/widgets/<scope>/<id>/`: `text.markdown`, `run.reasoning_trace`, `run.lineage_timeline`, `run.drilldown_table`, `run.frame_inspector`, `kg3d.synoptic_web`, `codegraph.canvas`, `dag.canvas`. Pluggable-renderer hook on graph widgets keeps the door open for Three.js. *Note: `dag.canvas` was implemented during the original Phase C window on a feature branch but the PR was never raised; it shipped on `phase-c-completion-dag-canvas` after the F2 merge to clean up the divergence between code and ROADMAP.* |
| **D** | ✅ shipped | Runtime transport scaffolded: `runtimeFetch`, `fetchAsAgent`, `listWidgets`. Proves the shell→runtime proxy chain end-to-end. |
| **D2** | ✅ shipped | Agent-context chokepoint. `createAgentRuntimeClient(scope)` (long-running, closure-bound) + `withAgentScope(scope, fn)` (synchronous, narrow) are the only two ways traffic gets tagged. Both audited by `AgentScopeMiddleware`. |
| **D3** | ✅ shipped | Agent saved-views — `saveView` / `loadView` / `listViews` ride the D2 chokepoint and exercise `/api/agent_sandbox/views/{save,read,list}`. |
| **F** | ✅ shipped | `.aamp.view` HMAC chokepoint. `POST /api/views/sign` + `POST /api/views/verify` mounted *outside* `/api/agent_sandbox/`, so `AgentScopeMiddleware` 403s every agent-scoped POST. Browser-side `signView` / `verifyView` helpers; bound agent clients propagate scope so the runtime issues the intended 403. The browser never holds the HMAC key. |
| **F2** | ✅ shipped | `pinView` — persistence half of Phase F. `POST /api/views/pin` reads the agent draft, signs, embeds the signature inline, writes to `$BENNY_HOME/workspaces/<ws>/views/`, and emits a `VIEW_PINNED` audit event. Self-describing pinned files — load-time replay verifies the embedded signature in one round-trip. |
| **F2b** | ✅ shipped | `loadPinnedView` — read-back half of F2. `GET /api/views/load/<ws>/<filename>` returns `{view, signature, valid}` in one round-trip. The runtime re-reads the file, extracts the embedded signature, recomputes the HMAC, and returns the `valid` boolean alongside the view. Reads are not blocked by `AgentScopeMiddleware`, so bound agent clients can replay pinned layouts even though they cannot create them. The shell never holds `BENNY_HMAC_KEY`; it only consumes `valid`. Missing/malformed inline signatures surface as `valid: false` (not HTTP error) so the caller has a single decision point. |
| **E** | ✅ shipped | Deterministic-zone surfaces — first static shell page at `_prime_silo/manifest_explorer/` (routed `#/_prime_silo/manifest_explorer`). Lists registered swarm manifests via `runtimeFetch` with no scope, mounts `dag.canvas` in `manifest` mode against the SwarmManifest → dag-data mapping (`mapManifestToDagData`). First user of the D2 "no scope = no header" path. Tests cover the pure mapping (wave inversion, run-overlay, defensive shape handling) and the hash-query parser. |
| **G** | open | Canvas consolidation — retire `ManifestCanvas` / `PipelineCanvas` / `WorkflowCanvas` from the runtime frontend; the migrated `dag.canvas` already ships all three modes. |
| **H1** | ✅ shipped | Session checkpoints — save / load / list / delete (draft only). `saveCheckpoint` / `loadCheckpoint` / `listCheckpoints` / `deleteCheckpoint` / `forkCheckpoint` browser helpers + `checkpoint_routes.py` (4 draft + 3 pinned endpoints) + pytest and `.mjs` test suites. API-only; no UI chrome. |
| **H2** | open | Session checkpoints — fork + UI chrome. Chat-panel save/restore/fork controls, HITL banner in Runs Explorer, fork badge with "back to base" link, auto-save `pre-restore-<ts>` before every restore, full CLI (`benny checkpoint` subcommands). |
| **H3** | open | Session checkpoints — pin. HMAC-signed checkpoints via the Phase F2 signing pipeline, `pinCheckpoint` / `loadPinnedCheckpoint` UI integration in the checkpoint picker, `CHECKPOINT_PINNED` audit event (already emitted by the runtime in H1), `benny checkpoint pin` + `inspect` reporting `pinned (valid ✓)`. |

Phase C follow-ups (post-Phase-E, independent of any open phase):
- **Three.js renderer** — ✅ shipped. `widgets/three_renderer/` exposes `createThreeRenderer()`; slots into the Phase C `options.renderer` hook on `kg3d.synoptic_web` and `codegraph.canvas`. The lib is dynamically imported from `https://esm.sh/3d-force-graph@1` on first mount (override via `options.cdnUrl`), so neither widget pays the bundle cost unless the caller opts in. Tests inject a stub loader so the node runner never touches the CDN.

## Working agreement

Driven by the user with one PR per phase, merge-then-continue cadence:
1. Take the next open phase from this table.
2. Cut a feature branch — convention `phase-<id>-<short-handle>` (e.g. `phase-f2-pin-view`).
3. Ship working code + tests + AGENTS.md updates in one PR against `main`.
4. User merges. User says **continue**. Repeat.

The shell repo is `binary16labs/prime-silo`. PRs land there; `runtime/` is a vendored Benny subtree that gets edited in-place when a phase touches the runtime.

## Decision recipes captured along the way

These are the architectural turns that survived review and should not be re-litigated unless someone has a real reason:

- **Two integration patterns for agent context** (D2). `mountAgentTurn(scope)` for long-running turns (closure captures scope; survives `await` boundaries). `runWithAgentContext(scope, fn)` for synchronous narrow flows (module-level active scope; lost across microtasks). Browsers have no `AsyncLocalStorage`; the dual-pattern is the unavoidable consequence.
- **Defence-in-depth for scope** (D2/D3/F). The shell never synthesises `X-Benny-Agent-Scope`; only the browser-side agent does. The proxy passes the header through unchanged. The runtime middleware is the only enforcer. A future shell change that accidentally drops the header surfaces as a 403, never as silent privilege escalation.
- **Renderer dependency strategy** (C, kg3d/codegraph). 2D SVG default + pluggable `options.renderer = { mount, update, dispose }`. Defers the Three.js bundling decision while validating the data path. Three.js becomes a drop-in via the same hook.
- **Agents draft, humans pin** (F). Sign/verify endpoints sit outside `/api/agent_sandbox/`, so `AgentScopeMiddleware` 403s every agent-scoped POST. Pinning is human-only by middleware policy, not by convention. The browser never holds `BENNY_HMAC_KEY`; the runtime does.
- **Sign now, persist later** (F → F2). Phase F shipped only the cryptographic chokepoint so the signing technique locks in before the persistence storage shape does. F2 adds `pinView` once the canonical-location decision is made.

## Where the code lives

| Concern | Path |
| ------- | ---- |
| Agent-context chokepoint (browser) | [`app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js`](../app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js) |
| Agent runtime mount point | [`app/L0/_all/mod/_prime_silo/agent_runtime/agent-runtime.js`](../app/L0/_all/mod/_prime_silo/agent_runtime/agent-runtime.js) |
| Scope middleware (runtime) | [`runtime/benny/api/agent_scope.py`](../runtime/benny/api/agent_scope.py) |
| Sandbox writes (runtime) | [`runtime/benny/api/agent_sandbox_routes.py`](../runtime/benny/api/agent_sandbox_routes.py) |
| View signing (runtime) | [`runtime/benny/api/views_signing.py`](../runtime/benny/api/views_signing.py) + [`views_routes.py`](../runtime/benny/api/views_routes.py) |
| Session checkpoints (browser) | [`app/L0/_all/mod/_prime_silo/session_checkpoint/index.js`](../app/L0/_all/mod/_prime_silo/session_checkpoint/index.js) |
| Session checkpoints (runtime) | [`runtime/benny/api/checkpoint_routes.py`](../runtime/benny/api/checkpoint_routes.py) |
| Browser→runtime proxy (shell) | [`server/lib/runtime_proxy.js`](../server/lib/runtime_proxy.js) |
| Migrated widgets | [`app/L0/_all/mod/_prime_silo/widgets/`](../app/L0/_all/mod/_prime_silo/widgets/) |
