"""Multi-endpoint resolution for local model providers.

A local provider (lemonade, ollama, …) normally points at a single localhost
``base_url``. When you run the same provider on more than one machine — e.g.
Gemma on a Ryzen AI laptop *and* a model on a second box — you can declare a
pool of endpoints, and the router round-robins concurrent calls across them so a
fanned-out swarm / deep-produce run gets real parallelism instead of serializing
on one model server.

Configuration (env), either form (both may be combined):

  * ``BENNY_MODEL_ENDPOINTS`` — JSON map of provider → list of base URLs::

        {"lemonade": ["http://ryzen.local:13305/api/v1",
                      "http://t480.local:13305/api/v1"]}

  * ``BENNY_<PROVIDER>_ENDPOINTS`` — comma-separated base URLs for one provider::

        BENNY_LEMONADE_ENDPOINTS=http://ryzen.local:13305/api/v1,http://t480.local:13305/api/v1

Endpoints in a pool are LAN hosts of the *same local provider*, so the offline
guard still treats them as local. With no pool configured, the provider's
default ``base_url`` is returned unchanged — fully backwards compatible.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import threading
from typing import Dict, List, Optional

_lock = threading.Lock()
# provider -> (pool_tuple, cycle) so a changed pool rebuilds its round-robin.
_cyclers: Dict[str, tuple] = {}

_ENV_KEY_RE = re.compile(r"^BENNY_([A-Z0-9]+)_ENDPOINTS$")


def _clean_urls(values: List[str]) -> List[str]:
    out = []
    for value in values:
        if isinstance(value, str):
            stripped = value.strip().rstrip("/")
            if stripped:
                out.append(stripped)
    return out


def get_endpoint_pools(env: Optional[Dict[str, str]] = None) -> Dict[str, List[str]]:
    """Parse the configured endpoint pools, keyed by lowercased provider name."""
    env = env if env is not None else os.environ
    pools: Dict[str, List[str]] = {}

    raw = str(env.get("BENNY_MODEL_ENDPOINTS", "") or "").strip()
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                for provider, urls in data.items():
                    if isinstance(urls, str):
                        urls = [urls]
                    if isinstance(urls, list):
                        cleaned = _clean_urls(urls)
                        if cleaned:
                            pools[str(provider).lower()] = cleaned
        except (ValueError, TypeError):
            pass  # malformed config must never break inference

    for key, value in env.items():
        match = _ENV_KEY_RE.match(str(key))
        if not match or key == "BENNY_MODEL_ENDPOINTS":
            continue
        provider = match.group(1).lower()
        cleaned = _clean_urls(str(value or "").split(","))
        if cleaned:
            pools[provider] = cleaned  # explicit per-provider env wins

    return pools


def resolve_endpoint(
    provider: str, default_base_url: str, env: Optional[Dict[str, str]] = None
) -> str:
    """Return the base URL to use for the next call to ``provider``.

    With no pool configured (or a single-entry pool) this is deterministic; with
    a multi-entry pool it round-robins so concurrent fan-out spreads across the
    configured machines. ``default_base_url`` is returned when no pool applies.
    """
    pool = get_endpoint_pools(env).get(str(provider or "").lower())
    if not pool:
        return default_base_url
    if len(pool) == 1:
        return pool[0]

    key = str(provider).lower()
    pool_tuple = tuple(pool)
    with _lock:
        cached = _cyclers.get(key)
        if cached is None or cached[0] != pool_tuple:
            cached = (pool_tuple, itertools.cycle(pool_tuple))
            _cyclers[key] = cached
        return next(cached[1])


def reset() -> None:
    """Clear round-robin state (tests)."""
    with _lock:
        _cyclers.clear()
