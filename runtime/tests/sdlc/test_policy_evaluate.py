"""AOS-F25, AOS-SEC1, AOS-SEC3 — Policy-as-Code evaluator.

Red tests — will fail with ModuleNotFoundError until
benny/governance/policy.py is implemented.

AOS-F25: evaluate(intent, persona, manifest) returns approved | denied | escalate.
         denied propagates to user; escalate pauses for HITL.
AOS-SEC1: policy enforcer rejects tool not in allowed_tools_per_persona[persona].
AOS-SEC3: path traversal (..) rejected at evaluate() time.
"""

from __future__ import annotations

import pytest

from benny.governance.policy import PolicyDecision, PolicyEvaluator, PolicyDeniedError


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _evaluator(**kwargs) -> PolicyEvaluator:
    """Return a PolicyEvaluator with sensible defaults."""
    defaults = dict(
        mode="warn",
        auto_approve_writes=False,
        allowed_tools_per_persona={
            "architect": ["read_file", "write_file", "pypes.run"],
            "planner":   ["read_file"],
            "reviewer":  ["read_file", "git.commit"],
        },
        deny_network=True,
    )
    defaults.update(kwargs)
    return PolicyEvaluator(**defaults)


# ---------------------------------------------------------------------------
# AOS-F25 — evaluate modes
# ---------------------------------------------------------------------------


def test_aos_f25_policy_evaluate_modes_approved():
    """F25: approved tool for persona returns 'approved' in warn mode."""
    ev = _evaluator(mode="warn")
    result = ev.evaluate(
        intent="write config file",
        tool="write_file",
        persona="architect",
        workspace="ws",
    )
    assert result == PolicyDecision.APPROVED


def test_aos_f25_policy_evaluate_modes_denied_unknown_tool():
    """F25: tool not in allowlist returns 'denied'."""
    ev = _evaluator(mode="warn")
    result = ev.evaluate(
        intent="execute shell command",
        tool="subprocess.run",
        persona="architect",
        workspace="ws",
    )
    assert result == PolicyDecision.DENIED


def test_aos_f25_policy_enforce_mode_raises_on_denied():
    """F25: in enforce mode, denied intent raises PolicyDeniedError."""
    ev = _evaluator(mode="enforce")
    with pytest.raises(PolicyDeniedError):
        ev.evaluate(
            intent="write shell script",
            tool="subprocess.run",
            persona="planner",
            workspace="ws",
        )


def test_aos_f25_escalate_pauses():
    """F25: escalate is returned when persona has escalate-tier tool and mode=warn."""
    # 'git.commit' is allowed for reviewer, but escalate-tier (write to version control)
    ev = _evaluator(
        mode="warn",
        escalate_tools={"git.commit"},
    )
    result = ev.evaluate(
        intent="commit reviewed changes",
        tool="git.commit",
        persona="reviewer",
        workspace="ws",
    )
    assert result == PolicyDecision.ESCALATE


def test_aos_f25_escalate_in_enforce_mode_does_not_raise():
    """F25: escalate result never raises PolicyDeniedError (only denied raises)."""
    ev = _evaluator(
        mode="enforce",
        escalate_tools={"git.commit"},
    )
    result = ev.evaluate(
        intent="commit changes",
        tool="git.commit",
        persona="reviewer",
        workspace="ws",
    )
    assert result == PolicyDecision.ESCALATE


def test_aos_f25_approved_returns_decision_not_raises():
    """F25: approved in enforce mode returns APPROVED without raising."""
    ev = _evaluator(mode="enforce")
    result = ev.evaluate(
        intent="read project spec",
        tool="read_file",
        persona="planner",
        workspace="ws",
    )
    assert result == PolicyDecision.APPROVED


def test_aos_f25_policy_decision_values():
    """F25: PolicyDecision enum has exactly approved / denied / escalate."""
    values = {d.value for d in PolicyDecision}
    assert "approved" in values
    assert "denied" in values
    assert "escalate" in values


# ---------------------------------------------------------------------------
# AOS-SEC1 — persona tool allowlist
# ---------------------------------------------------------------------------


def test_aos_sec1_persona_tool_allowlist_deny_wrong_persona():
    """SEC1: reviewer cannot use pypes.run (not in their allowlist)."""
    ev = _evaluator()
    result = ev.evaluate(
        intent="run pypes pipeline",
        tool="pypes.run",
        persona="reviewer",
        workspace="ws",
    )
    assert result == PolicyDecision.DENIED


def test_aos_sec1_persona_tool_allowlist_allow_correct_persona():
    """SEC1: architect can use pypes.run."""
    ev = _evaluator()
    result = ev.evaluate(
        intent="run pypes pipeline",
        tool="pypes.run",
        persona="architect",
        workspace="ws",
    )
    assert result == PolicyDecision.APPROVED


def test_aos_sec1_empty_allowlist_denies_all():
    """SEC1: persona with no allowlist entry is denied all tools."""
    ev = _evaluator(allowed_tools_per_persona={"architect": ["read_file"]})
    result = ev.evaluate(
        intent="write file",
        tool="write_file",
        persona="unknown_persona",
        workspace="ws",
    )
    assert result == PolicyDecision.DENIED


# ---------------------------------------------------------------------------
# AOS-SEC3 — path traversal rejection
# ---------------------------------------------------------------------------


def test_aos_sec3_path_traversal_rejected_in_intent():
    """SEC3: intent containing '..' is always denied."""
    ev = _evaluator()
    result = ev.evaluate(
        intent="read ../../../etc/passwd",
        tool="read_file",
        persona="architect",
        workspace="ws",
    )
    assert result == PolicyDecision.DENIED


def test_aos_sec3_path_traversal_rejected_in_workspace():
    """SEC3: workspace containing '..' is denied."""
    ev = _evaluator()
    result = ev.evaluate(
        intent="write config",
        tool="write_file",
        persona="architect",
        workspace="../../../etc",
    )
    assert result == PolicyDecision.DENIED


def test_aos_sec3_windows_path_traversal_rejected():
    """SEC3: Windows-style path traversal is rejected."""
    ev = _evaluator()
    result = ev.evaluate(
        intent=r"read ..\..\Windows\System32\config\SAM",
        tool="read_file",
        persona="architect",
        workspace="ws",
    )
    assert result == PolicyDecision.DENIED


def test_aos_sec3_clean_path_allowed():
    """SEC3: clean paths within workspace are not blocked by traversal check."""
    ev = _evaluator()
    result = ev.evaluate(
        intent="write output/report.md",
        tool="write_file",
        persona="architect",
        workspace="ws",
    )
    assert result == PolicyDecision.APPROVED


# ---------------------------------------------------------------------------
# auto_approve_writes must always be False
# ---------------------------------------------------------------------------


def test_auto_approve_writes_must_be_false():
    """GATE-AOS-POLICY-1: PolicyEvaluator refuses to init with auto_approve_writes=True."""
    with pytest.raises((ValueError, AssertionError)):
        PolicyEvaluator(
            mode="warn",
            auto_approve_writes=True,  # MUST be rejected
            allowed_tools_per_persona={},
        )
