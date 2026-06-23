"""
Tests for profile-aware, default-safe thinking suppression.

The core guarantee: a 'capable' reasoning model on a synthesis role suppresses
hidden reasoning WITHOUT any operator toggle, while 'fragile' FLM models are
never suppressed (/no_think empties them) — and an explicit operator override
still wins for capable/none models.

Run with: python -m pytest tests/test_model_profiles.py -v
"""

from benny.core import model_profiles as mp


# --- capability classification -------------------------------------------------

def test_capability_capable_fragile_none():
    assert mp.get_thinking_capability("lemonade/Qwen3-8B-Hybrid") == "capable"
    assert mp.get_thinking_capability("qwen3.5-9b-FLM") == "fragile"
    assert mp.get_thinking_capability("Gemma-4-E4B-it-GGUF") == "none"


def test_capability_heuristic_for_unlisted():
    # Unknown FLM → fragile (the /no_think-empties caveat).
    assert mp.get_thinking_capability("some-new-7b-FLM") == "fragile"
    # Unknown reasoning-ish name → capable.
    assert mp.get_thinking_capability("acme-r1-13b") == "capable"
    # Unknown instruct → none; truly unknown → none (safe: don't inject /no_think).
    assert mp.get_thinking_capability("acme-instruct-3b") == "none"
    assert mp.get_thinking_capability("totally-unknown") == "none"


# --- the default-safe decision -------------------------------------------------

def test_capable_synthesis_role_suppresses_without_toggle():
    """The headline fix: no operator toggle, capable model, synthesis role → suppress."""
    assert mp.should_suppress_thinking(
        "Qwen3-8B-Hybrid", "lemonade/Qwen3-8B-Hybrid", None, "graph_synthesis", operator_override=None
    ) is True


def test_capable_chat_role_does_not_suppress():
    """Non-structured roles keep reasoning on for capable models."""
    assert mp.should_suppress_thinking(
        "Qwen3-8B-Hybrid", "lemonade/Qwen3-8B-Hybrid", None, "chat", operator_override=None
    ) is False


def test_fragile_never_suppressed_even_on_synthesis():
    assert mp.should_suppress_thinking(
        "qwen3.5-9b-FLM", "lemonade/qwen3.5-9b-FLM", None, "graph_synthesis", operator_override=None
    ) is False


def test_fragile_protected_against_operator_off():
    """Caveat protection: even an explicit 'off' must not /no_think a fragile model."""
    assert mp.should_suppress_thinking(
        "qwen3.5-9b-FLM", "lemonade/qwen3.5-9b-FLM", None, "chat", operator_override=True
    ) is False


def test_operator_override_wins_for_capable():
    # off → suppress even on a non-synthesis role
    assert mp.should_suppress_thinking(
        "Qwen3-8B-Hybrid", "lemonade/Qwen3-8B-Hybrid", None, "chat", operator_override=True
    ) is True
    # on → keep thinking even on a synthesis role
    assert mp.should_suppress_thinking(
        "Qwen3-8B-Hybrid", "lemonade/Qwen3-8B-Hybrid", None, "graph_synthesis", operator_override=False
    ) is False


def test_none_model_not_suppressed_by_default():
    assert mp.should_suppress_thinking(
        "Gemma-4-E4B-it-GGUF", "lemonade/Gemma-4-E4B-it-GGUF", None, "graph_synthesis", operator_override=None
    ) is False


def test_provider_profile_selection_changes_behaviour(tmp_path, monkeypatch):
    """Selecting the 'always-think' profile for a provider disables auto-suppress."""
    import benny.core.workspace as ws

    monkeypatch.setattr(
        mp, "active_profile_name", lambda provider, workspace=None: "always-think"
    )
    assert mp.should_suppress_thinking(
        "Qwen3-8B-Hybrid", "lemonade/Qwen3-8B-Hybrid", None, "graph_synthesis", operator_override=None
    ) is False
