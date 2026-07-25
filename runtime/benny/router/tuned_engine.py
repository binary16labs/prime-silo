"""T4 — register the EP-T tuned model as an *additive* candidate engine.

The house-method QLoRA (T3, served as a q4_k_m GGUF by llama-server, OpenAI-compatible)
becomes one more candidate behind Benny's existing router **without editing the router**.
Everything here is additive and reversible:

  * ``register_tuned_model`` adds one MODEL_REGISTRY entry + a ``llama_server`` provider.
    It never touches ``BENNY_DEFAULT_MODEL`` — the current engine stays the default.
  * ``register_tuned_executor`` wraps ``local_executor.resolve_executor`` so the
    ``house/`` prefix resolves to an OpenAI-compatible executor pointed at the tuned
    endpoint; every existing prefix resolves exactly as before.
  * ``select_engine`` implements the fallback: prefer the tuned engine only when asked
    *and* it is healthy; otherwise return the current default. Never raises.

Nothing here imports at package load — call ``register_all()`` (idempotent) from the
serving process, or the gate/tests call the pieces directly. Config is env-driven so the
served artifact can be swapped (v3 -> DPO) without code change.
"""

from __future__ import annotations

import logging
import os
from typing import Callable, Dict, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# Canonical id for the tuned engine as seen by the router / offload manifests.
TUNED_ENGINE_ID = "house/qwen2.5-coder-tuned"
_HOUSE_PREFIX = "house/"

# Env knobs (documented in docs/train/T4-integration.md).
# The tuned GGUF is served by **LM Studio on the eGPU** (owner constraint: LM Studio +
# eGPU only, parallelism 1) — the existing OpenAI-compatible ``lmstudio`` provider at
# :1234. The ``house/`` alias is a stable router-candidate id decoupled from LM Studio's
# exact model string, so offload manifests and the router name the tuned engine the same
# way regardless of which GGUF (v3, later DPO) is loaded.
ENV_BASE_URL = "BENNY_TUNED_BASE_URL"      # LM Studio OpenAI base (default :1234/v1)
ENV_MODEL = "BENNY_TUNED_MODEL"            # the model id LM Studio serves the tuned GGUF as
ENV_GGUF = "BENNY_TUNED_GGUF"              # path to the served GGUF (provenance only)
TUNED_PROVIDER = "lmstudio"
DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1"
DEFAULT_MODEL_NAME = "qwen2.5-coder-7b-instruct-house-tuned"


def tuned_base_url() -> str:
    return os.environ.get(ENV_BASE_URL, DEFAULT_BASE_URL).rstrip("/")


def tuned_model_name() -> str:
    return os.environ.get(ENV_MODEL, DEFAULT_MODEL_NAME)


def tuned_engine_config() -> Dict[str, object]:
    """The MODEL_REGISTRY entry for the tuned engine (additive candidate). Served by
    LM Studio, so it resolves through the existing ``lmstudio`` provider."""
    return {
        "model": f"lmstudio/{tuned_model_name()}",
        "provider": TUNED_PROVIDER,
        "cost_per_1k": 0.0,
        "use_for": ["house_method", "offline", "sdlc", "candidate", "tuned"],
        "candidate": True,          # marks it opt-in, never a default
        "gguf": os.environ.get(ENV_GGUF, ""),
    }


def register_tuned_model(registry: Optional[Dict] = None, providers: Optional[Dict] = None) -> str:
    """Additively register the tuned engine + its provider. Returns the engine id.

    Mutates the live ``MODEL_REGISTRY`` / ``LOCAL_PROVIDERS`` dicts (imported from
    ``core.models``) by default — additive, idempotent, and it refuses to become the
    default engine. Pass explicit dicts in tests.
    """
    if registry is None or providers is None:
        from ..core import models as _m

        registry = _m.MODEL_REGISTRY if registry is None else registry
        providers = _m.LOCAL_PROVIDERS if providers is None else providers

    # LM Studio provider already exists in core; only ensure the base_url matches env
    # (owner may repoint the eGPU LM Studio). Additive, non-destructive.
    providers.setdefault(
        TUNED_PROVIDER,
        {"port": _port_from(tuned_base_url()), "base_url": tuned_base_url(),
         "docs": "https://lmstudio.ai"},
    )
    registry[TUNED_ENGINE_ID] = tuned_engine_config()
    logger.info("router: registered additive candidate %s -> %s", TUNED_ENGINE_ID, tuned_base_url())
    return TUNED_ENGINE_ID


def register_tuned_executor(resolver_owner=None) -> Callable:
    """Wrap ``local_executor.resolve_executor`` so ``house/`` resolves to the tuned
    endpoint; all other prefixes delegate to the original. Idempotent; returns the
    installed resolver. Store the original on the wrapper for reversibility."""
    if resolver_owner is None:
        from ..core import local_executor as resolver_owner  # module

    original = resolver_owner.resolve_executor
    if getattr(original, "_t4_wrapped", False):
        return original

    from ..core.local_executor import OpenAICompatibleExecutor

    def resolve_with_tuned(model_str: str):
        if model_str and model_str.lower().startswith(_HOUSE_PREFIX):
            # Served by LM Studio on the eGPU (OpenAI-compatible).
            return OpenAICompatibleExecutor(
                tuned_model_name(), TUNED_PROVIDER, tuned_base_url()
            )
        return original(model_str)

    resolve_with_tuned._t4_wrapped = True          # type: ignore[attr-defined]
    resolve_with_tuned._t4_original = original      # type: ignore[attr-defined]
    resolver_owner.resolve_executor = resolve_with_tuned
    return resolve_with_tuned


def unregister_tuned_executor(resolver_owner=None) -> None:
    """Restore the original resolver (test hygiene / reversibility)."""
    if resolver_owner is None:
        from ..core import local_executor as resolver_owner
    cur = resolver_owner.resolve_executor
    if getattr(cur, "_t4_wrapped", False):
        resolver_owner.resolve_executor = cur._t4_original


def register_all() -> str:
    register_tuned_model()
    register_tuned_executor()
    return TUNED_ENGINE_ID


def tuned_healthy(base_url: Optional[str] = None, timeout: float = 3.0) -> bool:
    """True iff LM Studio is serving the tuned model. LM Studio's ``/v1/models`` returns
    200 even with nothing loaded, so 'healthy' means the tuned model id is actually in the
    served list — a truer readiness check the fallback path can trust. Never raises."""
    base = (base_url or tuned_base_url()).rstrip("/")
    want = tuned_model_name().lower()
    try:
        r = httpx.get(f"{base}/models", timeout=timeout)
        if r.status_code != 200:
            return False
        served = [str(m.get("id", "")).lower() for m in r.json().get("data", [])]
        # exact or prefix match (LM Studio may append a quant/path suffix to the id)
        return any(want == s or want in s or s in want for s in served if s)
    except Exception:
        return False


def select_engine(
    default_id: str,
    prefer_tuned: bool = False,
    health: Optional[Callable[[], bool]] = None,
) -> Tuple[str, bool]:
    """Pick the engine. Returns ``(engine_id, used_tuned)``.

    Additive + safe: the tuned engine is used only when explicitly preferred AND healthy.
    Otherwise the current default is returned and the fallback is logged. Never raises —
    an unhealthy tuned endpoint must degrade, never crash a route.
    """
    if not prefer_tuned:
        return default_id, False
    checker = health or tuned_healthy
    try:
        ok = bool(checker())
    except Exception:  # a broken health check must not take down routing
        ok = False
    if ok:
        return TUNED_ENGINE_ID, True
    logger.warning(
        "router: tuned engine preferred but unhealthy at %s — falling back to default %r",
        tuned_base_url(),
        default_id,
    )
    return default_id, False


def router_config_view(registry: Optional[Dict] = None, default_id: Optional[str] = None) -> Dict:
    """Inspectable router state for the 'inspect router config' scenario:
    the default engine and the opt-in candidates (tuned flagged)."""
    if registry is None:
        from ..core import models as _m

        registry = _m.MODEL_REGISTRY
    default_id = default_id or os.environ.get("BENNY_DEFAULT_MODEL") or "qwen3_5_9b"
    candidates = [k for k, v in registry.items() if isinstance(v, dict) and v.get("candidate")]
    return {
        "default": default_id,
        "candidates": candidates,
        "tuned_registered": TUNED_ENGINE_ID in registry,
        "tuned_is_default": default_id == TUNED_ENGINE_ID,  # must be False — additive only
        "tuned_base_url": tuned_base_url(),
    }


def _port_from(base_url: str) -> int:
    try:
        return int(base_url.split(":")[2].split("/")[0])
    except Exception:
        return 8080


# --- L12: served id reflects human-signed promotions (additive, R36) -------- #
def served_engine_id(pointer_path: Optional[str] = None, default: Optional[str] = None) -> str:
    """Who is currently served: the model named by a human-signed promotion pointer (L12), else the
    default engine. With no pointer this returns the default unchanged — the router keeps its existing
    behaviour until a promotion is signed. The served position only ever moves by human signature
    (promotion.py enforces the sign gate); this is the read side the router consults."""
    default = default or os.environ.get("BENNY_DEFAULT_MODEL") or "qwen3_5_9b"
    path = pointer_path or os.environ.get("BENNY_SERVED_POINTER")
    if not path:
        return default
    from .promotion import read_served

    rec = read_served(path)
    served = rec.get("served") if rec else None
    return served or default
