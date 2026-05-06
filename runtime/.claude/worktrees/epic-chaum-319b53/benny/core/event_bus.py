import asyncio
import logging
import json
from datetime import datetime
from typing import Dict, List, Any, AsyncGenerator, Optional

class EventBus:
    """
    Centralized event bus for real-time workflow execution signals (SSE).
    Allows Studio graphs and Swarm workflows to push events to a unified UI stream.
    """
    _instance = None
    _lock = asyncio.Lock()

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(EventBus, cls).__new__(cls)
            cls._instance._events = {} # run_id -> List[Dict]
            cls._instance._flags = {}  # run_id -> asyncio.Event
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
        
        # Signal any waiting consumers
        flag = self._flags.get(run_id)
        if flag:
            flag.set()
        
        logging.info(f"[EVENT_BUS] Event emitted | run_id: {run_id} | type: {event_type} | total_events: {len(self._events[run_id])}")

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
            if hasattr(obj, "model_dump"): # Pydantic v2
                return obj.model_dump()
            if hasattr(obj, "dict"): # Pydantic v1 / other
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

    def clear(self, run_id: str):
        """Manually purge events for a run ID."""
        self._events.pop(run_id, None)
        self._flags.pop(run_id, None)

event_bus = EventBus()
