# ADR-003 — Credential-bound agent scope (confused-deputy fix)

- **Status:** Accepted (partial — see Residual Gap)
- **Date:** 2026-06-24
- **Supersedes the enforcement mechanism of:** [ADR-001](../runtime/architecture/ADR-001-prime-silo-shell-fork.md) determinism boundary
- **Related code:** `server/lib/runtime_proxy.js`, `server/lib/service_proxy.js`, `server/router/router.js`, `runtime/benny/api/agent_scope.py`, `app/L0/_all/mod/_prime_silo/runtime_client/runtime-client.js`

## Context

ADR-001 introduced a determinism boundary: the in-browser agent runtime has full
_read_ access to Benny but its _writes_ are confined to `/api/agent_sandbox/`.
That boundary was enforced entirely by a client-set header,
`X-Benny-Agent-Scope`, that the browser's agent runtime _voluntarily_ attached.

A code review flagged this as a classic **confused-deputy / privilege
escalation** vulnerability:

- The space-agent shell proxy injects the trusted `X-Benny-API-Key` on every
  `/api/runtime/*` call, so the request reaches Benny fully trusted.
- The proxy then **forwarded the client's `X-Benny-Agent-Scope` unchanged**.
- Therefore any authenticated caller (or agent-generated code) could simply
  **omit or alter** the scope header and reach Benny with full, unscoped trust —
  executing arbitrary swarm/graph/config mutations the sandbox was meant to deny.

Two further facts sharpened the problem:

1. There is no agent-vs-human identity in the auth layer (`request_context.js`
   has no role/scope field), so the proxy cannot "derive scope from RBAC."
2. Benny's `GovernanceMiddleware` is currently disabled (`server.py`), so the
   API key is not even validated — the scope header was the _only_ gate.

## Decision

**Bind scope to a server-injected credential, never to a client header.**

### Two proxy facades (`server/lib/runtime_proxy.js`)

| Facade | Path                   | Injects                         | Scope                                                                   |
| ------ | ---------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| Human  | `/api/runtime/*`       | `BENNY_API_KEY` (trusted)       | client `X-Benny-Agent-Scope` **stripped** → normal RBAC                 |
| Agent  | `/api/agent-runtime/*` | `BENNY_AGENT_API_KEY` (sandbox) | `X-Benny-Agent-Scope: sandbox` **forced**, overwriting any client value |

Header filtering and stream piping are centralised in
`server/lib/service_proxy.js` so the "drop these client headers, set these
server headers" decision lives in exactly one place.

### Server-side enforcement (`runtime/benny/api/agent_scope.py`)

`AgentScopeMiddleware` now computes an **effective scope** = the _most
restrictive_ of (a) the scope implied by the authenticating key — the sandbox
agent key pins the request to `sandbox` — and (b) the header scope. A caller can
only **narrow** its confinement (`sandbox → read_only`), never widen it. The
boundary therefore holds even if the header is forged or the proxy is
misconfigured.

### Client routing (`runtime-client.js`)

The browser runtime client routes to the agent facade automatically whenever an
agent scope is active (`withAgentScope` / `fetchAsAgent` / a bound client) and to
the human facade otherwise. The scope header is still sent for audit/back-compat,
but the proxy is authoritative.

### Credential hygiene

The hardcoded `DEFAULT_BENNY_API_KEY = "benny-mesh-2026-auth"` fallback is gone.
Keys resolve from env with dev-only fallbacks; in production
(`NODE_ENV=production`) `assertRuntimeProxyConfig()` throws at startup if
`BENNY_API_KEY` or `BENNY_AGENT_API_KEY` is missing. Set both to the same secret
in the Benny process and the shell process.

## Residual Gap (why status is "partial")

Both facades are **same-origin**. In-page JavaScript — including agent-generated
code — can still _choose_ to call `/api/runtime/*` (the human path) instead of
`/api/agent-runtime/*`. The credential binding makes scope unforgeable _given a
path_, but it does not stop code from selecting the privileged path.

Making the boundary truly unbypassable requires the agent runtime to execute
**isolated from human JS** — e.g. a sandboxed Web Worker or cross-origin iframe
whose only channel to Benny is a broker that can reach the agent facade alone,
with CSP denying direct `/api/runtime` access. That is a larger change to the
space-agent trust model and is tracked as the ADR-001 follow-up.

Until then, this ADR delivers: (1) scope can no longer be forged by tampering
with a header, (2) human and agent traffic carry distinct, scoped credentials,
and (3) no shipped default key in production.

### Q0 follow-up (2026-07-06) — residual status

Q0 (delivery/tasks/Q0.md) hardened every server-side-enforceable part of this
boundary; the invariants are pinned by
`tests/adr003_same_origin_followup_test.mjs` so they cannot silently regress:

- **No shipped default key in ANY mode** — the dev fallbacks
  (`benny-mesh-2026-auth`, `benny-agent-sandbox-2026-dev`) are burned. Both
  keys resolve env → per-install keystore (`$BENNY_HOME/state/hmac-key`;
  agent key = HMAC-SHA256(install key, `"benny-agent-scope"`), identical
  derivation in Node and Python) → fail-fast at startup.
- **Loopback by default** — the shell binds 127.0.0.1 unless `HOST` names a
  wildcard interface explicitly, which logs a LAN-exposure warning. The
  boundary's audience shrinks from "anyone on the LAN" to "code already
  running on this machine".
- **Facade path integrity** — encoded dot-segments (`..%2f`, `%2e%2e%2f`)
  are rejected with 400 before proxying, so a caller cannot escape a facade's
  `/api` prefix via upstream decoding.

**Still open (unchanged):** in-page JS choosing the human path. That requires
the worker/iframe isolation described above and remains the ADR-001 follow-up;
nothing in Q0 claims to close it.

## Consequences

- `tests/runtime_proxy_test.mjs` updated: the human facade now _strips_ the
  client scope; a new test asserts the agent facade forces sandbox + the agent
  key.
- Existing `runtime/tests/api/test_agent_sandbox.py` behaviour is preserved
  (those tests never send the agent key, so header-based behaviour is unchanged).
- Deployments must provision two secrets; see `docker-compose.yml` / DEVOPS.md.
