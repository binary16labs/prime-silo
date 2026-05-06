"""AOS-001 Phase 9 — Policy-as-Code evaluator.

Public API
----------
  PolicyDecision
      Enum with values ``approved``, ``denied``, ``escalate``.

  PolicyDeniedError
      Raised by :meth:`PolicyEvaluator.evaluate` when the decision is
      ``denied`` and :attr:`PolicyEvaluator.mode` is ``"enforce"``.

  PolicyEvaluator(mode, auto_approve_writes, allowed_tools_per_persona,
                  deny_network=True, escalate_tools=None)
      Evaluates whether a tool invocation is permitted for a persona.

      evaluate(intent, tool, persona, workspace) -> PolicyDecision
          Returns ``PolicyDecision.APPROVED``, ``PolicyDecision.DENIED``,
          or ``PolicyDecision.ESCALATE``.

          Rules (applied in order):
          1. ``auto_approve_writes`` MUST be ``False`` — constructor raises
             ``ValueError`` if ``True`` (GATE-AOS-POLICY-1).
          2. Path-traversal check: if *intent* or *workspace* contain ``..``
             (both POSIX and Windows ``..\\``), return ``DENIED`` (AOS-SEC3).
          3. Persona allowlist: if *tool* is not in
             ``allowed_tools_per_persona.get(persona, [])`` return ``DENIED``
             (AOS-SEC1).
          4. Escalate tier: if *tool* is in *escalate_tools* return ``ESCALATE``
             (AOS-F25).
          5. Otherwise return ``APPROVED``.

          In ``"enforce"`` mode a ``DENIED`` decision raises
          :class:`PolicyDeniedError` instead of returning.

AOS requirements covered
------------------------
  F25    evaluate(): approved / denied / escalate + enforce-mode raises.
  SEC1   Persona tool allowlist — deny unlisted tool.
  SEC3   Path-traversal (``..``) rejection at evaluate() time.
  NFR8   Stdlib-only — no network calls; offline-safe.

Dependencies: stdlib only (enum, pathlib, re).
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Decision type
# ---------------------------------------------------------------------------


class PolicyDecision(str, Enum):
    """Outcome of a policy evaluation (AOS-F25)."""

    APPROVED = "approved"
    DENIED   = "denied"
    ESCALATE = "escalate"


# ---------------------------------------------------------------------------
# Exception
# ---------------------------------------------------------------------------


class PolicyDeniedError(RuntimeError):
    """Raised by PolicyEvaluator.evaluate() when mode='enforce' and decision=DENIED.

    Contains the tool name, persona, and reason so the caller can surface a
    meaningful error to the user or the SSE event bus.
    """


# ---------------------------------------------------------------------------
# Path-traversal patterns
# ---------------------------------------------------------------------------

# Matches '..' in POSIX paths and '..\\' / '..\/' in Windows paths
_TRAVERSAL_RE = re.compile(r"\.\.[/\\]|\.\.$|^\.\.$")


def _has_traversal(text: str) -> bool:
    """Return True if *text* contains a path-traversal sequence."""
    return bool(_TRAVERSAL_RE.search(text))


# ---------------------------------------------------------------------------
# Policy evaluator
# ---------------------------------------------------------------------------


class PolicyEvaluator:
    """AOS-001 Policy-as-Code evaluator (AOS-F25 / AOS-SEC1 / AOS-SEC3).

    Parameters
    ----------
    mode:
        ``"warn"`` — denied decisions return :attr:`PolicyDecision.DENIED`;
        no exception.
        ``"enforce"`` — denied decisions raise :class:`PolicyDeniedError`.
    auto_approve_writes:
        MUST be ``False``.  Passing ``True`` raises :exc:`ValueError`
        immediately (GATE-AOS-POLICY-1).
    allowed_tools_per_persona:
        Dict mapping persona name → list of permitted tool names.
        A persona absent from this dict is denied all tools.
    deny_network:
        Reserved for Phase 9 socket-level enforcement.  Stored but not
        yet enforced at this layer (socket guard is in
        ``tests/safety/test_aos_no_unexpected_egress.py``).
    escalate_tools:
        Optional set of tool names that trigger an ``ESCALATE`` result
        instead of ``APPROVED`` even when the tool is in the allowlist.
        Useful for write-to-VCS operations that require HITL sign-off.
    """

    def __init__(
        self,
        *,
        mode: str = "warn",
        auto_approve_writes: bool = False,
        allowed_tools_per_persona: dict[str, list[str]],
        deny_network: bool = True,
        escalate_tools: Optional[set[str]] = None,
    ) -> None:
        if auto_approve_writes:
            raise ValueError(
                "aos.policy.auto_approve_writes MUST be False — "
                "this is a hard release gate (GATE-AOS-POLICY-1)."
            )
        if mode not in ("warn", "enforce"):
            raise ValueError(f"policy.mode must be 'warn' or 'enforce', got {mode!r}")

        self.mode = mode
        self.auto_approve_writes = False  # always False
        self.allowed_tools_per_persona = allowed_tools_per_persona
        self.deny_network = deny_network
        self.escalate_tools: set[str] = set(escalate_tools or [])

    # ------------------------------------------------------------------

    def evaluate(
        self,
        *,
        intent: str,
        tool: str,
        persona: str,
        workspace: str,
    ) -> PolicyDecision:
        """Evaluate whether *tool* invocation is permitted for *persona*.

        Parameters
        ----------
        intent:
            Human-readable description of what the tool will do.
        tool:
            Tool identifier, e.g. ``"write_file"``, ``"git.commit"``.
        persona:
            Persona requesting the invocation, e.g. ``"architect"``.
        workspace:
            Workspace path the tool will operate within.

        Returns
        -------
        PolicyDecision
            ``APPROVED``, ``DENIED``, or ``ESCALATE``.

        Raises
        ------
        PolicyDeniedError
            When the decision is ``DENIED`` and ``self.mode == "enforce"``.
        """
        # --- Rule 1: path-traversal check (AOS-SEC3) ---
        if _has_traversal(intent) or _has_traversal(workspace):
            return self._denied(
                tool=tool,
                persona=persona,
                reason=f"Path traversal detected in intent or workspace",
            )

        # --- Rule 2: persona allowlist (AOS-SEC1) ---
        allowed = self.allowed_tools_per_persona.get(persona, [])
        if tool not in allowed:
            return self._denied(
                tool=tool,
                persona=persona,
                reason=f"Tool '{tool}' not in allowlist for persona '{persona}'",
            )

        # --- Rule 3: escalate tier ---
        if tool in self.escalate_tools:
            return PolicyDecision.ESCALATE

        return PolicyDecision.APPROVED

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _denied(
        self,
        *,
        tool: str,
        persona: str,
        reason: str,
    ) -> PolicyDecision:
        """Return DENIED or raise PolicyDeniedError depending on mode."""
        if self.mode == "enforce":
            raise PolicyDeniedError(
                f"Policy denied [{persona}] → '{tool}': {reason}"
            )
        return PolicyDecision.DENIED


# ---------------------------------------------------------------------------
# AAMP-001 intent constants (AAMP-F26)
#
# These string constants are the canonical *intent* values passed to
# PolicyEvaluator.evaluate() for AgentAmp operations.  Using named constants
# instead of inline strings prevents typo drift across the codebase.
# ---------------------------------------------------------------------------

AAMP_INTENT_SKIN_LOAD    = "aamp.skin_load"
AAMP_INTENT_SKIN_INSTALL = "aamp.skin_install"
AAMP_INTENT_PLUGIN_INVOKE = "aamp.plugin_invoke"
AAMP_INTENT_EQ_WRITE     = "aamp.eq_write"
AAMP_INTENT_DESIGNER_RUN = "aamp.designer_run"

# Default AAMP tool names — paired with the intent constants above
AAMP_TOOL_SKIN_LOAD    = "agentamp.load_skin"
AAMP_TOOL_SKIN_INSTALL = "agentamp.install_skin"
AAMP_TOOL_PLUGIN_INVOKE = "agentamp.invoke_plugin"
AAMP_TOOL_EQ_WRITE     = "agentamp.eq_write"
AAMP_TOOL_DESIGNER_RUN = "agentamp.designer_run"
