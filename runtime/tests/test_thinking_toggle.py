"""
Regression tests for the per-model thinking toggle reaching synthesis (PIX-001).

Root cause that this guards against: reasoning models (e.g. Qwen3-8B-Hybrid)
produced ZERO knowledge triples because the `model_thinking="off"` toggle never
fired during extraction — the synthesis path didn't thread the workspace, and
the toggle key was compared in the wrong (prefixed vs bare) form. Verified live
that fixing both makes the same model emit parseable JSON triples.
"""

from types import SimpleNamespace
from unittest.mock import patch

from benny.core import models as M


def _manifest(model_thinking):
    return SimpleNamespace(model_thinking=model_thinking)


def test_toggle_matches_bare_key_for_prefixed_model():
    """A toggle stored as the bare id must match a provider-prefixed call."""
    with patch("benny.core.workspace.load_manifest", return_value=_manifest({"Qwen3-8B-Hybrid": "off"})):
        assert M._thinking_disabled("lemonade/Qwen3-8B-Hybrid", "lemonade/Qwen3-8B-Hybrid", "ws") is True


def test_toggle_matches_prefixed_key_for_bare_model():
    with patch("benny.core.workspace.load_manifest", return_value=_manifest({"lemonade/Qwen3-8B-Hybrid": "off"})):
        assert M._thinking_disabled("Qwen3-8B-Hybrid", "Qwen3-8B-Hybrid", "ws") is True


def test_toggle_off_for_unlisted_model():
    with patch("benny.core.workspace.load_manifest", return_value=_manifest({"Qwen3-8B-Hybrid": "off"})):
        assert M._thinking_disabled("lemonade/some-other-model", "lemonade/some-other-model", "ws") is False


def test_no_prefs_returns_false():
    with patch("benny.core.workspace.load_manifest", return_value=_manifest({})):
        assert M._thinking_disabled("Qwen3-8B-Hybrid", "Qwen3-8B-Hybrid", "ws") is False


def test_call_llm_threads_workspace_to_call_model():
    """The synthesis call_llm wrapper must pass the workspace through so the
    thinking toggle can key off the right manifest."""
    import asyncio
    from benny.synthesis import engine

    captured = {}

    async def fake_call_model(*args, **kwargs):
        captured.update(kwargs)
        return "[]"

    with patch.object(engine, "call_model", side_effect=fake_call_model):
        asyncio.run(engine.call_llm("prompt", provider="lemonade", model="Qwen3-8B-Hybrid", workspace="prime_silo_self"))

    assert captured.get("workspace_id") == "prime_silo_self"
