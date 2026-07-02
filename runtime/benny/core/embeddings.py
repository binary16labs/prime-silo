"""
Torch-free Embedding Utilities - Bypasses WinError 4551 by using HTTP providers.
"""

import logging
from typing import List, Optional

import httpx

logger = logging.getLogger(__name__)

# Use shared client for performance
_async_client: Optional[httpx.AsyncClient] = None
_sync_client: Optional[httpx.Client] = None


def _get_async_client() -> httpx.AsyncClient:
    global _async_client
    if _async_client is None:
        _async_client = httpx.AsyncClient(timeout=30.0)
    return _async_client


def _get_sync_client() -> httpx.Client:
    global _sync_client
    if _sync_client is None:
        _sync_client = httpx.Client(timeout=30.0)
    return _sync_client


# Cache: provider name -> embedding model id the provider actually serves.
_embed_model_cache: dict = {}


def _resolve_embedding_model(
    current_provider: str, provider_config: Optional[dict], fallback_model: str
) -> str:
    """Pick an embedding model the provider actually serves.

    The hardcoded default ("nomic-embed-text-v1-GGUF") matches Lemonade but NOT
    LM Studio (which serves e.g. "text-embedding-nomic-embed-text-v1.5"). When
    the cascade falls through to a provider that doesn't have that exact id, the
    provider returns "No models loaded" / 400. So we query the provider's
    OpenAI-compatible /models once (cached) and prefer an id containing "embed";
    otherwise we keep the caller's fallback (provider may JIT-load it).
    """
    if current_provider in _embed_model_cache:
        return _embed_model_cache[current_provider]
    model = fallback_model
    try:
        base = (provider_config or {}).get("base_url")
        if base:
            resp = _get_sync_client().get(base.rstrip("/") + "/models", timeout=4.0)
            if resp.status_code == 200:
                ids = [m.get("id") for m in resp.json().get("data", []) if m.get("id")]
                embed_ids = [i for i in ids if "embed" in i.lower()]
                if embed_ids:
                    model = embed_ids[0]
    except Exception:
        pass
    _embed_model_cache[current_provider] = model
    return model


# Embedding dimension we pad to when every provider fails (nomic-embed = 768).
_EMBED_DIM = 768

# Max chars sent to an embedding model. Local embedders have a hard TOKEN limit:
# lemonade's nomic-embed runs llama-server with physical batch size 512, so any
# input over ~512 tokens 500s ("input (525 tokens) is too large to process") and
# returns no vector — which ChromaDB >=1.x then rejects ("each embedding ... at
# least 1 value"), crashing the whole batch. Dense/technical text runs ~2.5-3.5
# chars/token, so 1200 chars stays under 512 tokens (≤ ~480) with margin. The RAG
# chunker emits chunks up to 4000 chars; we truncate only the EMBEDDING input
# (the full chunk text is still stored as the document), which keeps every chunk
# embeddable while preserving ample signal for semantic retrieval.
_EMBED_MAX_CHARS = 1200


def _extract_embedding(data) -> List[float]:
    """Pull the vector out of an OpenAI-/Ollama-style embeddings response.

    Returns [] when the response carries no usable vector so the caller can
    fall through to the next provider instead of handing ChromaDB an empty
    embedding (which 1.x rejects, failing the entire add).
    """
    try:
        arr = data.get("data")
        if isinstance(arr, list) and arr:
            emb = arr[0].get("embedding")
            if emb:
                return emb
        emb = data.get("embedding")
        if emb:
            return emb
    except Exception:
        pass
    return []


async def get_embedding_async(
    text: str, provider: str = "lemonade", model: str = "nomic-embed-text-v1-GGUF"
) -> List[float]:
    """Get embeddings via HTTP (Async). No Torch/Transformers required."""
    from .models import LOCAL_PROVIDERS

    text = (text or "")[:_EMBED_MAX_CHARS]
    # Dynamic provider cascade for failover
    providers_to_try = [provider] + [
        p for p in ["lmstudio", "fastflowlm", "ollama"] if p != provider
    ]
    client = _get_async_client()

    for current_provider in providers_to_try:
        provider_config = LOCAL_PROVIDERS.get(current_provider)

        if not provider_config:
            if current_provider == "ollama":
                url = "http://localhost:11434/api/embeddings"
                payload = {"model": "nomic-embed-text", "prompt": text}
            else:
                continue
        else:
            api_base = provider_config.get("base_url", "http://localhost:11434/api")
            # fastflowlm and others might use /v1, so we ensure /embeddings is appended correctly
            url = f"{api_base}/embeddings"
            resolved = _resolve_embedding_model(current_provider, provider_config, model)
            payload = {"model": resolved, "input": text}

        try:
            response = await client.post(url, json=payload)
            if response.status_code == 200:
                emb = _extract_embedding(response.json())
                if emb:
                    return emb
                logger.warning(
                    f"{current_provider} returned an empty embedding; trying next provider."
                )
                continue
        except httpx.ConnectError:
            logger.debug(
                f"Connection refused for embedding provider {current_provider}. Trying next..."
            )
            continue
        except Exception as e:
            logger.warning(f"Error with embedding provider {current_provider}: {e}")
            continue

    logger.error("All local embedding providers failed (ConnectError/Timeout).")
    return [
        0.0
    ] * _EMBED_DIM  # Fallback to a consistent-dimension zero vector to prevent a batch crash


def get_embedding_sync(
    text: str, provider: str = "lemonade", model: str = "nomic-embed-text-v1-GGUF"
) -> List[float]:
    """Get embeddings via HTTP (Sync). Used by ChromaDB EmbeddingFunction."""
    from .models import LOCAL_PROVIDERS

    text = (text or "")[:_EMBED_MAX_CHARS]
    providers_to_try = [provider] + [
        p for p in ["lmstudio", "fastflowlm", "ollama"] if p != provider
    ]
    client = _get_sync_client()

    for current_provider in providers_to_try:
        provider_config = LOCAL_PROVIDERS.get(current_provider)

        if not provider_config:
            if current_provider == "ollama":
                url = "http://localhost:11434/api/embeddings"
                payload = {"model": "nomic-embed-text", "prompt": text}
            else:
                continue
        else:
            api_base = provider_config.get("base_url", "http://localhost:11434/api")
            url = f"{api_base}/embeddings"
            resolved = _resolve_embedding_model(current_provider, provider_config, model)
            payload = {"model": resolved, "input": text}

        try:
            response = client.post(url, json=payload)
            if response.status_code == 200:
                emb = _extract_embedding(response.json())
                if emb:
                    return emb
                # 200 but no vector — usually an over-limit input echoed in body.
                logger.warning(
                    "Embedding empty from %s (model=%s): %s",
                    current_provider,
                    payload.get("model"),
                    response.text[:160],
                )
                continue
            logger.warning(
                "Embedding non-200 from %s (model=%s): %s %s",
                current_provider,
                payload.get("model"),
                response.status_code,
                response.text[:160],
            )
        except httpx.ConnectError:
            continue
        except Exception as e:
            logger.warning(f"Sync embedding error with provider {current_provider}: {e}")
            continue

    logger.error("All sync local embedding providers failed.")
    return [0.0] * _EMBED_DIM


# =============================================================================
# CHROMADB INTEGRATION
# =============================================================================

from chromadb.api.types import Documents, EmbeddingFunction, Embeddings


class LocalEmbeddingFunction(EmbeddingFunction):
    """ChromaDB-compatible wrapper for our HTTP embedding utility."""

    def __init__(self, provider: str = "lemonade", model: str = "nomic-embed-text-v1-GGUF"):
        self.provider = provider
        self.model = model

    def __call__(self, input: Documents) -> Embeddings:
        # ChromaDB expects a list of embeddings
        return [get_embedding_sync(text, self.provider, self.model) for text in input]

    # ChromaDB >= 1.x persists the embedding-function config with the collection
    # and refuses to reopen it with a function it can't identify ("conflict: new:
    # NotImplemented vs persisted: ..."). Implementing name()/get_config()/
    # build_from_config() gives the collection a stable identity so subsequent
    # opens match instead of raising.
    @staticmethod
    def name() -> str:
        return "benny_local_http"

    def get_config(self) -> dict:
        return {"provider": self.provider, "model": self.model}

    @classmethod
    def build_from_config(cls, config: dict) -> "LocalEmbeddingFunction":
        config = config or {}
        return cls(
            provider=config.get("provider", "lemonade"),
            model=config.get("model", "nomic-embed-text-v1-GGUF"),
        )
