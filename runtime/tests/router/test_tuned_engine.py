"""T4 router unit tests — candidate registration is ADDITIVE, and an unhealthy tuned
engine falls back rather than hard-failing. No network, no served endpoint."""

import pytest

from benny.router import tuned_engine as te


def test_register_is_additive_default_unchanged():
    registry = {"qwen3_5_9b": {"model": "x", "provider": "lemonade"}}
    providers = {"lemonade": {"port": 13305}}
    eid = te.register_tuned_model(registry, providers)

    assert eid == te.TUNED_ENGINE_ID
    # the pre-existing default entry is untouched
    assert registry["qwen3_5_9b"] == {"model": "x", "provider": "lemonade"}
    # the tuned engine is present and flagged an opt-in candidate (never a default)
    assert registry[te.TUNED_ENGINE_ID]["candidate"] is True
    # served by LM Studio on the eGPU (owner constraint) — resolves via the lmstudio provider
    assert registry[te.TUNED_ENGINE_ID]["provider"] == "lmstudio"
    assert "lmstudio" in providers
    # idempotent
    te.register_tuned_model(registry, providers)
    assert sum(1 for k in registry if k == te.TUNED_ENGINE_ID) == 1


def test_config_view_shows_candidate_not_default(monkeypatch):
    registry = {
        "qwen3_5_9b": {"model": "x", "provider": "lemonade"},
        te.TUNED_ENGINE_ID: te.tuned_engine_config(),
    }
    monkeypatch.setenv("BENNY_DEFAULT_MODEL", "qwen3_5_9b")
    view = te.router_config_view(registry)
    assert view["default"] == "qwen3_5_9b"
    assert te.TUNED_ENGINE_ID in view["candidates"]
    assert view["tuned_is_default"] is False
    assert view["tuned_registered"] is True


def test_resolver_hook_is_additive():
    """The wrapped resolver resolves house/ to the tuned endpoint while delegating every
    existing prefix to the original resolver unchanged."""
    calls = []

    class FakeModule:
        @staticmethod
        def resolve_executor(model_str):
            calls.append(model_str)
            return f"ORIG:{model_str}"

    fake = FakeModule()
    # patch OpenAICompatibleExecutor lookup used inside the wrapper
    import benny.core.local_executor as le

    installed = te.register_tuned_executor(fake)
    try:
        # existing prefix delegates to the original (and returns its value)
        assert fake.resolve_executor("lemonade/qwen3.5-9b-FLM") == "ORIG:lemonade/qwen3.5-9b-FLM"
        assert "lemonade/qwen3.5-9b-FLM" in calls
        # house/ prefix resolves to a real OpenAI-compatible executor, NOT the original
        exe = fake.resolve_executor("house/anything")
        assert isinstance(exe, le.OpenAICompatibleExecutor)
        assert installed._t4_wrapped is True
    finally:
        te.unregister_tuned_executor(fake)
    # reversibility: original restored
    assert fake.resolve_executor("house/anything") == "ORIG:house/anything"


def test_select_engine_falls_back_when_unhealthy():
    default = "qwen3_5_9b"
    # not preferred -> default, no health check consulted
    assert te.select_engine(default, prefer_tuned=False) == (default, False)
    # preferred but unhealthy -> fallback to default, no raise
    eid, used = te.select_engine(default, prefer_tuned=True, health=lambda: False)
    assert (eid, used) == (default, False)
    # preferred and healthy -> tuned
    eid, used = te.select_engine(default, prefer_tuned=True, health=lambda: True)
    assert (eid, used) == (te.TUNED_ENGINE_ID, True)
    # a health check that raises must NOT crash routing — degrade to default
    eid, used = te.select_engine(default, prefer_tuned=True, health=_boom)
    assert (eid, used) == (default, False)


def _boom():
    raise RuntimeError("health probe exploded")


def test_tuned_healthy_false_when_down(monkeypatch):
    # point at a certainly-dead port; must return False, never raise
    monkeypatch.setenv(te.ENV_BASE_URL, "http://127.0.0.1:9/v1")
    assert te.tuned_healthy(timeout=0.2) is False
