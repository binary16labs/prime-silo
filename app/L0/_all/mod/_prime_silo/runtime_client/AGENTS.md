# AGENTS — `_prime_silo/runtime_client/`

## Purpose

Browser-side helper for talking to the Benny FastAPI runtime through the shell's `/api/runtime/<path>` proxy.

This is the **single chokepoint** for agent-scope header injection. Anything else in the shell that needs to talk to the runtime imports from here — widgets, layout-pinning code, drill-down fetchers, audit-query views.

## Files

| File              | Owns                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `runtime-client.js` | `runtimeFetch`, `fetchAsAgent`, `listWidgets`, `readRuntimeJson` exports |

## Boundary

- `runtimeFetch(path, init)` — human / unscoped traffic. The runtime applies normal governance + RBAC. Use when a *user click* originated the request.
- `fetchAsAgent(path, init, {scope})` — agent-originated traffic. Injects `X-Benny-Agent-Scope`. The runtime's `AgentScopeMiddleware` confines writes to `/api/agent_sandbox/`. Default scope is `sandbox`; pass `{scope: "read_only"}` for inspection-only flows.

## Local contracts

- Paths are passed **relative to the runtime API root**. The proxy prefix `/api/runtime` is appended internally — callers do not write it themselves.
- Non-2xx responses raise `RuntimeError` (a regular Error with `.status` and `.body` populated). Callers can branch on `error.status === 403` to surface "agent attempted disallowed write" to a layout panel.
- Auth cookies and CSRF tokens flow normally through `credentials: "same-origin"`. The shell's edge auth still applies; this module does not bypass authentication.

## Phase status

- **Phase D (this module)** — scaffolded. `listWidgets` proves the proxy chain end-to-end.
- **Phase D follow-up** — saved-layout helpers (`saveView`, `loadView`, `pinView`) once the runtime exposes `/api/runtime/agent_sandbox/views/save` from agent context.
- **Phase F** — `.aamp.view` signing helpers will live here so signing happens before the request leaves the shell.
