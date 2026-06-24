// ADR-001 Phase D2 — agent runtime header injection.
//
// This is the integration seam between space-agent's browser-resident agent
// runtime and Prime-Silo's runtime proxy. When the agent runs a turn, it
// should mount an "agent context" through which any skill, widget, or tool
// it spawns can hit `/api/runtime/*` with the correct
// `X-Benny-Agent-Scope` header on every hop.
//
// Why a dedicated module
// ---------------------
// `runtime-client.js` exposes the primitives (`createAgentRuntimeClient`,
// `withAgentScope`). This module is the named import the agent runtime
// reaches for — keeps the boundary auditable: search the codebase for
// `agent-runtime.js` and you find every place an agent's call surface is
// constructed.
//
// Two surfaces, one source of truth (the runtime client):
//
//   1. `mountAgentTurn(scope)` — call once at the start of an agent turn.
//      Returns a `{ runtimeClient, dispose }` handle. The runtimeClient is
//      the shape widgets already accept via `options.runtimeClient`. Pass
//      it through to anything the agent spawns. `dispose()` is a no-op
//      safety hook reserved for future telemetry.
//
//   2. `runWithAgentContext(scope, fn)` — synchronous-flow helper. Wraps
//      `fn` so any direct call to `runtimeFetch` made on the synchronous
//      code path inside `fn` picks up the scope. Browsers have no
//      AsyncLocalStorage, so this is intentionally narrow — once `fn`
//      resolves, ambient context is gone. For long-running loops use
//      `mountAgentTurn`.
//
// Both routes converge on Benny's `AgentScopeMiddleware`: a write outside
// `agent_sandbox/` returns 403 regardless of which surface fired the call.
// That makes the boundary policy-enforced rather than convention-enforced.

import {
  createAgentRuntimeClient,
  withAgentScope,
  getActiveAgentScope
} from "../runtime_client/runtime-client.js";

const DEFAULT_AGENT_SCOPE = "sandbox";

/**
 * Mount an agent turn. Returns a handle the agent runtime threads through
 * its tool / skill / widget invocations.
 *
 * @param {"sandbox"|"read_only"} [scope="sandbox"]
 * @returns {{ scope: string, runtimeClient: object, dispose: () => void }}
 */
export function mountAgentTurn(scope = DEFAULT_AGENT_SCOPE) {
  const runtimeClient = createAgentRuntimeClient(scope);
  let disposed = false;
  return {
    get scope() {
      return runtimeClient.scope;
    },
    runtimeClient,
    dispose() {
      // No mutable state to release — the bound client is itself stateless
      // beyond the scope it captured. Reserved for future telemetry hooks
      // (turn-level lineage, audit-trail close events) so call sites pick
      // up dispose-on-end semantics today.
      disposed = true;
    },
    get disposed() {
      return disposed;
    }
  };
}

/**
 * Run `fn` inside an agent scope. Any `runtimeFetch` invoked synchronously
 * inside `fn` — including the first await on its returned promise — is
 * tagged with `X-Benny-Agent-Scope`. The previous active scope (or none) is
 * restored when `fn` resolves.
 *
 * @template T
 * @param {"sandbox"|"read_only"} scope
 * @param {() => T | Promise<T>} fn
 * @returns {T | Promise<T>}
 */
export function runWithAgentContext(scope, fn) {
  return withAgentScope(scope, fn);
}

/**
 * Inspect the active agent scope. Useful for assertions and structured
 * logging on the host side.
 *
 * @returns {string|null}
 */
export function getCurrentAgentScope() {
  return getActiveAgentScope();
}

export const __agent_runtime_meta__ = {
  schema_version: "1.0.0",
  description: "Phase D2 chokepoint for browser-resident agent runtime → Benny scope-tagged calls.",
  default_scope: DEFAULT_AGENT_SCOPE
};
