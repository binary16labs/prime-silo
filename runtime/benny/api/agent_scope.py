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

import os

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
# Must match server/lib/runtime_proxy.js DEV_FALLBACK_AGENT_API_KEY in dev; set
# BENNY_AGENT_API_KEY in both processes to the same secret in production.
_DEV_FALLBACK_AGENT_API_KEY = "benny-agent-sandbox-2026-dev"


def _agent_api_key() -> str:
    return os.environ.get("BENNY_AGENT_API_KEY") or _DEV_FALLBACK_AGENT_API_KEY


def _effective_scope(request: Request) -> str:
    """Resolve the request's effective agent scope.

    Combines the credential-derived scope (sandbox, when the sandbox-bound agent
    key authenticated the call) with the header-declared scope, taking whichever
    is *more* restrictive. Returns ``""`` for unscoped human traffic.
    """
    candidates: list[str] = []

    if request.headers.get("X-Benny-API-Key", "") == _agent_api_key():
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
