# AGENTS — `_prime_silo/runtime_client/`

## Purpose

Browser-side helper for talking to the Benny FastAPI runtime through the shell's `/api/runtime/<path>` proxy.

This is the **single chokepoint** for agent-scope header injection. Anything else in the shell that needs to talk to the runtime imports from here — widgets, layout-pinning code, drill-down fetchers, audit-query views.

## Files

| File                | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-client.js` | Transport: `runtimeFetch`, `fetchAsAgent`, `listWidgets`, `readRuntimeJson`. Phase D2 additions: `createAgentRuntimeClient(scope)`, `withAgentScope(scope, fn)`, `getActiveAgentScope()`. Phase D3 additions: `saveView`, `loadView`, `listViews` (standalone + bound). Phase F additions: `signView`, `verifyView` (standalone + bound; bound calls 403 by middleware design). Phase F2 addition: `pinView` (standalone + bound; bound 403s — humans pin). Phase F2b addition: `loadPinnedView` (standalone + bound; reads ARE allowed for agents — replay must work for any caller). |

## Boundary

> **ADR-001 confused-deputy fix:** scope is no longer something the browser asserts. There are **two proxy facades**: human traffic goes to `/api/runtime/*` (the shell injects the trusted Benny key and _strips_ any `X-Benny-Agent-Scope`); agent traffic goes to `/api/agent-runtime/*` (the shell injects a distinct sandbox-bound key and _forces_ the scope server-side). This client routes to the agent facade automatically whenever an agent scope is active (`withAgentScope` / `fetchAsAgent` / a bound client) and to the human facade otherwise. The `X-Benny-Agent-Scope` header is still sent for audit/back-compat, but the proxy — not the header — is authoritative. Residual gap: same-origin in-page JS can still choose the human path; full isolation of the agent runtime is tracked in the ADR-001 follow-up.

- `runtimeFetch(path, init)` — runtime call. Routes to the agent facade when an agent scope is active (via `withAgentScope` or a bound client), else the human facade. Sends the active scope header for audit; the server re-asserts it.
- `fetchAsAgent(path, init, {scope})` — explicit agent-originated traffic. Runs in the agent scope context so the call hits `/api/agent-runtime/*` and the runtime's `AgentScopeMiddleware` confines writes to `/api/agent_sandbox/`. Default scope is `sandbox`; pass `{scope: "read_only"}` for inspection-only flows.
- `createAgentRuntimeClient(scope)` — returns a runtime-client-shaped object whose every call auto-injects scope. Pass through `options.runtimeClient` to widgets / skills / tools so the agent's call surface is scope-tagged end-to-end. **Preferred** for long-running agent turns. Phase D2.
- `withAgentScope(scope, fn)` — synchronous-flow helper. Sets the active scope for the duration of `fn` and restores on return. Browsers have no `AsyncLocalStorage`; use this for short, narrow code paths and `createAgentRuntimeClient` for everything else. Phase D2.
- `getActiveAgentScope()` — returns the currently active scope, or `null`. Useful for assertions and structured logs.
- `saveView(workspace, filename, content, {agentId})` — POST `/agent_sandbox/views/save`. Accepts a JSON string _or_ a JSON-serialisable object (the helper stringifies). The runtime forces `subdir="views"` and validates the body parses as JSON, so a stray call cannot land outside `agent_sandbox/views/`. Phase D3.
- `loadView(workspace, filename, {parseJson})` — GET `/agent_sandbox/read/<ws>/views/<filename>`. Returns the runtime envelope `{workspace, subdir, filename, relative_path, content, bytes}`. Default behaviour parses `content` as JSON and exposes the result on `view`; pass `{parseJson:false}` to skip. Phase D3.
- `listViews(workspace, {raw})` — GET `/agent_sandbox/list/<ws>/views`. Returns the entries array directly, or pass `{raw:true}` for the full envelope. Phase D3.
- `signView(view)` — POST `/views/sign`. The runtime computes HMAC-SHA256 over a canonical payload (sorted keys, no whitespace, `signature` field stripped) and returns `{signature: {algorithm, value, signed_at}, canonical_payload: "..."}`. Mounted _outside_ `/api/agent_sandbox/`, so a bound agent client calling this surfaces the security boundary as a `RuntimeError(status=403)` — pinning is a human action by middleware policy, not by convention. Phase F.
- `verifyView(view, signature)` — POST `/views/verify`. The runtime uses `hmac.compare_digest` for constant-time comparison; the helper returns the boolean directly. Same human-only boundary as `signView`. Phase F.
- `pinView(workspace, sourceFilename, {targetFilename, pinnedBy})` — POST `/views/pin`. The runtime re-reads `agent_sandbox/views/<sourceFilename>`, signs it, embeds the signature inline under `signature`, writes to the workspace's canonical `views/<targetFilename or sourceFilename>` directory (outside the sandbox), and emits a `VIEW_PINNED` audit event. Same middleware boundary as `signView` — pinning is human-only. Phase F2.
- `loadPinnedView(workspace, filename)` — GET `/views/load/<workspace>/<filename>`. The runtime reads the pinned file from `<workspace>/views/<filename>`, extracts the embedded `signature` field, recomputes the HMAC over the rest of the canonical payload, and returns `{workspace, filename, relative_path, bytes, view, signature, valid}`. `valid: false` is NOT an HTTP error — missing/malformed inline signatures and tampered bodies both surface as `valid: false` so the caller has a single decision point. Reads are NOT 403'd by `AgentScopeMiddleware` — bound agent clients can replay pinned views even though they cannot create them. The shell never holds `BENNY_HMAC_KEY`; it consumes `valid` only. Phase F2b.

The named import the agent runtime should use lives one folder over in [`_prime_silo/agent_runtime/agent-runtime.js`](../agent_runtime/agent-runtime.js) — it re-exports the bound-client factory through `mountAgentTurn` so the boundary is auditable by name.

## Local contracts

- Paths are passed **relative to the runtime API root**. The proxy prefix (`/api/runtime` for human calls, `/api/agent-runtime` for scoped agent calls) is chosen and appended internally — callers do not write it themselves.
- Non-2xx responses raise `RuntimeError` (a regular Error with `.status` and `.body` populated). Callers can branch on `error.status === 403` to surface "agent attempted disallowed write" to a layout panel.
- Auth cookies and CSRF tokens flow normally through `credentials: "same-origin"`. The shell's edge auth still applies; this module does not bypass authentication.
- Scope validation rejects anything outside `{"sandbox", "read_only"}` synchronously, before any header is set. The runtime would reject other values with 403, but failing fast in the browser surfaces typos at the call site.

## Phase status

- **Phase D** — transport scaffolded. `listWidgets` proved the proxy chain end-to-end.
- **Phase D2** — agent-context chokepoint shipped. `createAgentRuntimeClient` and `withAgentScope` give the browser-resident agent runtime exactly two ways to tag traffic, both flowing through `AgentScopeMiddleware`.
- **Phase D3** — saved-layout helpers shipped. `saveView`, `loadView`, `listViews` ride the Phase D2 chokepoint and exercise the agent_sandbox write path end-to-end.
- **Phase F** — `.aamp.view` signing chokepoint shipped. The runtime owns the HMAC key (`BENNY_HMAC_KEY` env var → dev fallback) and exposes `POST /api/views/sign` + `POST /api/views/verify`. The browser never holds the key; it asks the runtime to sign or verify. Mounting these endpoints outside `/api/agent_sandbox/` makes the policy explicit: agents draft, humans pin.
- **Phase F2** — `pinView` shipped. Composes signing + canonical-location write + lineage emission server-side under `POST /api/views/pin`. Pinned views land at `$BENNY_HOME/workspaces/<ws>/views/<filename>` with the signature embedded inline under `signature`, so the file is self-describing.
- **Phase F2b (this commit)** — `loadPinnedView` shipped. `GET /api/views/load/<ws>/<filename>` is the read-back companion to `pinView`: read + verify in one round-trip, returning `{view, signature, valid}`. Closes the F→F2 read-write-load triad. Browser-side helper rides the same chokepoint; the bound-client variant tags the scope header for audit logs but the call is not 403'd because reads are unrestricted by `AgentScopeMiddleware` (agents may replay deterministic-zone artefacts, just not create them).
