# Phase 7.1 — Recursive Swarm Logic & Dynamic Tasking

## 1. Objective
Enable the Benny Swarm engine to dynamically expand its plan during execution. If an agent identifies a "Knowledge Pillar" that requires deeper investigation, it can spawn a recursive sub-swarm (up to a depth of 2).

## 2. Architectural Changes

### 2.1 Backend State (`benny/core/state.py`)
- **TaskItem Update**: Add `parent_id` and `depth` to track lineage of sub-tasks.
- **SwarmState Update**: Add `active_task_pool` and `expansion_signals` to handle runtime task addition.

### 2.2 Swarm Logic (`benny/graph/swarm.py`)
- **Discovery Node**: A new node that periodically checks `expansion_signals` and feeds them back to the `Planner`.
- **Adaptive Planner**: Refactored to handle "Incremental Planning" (adding new tasks without resetting the entire wave schedule).

## 3. Implementation Details

### [MODIFY] [benny/core/state.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/state.py)
```python
class TaskItem(TypedDict):
    # ... existing fields ...
    parent_id: Optional[str]           # Link to the task that spawned this sub-task
    depth: int                         # Recursive depth (0 = root)
    assigned_skills: List[str]         # Specific MCP skills allowed for this task
```

### [MODIFY] [benny/graph/swarm.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/graph/swarm.py)
```python
async def expansion_monitor_node(state: SwarmState) -> Dict[str, Any]:
    """Inspects executor results for [[EXPAND]] signals."""
    new_tasks = []
    for result in state['partial_results']:
        if "[[EXPAND]]" in result['content']:
            # Extract sub-task descriptions from content
            # ... logic to parse expansion requests ...
            pass
    return {"expansion_signals": new_tasks}
```

## 4. Acceptance Criteria (BDD)
- **Scenario**: Agent discovers a complex sub-topic.
  - **Given** an executor result contains the string `[[EXPAND]]`.
  - **When** the wave completes.
  - **Then** the `expansion_monitor_node` must identify the signal.
  - **And** the `Planner` must generate new `TaskItems` with `depth = parent.depth + 1`.
  - **And** the `WaveScheduler` must insert these tasks into a new Wave.

## 5. Test Plan (TDD)
- `tests/test_swarm_recursion.py`: 
    - Mock an executor result with an expansion signal.
    - Assert that the total task count in `SwarmState` increases.
    - Assert that recursion stops strictly at `depth = 2`.
