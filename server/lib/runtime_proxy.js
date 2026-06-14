// ADR-001 Phase D — Benny runtime proxy.
//
// Forwards /api/runtime/<path> requests from the space-agent shell to the
// Benny FastAPI runtime (default http://127.0.0.1:8005). The proxy:
//
//   • Strips the /api/runtime prefix when constructing the upstream path,
//     so /api/runtime/agent_sandbox/health → /api/agent_sandbox/health.
//   • Injects X-Benny-API-Key from BENNY_API_KEY env (Benny's existing
//     governance convention; default falls back to the dev key).
//   • Preserves X-Benny-Agent-Scope: sandbox | read_only when the caller
//     sets it. The runtime's AgentScopeMiddleware enforces the boundary —
//     the shell does NOT inject scope headers itself.
//   • Streams request and response bodies. Hop-by-hop headers stripped on
//     both directions per RFC 7230 §6.1.
//
// Configuration (env):
//   RUNTIME_BASE_URL   Default: "http://127.0.0.1:8005"
//   BENNY_API_KEY      Default: "benny-mesh-2026-auth" (matches Benny dev)
//
// This module is the only Phase D entry point — keep dispatch tight.

import { Readable } from "node:stream";

const RUNTIME_PATH_PREFIX = "/api/runtime";

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:8005";
const DEFAULT_BENNY_API_KEY = "benny-mesh-2026-auth";

// Hop-by-hop and cookie/host headers we don't want on the upstream call.
// Mirrors the existing space-agent proxy in server/router/proxy.js so the
// behaviour is consistent.
const UPSTREAM_REQUEST_HEADERS_TO_STRIP = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const RESPONSE_HEADERS_TO_STRIP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "set-cookie2",
  "transfer-encoding"
]);

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "OPTIONS"]);

export function isRuntimeProxyPath(pathname) {
  return pathname === RUNTIME_PATH_PREFIX || pathname.startsWith(RUNTIME_PATH_PREFIX + "/");
}

function getRuntimeBaseUrl() {
  return (process.env.RUNTIME_BASE_URL || DEFAULT_RUNTIME_BASE_URL).replace(/\/+$/, "");
}

function getBennyApiKey() {
  return process.env.BENNY_API_KEY || DEFAULT_BENNY_API_KEY;
}

function buildUpstreamUrl(requestUrl) {
  // requestUrl is the parsed URL; strip the /api/runtime prefix and rebuild
  // against the runtime base. /api/runtime/agent_sandbox/health
  // → http://127.0.0.1:8005/api/agent_sandbox/health
  const trimmed = requestUrl.pathname.slice(RUNTIME_PATH_PREFIX.length) || "/";
  const upstream = `${getRuntimeBaseUrl()}/api${trimmed}${requestUrl.search}`;
  return upstream;
}

function buildUpstreamHeaders(incomingHeaders) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (value === undefined || value === null) {
      continue;
    }

    const lower = name.toLowerCase();
    if (UPSTREAM_REQUEST_HEADERS_TO_STRIP.has(lower)) {
      continue;
    }

    const flat = Array.isArray(value) ? value.join(", ") : String(value);
    headers.set(name, flat);
  }

  // Always inject the Benny governance API key. The shell is the trusted
  // edge; downstream RBAC fires per route inside Benny.
  headers.set("X-Benny-API-Key", getBennyApiKey());

  return headers;
}

function streamRequestBody(req) {
  if (METHODS_WITHOUT_BODY.has(String(req.method).toUpperCase())) {
    return undefined;
  }
  // Node IncomingMessage is a Readable stream; convert to a Web stream so
  // fetch() can consume it without buffering the whole body.
  return Readable.toWeb(req);
}

function copyResponseHeaders(upstreamResponse, res) {
  upstreamResponse.headers.forEach((value, name) => {
    if (RESPONSE_HEADERS_TO_STRIP.has(name.toLowerCase())) {
      return;
    }
    res.setHeader(name, value);
  });
}

async function pipeResponseBody(upstreamResponse, res) {
  if (!upstreamResponse.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstreamResponse.body);
  nodeStream.on("error", (err) => {
    res.destroy(err);
  });
  nodeStream.pipe(res);
}

/**
 * Handle a /api/runtime/<path> request by proxying it to the Benny runtime.
 * Returns a promise that resolves once the response has been fully streamed.
 */
export async function proxyToRuntime(req, res, requestUrl) {
  const upstreamUrl = buildUpstreamUrl(requestUrl);
  const headers = buildUpstreamHeaders(req.headers);
  const body = streamRequestBody(req);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      // Allows fetch to stream a request body in Node 20+/22 without
      // requiring Content-Length.
      duplex: body ? "half" : undefined,
      redirect: "manual"
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "runtime_proxy_unreachable",
      detail: String(err?.message || err),
      upstream_url: upstreamUrl
    }));
    return;
  }

  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse, res);
  await pipeResponseBody(upstreamResponse, res);
}

/**
 * Out-of-band Benny-runtime request helper for non-router callers (the
 * `node space bridge` CLI). Mirrors memoray_proxy.js#memorayRequest: same
 * base-URL + API-key resolution as the proxy, returns parsed JSON, never
 * throws on transport failure (returns {ok:false}). Paths are relative to the
 * runtime's /api root, e.g. "/manifests/runs".
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
  DEFAULT_RUNTIME_BASE_URL,
  DEFAULT_BENNY_API_KEY,
  buildUpstreamUrl
};
