// Phase M1 — Memo-Ray memory-graph proxy.
//
// Forwards /api/memoray/<path> requests from the space-agent shell to the
// Memo-Ray Express server (default http://127.0.0.1:3030). Memo-Ray is the
// memory graph of the cognitive mesh — the third first-class graph beside
// the knowledge graph (documents) and code graph (AST). The shell page,
// the onscreen-agent `memory-recall` skill, and the `node space memory`
// CLI all consume Memo-Ray through this one chokepoint, so the endpoint
// is configurable in exactly one place.
//
// The integration is declared in manifests/integrations/memoray.integration.json
// (schema aamp.integration/1); this module is the `shell_proxy` node of that
// manifest's process map. Drift between this file and the manifest is a
// conformance finding (`GET /api/integration_audit`).
//
// The proxy:
//   • Strips the /api/memoray prefix: /api/memoray/beta/overview
//     → <base>/api/beta/overview.
//   • Whitelists methods: GET on any path, POST only on /files/open
//     (Memo-Ray validates open targets against its indexed lineage
//     server-side — paths outside the memory graph get a 403 upstream).
//     Everything else → 405.
//   • Returns 404 {error:"memoray_disabled"} when MEMORAY_ENABLED is off,
//     502 {error:"memoray_unreachable"} with a boot hint when the upstream
//     is down — the page renders both as friendly first-class screens.
//   • Server-to-server fetch carries no Origin header, so Memo-Ray's
//     localhost-only CORS policy never applies; browser callers stay on
//     the shell origin.
//
// Configuration resolution per key (most specific wins):
//   1. Runtime params MEMORAY_ENABLED / MEMORAY_BASE_URL when set by a
//      launch arg, stored .env value, or process env (commands/params.yaml
//      owns the schema; `node space get/set MEMORAY_BASE_URL` manages it).
//   2. The wizard manifest prime-silo.config.json `memoray` block.
//   3. The app-registry lockfile (apps.lock.json) — the port the resolver
//      assigned memo-ray on this machine, so a port change propagates without
//      touching prime-silo config.
//   4. Defaults: enabled, http://127.0.0.1:3030.

import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { lockServiceUrl } from "./registry_lock.js";

const MEMORAY_PATH_PREFIX = "/api/memoray";

const DEFAULT_MEMORAY_BASE_URL = "http://127.0.0.1:3030";
const DEFAULT_MEMORAY_ENABLED = true;

const CONFIG_MANIFEST_FILENAME = "prime-silo.config.json";

// Memo-Ray's only mutating endpoint the shell is allowed to reach. Opening
// a file is lineage-validated upstream; nothing else may POST through.
const POST_PATH_WHITELIST = new Set(["/files/open"]);

// Mirrors server/lib/runtime_proxy.js so proxy behaviour stays consistent.
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

const BOOT_HINT = "Memo-Ray is not running. Boot it with scripts/memoray.ps1 (or scripts/memoray.sh), or point MEMORAY_BASE_URL at a running instance.";

export function isMemorayProxyPath(pathname) {
  return pathname === MEMORAY_PATH_PREFIX || pathname.startsWith(MEMORAY_PATH_PREFIX + "/");
}

// prime-silo.config.json `memoray` block, cached by mtime so the proxy does
// not re-read the manifest on every request but still notices wizard edits.
let configCache = { path: "", mtimeMs: -1, block: null };

async function readConfigMemorayBlock(projectRoot) {
  if (!projectRoot) {
    return null;
  }

  const manifestPath = path.join(projectRoot, CONFIG_MANIFEST_FILENAME);

  let mtimeMs;
  try {
    mtimeMs = (await fs.stat(manifestPath)).mtimeMs;
  } catch {
    return null;
  }

  if (configCache.path === manifestPath && configCache.mtimeMs === mtimeMs) {
    return configCache.block;
  }

  let block = null;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest && typeof manifest.memoray === "object" && manifest.memoray !== null) {
      block = manifest.memoray;
    }
  } catch {
    block = null;
  }

  configCache = { path: manifestPath, mtimeMs, block };
  return block;
}

function runtimeParamValue(runtimeParams, name) {
  // Only honour values the operator actually set (launch arg, stored .env,
  // process env). A schema default must not shadow the wizard manifest —
  // the manifest is the more deliberate record.
  const entry = runtimeParams && typeof runtimeParams.getEntry === "function"
    ? runtimeParams.getEntry(name)
    : null;
  if (!entry || entry.value === undefined || entry.source === "default" || entry.source === "unset") {
    return undefined;
  }
  return entry.value;
}

/**
 * Resolve the effective Memo-Ray settings. Shared by the router proxy
 * branch, the `node space memory` CLI, and the integration audit so all
 * surfaces agree on one precedence order.
 */
export async function resolveMemoraySettings({ runtimeParams, projectRoot } = {}) {
  const configBlock = await readConfigMemorayBlock(projectRoot);

  let enabled = runtimeParamValue(runtimeParams, "MEMORAY_ENABLED");
  let enabledSource = "param";
  if (enabled === undefined && configBlock && typeof configBlock.enabled === "boolean") {
    enabled = configBlock.enabled;
    enabledSource = "config";
  }
  if (enabled === undefined) {
    enabled = DEFAULT_MEMORAY_ENABLED;
    enabledSource = "default";
  }

  let baseUrl = runtimeParamValue(runtimeParams, "MEMORAY_BASE_URL");
  let baseUrlSource = "param";
  if (baseUrl === undefined && configBlock && typeof configBlock.base_url === "string" && configBlock.base_url.trim()) {
    baseUrl = configBlock.base_url.trim();
    baseUrlSource = "config";
  }
  if (baseUrl === undefined) {
    const lockedUrl = lockServiceUrl({ appId: "memo-ray", service: "memory-graph", startDir: projectRoot || process.cwd() });
    if (lockedUrl) {
      baseUrl = lockedUrl;
      baseUrlSource = "lock";
    }
  }
  if (baseUrl === undefined) {
    baseUrl = DEFAULT_MEMORAY_BASE_URL;
    baseUrlSource = "default";
  }

  return {
    enabled: Boolean(enabled),
    baseUrl: String(baseUrl).replace(/\/+$/, ""),
    sources: { enabled: enabledSource, baseUrl: baseUrlSource }
  };
}

function buildUpstreamUrl(requestUrl, baseUrl) {
  const trimmed = requestUrl.pathname.slice(MEMORAY_PATH_PREFIX.length) || "/";
  return `${baseUrl}/api${trimmed}${requestUrl.search}`;
}

function upstreamPath(requestUrl) {
  return requestUrl.pathname.slice(MEMORAY_PATH_PREFIX.length) || "/";
}

function isMethodAllowed(method, requestUrl) {
  const normalized = String(method || "").toUpperCase();
  if (normalized === "GET" || normalized === "HEAD") {
    return true;
  }
  if (normalized === "POST") {
    return POST_PATH_WHITELIST.has(upstreamPath(requestUrl));
  }
  return false;
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

  return headers;
}

function streamRequestBody(req) {
  if (METHODS_WITHOUT_BODY.has(String(req.method).toUpperCase())) {
    return undefined;
  }
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

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Handle a /api/memoray/<path> request by proxying it to the Memo-Ray
 * server. Resolves settings per request so wizard/config edits apply
 * without a shell restart.
 */
export async function proxyToMemoray(req, res, requestUrl, { runtimeParams, projectRoot } = {}) {
  const settings = await resolveMemoraySettings({ runtimeParams, projectRoot });

  if (!settings.enabled) {
    sendJson(res, 404, {
      error: "memoray_disabled",
      detail: "Memo-Ray integration is disabled. Enable it with `node space set MEMORAY_ENABLED=true` or in the configuration wizard."
    });
    return;
  }

  if (!isMethodAllowed(req.method, requestUrl)) {
    sendJson(res, 405, {
      error: "memoray_method_not_allowed",
      detail: "The Memo-Ray proxy forwards GET requests, plus POST to /files/open only."
    });
    return;
  }

  const upstreamUrl = buildUpstreamUrl(requestUrl, settings.baseUrl);
  const headers = buildUpstreamHeaders(req.headers);
  const body = streamRequestBody(req);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      duplex: body ? "half" : undefined,
      redirect: "manual"
    });
  } catch (err) {
    sendJson(res, 502, {
      error: "memoray_unreachable",
      detail: String(err?.message || err),
      hint: BOOT_HINT,
      upstream_url: upstreamUrl
    });
    return;
  }

  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse, res);
  await pipeResponseBody(upstreamResponse, res);
}

/**
 * Out-of-band Memo-Ray request helper for non-router callers (the
 * `node space memory` CLI and the integration audit). Same settings
 * resolution and method whitelist as the proxy; returns parsed JSON.
 */
export async function memorayRequest(apiPath, { runtimeParams, projectRoot, method = "GET", body, timeoutMs = 5000 } = {}) {
  const settings = await resolveMemoraySettings({ runtimeParams, projectRoot });

  if (!settings.enabled) {
    return { ok: false, status: 404, error: "memoray_disabled", settings };
  }

  const normalizedPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${settings.baseUrl}/api${normalizedPath}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: "memoray_unreachable",
      detail: String(err?.message || err),
      hint: BOOT_HINT,
      settings
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { ok: response.ok, status: response.status, body: payload, settings };
}

// Exposed for tests so the proxy's path and policy semantics stay locked.
export const __testing = {
  MEMORAY_PATH_PREFIX,
  DEFAULT_MEMORAY_BASE_URL,
  CONFIG_MANIFEST_FILENAME,
  buildUpstreamUrl,
  isMethodAllowed,
  resetConfigCache() {
    configCache = { path: "", mtimeMs: -1, block: null };
  }
};
