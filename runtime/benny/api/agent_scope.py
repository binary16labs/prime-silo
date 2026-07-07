"""ADR-001 — Agent scope guard.

The Prime-Silo shell fork (ADR-001) introduces a determinism boundary: the
in-browser agent runtime has *full read* access across Benny's API surface but
its *writes* are restricted to the workspace's ``agent_sandbox/`` subtree.

Callers identify themselves via the ``X-Benny-Agent-Scope`` header:

============   =================  ============================================
Header value   Reads              Writes
============   =================  ============================================
absent         per existing RBAC  per existing RBAC (human user)
``read_only``  full               rejected (HTTP 403)
``sandbox``    full               only to the dedicated sandbox route prefix
============   =================  ============================================

The sandbox route prefix is a deliberate single chokepoint:
``/api/agent_sandbox/...``. Routing every agent write through one prefix is
simpler and safer than per-request path inspection across two-dozen route
modules — there is exactly one place to audit. ``GET``/``HEAD``/``OPTIONS``
are never gated by this middleware so the agent can read freely.

Every accepted sandbox write is lineage-emitted as
``process=agent_authorship`` via :func:`benny.governance.lineage.emit_agent_authorship`,
making the agent's authoring history itself auditable.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

# Reads are unrestricted — only mutating verbs are gated.
_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Single chokepoint for agent-authored writes. ``benny.api.agent_sandbox_routes``
# implements the endpoints behind this prefix.
AGENT_SANDBOX_PREFIX = "/api/agent_sandbox"

# Header values recognised by the guard. Anything else is treated as "absent"
# (i.e. a normal authenticated human user) and falls through to the existing
# governance / RBAC checks.
SCOPE_SANDBOX = "sandbox"
SCOPE_READ_ONLY = "read_only"

_VALID_SCOPES = frozenset({SCOPE_SANDBOX, SCOPE_READ_ONLY})

# Restrictiveness order (most restrictive first). The effective scope of a
# request is the *most* restrictive of the credential-derived scope and the
# header-declared scope, so a caller can never widen the confinement its
# credential pins it to — only narrow it further.
_RESTRICTIVENESS = {SCOPE_READ_ONLY: 2, SCOPE_SANDBOX: 1}

# ADR-001 confused-deputy fix: the space-agent shell injects a distinct,
# sandbox-bound API key on the /api/agent-runtime proxy path. Whenever a request
# authenticates with THAT key, its scope is pinned to ``sandbox`` here —
# server-side, independent of any X-Benny-Agent-Scope header — so the boundary
# holds even if the header is forged or stripped. The trusted/human key carries
# no key-derived scope and falls through to header behaviour (back-compat).
#
# Q0: no shipped default remains. Resolution: env BENNY_AGENT_API_KEY, else
# derive from the per-install keystore via HMAC-SHA256(installKeyBytes,
# b"benny-agent-scope") hex — this MUST match server/lib/runtime_proxy.js's
# resolveBennyAgentApiKey byte-for-byte (cross-language parity pinned by a test).
_AGENT_SCOPE_DERIVATION_LABEL = b"benny-agent-scope"


def _install_key_bytes() -> bytes | None:
    """Resolve the per-install keystore content as bytes: hex-decoded if the
    stored value is valid hex, else its raw utf-8 bytes."""
    benny_home = os.environ.get("BENNY_HOME")
    if not benny_home:
        return None
    from ..portable.home import read_install_hmac_key

    value = read_install_hmac_key(Path(benny_home))
    if not value:
        return None
    try:
        decoded = bytes.fromhex(value)
        if decoded and decoded.hex() == value.lower():
            return decoded
    except ValueError:
        pass
    return value.encode("utf-8")


def resolve_benny_api_key() -> str:
    """Single resolution path (Q0) for the trusted/human key: env BENNY_API_KEY
    -> per-install keystore ($BENNY_HOME/state/hmac-key) -> fail fast. No
    shipped default remains. Canonical for the runtime API (server.py aliases
    this); consumer scripts duplicate the same three steps per their contracts."""
    value = os.environ.get("BENNY_API_KEY")
    if value:
        return value

    benny_home = os.environ.get("BENNY_HOME")
    if benny_home:
        from ..portable.home import read_install_hmac_key

        keystore_value = read_install_hmac_key(Path(benny_home))
        if keystore_value:
            return keystore_value

    raise RuntimeError(
        "BENNY_API_KEY is not set and no per-install key was found at "
        "<BENNY_HOME>/state/hmac-key. Set the BENNY_API_KEY environment variable, "
        "or run `benny init` to generate a per-install keystore."
    )


def derive_agent_api_key_from_install_key(install_key_bytes: bytes) -> str:
    """HMAC-SHA256(install_key_bytes, b"benny-agent-scope") hex. Exposed for the
    cross-language parity test against server/lib/runtime_proxy.js."""
    return hmac.new(install_key_bytes, _AGENT_SCOPE_DERIVATION_LABEL, hashlib.sha256).hexdigest()


def _agent_api_key() -> str | None:
    """Resolve the sandbox-bound agent key: env override, else derived from the
    per-install keystore. Returns ``None`` if neither is available (no install
    key yet) — callers must treat that as "no agent key configured", not as a
    match against an empty string."""
    env_value = os.environ.get("BENNY_AGENT_API_KEY")
    if env_value:
        return env_value
    install_key_bytes = _install_key_bytes()
    if install_key_bytes is None:
        return None
    return derive_agent_api_key_from_install_key(install_key_bytes)


def _effective_scope(request: Request) -> str:
    """Resolve the request's effective agent scope.

    Combines the credential-derived scope (sandbox, when the sandbox-bound agent
    key authenticated the call) with the header-declared scope, taking whichever
    is *more* restrictive. Returns ``""`` for unscoped human traffic.
    """
    candidates: list[str] = []

    agent_key = _agent_api_key()
    if agent_key is not None and request.headers.get("X-Benny-API-Key", "") == agent_key:
        candidates.append(SCOPE_SANDBOX)

    header_scope = request.headers.get("X-Benny-Agent-Scope", "").strip().lower()
    if header_scope in _VALID_SCOPES:
        candidates.append(header_scope)

    if not candidates:
        return ""

    return max(candidates, key=lambda s: _RESTRICTIVENESS[s])


class AgentScopeMiddleware(BaseHTTPMiddleware):
    """Enforce the ADR-001 read/write boundary for agent-scoped requests."""

    async def dispatch(self, request: Request, call_next):
        scope = _effective_scope(request)

        # Human / unscoped traffic — defer entirely to the existing
        # GovernanceMiddleware + per-route auth.
        if scope == "":
            return await call_next(request)

        # Reads are always allowed for both agent scopes.
        if request.method.upper() not in _MUTATING_METHODS:
            return await call_next(request)

        # read_only scope — no writes anywhere.
        if scope == SCOPE_READ_ONLY:
            return _forbidden("Agent scope 'read_only' may not perform mutating requests.")

        # sandbox scope — writes only inside the agent_sandbox route prefix.
        path = request.url.path
        if path == AGENT_SANDBOX_PREFIX or path.startswith(AGENT_SANDBOX_PREFIX + "/"):
            return await call_next(request)

        return _forbidden(
            "Agent scope 'sandbox' may only write under "
            f"{AGENT_SANDBOX_PREFIX}/. See architecture/ADR-001-prime-silo-shell-fork.md."
        )


def _forbidden(detail: str) -> Response:
    body = f'{{"detail":"Forbidden: {detail}"}}'
    return Response(content=body, status_code=403, media_type="application/json")
