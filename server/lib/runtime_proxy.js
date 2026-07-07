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
//   BENNY_API_KEY        Trusted/human key. Falls back to the per-install
//                        keystore ($BENNY_HOME/state/hmac-key); fails fast if
//                        neither is present.
//   BENNY_AGENT_API_KEY  Sandbox-bound agent key. Derived from the per-install
//                        keystore when absent; fails fast if neither resolves.
//
// Streams request/response bodies; hop-by-hop headers stripped both directions
// (see service_proxy.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildUpstreamHeaders, forwardToUpstream } from "./service_proxy.js";

const RUNTIME_PATH_PREFIX = "/api/runtime";
const AGENT_RUNTIME_PATH_PREFIX = "/api/agent-runtime";

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:8005";

const AGENT_SCOPE_HEADER = "X-Benny-Agent-Scope";
const SANDBOX_SCOPE = "sandbox";

// Derivation label for the sandbox-bound agent key, HMAC'd from the per-install
// keystore. MUST match runtime/benny/api/agent_scope.py byte-for-byte.
const AGENT_SCOPE_DERIVATION_LABEL = "benny-agent-scope";

function keystorePath(env) {
  if (!env.BENNY_HOME) {
    return null;
  }
  return path.join(env.BENNY_HOME, "state", "hmac-key");
}

function readKeystore(env) {
  const p = keystorePath(env);
  if (!p) {
    return null;
  }
  try {
    const value = fs.readFileSync(p, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function actionableError(envName) {
  return new Error(
    `${envName} is not set and no per-install key was found at <BENNY_HOME>/state/hmac-key. ` +
      `Set the ${envName} environment variable, or run \`benny init\` to generate a per-install keystore.`
  );
}

/**
 * Single resolution path for the trusted/human Benny API key:
 *   1. env.BENNY_API_KEY
 *   2. per-install keystore at $BENNY_HOME/state/hmac-key (trimmed file text)
 *   3. fail fast — actionable error naming BENNY_API_KEY and the keystore path
 */
export function resolveBennyApiKey({ env = process.env } = {}) {
  if (env.BENNY_API_KEY) {
    return env.BENNY_API_KEY;
  }
  const keystoreValue = readKeystore(env);
  if (keystoreValue) {
    return keystoreValue;
  }
  throw actionableError("BENNY_API_KEY");
}

/**
 * Single resolution path for the sandbox-bound agent key:
 *   1. env.BENNY_AGENT_API_KEY
 *   2. derived: hmac-sha256(installKeyBytes, "benny-agent-scope") hex, where
 *      installKeyBytes = hex-decode of the keystore content if valid hex, else
 *      its raw utf8 bytes. MUST match agent_scope.py's derivation.
 *   3. fail fast — actionable error naming BENNY_AGENT_API_KEY and the keystore path
 */
export function resolveBennyAgentApiKey({ env = process.env } = {}) {
  if (env.BENNY_AGENT_API_KEY) {
    return env.BENNY_AGENT_API_KEY;
  }
  const keystoreValue = readKeystore(env);
  if (keystoreValue) {
    let installKeyBytes;
    try {
      installKeyBytes = Buffer.from(keystoreValue, "hex");
      if (
        installKeyBytes.length === 0 ||
        installKeyBytes.toString("hex") !== keystoreValue.toLowerCase()
      ) {
        installKeyBytes = Buffer.from(keystoreValue, "utf8");
      }
    } catch {
      installKeyBytes = Buffer.from(keystoreValue, "utf8");
    }
    return crypto
      .createHmac("sha256", installKeyBytes)
      .update(AGENT_SCOPE_DERIVATION_LABEL)
      .digest("hex");
  }
  throw actionableError("BENNY_AGENT_API_KEY");
}

/**
 * Fail-fast credential check, called once at server startup (see app.js).
 * Throws before the server begins listening if either Benny key cannot be
 * resolved via env or the per-install keystore — in ALL modes, not just
 * production, since there is no shipped default left to fall back to.
 */
export function assertRuntimeProxyConfig() {
  resolveBennyApiKey();
  resolveBennyAgentApiKey();
}

function getRuntimeBaseUrl() {
  return (process.env.RUNTIME_BASE_URL || DEFAULT_RUNTIME_BASE_URL).replace(/\/+$/, "");
}

function getBennyApiKey() {
  return resolveBennyApiKey();
}

function getBennyAgentApiKey() {
  return resolveBennyAgentApiKey();
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

/**
 * ADR-003 (Q0 follow-up): dot-segments must never survive into the upstream
 * URL. `new URL()` normalises literal `..` before routing, but percent-encoded
 * dots (`%2e%2e`) pass through `pathname` untouched and would be decoded and
 * normalised by the upstream server — letting a caller escape the facade's
 * `/api` prefix. Undecodable paths are rejected as traversal too.
 */
export function hasPathTraversal(pathname) {
  let decoded = String(pathname || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return true;
  }
  return decoded.split(/[\\/]+/).some((segment) => segment === "..");
}

function rejectTraversal(res) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "invalid_path", detail: "dot-segments are not allowed" }));
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
  if (hasPathTraversal(requestUrl.pathname)) {
    rejectTraversal(res);
    return;
  }
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
  if (hasPathTraversal(requestUrl.pathname)) {
    rejectTraversal(res);
    return;
  }
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
