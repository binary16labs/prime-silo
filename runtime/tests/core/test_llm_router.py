"""Phase 3 — LLM router hardening.

Four contracts (PBR-001 §5, Phase 3):

* ``executor_override`` — a per-task explicit model wins over every other
  resolution rule; this is how a manifest pins "this task runs on Claude"
  irrespective of workspace defaults.
* Role-resolution order — ``model_roles[role]`` first, then
  ``default_model``, then the provider probe.
* ``local_only`` — refuses to resolve a cloud model; used by ``--offline``.
* ``BENNY_OFFLINE`` — the runtime-wide kill switch. Even if a manifest
  names a cloud model, ``call_model`` refuses when offline is engaged.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock
import pytest

from benny.core import models as llm


# ---- is_local_model --------------------------------------------------------


@pytest.mark.parametrize(
    "model,expected",
    [
        ("lemonade/openai/deepseek-r1-8b-FLM", True),
        ("ollama/llama3", True),
        ("lmstudio/gemma-2-27b", True),
        ("fastflowlm/qwen3", True),
        ("litert/gemma-4-E4B-it.litertlm", True),
        ("openai/gpt-4-turbo", False),
        ("anthropic/claude-3-sonnet-20240229", False),
        ("claude-3-sonnet-20240229", False),
        ("gpt-4", False),
        ("", False),
    ],
)
def test_is_local_model_classifier(model: str, expected: bool) -> None:
    assert llm.is_local_model(model) is expected


# ---- fixtures --------------------------------------------------------------


def _fake_manifest(**fields: Any) -> SimpleNamespace:
    base = dict(
        default_model=None,
        model_roles={},
    )
    base.update(fields)
    return SimpleNamespace(**base)


@pytest.fixture
def patch_manifest(monkeypatch: pytest.MonkeyPatch):
    """Return a factory that installs a fake ``load_manifest`` in the router."""

    def _install(manifest: SimpleNamespace) -> None:
        def fake_load(_ws: str):
            return manifest

        monkeypatch.setattr("benny.core.workspace.load_manifest", fake_load)

    return _install


@pytest.fixture
def patch_probe_all_down(monkeypatch: pytest.MonkeyPatch):
    """Force every provider probe to report 'not running'.

    We replace the ``httpx.AsyncClient`` used inside get_active_model so the
    test doesn't make real network calls or block waiting for timeouts.
    """

    class _StubResponse:
        status_code = 503

        def json(self) -> dict:
            return {"data": []}

    class _StubClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url: str):
            return _StubResponse()

    monkeypatch.setattr("benny.core.models.httpx.AsyncClient", _StubClient)


# ---- role resolution order -------------------------------------------------


@pytest.mark.asyncio
async def test_role_resolution_order_prefers_role_over_default(
    patch_manifest, patch_probe_all_down
) -> None:
    """``model_roles[role]`` must win over ``default_model``."""
    patch_manifest(
        _fake_manifest(
            default_model="ollama/llama3",
            model_roles={"plan": "anthropic/claude-3-sonnet-20240229"},
        )
    )
    resolved = await llm.get_active_model("ws", role="plan")
    assert resolved == "anthropic/claude-3-sonnet-20240229"


@pytest.mark.asyncio
async def test_role_resolution_falls_back_to_default_model(
    patch_manifest, patch_probe_all_down
) -> None:
    patch_manifest(
        _fake_manifest(
            default_model="lemonade/openai/deepseek-r1-8b-FLM",
            model_roles={"plan": "claude"},  # unrelated role
        )
    )
    resolved = await llm.get_active_model("ws", role="chat")
    assert resolved == "lemonade/openai/deepseek-r1-8b-FLM"


# ---- executor_override -----------------------------------------------------


@pytest.mark.asyncio
async def test_executor_override_wins_over_role_and_default(
    patch_manifest, patch_probe_all_down
) -> None:
    """Per-task override beats workspace config entirely."""
    patch_manifest(
        _fake_manifest(
            default_model="ollama/llama3",
            model_roles={"plan": "lemonade/openai/deepseek-r1-8b-FLM"},
        )
    )
    resolved = await llm.get_active_model(
        "ws", role="plan", executor_override="anthropic/claude-3-opus-20240229"
    )
    assert resolved == "anthropic/claude-3-opus-20240229"


@pytest.mark.asyncio
async def test_executor_override_refused_when_local_only_and_cloud(
    patch_manifest, patch_probe_all_down
) -> None:
    """local_only + cloud override must fail fast — not silently fall back."""
    patch_manifest(_fake_manifest(default_model="ollama/llama3"))
    with pytest.raises(Exception, match="local"):
        await llm.get_active_model(
            "ws",
            role="plan",
            executor_override="anthropic/claude-3-opus-20240229",
            local_only=True,
        )


# ---- local_only ------------------------------------------------------------


@pytest.mark.asyncio
async def test_local_only_refuses_cloud_default_model(
    patch_manifest, patch_probe_all_down
) -> None:
    """Even if the workspace default is cloud, local_only must bail."""
    patch_manifest(_fake_manifest(default_model="anthropic/claude-3-sonnet-20240229"))
    with pytest.raises(Exception, match="local"):
        await llm.get_active_model("ws", role="chat", local_only=True)


@pytest.mark.asyncio
async def test_local_only_accepts_local_default_model(
    patch_manifest, patch_probe_all_down
) -> None:
    patch_manifest(_fake_manifest(default_model="lemonade/openai/deepseek-r1-8b-FLM"))
    resolved = await llm.get_active_model("ws", role="chat", local_only=True)
    assert resolved.startswith("lemonade/")


# ---- offline kill switch ---------------------------------------------------


@pytest.mark.asyncio
async def test_offline_env_blocks_cloud_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With ``BENNY_OFFLINE=1``, call_model must refuse any non-local model
    BEFORE touching the network."""
    monkeypatch.setenv("BENNY_OFFLINE", "1")
    with pytest.raises(llm.OfflineRefusal):
        await llm.call_model(
            model="anthropic/claude-3-sonnet-20240229",
            messages=[{"role": "user", "content": "hello"}],
        )


@pytest.mark.asyncio
async def test_offline_env_allows_local_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Offline mode doesn't touch local models — they're the whole point."""
    monkeypatch.setenv("BENNY_OFFLINE", "1")

    # Patch resolve_executor to return a mock executor
    mock_executor = AsyncMock()
    mock_executor.generate.return_value = "ok"
    # Ensure count_tokens is treated as a normal method, not a coroutine
    mock_executor.count_tokens = MagicMock(return_value=10)
    mock_executor.provider_name = "test-provider"
    
    monkeypatch.setattr("benny.core.models.resolve_executor", lambda _: mock_executor)
    
    out = await llm.call_model(
        model="lemonade/openai/deepseek-r1-8b-FLM",
        messages=[{"role": "user", "content": "hello"}],
    )
    assert out == "ok"
