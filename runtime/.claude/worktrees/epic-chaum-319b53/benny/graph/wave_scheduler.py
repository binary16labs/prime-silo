"""
Wave Scheduler — Dependency-aware task scheduling for Swarm execution.

Computes execution waves using topological layering.
Each wave contains tasks whose dependencies are ALL satisfied by previous waves.
"""

from __future__ import annotations

import logging
from typing import List, Dict, Tuple, Optional, Set, Any
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
    tasks: List[Dict[str, Any]],
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
    if not tasks:
        return []
        
    task_ids = {t["task_id"] for t in tasks}
    
    # Validate all dependencies reference existing tasks
    for task_id, deps in dependency_graph.items():
        if task_id not in task_ids:
             continue
        for dep in deps:
            if dep not in task_ids:
                logger.warning("Dependency '%s' for task '%s' does not exist, ignoring", dep, task_id)
    
    # Build adjacency list (reverse: what depends on me?)
    dependents: Dict[str, List[str]] = defaultdict(list)
    in_degree: Dict[str, int] = {t["task_id"]: 0 for t in tasks}
    
    for task_id, deps in dependency_graph.items():
        if task_id not in task_ids:
            continue
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
            # Create conflict for each pair (simplified: just bump later ones)
            # Actually, the logic in resolve_conflicts will use these.
            # We just need to report them.
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
    new_waves = [list(w) for w in waves]
    max_iterations = 100  # Safety valve
    iteration = 0
    
    while iteration < max_iterations:
        iteration += 1
        found_conflict = False
        
        for wave_idx, wave in enumerate(new_waves):
            conflicts = detect_conflicts(wave, file_assignments)
            if conflicts:
                found_conflict = True
                # Move the second task in each conflict to the next wave
                for conflict in conflicts:
                    task_to_move = conflict.task_b
                    if task_to_move not in new_waves[wave_idx]: continue # Already moved
                    
                    new_waves[wave_idx] = [t for t in new_waves[wave_idx] if t != task_to_move]
                    
                    # Ensure next wave exists
                    if wave_idx + 1 >= len(new_waves):
                        new_waves.append([])
                    new_waves[wave_idx + 1].append(task_to_move)
                break  # Re-check from the beginning after modification
        
        if not found_conflict:
            break
    
    # Remove any empty waves created during resolution
    return [w for w in new_waves if w]


def generate_ascii_dag(
    tasks: List[Dict[str, Any]],
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
    
    lines.append(f"═══ {len(waves)} waves, {len(tasks)} tasks ═══")
    return "\n".join(lines)


def assign_models(
    tasks: List[Dict[str, Any]],
    model_registry: Dict[str, Dict[str, Any]]
) -> Dict[str, str]:
    """
    Assign optimal models to tasks based on their role/complexity and keywords.
    Prefers local NPU-accelerated models if they match the desired capability.
    """
    assignment: Dict[str, str] = {}
    
    reasoning_keywords = {"plan", "analyze", "architect", "design", "evaluate", "review", "assess"}
    writing_keywords = {"write", "generate", "create", "compose", "draft", "document"}
    fast_keywords = {"search", "find", "explore", "list", "check", "verify"}
    
    # Identify best local candidates from registry
    local_reasoning = next((k for k, v in model_registry.items() if "reasoning" in v.get("use_for", []) and v.get("cost_per_1k", 1.0) == 0), None)
    local_writing = next((k for k, v in model_registry.items() if "content_generation" in v.get("use_for", []) and v.get("cost_per_1k", 1.0) == 0), None)
    local_fast = next((k for k, v in model_registry.items() if "simple_tasks" in v.get("use_for", []) and v.get("cost_per_1k", 1.0) == 0), None)

    for task in tasks:
        desc_lower = task.get("description", "").lower()
        words = set(desc_lower.split())
        complexity = task.get("complexity", "medium")
        
        # Determine the "functional type" of the task
        if complexity == "high" or (words & reasoning_keywords):
            # Prefer local reasoning (e.g. DeepSeek-R1-FLM) if available
            assignment[task["task_id"]] = local_reasoning or model_registry.get("reasoning", {}).get("model", "gpt-4-turbo")
        elif words & writing_keywords:
            assignment[task["task_id"]] = local_writing or model_registry.get("writing", {}).get("model", "claude-3-sonnet-20240229")
        elif words & fast_keywords:
            assignment[task["task_id"]] = local_fast or model_registry.get("fast", {}).get("model", "gpt-3.5-turbo")
        else:
            # Default to the task's pre-assigned model or a safe local fallback
            assignment[task["task_id"]] = task.get("assigned_model") or local_fast or "local_ollama"
    
    return assignment
