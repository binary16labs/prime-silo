// ADR-001 Phase D — runtime client.
//
// Single browser-side fetch helper for talking to the Benny FastAPI runtime
// through the shell's /api/runtime/<path> proxy. All Prime-Silo widgets and
// agent-composed layouts go through here so:
//
//   • Agent-scope header injection has exactly one chokepoint.
//   • Tests can swap the underlying fetch by overriding window.fetch.
//   • Phase F (.aamp.view signing) gets a stable seam to verify before
//     pinned layouts replay against the runtime.
//
// Public API
//   runtimeFetch(path, init)        — request the runtime; auto-injects the
//                                     active agent scope when one is set via
//                                     withAgentScope() or createAgentRuntimeClient
//   fetchAsAgent(path, init, opts)  — explicit agent request; injects
//                                     X-Benny-Agent-Scope unconditionally
//   readRuntimeJson(response)       — parse the runtime's JSON body
//   listWidgets()                   — convenience wrapper around GET /widgets
//
// Phase D2 additions
//   createAgentRuntimeClient(scope) — bound client whose every call auto-injects
//                                     the agent scope. Hand this to skills /
//                                     widgets via options.runtimeClient and the
//                                     X-Benny-Agent-Scope header is on every
//                                     /api/runtime/* hop, audited at the
//                                     AgentScopeMiddleware in Benny.
//   withAgentScope(scope, fn)       — run fn() with scope set as the active
//                                     agent scope; restores on return.
//                                     Synchronous code path inside fn() —
//                                     including the *first* awaited runtimeFetch —
//                                     picks up the scope. Awaiting through
//                                     other tasks loses context (no
//                                     AsyncLocalStorage in browsers); for
//                                     long-running agent loops use
//                                     createAgentRuntimeClient instead.
//   getActiveAgentScope()           — returns the currently active scope or null.
//
// Path semantics: callers pass paths *relative to the runtime API root*.
//   listWidgets()                  → /api/runtime/widgets
//   runtimeFetch("/agent_sandbox/health") → /api/runtime/agent_sandbox/health
//
// Errors are thrown with .status set when the runtime returns non-2xx.

const RUNTIME_PROXY_PREFIX = "/api/runtime";

const VALID_AGENT_SCOPES = new Set(["sandbox", "read_only"]);

const AGENT_SCOPE_HEADER = "X-Benny-Agent-Scope";

// Module-scoped active agent scope. withAgentScope() pushes/pops; bound
// clients read it via the call site. The unbound runtimeFetch auto-injects
// this onto outgoing requests when no header was set explicitly.
let _activeAgentScope = null;

function joinPath(prefix, path) {
  if (!path || path === "/") {
    return prefix;
  }
  return path.startsWith("/") ? `${prefix}${path}` : `${prefix}/${path}`;
}

async function readErrorDetail(response) {
  try {
    const body = await response.text();
    if (!body) {
      return null;
    }
    try {
      return JSON.parse(body);
    } catch {
      return { detail: body };
    }
  } catch {
    return null;
  }
}

function createRuntimeError(response, body) {
  const detail =
    (body && (body.detail || body.error)) ||
    `Runtime ${response.status} ${response.statusText || ""}`.trim();
  const error = new Error(detail);
  error.name = "RuntimeError";
  error.status = response.status;
  error.body = body;
  return error;
}

function validateScope(scope) {
  if (!VALID_AGENT_SCOPES.has(scope)) {
    throw new Error(`Invalid agent scope: ${scope}. Expected one of ${[...VALID_AGENT_SCOPES].join(", ")}.`);
  }
}

/**
 * Make a request to the Benny runtime through the shell proxy.
 *
 * Without an active agent scope this is a *human-driven* request and the
 * runtime gates it via regular RBAC. When called from inside a
 * `withAgentScope()` block — or via a client returned from
 * `createAgentRuntimeClient(scope)` — the active scope is auto-injected as
 * the `X-Benny-Agent-Scope` header so the runtime's `AgentScopeMiddleware`
 * enforces the ADR-001 boundary on this hop.
 *
 * If the caller already set the header on `init.headers`, it wins — explicit
 * intent beats ambient context.
 */
export async function runtimeFetch(path, init = {}) {
  const url = joinPath(RUNTIME_PROXY_PREFIX, path);
  const headers = new Headers(init.headers || {});

  if (_activeAgentScope && !headers.has(AGENT_SCOPE_HEADER)) {
    headers.set(AGENT_SCOPE_HEADER, _activeAgentScope);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    credentials: init.credentials || "same-origin"
  });

  if (!response.ok) {
    const body = await readErrorDetail(response);
    throw createRuntimeError(response, body);
  }

  return response;
}

/**
 * Same as runtimeFetch, but injects the X-Benny-Agent-Scope header
 * unconditionally. Default scope is "sandbox" (writes confined to
 * agent_sandbox/). Pass {scope:"read_only"} to disallow writes entirely.
 *
 * Agent-authored writes that target anything outside /api/runtime/agent_sandbox/
 * will be rejected by the runtime with HTTP 403.
 */
export async function fetchAsAgent(path, init = {}, options = {}) {
  const scope = options.scope || "sandbox";
  validateScope(scope);

  const headers = new Headers(init.headers || {});
  headers.set(AGENT_SCOPE_HEADER, scope);

  return runtimeFetch(path, { ...init, headers });
}

export async function readRuntimeJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Convenience: GET /api/runtime/widgets and parse the JSON body. Throws
 * RuntimeError if the runtime is unreachable or returns non-2xx.
 *
 * When called from an agent context (withAgentScope or
 * createAgentRuntimeClient), the listing fetch is itself tagged with the
 * agent scope header so the audit log records who asked.
 */
export async function listWidgets() {
  const response = await runtimeFetch("/widgets");
  return readRuntimeJson(response);
}

/**
 * Phase D2 — synchronous agent-scope context.
 *
 * Sets the active agent scope for the duration of `fn()` and restores the
 * previous scope on return. Browsers don't have AsyncLocalStorage, so the
 * scope only auto-applies for the synchronous code path inside `fn` —
 * including the *first* await on `runtimeFetch`. Once `fn` resolves, the
 * scope is gone. For long-running agent loops, use
 * `createAgentRuntimeClient(scope)` and pass the bound client through.
 *
 * Nesting works: inner scopes shadow outer scopes and the outer scope is
 * restored when the inner block returns.
 *
 * @param {"sandbox"|"read_only"} scope
 * @param {() => T | Promise<T>} fn
 * @returns {T | Promise<T>}
 */
export function withAgentScope(scope, fn) {
  validateScope(scope);
  if (typeof fn !== "function") {
    throw new Error("withAgentScope: fn must be a function.");
  }
  const previous = _activeAgentScope;
  _activeAgentScope = scope;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        _activeAgentScope = previous;
      });
    }
    _activeAgentScope = previous;
    return result;
  } catch (err) {
    _activeAgentScope = previous;
    throw err;
  }
}

/**
 * Phase D2 — return the active agent scope, or null when no scope is in
 * effect. Useful for assertions and structured logging.
 */
export function getActiveAgentScope() {
  return _activeAgentScope;
}

/**
 * Phase D2 — bound runtime client whose every call auto-injects the given
 * agent scope. The space-agent browser-resident agent runtime should call
 * `createAgentRuntimeClient("sandbox")` once per turn and pass the result as
 * `options.runtimeClient` to whatever skill / widget / tool it spawns. Each
 * outgoing /api/runtime/* hop carries `X-Benny-Agent-Scope`, so the runtime's
 * `AgentScopeMiddleware` audits the call regardless of which code path
 * originates it.
 *
 * The bound client is shape-compatible with what widgets already accept via
 * `options.runtimeClient` ({ runtimeFetch, readRuntimeJson, … }) — no widget
 * changes required.
 *
 * @param {"sandbox"|"read_only"} scope
 * @returns {{
 *   scope: string,
 *   runtimeFetch: (path: string, init?: object) => Promise<Response>,
 *   fetchAsAgent: (path: string, init?: object, options?: {scope?: string}) => Promise<Response>,
 *   readRuntimeJson: (response: Response) => Promise<unknown>,
 *   listWidgets: () => Promise<unknown>
 * }}
 */
export function createAgentRuntimeClient(scope) {
  validateScope(scope);
  return {
    get scope() {
      return scope;
    },
    runtimeFetch(path, init = {}) {
      return fetchAsAgent(path, init, { scope });
    },
    fetchAsAgent(path, init = {}, options = {}) {
      return fetchAsAgent(path, init, { scope: options.scope || scope });
    },
    readRuntimeJson(response) {
      return readRuntimeJson(response);
    },
    async listWidgets() {
      const response = await fetchAsAgent("/widgets", {}, { scope });
      return readRuntimeJson(response);
    }
  };
}

export const __testing = {
  RUNTIME_PROXY_PREFIX,
  AGENT_SCOPE_HEADER,
  joinPath,
  resetAgentScope() {
    _activeAgentScope = null;
  },
  getActiveAgentScopeForTest() {
    return _activeAgentScope;
  }
};
