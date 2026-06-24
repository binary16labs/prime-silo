// Shared mechanics for the space-agent shell's internal service proxies.
//
// runtime_proxy.js (→ Benny FastAPI) and memoray_proxy.js (→ Memo-Ray Express)
// are two facades over the same plumbing. Each keeps its own *policy* — path
// prefix, method whitelist, settings resolution, which credential and scope to
// inject — but the *mechanics* are identical and live here:
//
//   • the hop-by-hop / cookie / host header sets to strip in each direction
//     (RFC 7230 §6.1), shared so behaviour can never drift between proxies;
//   • request-body streaming (Node IncomingMessage → Web ReadableStream);
//   • response piping (copy headers minus the strip set, stream the body);
//   • the upstream fetch + transport-error mapping.
//
// Centralising header filtering here is also a security property: there is now
// exactly one place that decides which client headers reach an upstream, so a
// proxy can additively *drop* a header (e.g. a client-forged trust header) and
// *set* a server-authoritative one in a single, audited call.

import { Readable } from "node:stream";

// Hop-by-hop and cookie/host headers we never forward upstream. Mirrors the
// external proxy in server/router/proxy.js so all three proxies agree.
export const UPSTREAM_REQUEST_HEADERS_TO_STRIP = new Set([
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

export const RESPONSE_HEADERS_TO_STRIP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "set-cookie2",
  "transfer-encoding"
]);

export const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Build the upstream request Headers for a proxied call.
 *
 * Order matters and is deliberate:
 *   1. forward incoming headers, minus the standard hop-by-hop set and minus
 *      any additional names listed in `dropHeaders` (lower-cased). Use this to
 *      refuse a client-forged trust header — the client value never survives.
 *   2. apply `setHeaders` last, so a server-injected credential or scope always
 *      wins over anything the client tried to send under the same name.
 *
 * @param {Record<string, unknown>} incomingHeaders  req.headers
 * @param {{ dropHeaders?: string[], setHeaders?: Record<string, string|undefined> }} [options]
 * @returns {Headers}
 */
export function buildUpstreamHeaders(incomingHeaders, { dropHeaders = [], setHeaders = {} } = {}) {
  const drop = new Set(UPSTREAM_REQUEST_HEADERS_TO_STRIP);
  for (const name of dropHeaders) {
    drop.add(String(name).toLowerCase());
  }

  const headers = new Headers();

  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (drop.has(name.toLowerCase())) {
      continue;
    }
    const flat = Array.isArray(value) ? value.join(", ") : String(value);
    headers.set(name, flat);
  }

  for (const [name, value] of Object.entries(setHeaders)) {
    if (value === undefined || value === null) {
      continue;
    }
    headers.set(name, String(value));
  }

  return headers;
}

/**
 * Convert a Node request body to a Web stream fetch() can consume without
 * buffering. Returns undefined for verbs that carry no body.
 */
export function streamRequestBody(req) {
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

/**
 * Forward a request to `upstreamUrl` and stream the response back onto `res`.
 *
 * On a transport failure (upstream down / DNS / reset) `mapError(err)` is
 * called to produce `{ status, body }`, which is written as JSON. This keeps
 * each proxy's user-facing error vocabulary (`runtime_proxy_unreachable`,
 * `memoray_unreachable`, …) in its own file while the wiring stays here.
 *
 * @param {{
 *   req: import("node:http").IncomingMessage,
 *   res: import("node:http").ServerResponse,
 *   upstreamUrl: string,
 *   headers: Headers,
 *   mapError: (err: unknown) => { status: number, body: unknown }
 * }} params
 */
export async function forwardToUpstream({ req, res, upstreamUrl, headers, mapError }) {
  const body = streamRequestBody(req);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      // Lets fetch stream a request body in Node 20+/22 without Content-Length.
      duplex: body ? "half" : undefined,
      redirect: "manual"
    });
  } catch (err) {
    const { status, body: errorBody } = mapError(err);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(errorBody));
    return;
  }

  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse, res);
  await pipeResponseBody(upstreamResponse, res);
}
