import threading
import json
import uuid
from typing import Dict, Optional, List, Any
from datetime import datetime
from pathlib import Path

from .schema import Task, TaskStatus
from .workspace import get_workspace_path
from ..governance.audit import emit_governance_event
from .event_bus import event_bus
from ..governance.lineage import track_aer

class TaskManager:
    """
    Central registry for background tasks with persistence.
    """
    def __init__(self):
        self._tasks: Dict[str, Task] = {}
        self._lock = threading.Lock()

    def create_task(self, workspace: str, task_type: str, task_id: Optional[str] = None) -> Task:
        """Create and register a new task."""
        tid = task_id or str(uuid.uuid4())
        task = Task(
            task_id=tid,
            workspace=workspace,
            type=task_type,
            status=TaskStatus.RUNNING,
            created_at=datetime.now().isoformat(),
            updated_at=datetime.now().isoformat()
        )
        with self._lock:
            self._tasks[tid] = task
        self.save_task(task)
        return task

    def update_task(self, task_id: str, **kwargs) -> Optional[Task]:
        """Update an existing task in-memory and on disk."""
        with self._lock:
            if task_id not in self._tasks:
                return None
            
            task = self._tasks[task_id]
            for key, value in kwargs.items():
                if hasattr(task, key):
                    # Handle Pydantic model attribute updates
                    if key == "aer_log" and isinstance(value, list):
                        task.aer_log.extend(value)
                    elif key == "event_log" and isinstance(value, list):
                        task.event_log.extend(value)
                    elif key == "status":
                        setattr(task, key, TaskStatus(value))
                    else:
                        setattr(task, key, value)
            
            task.updated_at = datetime.now().isoformat()
            self.save_task(task)
            return task

    def update_task_topology(self, task_id: str, topology: Dict[str, Any]):
        """Register the 3D graph structure for a run."""
        self.update_task(task_id, topology=topology)
        event_bus.emit(task_id, "topology_updated", topology)

    def add_aer_entry(self, task_id: str, intent: str, observation: str, inference: str = "", plan: str = "", nodeId: Optional[str] = None, type: str = "think"):
        """Helper to add a structured Agent Execution Record entry."""
        entry = {
            "timestamp": datetime.now().isoformat(),
            "intent": intent,
            "observation": observation,
            "inference": inference,
            "plan": plan,
            "type": type
        }
        self.update_task(task_id, aer_log=[entry])
        
        # Also mirror as a progress event to EventBus for real-time UI logs
        event_bus.emit(task_id, "node_progress", {
            "nodeId": nodeId or "task_manager",
            "message": intent,
            "inference": inference,
            "reasoning": entry,
            "type": type,
            "data": entry
        })

        # NEW: Log to OpenLineage for formal audit trail
        try:
            with self._lock:
                task = self._tasks.get(task_id)
                workspace = task.workspace if task else "default"
            
            track_aer(
                run_id=task_id,
                job_name=f"agent_reasoning_{task_id}",
                workspace=workspace,
                intent=intent,
                observation=observation,
                inference=inference,
                plan=plan
            )
        except Exception as e:
            # Don't let lineage failures crash the task
            print(f"[WARNING] Failed to track AER in lineage: {e}")

    def add_tool_event(self, task_id: str, tool_name: str, args: Dict[str, Any], result: Any, nodeId: str = "executor"):
        """Record a tool invocation event."""
        data = {
            "tool_name": tool_name,
            "args": args,
            "result": str(result)[:1000],  # Truncate large results
            "nodeId": nodeId,
            "timestamp": datetime.now().isoformat()
        }
        self.add_event(task_id, "tool_used", data)
        # Also add as a thinking step for node-level visibility
        self.add_aer_entry(
            task_id,
            intent=f"Using tool: {tool_name}",
            observation=f"Args: {json.dumps(args)}",
            inference=f"Result: {str(result)[:500]}...",
            nodeId=nodeId,
            type="tool"
        )

    def add_event(self, task_id: str, event_type: str, data: Dict[str, Any]):
        """Record an SSE event into the persistent task log and emit to EventBus."""
        if "nodeId" not in data:
            data["nodeId"] = "task_manager"
            
        entry = {
            "timestamp": datetime.now().isoformat(),
            "type": event_type,
            "data": data
        }
        self.update_task(task_id, event_log=[entry])
        event_bus.emit(task_id, event_type, data)

    def add_v2_telemetry(self, task_id: str, node_id: str, telemetry: Dict[str, Any]):
        """Emit high-frequency telemetry for V2 God-Mode visuals."""
        telemetry["nodeId"] = node_id
        telemetry["timestamp"] = datetime.now().isoformat()
        event_bus.emit(task_id, "v2_telemetry", telemetry)

    def get_task(self, task_id: str) -> Optional[Task]:
        """Retrieve a task by ID."""
        with self._lock:
            return self._tasks.get(task_id)

    def list_tasks(self, workspace: Optional[str] = None) -> List[Task]:
        """List all tasks, optionally filtered by workspace."""
        with self._lock:
            if workspace:
                return [t for t in self._tasks.values() if t.workspace == workspace]
            return list(self._tasks.values())

    def save_task(self, task: Task):
        """Persist task to workspace/runs/task_registry.json"""
        try:
            runs_dir = get_workspace_path(task.workspace, "runs")
            runs_dir.mkdir(parents=True, exist_ok=True)
            registry_path = runs_dir / "task_registry.json"
            
            # Load existing
            registry = {}
            if registry_path.exists():
                try:
                    with open(registry_path, "r", encoding="utf-8") as f:
                        registry = json.load(f)
                except json.JSONDecodeError:
                    registry = {}
            
            # Update
            registry[task.task_id] = task.model_dump()
            
            # Save
            with open(registry_path, "w", encoding="utf-8") as f:
                json.dump(registry, f, indent=2)

            # Local Governance Audit
            emit_governance_event(
                event_type="TASK_METADATA_UPDATE",
                data=task.model_dump(),
                workspace_id=task.workspace
            )
        except Exception as e:
            # We don't want task saving to crash the main process
            print(f"[ERROR] TaskManager persistence failed for {task.task_id}: {e}")

# Global instance
task_manager = TaskManager()
