import asyncio
import json
import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict


class EventBus:
    """
    Centralized event bus for real-time workflow execution signals (SSE).
    Allows Studio graphs and Swarm workflows to push events to a unified UI stream.
    """

    _instance = None
    _lock = asyncio.Lock()

    # Global feed kept to this many recent events; subscribers that lag past
    # the window miss events (history belongs to /api/runs, not the bus).
    ALL_FEED_MAX = 500

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(EventBus, cls).__new__(cls)
            cls._instance._events = {}  # run_id -> List[Dict]
            cls._instance._flags = {}  # run_id -> asyncio.Event
            cls._instance._all_events = []  # bounded global feed (all runs)
            cls._instance._all_base = 0  # count of events trimmed off the front
            # Per-subscriber wake events (each created inside the subscriber's
            # own loop — a single shared Event would bind to the first loop).
            cls._instance._all_waiters = set()
        return cls._instance

    def emit(self, run_id: str, event_type: str, data: Dict[str, Any]):
        """Emit an event for a specific run ID."""
        if not run_id:
            return

        if run_id not in self._events:
            self._events[run_id] = []
            self._flags[run_id] = asyncio.Event()
            logging.info(f"[EVENT_BUS] Initialized buffer for run_id: {run_id}")

        event = {
            "type": event_type,
            "timestamp": datetime.now().isoformat(),
            "run_id": run_id,
            **data,
        }

        self._events[run_id].append(event)

        # Mirror into the bounded global feed (the /live/events fan-in).
        self._all_events.append(event)
        overflow = len(self._all_events) - self.ALL_FEED_MAX
        if overflow > 0:
            del self._all_events[:overflow]
            self._all_base += overflow
        for waiter in list(self._all_waiters):
            waiter.set()

        # Signal any waiting consumers
        flag = self._flags.get(run_id)
        if flag:
            flag.set()

        logging.info(
            f"[EVENT_BUS] Event emitted | run_id: {run_id} | type: {event_type} | total_events: {len(self._events[run_id])}"
        )

    async def subscribe(self, run_id: str) -> AsyncGenerator[str, None]:
        """Subscribe to an SSE event stream for a specific run ID."""
        if run_id not in self._events:
            self._events[run_id] = []
            self._flags[run_id] = asyncio.Event()

        last_index = 0
        logging.info(f"[EVENT_BUS] Subscription started for run_id: {run_id}")

        def json_serial(obj):
            """JSON serializer for objects not serializable by default json code"""
            if isinstance(obj, datetime):
                return obj.isoformat()
            if hasattr(obj, "model_dump"):  # Pydantic v2
                return obj.model_dump()
            if hasattr(obj, "dict"):  # Pydantic v1 / other
                return obj.dict()
            try:
                return dict(obj)
            except:
                return str(obj)

        try:
            while True:
                events = self._events.get(run_id, [])

                while last_index < len(events):
                    event = events[last_index]
                    yield f"data: {json.dumps(event, default=json_serial)}\n\n"
                    last_index += 1

                    # Terminate stream on completion
                    if event["type"] in ("workflow_completed", "workflow_failed"):
                        logging.info(f"[EVENT_BUS] Completing stream for run_id: {run_id}")
                        return

                # Wait for next batch of events or heartbeat
                try:
                    flag = self._flags.get(run_id)
                    if flag:
                        await asyncio.wait_for(flag.wait(), timeout=15.0)
                        flag.clear()
                except asyncio.TimeoutError:
                    # Send heartbeat to keep connection alive
                    yield f"data: {json.dumps({'type': 'heartbeat'}, default=json_serial)}\n\n"

        except asyncio.CancelledError:
            logging.info(f"[EVENT_BUS] Subscription cancelled for run_id: {run_id}")
        finally:
            # We don't necessarily want to purge immediately,
            # as there might be multiple subscribers or history lookups.
            # Maintenance should be handled by a separate TTL/cleanup task.
            pass

    async def subscribe_all(self) -> AsyncGenerator[str, None]:
        """Subscribe to the global SSE feed: every event from every run.

        Unlike ``subscribe``, the stream never terminates on run completion —
        it is the app-wide activity feed. Starts at "now" (no history replay;
        past runs come from /api/runs). Heartbeats every 15s keep proxies from
        closing an idle connection.
        """

        def json_serial(obj):
            if isinstance(obj, datetime):
                return obj.isoformat()
            if hasattr(obj, "model_dump"):
                return obj.model_dump()
            if hasattr(obj, "dict"):
                return obj.dict()
            try:
                return dict(obj)
            except Exception:
                return str(obj)

        cursor = self._all_base + len(self._all_events)
        waiter = asyncio.Event()
        self._all_waiters.add(waiter)
        logging.info("[EVENT_BUS] Global subscription started")
        try:
            while True:
                # A subscriber that lagged past the bounded window skips ahead.
                if cursor < self._all_base:
                    cursor = self._all_base
                end = self._all_base + len(self._all_events)
                while cursor < end:
                    event = self._all_events[cursor - self._all_base]
                    yield f"data: {json.dumps(event, default=json_serial)}\n\n"
                    cursor += 1

                try:
                    await asyncio.wait_for(waiter.wait(), timeout=15.0)
                    waiter.clear()
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except asyncio.CancelledError:
            logging.info("[EVENT_BUS] Global subscription cancelled")
        finally:
            self._all_waiters.discard(waiter)

    def clear(self, run_id: str):
        """Manually purge events for a run ID."""
        self._events.pop(run_id, None)
        self._flags.pop(run_id, None)


event_bus = EventBus()
