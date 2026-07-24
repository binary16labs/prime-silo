"""Benny router — additive candidate-engine registration (EP-T / T4).

The tuned house-method model is wired in here as an *additive* candidate behind the
existing router in ``benny.core.models``; the current engine stays the default. See
``tuned_engine`` for the mechanism and ``docs/train/T4-integration.md`` for config.
"""

from .tuned_engine import (
    TUNED_ENGINE_ID,
    register_all,
    register_tuned_executor,
    register_tuned_model,
    router_config_view,
    select_engine,
    tuned_base_url,
    tuned_engine_config,
    tuned_healthy,
    tuned_model_name,
    unregister_tuned_executor,
)

__all__ = [
    "TUNED_ENGINE_ID",
    "register_all",
    "register_tuned_executor",
    "register_tuned_model",
    "router_config_view",
    "select_engine",
    "tuned_base_url",
    "tuned_engine_config",
    "tuned_healthy",
    "tuned_model_name",
    "unregister_tuned_executor",
]
