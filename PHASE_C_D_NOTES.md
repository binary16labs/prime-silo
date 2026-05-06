# Phase C/D — shell ↔ runtime wiring notes

This branch (`phase-c-d-wire-shell-runtime`) lands the first cut of Phase D
(runtime proxy + agent-scope plumbing) and the Phase C scaffolding that
canvas migration will attach to.

Phase B closed at "two processes side-by-side". This branch makes them talk.

## What landed

| Area                       | Files                                                                                                | Phase |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ----- |
| Shell → runtime proxy      | `server/lib/runtime_proxy.js`, dispatch in `server/router/router.js`                                 | D     |
| Browser-side runtime client | `app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js`                                       | D     |
| Widget registry client     | `app/L0/_all/mod/_prime_silo/widgets/widget-registry.js`                                             | C     |
| Module docs                | `app/L0/_all/mod/_prime_silo/{,runtime_client,widgets}/AGENTS.md`                                    | C/D   |
| Tests                      | `tests/runtime_proxy_test.mjs` (5 cases), `tests/widget_registry_test.mjs` (5 cases)                 | C/D   |

## How the proxy works

```
Browser                 Shell (Node)                Runtime (Python)
fetchAsAgent(           /api/runtime/agent_sandbox/  /api/agent_sandbox/
  "/agent_sandbox/  →   write                  →    write
  write",               + X-Benny-Agent-Scope        + X-Benny-API-Key
  ...)                  + X-Benny-API-Key (injected) + X-Benny-Agent-Scope
                                                     → AgentScopeMiddleware
                                                     → 200 OK if path is
                                                       inside agent_sandbox/
                                                     → 403 otherwise
```

- The shell is the trusted edge: it always injects `X-Benny-API-Key` so
  Benny's existing `GovernanceMiddleware` is satisfied.
- The shell **does not** synthesise `X-Benny-Agent-Scope`. The browser-side
  agent runtime sets it via `fetchAsAgent`; human-driven traffic uses
  `runtimeFetch` and inherits regular RBAC.
- Path stripping: `/api/runtime/<path>` → `/api/<path>` upstream.
- Configuration: `RUNTIME_BASE_URL` env (default `http://127.0.0.1:8005`),
  `BENNY_API_KEY` env (default `benny-mesh-2026-auth`).
- Error semantics: upstream non-2xx is propagated unchanged. Connection
  failure returns `502 runtime_proxy_unreachable`.

## Verification

```powershell
cd prime-silo

# Unit + integration tests for the proxy and widget registry
node tests/runtime_proxy_test.mjs
node tests/widget_registry_test.mjs

# End-to-end: boot both processes, hit through the proxy
$env:BENNY_HMAC_KEY = "<your hex key>"
.\scripts\dev.ps1
# Browser → http://localhost:<shell port>/api/runtime/widgets
#         → returns the 8 Phase A widget manifests via the runtime
```

## Boundary preserved

- The runtime's `AgentScopeMiddleware` is unchanged. Phase D adds a path,
  not new authority.
- `dag.canvas` carries `authority: deterministic_only` in the Phase A
  registry. The browser-side `isAuthorityAgentSafe` returns `false` for it;
  the runtime would also reject any agent-attempted state mutation. Two
  layers of defence, both committed to the same source of truth (the
  widget manifest).

## What is NOT yet wired

Phase D's *first half* lands here. The remainder is Phase D2/D3:

1. **Shell-side agent runtime header injection.** Space-agent's existing
   browser-resident agent runtime needs to route any `/api/runtime/*`
   call it makes through `fetchAsAgent` instead of `fetch`. Phase D2.
2. **Saved layout API.** `runtime_client` will gain `saveView`, `loadView`,
   `pinView` once layout pinning UX is decided. Phase D3.
3. **Canvas migration.** Phase C (per `widgets/AGENTS.md`) — port KG3D,
   `dag.canvas`, drill-down, frame inspector, lineage timeline into sibling
   folders under `widgets/`.
4. **`.aamp.view` signing.** Phase F — pinned layouts get HMAC-signed via
   the existing skin-pack path before they leave the shell.

## Known follow-ups carried over from Phase B

- Benny commit `e741043` (Phase A) is local-only on the worktree — push to
  `skybluecycology/benny` blocked by Git Credential Manager / gh CLI auth
  mismatch. Not blocking for the fork; subtree resolution still works
  through `file://`.
- gh PR creation is blocked by gh CLI logging in as `skybluecycology`,
  which lacks collaborator rights on `binary16labs/prime-silo`. PRs are
  opened via the GitHub web UI for now.
