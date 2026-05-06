# Phase 2 — Wave-Based Swarm Orchestration

> **Owner**: Implementation Agent  
> **PRD Reference**: `C:\Users\nsdha\OneDrive\code\benny\docs\requirements\5\PRD_dog_pound.txt`  
> **Parent Plan**: `C:\Users\nsdha\.gemini\antigravity\brain\fd945150-1e44-4e58-baa2-97d8004a2eb2\implementation_plan.md`  
> **Priority**: Core Architecture — highest visible impact  
> **Estimated Scope**: 2 new backend files, 1 new frontend component, 4 modified backend files, 3 modified frontend files

---

## 1. Objective

Upgrade the existing linear Planner → Dispatcher → Executor swarm pipeline into a **wave-based, dependency-aware execution engine** as specified in the PRD section "Swarm Orchestration and Wave-Based Execution" (Table 1). Tasks must be organized into dependency waves, dispatched in parallel within each wave, and include context handover between waves, conflict avoidance, and a post-execution review cycle.

---

## 2. Current State (READ THESE FILES FIRST)

| File | Purpose | Why You Need It |
|------|---------|-----------------|
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\state.py` | `SwarmState`, `TaskItem`, `PartialResult`, `create_swarm_state()` | You will EXTEND these TypedDicts with new fields |
| `C:\Users\nsdha\OneDrive\code\benny\benny\graph\swarm.py` | Current swarm graph (planner, orchestrator, dispatcher, executor, aggregator) | You will REFACTOR this significantly |
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\workflow_routes.py` | `_execute_swarm_async()` and swarm execution tracking | You will modify the execution flow |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\SwarmStatePanel.tsx` | Current swarm state display | You will integrate the WaveTimeline |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ExecutionBar.tsx` | Swarm execute button and canvas visualization | You will update the swarm visualization |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\hooks\useWorkflowStore.ts` | Zustand store for workflow state | Reference for state patterns |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\models.py` | `MODEL_REGISTRY` and `call_model()` | For role-based model assignment |

---

## 3. Files to Create or Modify

### 3.1 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\core\state.py`

#### 3.1.1 Extend `TaskItem` TypedDict

Add these fields to the EXISTING `TaskItem` class. Do NOT remove any existing fields:

```python
class TaskItem(TypedDict):
    """Individual task in the swarm plan"""
    task_id: str
    description: str
    status: str  # pending, running, completed, failed
    skill_hint: Optional[str]  # Suggested skill from benny/skills/
    # === NEW FIELDS BELOW ===
    wave: int                          # Wave assignment (0-indexed), set by wave_scheduler
    dependencies: List[str]            # List of task_ids this task depends on
    assigned_model: Optional[str]      # Role-specific model (e.g., deep reasoning vs fast)
    files_touched: List[str]           # Files this task will read/write (for conflict avoidance)
    estimated_tokens: Optional[int]    # Estimated token cost for this task
```

#### 3.1.2 Extend `SwarmState` TypedDict

Add these fields to the EXISTING `SwarmState` class. Do NOT remove any existing fields:

```python
class SwarmState(TypedDict):
    # ... ALL existing fields remain ...
    
    # === NEW FIELDS BELOW ===
    dependency_graph: Dict[str, List[str]]       # task_id → [dependency_task_ids]
    waves: List[List[str]]                        # Computed wave schedule: [[task_ids in wave 0], [wave 1], ...]
    current_wave: int                             # Index of currently executing wave
    wave_results: Dict[str, List[PartialResult]]  # Results grouped by wave index (str key for TypedDict compat)
    context_handover: Dict[str, Any]              # Accumulated state delta passed between waves
    review_pass_results: List[Dict[str, Any]]     # Findings from the post-execution review subagent
    ascii_dag: Optional[str]                      # ASCII visualization of the dependency graph
```

#### 3.1.3 Update `create_swarm_state()` factory

Add default values for all new fields:

```python
def create_swarm_state(
    execution_id: str,
    workspace: str = "default",
    original_request: str = "",
    model: str = "ollama/llama3.2",
    max_concurrency: int = 1
) -> SwarmState:
    """Create initial state for a new swarm workflow execution"""
    return SwarmState(
        # ... ALL existing field defaults remain ...
        # === NEW FIELD DEFAULTS ===
        dependency_graph={},
        waves=[],
        current_wave=0,
        wave_results={},
        context_handover={},
        review_pass_results=[],
        ascii_dag=None,
    )
```

---

### 3.2 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\graph\wave_scheduler.py`

This is a dedicated module for dependency-aware wave computation. It has NO LLM calls — it is pure algorithmic logic.

```python
"""
Wave Scheduler — Dependency-aware task scheduling for Swarm execution.

Computes execution waves using topological layering.
Each wave contains tasks whose dependencies are ALL satisfied by previous waves.
"""

from __future__ import annotations

import logging
from typing import List, Dict, Tuple, Optional, Set
from collections import defaultdict, deque

logger = logging.getLogger(__name__)


class CircularDependencyError(Exception):
    """Raised when the dependency graph contains cycles."""
    pass


class FileConflict:
    """Represents a file write conflict between two tasks in the same wave."""
    def __init__(self, file_path: str, task_a: str, task_b: str, wave: int):
        self.file_path = file_path
        self.task_a = task_a
        self.task_b = task_b
        self.wave = wave
    
    def __repr__(self):
        return f"FileConflict(file={self.file_path}, tasks=[{self.task_a}, {self.task_b}], wave={self.wave})"


def compute_waves(
    tasks: List[Dict],
    dependency_graph: Dict[str, List[str]]
) -> List[List[str]]:
    """
    Compute execution waves from a dependency graph using topological layering.
    
    Algorithm (Kahn's algorithm modified for layer extraction):
    1. Compute in-degree for each task
    2. All tasks with in-degree 0 form wave 0
    3. Remove wave 0 tasks, decrement in-degrees of their dependents
    4. Repeat: tasks with in-degree 0 after removal form the next wave
    5. Continue until all tasks are assigned to a wave
    
    Args:
        tasks: List of TaskItem dicts, each must have 'task_id'
        dependency_graph: Map of task_id → [list of task_ids it depends on]
    
    Returns:
        List of waves, where each wave is a list of task_ids
    
    Raises:
        CircularDependencyError: If the dependency graph contains cycles
    """
    task_ids = {t["task_id"] for t in tasks}
    
    # Validate all dependencies reference existing tasks
    for task_id, deps in dependency_graph.items():
        for dep in deps:
            if dep not in task_ids:
                logger.warning("Dependency '%s' for task '%s' does not exist, ignoring", dep, task_id)
    
    # Build adjacency list (reverse: what depends on me?)
    dependents: Dict[str, List[str]] = defaultdict(list)
    in_degree: Dict[str, int] = {t["task_id"]: 0 for t in tasks}
    
    for task_id, deps in dependency_graph.items():
        valid_deps = [d for d in deps if d in task_ids]
        in_degree[task_id] = len(valid_deps)
        for dep in valid_deps:
            dependents[dep].append(task_id)
    
    waves: List[List[str]] = []
    remaining = set(task_ids)
    
    while remaining:
        # Find all tasks with in-degree 0 (no unmet dependencies)
        current_wave = [tid for tid in remaining if in_degree.get(tid, 0) == 0]
        
        if not current_wave:
            # Remaining tasks all have dependencies that can't be met → cycle
            raise CircularDependencyError(
                f"Circular dependency detected. Remaining tasks: {remaining}"
            )
        
        waves.append(sorted(current_wave))  # Sort for deterministic ordering
        
        # Remove current wave tasks and decrement in-degrees
        for tid in current_wave:
            remaining.discard(tid)
            for dependent in dependents.get(tid, []):
                in_degree[dependent] -= 1
    
    return waves


def detect_conflicts(
    wave: List[str],
    file_assignments: Dict[str, List[str]]
) -> List[FileConflict]:
    """
    Detect file write conflicts within a single wave.
    
    Two tasks in the same wave MUST NOT write to the same file.
    
    Args:
        wave: List of task_ids in this wave
        file_assignments: Map of task_id → [list of file paths this task touches]
    
    Returns:
        List of FileConflict objects (empty if no conflicts)
    """
    conflicts: List[FileConflict] = []
    file_to_tasks: Dict[str, List[str]] = defaultdict(list)
    
    for task_id in wave:
        for file_path in file_assignments.get(task_id, []):
            file_to_tasks[file_path].append(task_id)
    
    for file_path, task_ids in file_to_tasks.items():
        if len(task_ids) > 1:
            # Create conflict for each pair
            for i in range(len(task_ids)):
                for j in range(i + 1, len(task_ids)):
                    conflicts.append(FileConflict(
                        file_path=file_path,
                        task_a=task_ids[i],
                        task_b=task_ids[j],
                        wave=0,  # Caller should set the actual wave index
                    ))
    
    return conflicts


def resolve_conflicts(
    waves: List[List[str]],
    file_assignments: Dict[str, List[str]]
) -> List[List[str]]:
    """
    Resolve file conflicts by bumping conflicting tasks to a later wave.
    
    Strategy: For each conflict, move the later-listed task to the next wave.
    This may cascade, so we iterate until no conflicts remain.
    
    Args:
        waves: Current wave assignment
        file_assignments: Map of task_id → [file paths]
    
    Returns:
        Conflict-free wave assignment (may have more waves than input)
    """
    max_iterations = 100  # Safety valve
    iteration = 0
    
    while iteration < max_iterations:
        iteration += 1
        found_conflict = False
        
        for wave_idx, wave in enumerate(waves):
            conflicts = detect_conflicts(wave, file_assignments)
            if conflicts:
                found_conflict = True
                # Move the second task in each conflict to the next wave
                for conflict in conflicts:
                    task_to_move = conflict.task_b
                    waves[wave_idx] = [t for t in waves[wave_idx] if t != task_to_move]
                    
                    # Ensure next wave exists
                    if wave_idx + 1 >= len(waves):
                        waves.append([])
                    waves[wave_idx + 1].append(task_to_move)
                break  # Re-check from the beginning after modification
        
        if not found_conflict:
            break
    
    # Remove any empty waves created during resolution
    return [w for w in waves if w]


def generate_ascii_dag(
    tasks: List[Dict],
    dependency_graph: Dict[str, List[str]],
    waves: List[List[str]]
) -> str:
    """
    Generate an ASCII visualization of the dependency DAG with wave assignments.
    
    Output format:
    ```
    Wave 0: [task_1] [task_2]
       │         │
       ▼         ▼
    Wave 1: [task_3]
       │
       ▼
    Wave 2: [task_4] [task_5]
    ```
    
    Args:
        tasks: List of TaskItem dicts
        dependency_graph: task_id → [dependency_ids]
        waves: Computed wave schedule
    
    Returns:
        ASCII string visualization
    """
    task_names = {t["task_id"]: t.get("description", t["task_id"])[:30] for t in tasks}
    
    lines = []
    lines.append("═══ DEPENDENCY GRAPH ═══")
    lines.append("")
    
    for wave_idx, wave in enumerate(waves):
        # Wave header
        task_labels = [f"[{tid}: {task_names.get(tid, tid)}]" for tid in wave]
        wave_line = f"  Wave {wave_idx}: " + "  ".join(task_labels)
        lines.append(wave_line)
        
        # Show arrows to next wave
        if wave_idx < len(waves) - 1:
            next_wave = waves[wave_idx + 1]
            arrows = []
            for next_tid in next_wave:
                deps = dependency_graph.get(next_tid, [])
                sources = [d for d in deps if d in wave]
                if sources:
                    arrows.append(f"    {', '.join(sources)} ──▶ {next_tid}")
            if arrows:
                lines.extend(arrows)
            else:
                lines.append("    │")
                lines.append("    ▼")
        
        lines.append("")
    
    lines.append(f"═══ {len(waves)} waves, {sum(len(w) for w in waves)} tasks ═══")
    return "\n".join(lines)


def assign_models(
    tasks: List[Dict],
    model_registry: Dict[str, Dict]
) -> Dict[str, str]:
    """
    Assign optimal models to tasks based on their role/complexity.
    
    Heuristic:
    - Tasks with "plan", "analyze", "architect" in description → reasoning model
    - Tasks with "write", "generate", "create" → writing model
    - Tasks with "search", "find", "explore" → fast model
    - All others → default model
    
    Args:
        tasks: List of TaskItem dicts
        model_registry: From core.models.MODEL_REGISTRY
    
    Returns:
        Map of task_id → model string
    """
    assignment: Dict[str, str] = {}
    
    reasoning_keywords = {"plan", "analyze", "architect", "design", "evaluate", "review", "assess"}
    writing_keywords = {"write", "generate", "create", "compose", "draft", "document"}
    fast_keywords = {"search", "find", "explore", "list", "check", "verify"}
    
    for task in tasks:
        desc_lower = task.get("description", "").lower()
        words = set(desc_lower.split())
        
        if words & reasoning_keywords:
            assignment[task["task_id"]] = model_registry.get("reasoning", {}).get("model", "gpt-4-turbo")
        elif words & writing_keywords:
            assignment[task["task_id"]] = model_registry.get("writing", {}).get("model", "claude-3-sonnet-20240229")
        elif words & fast_keywords:
            assignment[task["task_id"]] = model_registry.get("fast", {}).get("model", "gpt-3.5-turbo")
        else:
            # Default to the swarm's configured model
            assignment[task["task_id"]] = task.get("assigned_model") or "Qwen3-8B-Hybrid"
    
    return assignment
```

---

### 3.3 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\graph\swarm.py`

This is a MAJOR refactor. The high-level graph structure changes from:

**BEFORE**: `START → planner → orchestrator → dispatcher → executor → aggregator → END`

**AFTER**: `START → planner → wave_scheduler → orchestrator → [wave_dispatcher → executor → wave_aggregator → context_handover → (loop if more waves)] → review → final_aggregator → END`

#### 3.3.1 Add Imports (at top, after existing imports)

```python
from .wave_scheduler import (
    compute_waves,
    detect_conflicts,
    resolve_conflicts,
    generate_ascii_dag,
    assign_models,
    CircularDependencyError,
)
from ..core.models import MODEL_REGISTRY
```

#### 3.3.2 Enhanced `planner_node`

Replace the existing `planner_node` function. The NEW version must:

1. Keep the same LLM call structure (system prompt + user prompt + JSON parsing)
2. Change the output JSON format to include dependencies:

```python
# The system prompt must request this output format:
"""
OUTPUT FORMAT (JSON only, no markdown):
{
    "tasks": [
        {
            "task_id": "1",
            "description": "Task description",
            "skill_hint": "skill_name or null",
            "dependencies": [],
            "files_touched": ["output.md"],
            "complexity": "high|medium|low"
        }
    ]
}

Rules:
1. Each task MUST have a unique task_id (use simple integers: "1", "2", "3")
2. dependencies is a list of task_ids that MUST complete before this task starts
3. Tasks with no dependencies should have an empty list []
4. files_touched lists any files this task will create or modify
5. complexity helps assign the right model: "high" for analysis, "medium" for writing, "low" for lookups
"""
```

3. Parse the response and populate the new `TaskItem` fields:
   - `wave`: initially 0 (will be set by wave_scheduler)
   - `dependencies`: from the LLM response
   - `files_touched`: from the LLM response
   - `assigned_model`: based on complexity (use `assign_models()`)

4. Build the `dependency_graph` dict from the parsed tasks

5. Return:
```python
return {
    "plan": tasks,
    "dependency_graph": dependency_graph,
    "status": "planning",
    "revision_count": state.get("revision_count", 0) + 1,
}
```

#### 3.3.3 New `wave_scheduler_node`

```python
def wave_scheduler_node(state: SwarmState) -> Dict[str, Any]:
    """
    Compute execution waves from the dependency graph.
    Validates no circular dependencies and resolves file conflicts.
    """
    plan = state.get("plan", [])
    dependency_graph = state.get("dependency_graph", {})
    
    if not plan:
        return {"status": "failed", "errors": ["No plan to schedule"]}
    
    try:
        # Step 1: Compute waves from dependencies
        waves = compute_waves(plan, dependency_graph)
        
        # Step 2: Check for file conflicts within each wave
        file_assignments = {
            t["task_id"]: t.get("files_touched", []) for t in plan
        }
        waves = resolve_conflicts(waves, file_assignments)
        
        # Step 3: Update task wave assignments
        task_wave_map = {}
        for wave_idx, wave in enumerate(waves):
            for task_id in wave:
                task_wave_map[task_id] = wave_idx
        
        updated_plan = []
        for task in plan:
            task_copy = dict(task)
            task_copy["wave"] = task_wave_map.get(task["task_id"], 0)
            updated_plan.append(task_copy)
        
        # Step 4: Generate ASCII DAG
        ascii_dag = generate_ascii_dag(plan, dependency_graph, waves)
        
        # Step 5: Assign models based on task complexity
        model_assignments = assign_models(plan, MODEL_REGISTRY)
        for task in updated_plan:
            if task["task_id"] in model_assignments:
                task["assigned_model"] = model_assignments[task["task_id"]]
        
        return {
            "plan": updated_plan,
            "waves": waves,
            "current_wave": 0,
            "ascii_dag": ascii_dag,
            "status": "scheduled",
        }
    
    except CircularDependencyError as e:
        return {
            "status": "failed",
            "errors": [f"Circular dependency: {str(e)}"],
        }
```

#### 3.3.4 Refactored `dispatcher_node`

The dispatcher now sends ONLY the current wave's tasks:

```python
def dispatcher_node(state: SwarmState) -> List[Send]:
    """Dispatches only the current wave's tasks for parallel execution."""
    waves = state.get("waves", [])
    current_wave = state.get("current_wave", 0)
    plan = state.get("plan", [])
    
    if current_wave >= len(waves):
        return []  # No more waves
    
    current_wave_task_ids = set(waves[current_wave])
    wave_tasks = [t for t in plan if t["task_id"] in current_wave_task_ids]
    
    sends = []
    for task in wave_tasks:
        sends.append(Send("executor", {
            "task": task,
            "execution_id": state.get("execution_id", ""),
            "workspace": state.get("workspace", "default"),
            "model": task.get("assigned_model") or state.get("model", "ollama/llama3.2"),
            "context_handover": state.get("context_handover", {}),
        }))
    
    return sends
```

#### 3.3.5 Modify `executor_node`

The existing executor is mostly fine. Add one change: if `context_handover` is present in the input state, include it in the system prompt so the executor has context from previous waves:

```python
# After building system_prompt, BEFORE the LLM call, add:
context_handover = state.get("context_handover", {})
if context_handover:
    handover_summary = "\n".join([f"- {k}: {v}" for k, v in context_handover.items()])
    system_prompt += f"\n\nCONTEXT FROM PREVIOUS WAVES:\n{handover_summary}"
```

#### 3.3.6 New `context_handover_node`

```python
async def context_handover_node(state: SwarmState) -> Dict[str, Any]:
    """
    After a wave completes, summarize the delta state for the next wave.
    Trims full outputs to maintain context window budget.
    """
    partial_results = state.get("partial_results", [])
    current_wave = state.get("current_wave", 0)
    waves = state.get("waves", [])
    plan = state.get("plan", [])
    
    # Collect results from the current wave
    current_wave_task_ids = set(waves[current_wave]) if current_wave < len(waves) else set()
    wave_results = [r for r in partial_results if r.get("task_id") in current_wave_task_ids]
    
    # Build handover summary (trimmed to 500 chars per task max)
    handover = dict(state.get("context_handover", {}))
    for result in wave_results:
        task = next((t for t in plan if t["task_id"] == result["task_id"]), None)
        if task and result.get("content"):
            # Trim to 500 chars to prevent context bloat
            summary = result["content"][:500]
            if len(result["content"]) > 500:
                summary += "... [truncated]"
            handover[f"wave_{current_wave}_{result['task_id']}"] = summary
    
    # Store wave results
    wave_results_map = dict(state.get("wave_results", {}))
    wave_results_map[str(current_wave)] = wave_results
    
    # Advance to next wave
    next_wave = current_wave + 1
    has_more_waves = next_wave < len(waves)
    
    return {
        "context_handover": handover,
        "wave_results": wave_results_map,
        "current_wave": next_wave,
        "status": "executing" if has_more_waves else "aggregating",
    }
```

#### 3.3.7 New `review_node`

```python
async def review_node(state: SwarmState) -> Dict[str, Any]:
    """
    Post-execution review subagent pass.
    Validates execution quality and identifies gaps.
    """
    partial_results = state.get("partial_results", [])
    plan = state.get("plan", [])
    model = state.get("model", "ollama/llama3.2")
    
    review_findings = []
    
    # Check 1: All tasks have results
    result_task_ids = {r["task_id"] for r in partial_results}
    plan_task_ids = {t["task_id"] for t in plan}
    missing = plan_task_ids - result_task_ids
    if missing:
        review_findings.append({
            "type": "missing_results",
            "severity": "high",
            "message": f"Tasks without results: {', '.join(missing)}",
        })
    
    # Check 2: Error rate
    errors = [r for r in partial_results if r.get("error")]
    if errors:
        error_rate = len(errors) / len(partial_results) if partial_results else 0
        review_findings.append({
            "type": "error_rate",
            "severity": "high" if error_rate > 0.5 else "medium",
            "message": f"{len(errors)}/{len(partial_results)} tasks failed ({error_rate:.0%} error rate)",
        })
    
    # Check 3: Dependency satisfaction
    dependency_graph = state.get("dependency_graph", {})
    for task in plan:
        deps = dependency_graph.get(task["task_id"], [])
        for dep in deps:
            dep_result = next((r for r in partial_results if r["task_id"] == dep), None)
            if dep_result and dep_result.get("error"):
                review_findings.append({
                    "type": "broken_dependency",
                    "severity": "high",
                    "message": f"Task '{task['task_id']}' depends on failed task '{dep}'",
                })
    
    return {
        "review_pass_results": review_findings,
    }
```

#### 3.3.8 Updated `build_swarm_graph()`

```python
def build_swarm_graph(checkpointer=None) -> StateGraph:
    """Build the wave-based Swarm workflow graph."""
    
    graph = StateGraph(SwarmState)
    
    # Add nodes
    graph.add_node("planner", planner_node)
    graph.add_node("wave_scheduler", wave_scheduler_node)
    graph.add_node("orchestrator", orchestrator_node)
    graph.add_node("dispatcher", dispatcher_node)
    graph.add_node("executor", executor_node)
    graph.add_node("context_handover", context_handover_node)
    graph.add_node("review", review_node)
    graph.add_node("aggregator", aggregator_node)
    
    # Flow: START → planner → wave_scheduler → orchestrator
    graph.add_edge(START, "planner")
    graph.add_edge("planner", "wave_scheduler")
    graph.add_edge("wave_scheduler", "orchestrator")
    
    # Orchestrator uses Command for routing (existing pattern)
    # dispatcher → executor → context_handover
    graph.add_edge("dispatcher", "executor")
    graph.add_edge("executor", "context_handover")
    
    # context_handover decides: more waves → dispatcher, OR done → review
    def after_wave(state: SwarmState) -> str:
        current_wave = state.get("current_wave", 0)
        waves = state.get("waves", [])
        if current_wave < len(waves):
            return "dispatcher"
        return "review"
    
    graph.add_conditional_edges("context_handover", after_wave, {
        "dispatcher": "dispatcher",
        "review": "review",
    })
    
    graph.add_edge("review", "aggregator")
    graph.add_edge("aggregator", END)
    
    if checkpointer:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()
```

#### 3.3.9 Modify `orchestrator_node`

Update to route to `"dispatcher"` (unchanged) but also validate the wave schedule:

```python
def orchestrator_node(state: SwarmState) -> Command:
    """Reviews plan and wave schedule, then routes to dispatcher."""
    plan = state.get("plan", [])
    waves = state.get("waves", [])
    revision_count = state.get("revision_count", 0)
    
    if not plan:
        return Command(update={"status": "failed", "errors": ["No plan generated"]}, goto=END)
    
    if not waves:
        return Command(update={"status": "failed", "errors": ["No waves computed"]}, goto=END)
    
    if len(plan) <= 10 and revision_count < 3:
        return Command(
            update={"plan_approved": True, "status": "executing"},
            goto="dispatcher"
        )
    
    if revision_count >= 3:
        return Command(
            update={"plan_approved": True, "status": "executing", "errors": ["Plan approved after max revisions"]},
            goto="dispatcher"
        )
    
    return Command(
        update={"errors": ["Plan has too many tasks, requesting simplification"]},
        goto="planner"
    )
```

---

### 3.4 [NEW] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WaveTimeline.tsx`

```tsx
import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Loader, Clock, ArrowRight } from 'lucide-react';

interface WaveTask {
  task_id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  wave: number;
  assigned_model?: string;
}

interface WaveTimelineProps {
  waves: string[][];           // Array of waves, each containing task_ids
  tasks: WaveTask[];           // All tasks with their current status
  currentWave: number;         // Currently executing wave index
  reviewFindings?: Array<{     // Post-execution review results
    type: string;
    severity: string;
    message: string;
  }>;
  asciiDag?: string;           // ASCII dependency visualization
}

export default function WaveTimeline({ waves, tasks, currentWave, reviewFindings, asciiDag }: WaveTimelineProps) {
  const [showDag, setShowDag] = useState(false);

  const getTaskById = (id: string) => tasks.find(t => t.task_id === id);
  
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle size={14} style={{ color: 'var(--accent-success)' }} />;
      case 'failed': return <XCircle size={14} style={{ color: 'var(--accent-error)' }} />;
      case 'running': return <Loader size={14} className="animate-spin" style={{ color: 'var(--primary)' }} />;
      default: return <Clock size={14} style={{ color: 'var(--text-tertiary)' }} />;
    }
  };

  const getWaveStatus = (waveIdx: number): string => {
    if (waveIdx > currentWave) return 'pending';
    if (waveIdx < currentWave) return 'completed';
    return 'running';
  };

  if (!waves || waves.length === 0) {
    return (
      <div style={{ padding: '16px', color: 'var(--text-tertiary)', fontSize: '13px', textAlign: 'center' }}>
        No wave data available
      </div>
    );
  }

  return (
    <div className="wave-timeline" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', margin: 0 }}>
          ⚡ Wave Execution ({waves.length} waves, {tasks.length} tasks)
        </h3>
        {asciiDag && (
          <button 
            className="btn-ghost" 
            onClick={() => setShowDag(!showDag)}
            style={{ fontSize: '11px', padding: '4px 8px' }}
          >
            {showDag ? 'Hide' : 'Show'} DAG
          </button>
        )}
      </div>

      {/* ASCII DAG Visualization */}
      {showDag && asciiDag && (
        <pre style={{
          background: 'rgba(0,0,0,0.3)',
          padding: '12px',
          borderRadius: '6px',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: 'var(--text-secondary)',
          overflowX: 'auto',
          marginBottom: '12px',
          whiteSpace: 'pre-wrap',
        }}>
          {asciiDag}
        </pre>
      )}

      {/* Wave columns */}
      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '8px' }}>
        {waves.map((wave, waveIdx) => (
          <div key={waveIdx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              minWidth: '140px',
              background: getWaveStatus(waveIdx) === 'running' 
                ? 'rgba(139, 92, 246, 0.15)' 
                : 'rgba(255,255,255,0.03)',
              border: `1px solid ${getWaveStatus(waveIdx) === 'running' ? 'var(--primary)' : 'var(--border-color)'}`,
              borderRadius: '8px',
              padding: '8px',
            }}>
              <div style={{ 
                fontSize: '11px', 
                fontWeight: 600, 
                color: getWaveStatus(waveIdx) === 'running' ? 'var(--primary)' : 'var(--text-tertiary)',
                marginBottom: '8px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}>
                Wave {waveIdx}
              </div>
              {wave.map(taskId => {
                const task = getTaskById(taskId);
                return (
                  <div key={taskId} style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '6px',
                    padding: '6px',
                    background: 'rgba(0,0,0,0.2)',
                    borderRadius: '4px',
                    marginBottom: '4px',
                    fontSize: '11px',
                  }}>
                    {getStatusIcon(task?.status || 'pending')}
                    <div>
                      <div style={{ color: '#fff', fontWeight: 500 }}>{task?.description?.slice(0, 40) || taskId}</div>
                      {task?.assigned_model && (
                        <div style={{ color: 'var(--text-tertiary)', fontSize: '10px' }}>{task.assigned_model}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {waveIdx < waves.length - 1 && (
              <ArrowRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            )}
          </div>
        ))}
      </div>

      {/* Review Findings */}
      {reviewFindings && reviewFindings.length > 0 && (
        <div style={{ marginTop: '12px', padding: '8px', background: 'rgba(245, 158, 11, 0.1)', borderRadius: '6px', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#f59e0b', marginBottom: '6px' }}>
            ⚠ Review Findings ({reviewFindings.length})
          </div>
          {reviewFindings.map((finding, idx) => (
            <div key={idx} style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '2px 0' }}>
              <span style={{ 
                color: finding.severity === 'high' ? '#ef4444' : '#f59e0b',
                fontWeight: 600,
              }}>
                [{finding.severity.toUpperCase()}]
              </span> {finding.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### 3.5 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\SwarmStatePanel.tsx`

Import and integrate `WaveTimeline`. Find the section that displays swarm execution status and ADD the WaveTimeline component. The data should come from polling the `/api/workflow/{execution_id}/status` endpoint.

Add at the top:
```tsx
import WaveTimeline from './WaveTimeline';
```

In the render, when execution data is available, render:
```tsx
{execution?.waves && (
  <WaveTimeline
    waves={execution.waves}
    tasks={execution.plan || []}
    currentWave={execution.current_wave || 0}
    reviewFindings={execution.review_pass_results}
    asciiDag={execution.ascii_dag}
  />
)}
```

---

### 3.6 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ExecutionBar.tsx`

In `handleSwarmExecute()`, update the visualization nodes to show waves instead of the static 5-node chain:

After receiving the swarm execution response, poll for the plan and generate per-wave visualization on the canvas. Add a "Pause after Wave" checkbox before the Swarm button:

```tsx
<label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
  <input type="checkbox" /> Pause between waves
</label>
```

---

## 4. BDD Acceptance Criteria

### Feature: Wave Computation from Dependencies

```gherkin
Feature: Tasks are organized into dependency-aware execution waves

  Scenario: Independent tasks land in the same wave
    Given tasks A, B, C with no dependencies
    When waves are computed
    Then there should be 1 wave containing [A, B, C]

  Scenario: Linear dependencies create sequential waves
    Given task A has no dependencies
    And task B depends on A
    And task C depends on B
    When waves are computed
    Then there should be 3 waves: [[A], [B], [C]]

  Scenario: Diamond dependency pattern
    Given task A has no dependencies
    And tasks B and C both depend on A
    And task D depends on both B and C
    When waves are computed
    Then wave 0 = [A], wave 1 = [B, C], wave 2 = [D]

  Scenario: Circular dependency is detected
    Given task A depends on B
    And task B depends on A
    When waves are computed
    Then a CircularDependencyError should be raised
```

### Feature: File Conflict Avoidance

```gherkin
Feature: Parallel tasks in the same wave cannot write to the same file

  Scenario: Two tasks writing to the same file are separated
    Given task A and task B are in wave 0
    And both touch file "output.md"
    When conflict resolution runs
    Then task B should be moved to wave 1
    And wave 0 should contain only [A]
    And wave 1 should contain [B]
```

### Feature: Context Handover Between Waves

```gherkin
Feature: Completed wave results are summarized for the next wave

  Scenario: Wave 0 results are available in wave 1
    Given wave 0 has 2 tasks that completed successfully
    When context handover runs
    Then context_handover should contain summaries of both tasks
    And each summary should be truncated to 500 characters max
    And current_wave should be incremented to 1
```

### Feature: Post-execution Review

```gherkin
Feature: Post-execution review identifies quality issues

  Scenario: Missing results are flagged
    Given 5 tasks were planned
    And only 4 have results
    Then review should report a "missing_results" finding with severity "high"

  Scenario: High error rate is flagged
    Given 4 of 5 tasks failed
    Then review should report an error_rate finding with severity "high"
```

---

## 5. TDD Test File

### Create: `C:\Users\nsdha\OneDrive\code\benny\tests\test_wave_scheduler.py`

```python
"""
Test suite for Phase 2 — Wave Scheduler and Swarm Enhancements.
Run with: python -m pytest tests/test_wave_scheduler.py -v
"""

import pytest
from benny.graph.wave_scheduler import (
    compute_waves,
    detect_conflicts,
    resolve_conflicts,
    generate_ascii_dag,
    assign_models,
    CircularDependencyError,
    FileConflict,
)


class TestComputeWaves:

    def test_independent_tasks_single_wave(self):
        tasks = [{"task_id": "A"}, {"task_id": "B"}, {"task_id": "C"}]
        deps = {"A": [], "B": [], "C": []}
        waves = compute_waves(tasks, deps)
        assert len(waves) == 1
        assert set(waves[0]) == {"A", "B", "C"}

    def test_linear_chain_three_waves(self):
        tasks = [{"task_id": "A"}, {"task_id": "B"}, {"task_id": "C"}]
        deps = {"A": [], "B": ["A"], "C": ["B"]}
        waves = compute_waves(tasks, deps)
        assert len(waves) == 3
        assert waves[0] == ["A"]
        assert waves[1] == ["B"]
        assert waves[2] == ["C"]

    def test_diamond_pattern(self):
        tasks = [{"task_id": "A"}, {"task_id": "B"}, {"task_id": "C"}, {"task_id": "D"}]
        deps = {"A": [], "B": ["A"], "C": ["A"], "D": ["B", "C"]}
        waves = compute_waves(tasks, deps)
        assert len(waves) == 3
        assert waves[0] == ["A"]
        assert set(waves[1]) == {"B", "C"}
        assert waves[2] == ["D"]

    def test_circular_dependency_raises(self):
        tasks = [{"task_id": "A"}, {"task_id": "B"}]
        deps = {"A": ["B"], "B": ["A"]}
        with pytest.raises(CircularDependencyError):
            compute_waves(tasks, deps)

    def test_partial_dependencies(self):
        tasks = [{"task_id": "A"}, {"task_id": "B"}, {"task_id": "C"}, {"task_id": "D"}]
        deps = {"A": [], "B": [], "C": ["A"], "D": ["B"]}
        waves = compute_waves(tasks, deps)
        assert len(waves) == 2
        assert set(waves[0]) == {"A", "B"}
        assert set(waves[1]) == {"C", "D"}

    def test_empty_tasks(self):
        waves = compute_waves([], {})
        assert waves == []

    def test_single_task(self):
        waves = compute_waves([{"task_id": "A"}], {"A": []})
        assert waves == [["A"]]

    def test_invalid_dependency_ignored(self):
        tasks = [{"task_id": "A"}, {"task_id": "B"}]
        deps = {"A": [], "B": ["NONEXISTENT"]}
        waves = compute_waves(tasks, deps)
        assert len(waves) == 1  # B has no valid deps, so it's wave 0 with A


class TestConflictDetection:

    def test_no_conflicts(self):
        conflicts = detect_conflicts(
            ["A", "B"],
            {"A": ["file1.md"], "B": ["file2.md"]}
        )
        assert len(conflicts) == 0

    def test_file_conflict_detected(self):
        conflicts = detect_conflicts(
            ["A", "B"],
            {"A": ["output.md"], "B": ["output.md"]}
        )
        assert len(conflicts) == 1
        assert conflicts[0].file_path == "output.md"
        assert conflicts[0].task_a == "A"
        assert conflicts[0].task_b == "B"

    def test_multiple_conflicts(self):
        conflicts = detect_conflicts(
            ["A", "B", "C"],
            {"A": ["f1.md", "f2.md"], "B": ["f1.md"], "C": ["f2.md"]}
        )
        assert len(conflicts) == 2


class TestConflictResolution:

    def test_conflict_resolved_by_bumping(self):
        waves = [["A", "B"]]
        file_assignments = {"A": ["output.md"], "B": ["output.md"]}
        resolved = resolve_conflicts(waves, file_assignments)
        assert len(resolved) == 2
        assert "A" in resolved[0]
        assert "B" in resolved[1]

    def test_no_conflict_unchanged(self):
        waves = [["A", "B"]]
        file_assignments = {"A": ["f1.md"], "B": ["f2.md"]}
        resolved = resolve_conflicts(waves, file_assignments)
        assert len(resolved) == 1
        assert set(resolved[0]) == {"A", "B"}


class TestAsciiDag:

    def test_generates_output(self):
        tasks = [
            {"task_id": "1", "description": "Plan architecture"},
            {"task_id": "2", "description": "Write code"},
        ]
        deps = {"1": [], "2": ["1"]}
        waves = [["1"], ["2"]]
        result = generate_ascii_dag(tasks, deps, waves)
        assert "Wave 0" in result
        assert "Wave 1" in result
        assert "2 waves" in result


class TestModelAssignment:

    def test_reasoning_task_gets_reasoning_model(self):
        tasks = [{"task_id": "1", "description": "Analyze the financial report"}]
        registry = {"reasoning": {"model": "gpt-4-turbo"}}
        assignments = assign_models(tasks, registry)
        assert assignments["1"] == "gpt-4-turbo"

    def test_writing_task_gets_writing_model(self):
        tasks = [{"task_id": "1", "description": "Write a summary document"}]
        registry = {"writing": {"model": "claude-3-sonnet"}}
        assignments = assign_models(tasks, registry)
        assert assignments["1"] == "claude-3-sonnet"

    def test_unknown_task_gets_default(self):
        tasks = [{"task_id": "1", "description": "Do something else", "assigned_model": "local-model"}]
        assignments = assign_models(tasks, {})
        assert assignments["1"] == "local-model"
```

---

## 6. Execution Order

1. Read ALL files in Section 2
2. Create `C:\Users\nsdha\OneDrive\code\benny\tests\test_wave_scheduler.py` (tests first)
3. Create `C:\Users\nsdha\OneDrive\code\benny\benny\graph\wave_scheduler.py`
4. Run wave_scheduler tests: `python -m pytest tests/test_wave_scheduler.py -v`
5. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\core\state.py` — extend TypedDicts
6. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\graph\swarm.py` — refactor graph
7. Create `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WaveTimeline.tsx`
8. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\SwarmStatePanel.tsx`
9. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ExecutionBar.tsx`
10. Run full test suite
11. Verify end-to-end with a swarm execution

---

## 7. Definition of Done

- [ ] All 17 unit tests in `test_wave_scheduler.py` pass
- [ ] `compute_waves()` correctly computes topological layers
- [ ] `CircularDependencyError` is raised for cyclic dependencies
- [ ] File conflicts are detected and resolved
- [ ] ASCII DAG is generated and readable
- [ ] Model assignment uses keyword heuristics
- [ ] Swarm graph executes in wave order (wave 0 → wave 1 → ...)
- [ ] Context handover passes truncated summaries between waves
- [ ] Review node identifies missing results, high error rates, and broken dependencies
- [ ] WaveTimeline component renders waves as horizontal columns
- [ ] SwarmStatePanel integrates WaveTimeline with live status
- [ ] Existing swarm execution (non-wave) still works (backward compat via empty dependency_graph)
