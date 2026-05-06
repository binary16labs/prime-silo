"""AOS-001 OQ-1 — model resolution for the SDLC capability surface.

Resolution order (first non-empty wins):
  1. task.assigned_model
  2. config.model_per_persona[persona]
  3. config.model
  4. AOS_DEFAULT_PERSONA_MODEL  (qwen3_5_9b — Lemonade, offline-safe)

Never import litellm or call any network API here; this module is pure logic.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from benny.core.manifest import ManifestConfig

# Default AOS persona model (OQ-1 decision 2026-04-26).
# Registry key: "qwen3_5_9b" → lemonade/openai/Qwen3-8B-Instruct-FLM
# Fallback alias "local_lemonade" is used if qwen3_5_9b is unresolvable on host.
AOS_DEFAULT_PERSONA_MODEL: str = "qwen3_5_9b"


def resolve_model(
    persona: str,
    *,
    task_model: Optional[str] = None,
    config: Optional["ManifestConfig"] = None,
) -> str:
    """Return the model string for *persona* following the OQ-1 resolution order."""
    # 1. Task-level override wins everything
    if task_model:
        return task_model

    if config is not None:
        # 2. Per-persona map
        persona_map: dict[str, str] = getattr(config, "model_per_persona", {}) or {}
        if persona in persona_map:
            return persona_map[persona]

        # 3. Config-level default
        if config.model:
            return config.model

    # 4. Registry default
    return AOS_DEFAULT_PERSONA_MODEL
