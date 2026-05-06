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
//   runtimeFetch(path, init)        — human / unscoped request (regular RBAC)
//   fetchAsAgent(path, init, opts)  — agent request; injects X-Benny-Agent-Scope
//   listWidgets()                   — convenience wrapper around GET /widgets
//
// Path semantics: callers pass paths *relative to the runtime API root*.
//   listWidgets()                  → /api/runtime/widgets
//   runtimeFetch("/agent_sandbox/health") → /api/runtime/agent_sandbox/health
//
// Errors are thrown with .status set when the runtime returns non-2xx.

const RUNTIME_PROXY_PREFIX = "/api/runtime";

const VALID_AGENT_SCOPES = new Set(["sandbox", "read_only"]);

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

/**
 * Make an unscoped request to the Benny runtime through the shell proxy.
 * Use this for *human-driven* requests originating from a user clicking a
 * deterministic-zone surface. Agent-driven requests must call fetchAsAgent.
 */
export async function runtimeFetch(path, init = {}) {
  const url = joinPath(RUNTIME_PROXY_PREFIX, path);
  const response = await fetch(url, {
    ...init,
    credentials: init.credentials || "same-origin"
  });

  if (!response.ok) {
    const body = await readErrorDetail(response);
    throw createRuntimeError(response, body);
  }

  return response;
}

/**
 * Same as runtimeFetch, but injects the X-Benny-Agent-Scope header so the
 * Benny `AgentScopeMiddleware` enforces the ADR-001 boundary. Default scope
 * is "sandbox" (writes confined to agent_sandbox/). Pass {scope:"read_only"}
 * to disallow writes entirely.
 *
 * Agent-authored writes that target anything outside /api/runtime/agent_sandbox/
 * will be rejected by the runtime with HTTP 403.
 */
export async function fetchAsAgent(path, init = {}, options = {}) {
  const scope = options.scope || "sandbox";
  if (!VALID_AGENT_SCOPES.has(scope)) {
    throw new Error(`Invalid agent scope: ${scope}. Expected one of ${[...VALID_AGENT_SCOPES].join(", ")}.`);
  }

  const headers = new Headers(init.headers || {});
  headers.set("X-Benny-Agent-Scope", scope);

  return runtimeFetch(path, { ...init, headers });
}

export async function readRuntimeJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Convenience: GET /api/runtime/widgets and parse the JSON body. Throws
 * RuntimeError if the runtime is unreachable or returns non-2xx.
 */
export async function listWidgets() {
  const response = await runtimeFetch("/widgets");
  return readRuntimeJson(response);
}

export const __testing = {
  RUNTIME_PROXY_PREFIX,
  joinPath
};
