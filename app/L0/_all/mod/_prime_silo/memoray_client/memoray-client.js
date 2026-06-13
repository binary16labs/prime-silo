// Phase M1 — Memo-Ray client.
//
// Browser-side access to the memory graph through the shell's
// /api/memoray/<path> proxy (server/lib/memoray_proxy.js). Mirrors the
// runtime_client pattern: a fetch wrapper plus a JSON reader that maps the
// proxy's structured errors into friendly states the page can render
// without raw error spew.
//
// The browser never talks to the Memo-Ray server directly — the proxy owns
// the endpoint configuration (MEMORAY_BASE_URL / wizard manifest) and the
// method whitelist, so this module stays configuration-free.
//
// Public API
//   memorayFetch(path, init?)      — fetch against /api/memoray<path>
//   readMemorayJson(response)      — parse JSON; throws MemorayError with
//                                    .state = "offline" | "disabled" | "error"
//   isMemorayOffline(err)          — true when the upstream is down
//   isMemorayDisabled(err)         — true when MEMORAY_ENABLED is off
//
// Widgets take an injectable `options.memorayClient = { memorayFetch,
// readMemorayJson }` — the same test seam shape as `options.runtimeClient`
// on the Phase C widgets.

const MEMORAY_API_PREFIX = "/api/memoray";

export class MemorayError extends Error {
  constructor(message, { state = "error", status = 0, body = null } = {}) {
    super(message);
    this.name = "MemorayError";
    this.state = state;
    this.status = status;
    this.body = body;
  }
}

export function memorayFetch(path, init = {}) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${MEMORAY_API_PREFIX}${normalized}`, {
    credentials: "same-origin",
    ...init
  });
}

export async function readMemorayJson(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok) {
    return body;
  }

  const errorCode = body && typeof body.error === "string" ? body.error : "";

  if (errorCode === "memoray_unreachable") {
    throw new MemorayError(body.hint || "Memo-Ray is offline.", {
      state: "offline",
      status: response.status,
      body
    });
  }

  if (errorCode === "memoray_disabled") {
    throw new MemorayError(body.detail || "Memo-Ray integration is disabled.", {
      state: "disabled",
      status: response.status,
      body
    });
  }

  throw new MemorayError(
    (body && (body.detail || body.error)) || `Memo-Ray request failed (${response.status}).`,
    { state: "error", status: response.status, body }
  );
}

export function isMemorayOffline(err) {
  return Boolean(err && err.state === "offline");
}

export function isMemorayDisabled(err) {
  return Boolean(err && err.state === "disabled");
}

export const __testing = { MEMORAY_API_PREFIX };
