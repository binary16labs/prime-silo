# AGENTS — `_prime_silo/runtime_client/`

## Purpose

Browser-side helper for talking to the Benny FastAPI runtime through the shell's `/api/runtime/<path>` proxy.

This is the **single chokepoint** for agent-scope header injection. Anything else in the shell that needs to talk to the runtime imports from here — widgets, layout-pinning code, drill-down fetchers, audit-query views.

## Files

| File              | Owns                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `runtime-client.js` | Transport: `runtimeFetch`, `fetchAsAgent`, `listWidgets`, `readRuntimeJson`. Phase D2 additions: `createAgentRuntimeClient(scope)`, `withAgentScope(scope, fn)`, `getActiveAgentScope()`. |

## Boundary

- `runtimeFetch(path, init)` — runtime call. **Auto-injects** the active agent scope when one is set via `withAgentScope` or a bound client; otherwise human / unscoped traffic. Explicit `init.headers["X-Benny-Agent-Scope"]` always wins.
- `fetchAsAgent(path, init, {scope})` — explicit agent-originated traffic. Injects `X-Benny-Agent-Scope` unconditionally. The runtime's `AgentScopeMiddleware` confines writes to `/api/agent_sandbox/`. Default scope is `sandbox`; pass `{scope: "read_only"}` for inspection-only flows.
- `createAgentRuntimeClient(scope)` — returns a runtime-client-shaped object whose every call auto-injects scope. Pass through `options.runtimeClient` to widgets / skills / tools so the agent's call surface is scope-tagged end-to-end. **Preferred** for long-running agent turns. Phase D2.
- `withAgentScope(scope, fn)` — synchronous-flow helper. Sets the active scope for the duration of `fn` and restores on return. Browsers have no `AsyncLocalStorage`; use this for short, narrow code paths and `createAgentRuntimeClient` for everything else. Phase D2.
- `getActiveAgentScope()` — returns the currently active scope, or `null`. Useful for assertions and structured logs.

The named import the agent runtime should use lives one folder over in [`_prime_silo/agent_runtime/agent-runtime.js`](../agent_runtime/agent-runtime.js) — it re-exports the bound-client factory through `mountAgentTurn` so the boundary is auditable by name.

## Local contracts

- Paths are passed **relative to the runtime API root**. The proxy prefix `/api/runtime` is appended internally — callers do not write it themselves.
- Non-2xx responses raise `RuntimeError` (a regular Error with `.status` and `.body` populated). Callers can branch on `error.status === 403` to surface "agent attempted disallowed write" to a layout panel.
- Auth cookies and CSRF tokens flow normally through `credentials: "same-origin"`. The shell's edge auth still applies; this module does not bypass authentication.
- Scope validation rejects anything outside `{"sandbox", "read_only"}` synchronously, before any header is set. The runtime would reject other values with 403, but failing fast in the browser surfaces typos at the call site.

## Phase status

- **Phase D** — transport scaffolded. `listWidgets` proved the proxy chain end-to-end.
- **Phase D2 (this commit)** — agent-context chokepoint shipped. `createAgentRuntimeClient` and `withAgentScope` give the browser-resident agent runtime exactly two ways to tag traffic, both flowing through `AgentScopeMiddleware`.
- **Phase D3** — saved-layout helpers (`saveView`, `loadView`, `pinView`) once the runtime exposes `/api/runtime/agent_sandbox/views/save` from agent context.
- **Phase F** — `.aamp.view` signing helpers will live here so signing happens before the request leaves the shell.
