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
// Phase D3 additions
//   saveView(workspace, filename, content, options?)  — POST a JSON layout
//                                                       into agent_sandbox/views
//   loadView(workspace, filename, options?)           — GET + parse a saved view
//   listViews(workspace, options?)                    — GET the saved-view names
//
//   Bound clients gain the same three methods with the agent scope baked in.
//
// Phase F additions
//   signView(view, options?)                — POST /views/sign; returns
//                                              {signature, canonical_payload}.
//                                              Human-only: AgentScopeMiddleware
//                                              rejects agent-scoped POSTs to
//                                              /api/views/* with 403, so a bound
//                                              agent client calling this
//                                              surfaces the security boundary
//                                              as a RuntimeError(status=403).
//   verifyView(view, signature, options?)   — POST /views/verify; returns the
//                                              boolean result of the runtime's
//                                              constant-time HMAC compare.
//
// Phase F2 additions
//   pinView(workspace, sourceFilename, opts) — POST /views/pin; promotes an
//                                              agent draft from
//                                              agent_sandbox/views/<src> to
//                                              the canonical workspace
//                                              views/<dst>. The runtime
//                                              re-reads, signs, embeds the
//                                              signature inline, and emits
//                                              VIEW_PINNED. Human-only by
//                                              middleware.
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
 * Phase D3 — save a JSON layout view into the workspace's
 * `agent_sandbox/views/` subtree.
 *
 * The runtime endpoint validates that the body parses as JSON and forces
 * `subdir="views"` so a stray call cannot silently land in `drafts/` or
 * `notes/`. Callers may pass either a JSON string or any JSON-serialisable
 * object — objects are stringified before send so the JSON validation on
 * both sides agrees.
 *
 * Filename convention: `<id>.aamp.view`, but enforcement happens server-side
 * (no path separators, no leading dot). This helper does not invent the
 * extension — Phase F .aamp.view signing belongs at the manifest layer, not
 * here.
 *
 * Returns the runtime's `SandboxWriteResponse`:
 *   { status: "written", workspace, relative_path, bytes_written }
 *
 * Auto-injects the active agent scope when one is set; the bound-client
 * variant forces it. Without scope this is a human-driven write — the runtime
 * still validates JSON and path containment.
 *
 * @param {string} workspace
 * @param {string} filename
 * @param {string | object} content
 * @param {{ agentId?: string }} [options]
 * @returns {Promise<{status: "written", workspace: string, relative_path: string, bytes_written: number}>}
 */
export async function saveView(workspace, filename, content, options = {}) {
  const body = serialiseViewContent(content);
  const payload = {
    workspace,
    subdir: "views",
    filename,
    content: body,
    agent_id: options.agentId || "anonymous_agent"
  };
  const response = await runtimeFetch("/agent_sandbox/views/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return readRuntimeJson(response);
}

/**
 * Phase D3 — load a saved view from `agent_sandbox/views/`.
 *
 * Returns the runtime's read envelope:
 *   { workspace, subdir: "views", filename, relative_path, content, bytes }
 *
 * `content` is the raw UTF-8 string the file contains. By default the helper
 * also parses it as JSON and exposes the result on the `view` property —
 * pass `{ parseJson: false }` to skip parsing for non-JSON layouts (none
 * exist today; the runtime guards JSON on save, but the read endpoint is
 * format-agnostic).
 *
 * @param {string} workspace
 * @param {string} filename
 * @param {{ parseJson?: boolean }} [options]
 */
export async function loadView(workspace, filename, options = {}) {
  const path = `/agent_sandbox/read/${encodeURIComponent(workspace)}/views/${encodeURIComponent(filename)}`;
  const response = await runtimeFetch(path);
  const envelope = await readRuntimeJson(response);
  const parseJson = options.parseJson !== false;
  if (parseJson && envelope && typeof envelope.content === "string") {
    try {
      envelope.view = JSON.parse(envelope.content);
    } catch (err) {
      const error = new Error(`loadView: stored content is not valid JSON: ${err.message}`);
      error.name = "RuntimeError";
      error.cause = err;
      throw error;
    }
  }
  return envelope;
}

/**
 * Phase D3 — list saved view filenames for a workspace.
 *
 * Returns the entries array directly (the runtime envelope's `entries` field).
 * Pass `{ raw: true }` to get the full envelope `{ workspace, subdir, entries }`
 * instead.
 *
 * @param {string} workspace
 * @param {{ raw?: boolean }} [options]
 */
export async function listViews(workspace, options = {}) {
  const path = `/agent_sandbox/list/${encodeURIComponent(workspace)}/views`;
  const response = await runtimeFetch(path);
  const envelope = await readRuntimeJson(response);
  if (options.raw) {
    return envelope;
  }
  return (envelope && Array.isArray(envelope.entries)) ? envelope.entries : [];
}

/**
 * Phase F — sign a `.aamp.view` layout via the runtime's HMAC chokepoint.
 *
 * Posts the view to `/api/views/sign` (intentionally outside the agent_sandbox
 * prefix). `AgentScopeMiddleware` blocks any agent-scoped POST here with HTTP
 * 403, so calling `signView` from a bound agent client surfaces the security
 * boundary as a `RuntimeError(status=403)` — the runtime is the enforcer, not
 * this module.
 *
 * Accepts a JSON-serialisable view object. The runtime computes HMAC-SHA256
 * over a canonical payload (sorted keys, no whitespace, `signature` field
 * stripped) and returns:
 *
 *   { signature: { algorithm, value, signed_at }, canonical_payload: "..." }
 *
 * The canonical payload is returned so callers can audit exactly what was
 * signed before embedding the signature back into the view.
 *
 * @param {object} view
 * @param {{ }} [options]
 * @returns {Promise<{signature: {algorithm: string, value: string, signed_at: string}, canonical_payload: string}>}
 */
export async function signView(view, options = {}) {
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    throw new Error("signView: view must be a JSON object.");
  }
  const response = await runtimeFetch("/views/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view })
  });
  return readRuntimeJson(response);
}

/**
 * Phase F — verify an HMAC-SHA256 signature over a `.aamp.view` payload.
 *
 * Posts `{view, signature}` to `/api/views/verify` and returns the runtime's
 * boolean result. The runtime uses `hmac.compare_digest` to avoid timing
 * leaks; clients must treat any non-true result as a verification failure.
 *
 * Like `signView`, this endpoint sits outside `/api/agent_sandbox/`, so a
 * bound agent client invoking it triggers the middleware's 403 — verification
 * is a human / shell-server action.
 *
 * @param {object} view
 * @param {{algorithm: string, value: string, signed_at: string}} signature
 * @param {{ }} [options]
 * @returns {Promise<boolean>}
 */
export async function verifyView(view, signature, options = {}) {
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    throw new Error("verifyView: view must be a JSON object.");
  }
  if (!signature || typeof signature !== "object") {
    throw new Error("verifyView: signature must be an envelope object.");
  }
  const response = await runtimeFetch("/views/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view, signature })
  });
  const body = await readRuntimeJson(response);
  return Boolean(body && body.valid);
}

/**
 * Phase F2 — promote an agent-drafted view to a signed, canonical workspace
 * location.
 *
 * Posts `{workspace, source_filename, target_filename?, pinned_by?}` to
 * `/api/views/pin`. The runtime re-reads the draft from
 * `agent_sandbox/views/<source_filename>`, signs it, embeds the signature
 * inline, writes to `<workspace>/views/<target_filename>` (defaulting to
 * `source_filename`), and emits a `VIEW_PINNED` audit event.
 *
 * Same human-only boundary as `signView` — `/api/views/pin` lives outside
 * `/api/agent_sandbox/`, so a bound agent client invoking this triggers
 * `RuntimeError(status=403)`.
 *
 * Returns the runtime's `PinViewResponse`:
 *   {
 *     workspace, source_relative_path, pinned_relative_path,
 *     bytes_written, signature: { algorithm, value, signed_at }
 *   }
 *
 * @param {string} workspace
 * @param {string} sourceFilename — must match `agent_sandbox/views/<filename>`
 * @param {{ targetFilename?: string, pinnedBy?: string }} [options]
 */
export async function pinView(workspace, sourceFilename, options = {}) {
  if (typeof workspace !== "string" || !workspace) {
    throw new Error("pinView: workspace is required.");
  }
  if (typeof sourceFilename !== "string" || !sourceFilename) {
    throw new Error("pinView: sourceFilename is required.");
  }
  const payload = {
    workspace,
    source_filename: sourceFilename
  };
  if (options.targetFilename) {
    payload.target_filename = options.targetFilename;
  }
  if (options.pinnedBy) {
    payload.pinned_by = options.pinnedBy;
  }
  const response = await runtimeFetch("/views/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return readRuntimeJson(response);
}

function serialiseViewContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    throw new Error("saveView: content must be a JSON string or a JSON-serialisable object.");
  }
  return JSON.stringify(content);
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
 *   listWidgets: () => Promise<unknown>,
 *   saveView: (workspace: string, filename: string, content: string | object, options?: {agentId?: string}) => Promise<unknown>,
 *   loadView: (workspace: string, filename: string, options?: {parseJson?: boolean}) => Promise<unknown>,
 *   listViews: (workspace: string, options?: {raw?: boolean}) => Promise<unknown>,
 *   signView: (view: object, options?: object) => Promise<unknown>,
 *   verifyView: (view: object, signature: object, options?: object) => Promise<boolean>,
 *   pinView: (workspace: string, sourceFilename: string, options?: {targetFilename?: string, pinnedBy?: string}) => Promise<unknown>
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
    },
    saveView(workspace, filename, content, options = {}) {
      return withAgentScope(scope, () => saveView(workspace, filename, content, options));
    },
    loadView(workspace, filename, options = {}) {
      return withAgentScope(scope, () => loadView(workspace, filename, options));
    },
    listViews(workspace, options = {}) {
      return withAgentScope(scope, () => listViews(workspace, options));
    },
    // Phase F — the bound client tags signView/verifyView with the agent
    // scope, but the routes live outside /api/agent_sandbox/ so the runtime
    // middleware will 403 every agent-scoped POST. The 403 is the boundary;
    // do not silently downgrade by stripping the header here.
    signView(view, options = {}) {
      return withAgentScope(scope, () => signView(view, options));
    },
    verifyView(view, signature, options = {}) {
      return withAgentScope(scope, () => verifyView(view, signature, options));
    },
    // Phase F2 — same defence-in-depth: pinView from a bound agent client
    // forwards the scope header and the runtime's middleware issues 403.
    // Pinning is human-only by middleware policy.
    pinView(workspace, sourceFilename, options = {}) {
      return withAgentScope(scope, () => pinView(workspace, sourceFilename, options));
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
