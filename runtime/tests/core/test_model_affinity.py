"""A8 — model-routing hygiene (2026-07-06 swap-thrash incident).

Contracts under test:

* ``set_run_model_affinity`` — a run's primary model, once registered (e.g. by
  the /rag/ingest handler from the request's ``model`` field), wins for every
  role in that run that the workspace manifest does not explicitly map.
  This is the single-NPU rule: one run never alternates engines by accident.
* Explicit ``model_roles[role]`` still beats affinity (opt-in alternation).
* Auto-detect prefers the provider's *currently loaded* model over catalog
  order (a swap-free choice by definition).
* The last-resort catalog pick (``models[0]``) is loud: WARNING containing
  the word ``roulette`` — and sticky per run, so even the fallback cannot
  ping-pong two engines within one run.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

from benny.core import models as llm


def _fake_manifest(**fields: Any) -> SimpleNamespace:
    base = dict(default_model=None, model_roles={})
    base.update(fields)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def _clean_env_and_affinity(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BENNY_DEFAULT_MODEL", raising=False)
    llm.clear_run_model_affinity()
    yield
    llm.clear_run_model_affinity()


@pytest.fixture
def patch_manifest(monkeypatch: pytest.MonkeyPatch):
    def _install(manifest: SimpleNamespace) -> None:
        monkeypatch.setattr("benny.core.workspace.load_manifest", lambda _ws: manifest)

    return _install


@pytest.fixture
def patch_manifest_missing(monkeypatch: pytest.MonkeyPatch):
    def _raise(_ws: str):
        raise FileNotFoundError("no manifest (longview_v2 case)")

    monkeypatch.setattr("benny.core.workspace.load_manifest", _raise)


def _stub_client_factory(catalog: list, loaded: str | None, health_shape: str = "flat"):
    """httpx.AsyncClient stub: /models returns the catalog, /health the loaded model.

    ``health_shape`` selects how the loaded model is reported:
      * ``flat`` — ``{"model_loaded": <id>}`` (the older probe assumption)
      * ``list`` — ``{"all_models_loaded": [{"model_name": <id>, "type": "llm"}]}``
        which is the shape real lemonade actually returns (A8.3 residual: the
        probe scanned only the flat keys, so this form fell through to roulette)
    """

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
            self.status_code = 200

        def json(self):
            return self._payload

    class _StubClient:
        def __init__(self, *a, **k): ...

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url: str):
            if url.endswith("/models"):
                return _Resp({"data": [{"id": m} for m in catalog]})
            if url.endswith("/health"):
                if loaded is None:
                    raise ConnectionError("no health endpoint")
                if health_shape == "list":
                    return _Resp({"all_models_loaded": [{"model_name": loaded, "type": "llm"}]})
                return _Resp({"model_loaded": loaded})
            raise ConnectionError(f"unexpected url {url}")

    return _StubClient


# ---- run affinity -----------------------------------------------------------


@pytest.mark.asyncio
async def test_affinity_wins_for_unmapped_roles(patch_manifest_missing) -> None:
    """The ingest handler pins the run's model; default-role calls follow it."""
    llm.set_run_model_affinity("run-1", "lemonade/qwen3.5-9b-FLM")
    resolved = await llm.get_active_model("longview_v2", role="default", run_id="run-1")
    assert resolved == "lemonade/qwen3.5-9b-FLM"


@pytest.mark.asyncio
async def test_explicit_role_mapping_beats_affinity(patch_manifest) -> None:
    patch_manifest(_fake_manifest(model_roles={"vision": "lemonade/qwen3vl-it-4b-FLM"}))
    llm.set_run_model_affinity("run-2", "lemonade/qwen3.5-9b-FLM")
    resolved = await llm.get_active_model("ws", role="vision", run_id="run-2")
    assert resolved == "lemonade/qwen3vl-it-4b-FLM"


@pytest.mark.asyncio
async def test_affinity_beats_workspace_default_model(patch_manifest) -> None:
    patch_manifest(_fake_manifest(default_model="lemonade/DeepSeek-Qwen3-8B-GGUF"))
    llm.set_run_model_affinity("run-3", "lemonade/qwen3.5-9b-FLM")
    resolved = await llm.get_active_model("ws", role="default", run_id="run-3")
    assert resolved == "lemonade/qwen3.5-9b-FLM"


# ---- auto-detect: loaded-model preference, loud roulette --------------------


@pytest.mark.asyncio
async def test_autodetect_prefers_loaded_model_over_catalog_order(
    patch_manifest_missing, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Catalog lists DeepSeek first; qwen is loaded — resolution must pick qwen."""
    monkeypatch.setattr(
        "benny.core.models.httpx.AsyncClient",
        _stub_client_factory(
            catalog=["DeepSeek-Qwen3-8B-GGUF", "qwen3.5-9b-FLM"], loaded="qwen3.5-9b-FLM"
        ),
    )
    resolved = await llm.get_active_model("longview_v2", role="default")
    assert resolved.endswith("/qwen3.5-9b-FLM")


@pytest.mark.asyncio
async def test_autodetect_reads_lemonade_list_health_shape(
    patch_manifest_missing, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A8.3: real lemonade reports the loaded model as all_models_loaded[].model_name
    (a list), NOT a flat model_loaded key. The loaded-model preference must read
    that shape — otherwise it falls through to catalog roulette against live lemonade
    (the very swap-thrash A8 exists to prevent). Catalog lists DeepSeek first; qwen
    is loaded and reported only in list form → resolution must still pick qwen."""
    monkeypatch.setattr(
        "benny.core.models.httpx.AsyncClient",
        _stub_client_factory(
            catalog=["DeepSeek-Qwen3-8B-GGUF", "qwen3.5-9b-FLM"],
            loaded="qwen3.5-9b-FLM",
            health_shape="list",
        ),
    )
    resolved = await llm.get_active_model("longview_v2", role="default")
    assert resolved.endswith("/qwen3.5-9b-FLM")


@pytest.mark.asyncio
async def test_catalog_roulette_is_loud_and_sticky(
    patch_manifest_missing, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    """No loaded model detectable: models[0] is allowed but WARN'd, and pinned per run."""
    monkeypatch.setattr(
        "benny.core.models.httpx.AsyncClient",
        _stub_client_factory(catalog=["DeepSeek-Qwen3-8B-GGUF", "qwen3.5-9b-FLM"], loaded=None),
    )
    with caplog.at_level(logging.WARNING, logger="benny.core.models"):
        resolved = await llm.get_active_model("longview_v2", role="default", run_id="run-4")
    assert resolved.endswith("/DeepSeek-Qwen3-8B-GGUF")
    assert any("roulette" in r.message for r in caplog.records)
    # sticky: the same run never re-rolls (and therefore never swaps engines)
    assert llm.get_run_model_affinity("run-4") == resolved
