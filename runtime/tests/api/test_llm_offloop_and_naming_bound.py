"""T-029: model calls never run on the event loop; clustering names a bounded set of communities.

Found live 2026-11-22: litellm.completion (sync) ran straight inside async call_model, so every
model call froze the API; clustering then named thousands of communities at once and /api/health
refused connections for an hour, failing every LONGVIEW code scan.
"""

import asyncio
import threading
import time

import pytest

from benny.core import models
from benny.graph import clustering_service as cs


def test_completion_runs_in_a_worker_thread_and_the_loop_keeps_ticking(monkeypatch):
    loop_thread = {}
    seen = {}

    def slow_completion(**kwargs):
        seen["thread"] = threading.get_ident()
        time.sleep(0.6)  # a blocking model call
        return "ok"

    monkeypatch.setattr(models, "_run_completion", slow_completion)

    async def main():
        loop_thread["id"] = threading.get_ident()
        ticks = 0

        async def heartbeat():
            nonlocal ticks
            for _ in range(10):
                await asyncio.sleep(0.05)
                ticks += 1

        result, _ = await asyncio.gather(models._complete_off_loop(model="x"), heartbeat())
        return result, ticks

    result, ticks = asyncio.run(main())
    assert result == "ok"
    assert seen["thread"] != loop_thread["id"], "the blocking call ran on the event loop thread"
    assert ticks >= 8, f"the event loop was frozen during the model call (ticks={ticks})"


def test_a_patched_async_completion_is_still_awaited(monkeypatch):
    async def async_completion(**kwargs):
        return "async-ok"

    monkeypatch.setattr(models, "_run_completion", async_completion)
    assert asyncio.run(models._complete_off_loop(model="x")) == "async-ok"


def test_call_model_uses_the_off_loop_path():
    import inspect

    src = inspect.getsource(models.call_model)
    assert "_complete_off_loop(" in src
    assert "_await_if_needed(_run_completion(" not in src


def test_naming_takes_only_the_largest_communities():
    members = {
        1: ["a", "b"],  # too small
        2: ["a"] * 10,
        3: ["a"] * 3,
        4: ["a"] * 50,
        5: ["a"] * 10,
    }
    chosen = cs.communities_to_name(members, 2)
    assert [c for c, _ in chosen] == [4, 2]  # largest first, tie broken by id
    assert [c for c, _ in cs.communities_to_name(members, 99)] == [4, 2, 5, 3]
    assert cs.communities_to_name(members, 0) == []


@pytest.mark.parametrize("raw,want", [(None, 40), ("0", 0), ("7", 7), ("-3", 0), ("lots", 40)])
def test_naming_limit_env(raw, want):
    env = {} if raw is None else {"BENNY_COMMUNITY_NAMING_MAX": raw}
    assert cs.naming_limit(env) == want


def test_naming_is_sequential_and_bounded():
    import inspect

    src = inspect.getsource(cs.ClusteringService.run_lpa_on_workspace)
    assert "communities_to_name(" in src and "Semaphore(1)" in src
    assert "for c_id, members in community_members.items()\n            if len(members) >= 3" not in src
