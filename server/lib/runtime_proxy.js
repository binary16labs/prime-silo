// ADR-001 Phase D — Benny runtime proxy.
//
// Forwards shell requests to the Benny FastAPI runtime (default
// http://127.0.0.1:8005) over two distinct, server-authoritative facades:
//
//   • /api/runtime/<path>        — HUMAN path. Strips /api/runtime, injects the
//     trusted BENNY_API_KEY, and *strips* any client X-Benny-Agent-Scope. A
//     human-driven request runs under Benny's normal RBAC (no agent scope).
//
//   • /api/agent-runtime/<path>  — AGENT path. Strips /api/agent-runtime,
//     injects the sandbox-bound BENNY_AGENT_API_KEY, and *sets* the agent
//     scope to "sandbox" server-side, overwriting whatever the client sent.
//
// Why two paths (ADR-001 confused-deputy fix): the determinism boundary used to
// be a client-set X-Benny-Agent-Scope header, so any authenticated caller could
// omit it and reach Benny with full trust. Scope is now bound to a credential
// the *proxy* injects, never to a header the browser controls. Benny's
// AgentScopeMiddleware additionally pins the agent key to sandbox scope so the
// boundary holds even if this proxy is misconfigured.
//
//   RESIDUAL GAP: both paths are same-origin, so in-page JS can still choose to
//   call /api/runtime instead of /api/agent-runtime. Closing that requires the
//   browser agent runtime to execute isolated from human JS (sandboxed
//   worker/iframe) — tracked in architecture/ADR-001 follow-up. This proxy
//   makes the boundary credential-bound; isolation makes it unbypassable.
//
// Configuration (env):
//   RUNTIME_BASE_URL     Default: "http://127.0.0.1:8005"
//   BENNY_API_KEY        Trusted/human key. Required in production.
//   BENNY_AGENT_API_KEY  Sandbox-bound agent key. Required in production.
//
// Streams request/response bodies; hop-by-hop headers stripped both directions
// (see service_proxy.js).

import { buildUpstreamHeaders, forwardToUpstream } from "./service_proxy.js";

const RUNTIME_PATH_PREFIX = "/api/runtime";
const AGENT_RUNTIME_PATH_PREFIX = "/api/agent-runtime";

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:8005";

const AGENT_SCOPE_HEADER = "X-Benny-Agent-Scope";
const SANDBOX_SCOPE = "sandbox";

// Dev-only fallbacks. In production these are refused (see resolveCredential /
// assertRuntimeProxyConfig) so a real deployment can never run on a shipped key.
const DEV_FALLBACK_API_KEY = "benny-mesh-2026-auth";
const DEV_FALLBACK_AGENT_API_KEY = "benny-agent-sandbox-2026-dev";

function isProduction() {
  const env = String(process.env.NODE_ENV || process.env.PRIME_SILO_ENV || "").toLowerCase();
  return env === "production";
}

function resolveCredential(envName, devFallback) {
  const value = process.env[envName];
  if (value) {
    return value;
  }
  if (isProduction()) {
    throw new Error(
      `${envName} is required in production. Refusing to proxy to the Benny runtime with a built-in development key. ` +
        `Set ${envName} in the environment (see DEVOPS.md / docker-compose).`
    );
  }
  return devFallback;
}

/**
 * Fail-fast credential check, called once at server startup (see app.js). In
 * production this throws before the server begins listening if either Benny key
 * is missing, rather than silently falling back to a shipped default per
 * request. In development it is a no-op (dev fallbacks apply).
 */
export function assertRuntimeProxyConfig() {
  if (!isProduction()) {
    return;
  }
  // resolveCredential throws in production when the env var is absent.
  resolveCredential("BENNY_API_KEY", DEV_FALLBACK_API_KEY);
  resolveCredential("BENNY_AGENT_API_KEY", DEV_FALLBACK_AGENT_API_KEY);
}

function getRuntimeBaseUrl() {
  return (process.env.RUNTIME_BASE_URL || DEFAULT_RUNTIME_BASE_URL).replace(/\/+$/, "");
}

function getBennyApiKey() {
  return resolveCredential("BENNY_API_KEY", DEV_FALLBACK_API_KEY);
}

function getBennyAgentApiKey() {
  return resolveCredential("BENNY_AGENT_API_KEY", DEV_FALLBACK_AGENT_API_KEY);
}

export function isRuntimeProxyPath(pathname) {
  return pathname === RUNTIME_PATH_PREFIX || pathname.startsWith(RUNTIME_PATH_PREFIX + "/");
}

export function isAgentRuntimeProxyPath(pathname) {
  return (
    pathname === AGENT_RUNTIME_PATH_PREFIX || pathname.startsWith(AGENT_RUNTIME_PATH_PREFIX + "/")
  );
}

function buildUpstreamUrlFor(prefix, requestUrl) {
  // Strip the proxy prefix and rebuild against the runtime base.
  // /api/runtime/agent_sandbox/health → http://127.0.0.1:8005/api/agent_sandbox/health
  const trimmed = requestUrl.pathname.slice(prefix.length) || "/";
  return `${getRuntimeBaseUrl()}/api${trimmed}${requestUrl.search}`;
}

function mapUnreachable(err, upstreamUrl) {
  return {
    status: 502,
    body: {
      error: "runtime_proxy_unreachable",
      detail: String(err?.message || err),
      upstream_url: upstreamUrl
    }
  };
}

/**
 * Handle a /api/runtime/<path> request — the HUMAN facade.
 *
 * Injects the trusted Benny key and strips any client-supplied agent scope so a
 * human request can never self-assert (or be tricked into asserting) an agent
 * scope. Resolves once the response has fully streamed.
 */
export async function proxyToRuntime(req, res, requestUrl) {
  const upstreamUrl = buildUpstreamUrlFor(RUNTIME_PATH_PREFIX, requestUrl);
  const headers = buildUpstreamHeaders(req.headers, {
    // The client value is never trusted: a forged X-Benny-Agent-Scope is dropped.
    dropHeaders: [AGENT_SCOPE_HEADER],
    setHeaders: { "X-Benny-API-Key": getBennyApiKey() }
  });

  await forwardToUpstream({
    req,
    res,
    upstreamUrl,
    headers,
    mapError: (err) => mapUnreachable(err, upstreamUrl)
  });
}

/**
 * Handle a /api/agent-runtime/<path> request — the AGENT facade.
 *
 * Injects the sandbox-bound agent key and sets X-Benny-Agent-Scope=sandbox
 * server-side, overwriting any client value. The agent cannot widen its own
 * scope: the header it sends is discarded and the credential it gets is pinned
 * to sandbox at Benny.
 */
export async function proxyToAgentRuntime(req, res, requestUrl) {
  const upstreamUrl = buildUpstreamUrlFor(AGENT_RUNTIME_PATH_PREFIX, requestUrl);
  const headers = buildUpstreamHeaders(req.headers, {
    dropHeaders: [AGENT_SCOPE_HEADER],
    setHeaders: {
      "X-Benny-API-Key": getBennyAgentApiKey(),
      [AGENT_SCOPE_HEADER]: SANDBOX_SCOPE
    }
  });

  await forwardToUpstream({
    req,
    res,
    upstreamUrl,
    headers,
    mapError: (err) => mapUnreachable(err, upstreamUrl)
  });
}

/**
 * Out-of-band Benny-runtime request helper for non-router callers (the
 * `node space bridge` CLI). This is a trusted server-side caller, so it uses
 * the trusted key. Returns parsed JSON; never throws on transport failure
 * (returns {ok:false}). Paths are relative to the runtime's /api root.
 */
export async function runtimeRequest(apiPath, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const normalizedPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${getRuntimeBaseUrl()}/api${normalizedPath}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-Benny-API-Key": getBennyApiKey(),
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: "runtime_unreachable",
      detail: String(err?.message || err),
      hint: "Benny runtime is not running. Boot it with scripts/dev.ps1 (or python -m benny.api.server), or set RUNTIME_BASE_URL.",
      url
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, body: payload, url };
}

// Exposed for tests so the proxy's path semantics stay locked.
export const __testing = {
  RUNTIME_PATH_PREFIX,
  AGENT_RUNTIME_PATH_PREFIX,
  DEFAULT_RUNTIME_BASE_URL,
  AGENT_SCOPE_HEADER,
  SANDBOX_SCOPE,
  buildUpstreamUrl: (requestUrl) => buildUpstreamUrlFor(RUNTIME_PATH_PREFIX, requestUrl),
  buildAgentUpstreamUrl: (requestUrl) => buildUpstreamUrlFor(AGENT_RUNTIME_PATH_PREFIX, requestUrl)
};
