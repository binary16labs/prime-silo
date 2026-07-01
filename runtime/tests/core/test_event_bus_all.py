"""EventBus global feed (subscribe_all) — the /api/workflows/events fan-in."""

import asyncio
import json

from benny.core.event_bus import event_bus


def test_subscribe_all_receives_events_from_any_run():
    async def scenario():
        stream = event_bus.subscribe_all()
        # Prime the generator up to its wait point, then emit from two runs.
        task = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0)
        event_bus.emit("run-a", "workflow_started", {"workspace": "w1"})
        first = await asyncio.wait_for(task, timeout=2)
        event_bus.emit("run-b", "workflow_completed", {"workspace": "w2"})
        second = await asyncio.wait_for(anext(stream), timeout=2)
        await stream.aclose()
        return first, second

    first, second = asyncio.run(scenario())
    a = json.loads(first.removeprefix("data: "))
    b = json.loads(second.removeprefix("data: "))
    assert a["run_id"] == "run-a" and a["type"] == "workflow_started"
    assert b["run_id"] == "run-b" and b["type"] == "workflow_completed"


def test_subscribe_all_starts_at_now_not_history():
    event_bus.emit("old-run", "workflow_started", {})

    async def scenario():
        stream = event_bus.subscribe_all()
        task = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0)
        event_bus.emit("new-run", "workflow_started", {})
        first = await asyncio.wait_for(task, timeout=2)
        await stream.aclose()
        return first

    first = asyncio.run(scenario())
    assert json.loads(first.removeprefix("data: "))["run_id"] == "new-run"


def test_global_feed_is_bounded():
    for i in range(event_bus.ALL_FEED_MAX + 50):
        event_bus.emit(f"r{i}", "tick", {})
    assert len(event_bus._all_events) <= event_bus.ALL_FEED_MAX
