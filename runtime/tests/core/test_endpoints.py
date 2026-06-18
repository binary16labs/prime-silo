"""Multi-endpoint resolution — round-robin a local provider's call across a pool
of machine endpoints so fanned-out runs parallelize instead of serializing on a
single model server. No pool configured ⇒ the default base_url, unchanged.
"""
from __future__ import annotations

import pytest

from benny.core import endpoints


@pytest.fixture(autouse=True)
def _reset():
    endpoints.reset()
    yield
    endpoints.reset()


def test_no_pool_returns_default():
    assert endpoints.resolve_endpoint("lemonade", "http://127.0.0.1:13305/api/v1", env={}) \
        == "http://127.0.0.1:13305/api/v1"


def test_single_endpoint_pool_via_per_provider_env():
    env = {"BENNY_LEMONADE_ENDPOINTS": "http://ryzen.local:13305/api/v1"}
    assert endpoints.resolve_endpoint("lemonade", "http://default/api/v1", env=env) \
        == "http://ryzen.local:13305/api/v1"


def test_round_robin_across_two_machines():
    env = {"BENNY_LEMONADE_ENDPOINTS":
           "http://ryzen.local:13305/api/v1, http://t480.local:13305/api/v1"}
    picks = [endpoints.resolve_endpoint("lemonade", "http://default/api/v1", env=env)
             for _ in range(4)]
    # Alternates, and covers both endpoints.
    assert picks[0] != picks[1]
    assert set(picks) == {"http://ryzen.local:13305/api/v1", "http://t480.local:13305/api/v1"}
    assert picks[0] == picks[2] and picks[1] == picks[3]


def test_json_form_and_trailing_slash_normalisation():
    env = {"BENNY_MODEL_ENDPOINTS":
           '{"lemonade": ["http://a/api/v1/", "http://b/api/v1"]}'}
    picks = {endpoints.resolve_endpoint("lemonade", "http://default", env=env) for _ in range(6)}
    assert picks == {"http://a/api/v1", "http://b/api/v1"}  # trailing slash trimmed


def test_provider_case_insensitive_and_other_providers_default():
    env = {"BENNY_OLLAMA_ENDPOINTS": "http://x/v1,http://y/v1"}
    # Configured provider pools round-robin…
    assert endpoints.resolve_endpoint("OLLAMA", "http://default", env=env) in {"http://x/v1", "http://y/v1"}
    # …a provider with no pool still gets its default.
    assert endpoints.resolve_endpoint("lemonade", "http://default/api/v1", env=env) == "http://default/api/v1"


def test_malformed_json_is_ignored():
    env = {"BENNY_MODEL_ENDPOINTS": "{not valid json"}
    assert endpoints.resolve_endpoint("lemonade", "http://default/api/v1", env=env) \
        == "http://default/api/v1"
