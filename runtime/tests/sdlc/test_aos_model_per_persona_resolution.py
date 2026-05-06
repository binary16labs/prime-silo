"""Phase 0 acceptance tests: OQ-1 model_per_persona resolution chain.

Resolution order (first non-empty wins):
  1. task.assigned_model
  2. config.model_per_persona[persona]
  3. config.model
  4. AOS_DEFAULT_PERSONA_MODEL  (fallback — qwen3_5_9b)
"""
import pytest
from benny.core.manifest import ManifestConfig
from benny.core.models import MODEL_REGISTRY, is_local_model
from benny.sdlc.model_resolver import resolve_model, AOS_DEFAULT_PERSONA_MODEL


def test_aos_model_per_persona_resolution():
    """model_per_persona overrides config.model for a named persona."""
    cfg = ManifestConfig(
        model="openai/gpt-4o",
        model_per_persona={
            "planner": "local_lemonade",
            "architect": "local_litert",
        },
    )
    assert resolve_model("planner", config=cfg) == "local_lemonade"
    assert resolve_model("architect", config=cfg) == "local_litert"


def test_aos_model_per_persona_fallback_to_config_model():
    """Persona not in model_per_persona falls back to config.model."""
    cfg = ManifestConfig(
        model="openai/gpt-4o",
        model_per_persona={"planner": "local_lemonade"},
    )
    assert resolve_model("writer", config=cfg) == "openai/gpt-4o"


def test_aos_model_per_persona_task_model_wins():
    """task.assigned_model takes priority over everything else."""
    cfg = ManifestConfig(
        model="openai/gpt-4o",
        model_per_persona={"planner": "local_lemonade"},
    )
    assert resolve_model("planner", task_model="local_ollama", config=cfg) == "local_ollama"


def test_aos_model_per_persona_no_config_fallback():
    """Without any config, returns AOS_DEFAULT_PERSONA_MODEL."""
    result = resolve_model("planner")
    assert result == AOS_DEFAULT_PERSONA_MODEL


def test_aos_model_per_persona_empty_map_uses_config_model():
    """Empty model_per_persona dict falls through to config.model."""
    cfg = ManifestConfig(model="local_lemonade", model_per_persona={})
    assert resolve_model("planner", config=cfg) == "local_lemonade"


def test_aos_model_registry_qwen3_5_9b_resolves():
    """qwen3_5_9b alias is present in MODEL_REGISTRY and resolves as a local model."""
    assert "qwen3_5_9b" in MODEL_REGISTRY, (
        "qwen3_5_9b must be registered in MODEL_REGISTRY per OQ-1 decision"
    )
    assert is_local_model("qwen3_5_9b"), (
        "qwen3_5_9b must be a local model (offline-safe)"
    )


def test_aos_default_persona_model_is_local():
    """AOS_DEFAULT_PERSONA_MODEL must resolve to a local (offline-safe) model."""
    assert is_local_model(AOS_DEFAULT_PERSONA_MODEL), (
        f"AOS_DEFAULT_PERSONA_MODEL='{AOS_DEFAULT_PERSONA_MODEL}' must be local"
    )
