import pytest
import asyncio
from typing import Dict, Any
from benny.graph.swarm import expansion_monitor_node, planner_node
from benny.core.state import create_swarm_state, TaskItem, PartialResult

@pytest.mark.asyncio
async def test_expansion_monitor_detects_signals():
    """Test that expansion_monitor_node correctly identifies [[EXPAND]] signals."""
    state = create_swarm_state("test_exec")
    state["plan"] = [
        TaskItem(
            task_id="1", description="Initial Task", status="completed",
            skill_hint=None, assigned_skills=[], parent_id=None, depth=0, wave=0,
            dependencies=[], files_touched=[], complexity="medium",
            assigned_model=None, estimated_tokens=None
        )
    ]
    state["partial_results"] = [
        PartialResult(
            task_id="1", 
            content="I found something deep. [[EXPAND: deeper topic A]] and [[EXPAND: deeper topic B]]",
            error=None, execution_time_ms=100
        )
    ]
    
    result = await expansion_monitor_node(state)
    signals = result.get("expansion_signals", [])
    
    assert len(signals) == 2
    assert signals[0]["description"] == "deeper topic A"
    assert signals[0]["parent_id"] == "1"
    assert signals[0]["depth"] == 0

@pytest.mark.asyncio
async def test_planner_handles_expansion():
    """Test that planner_node creates new tasks from expansion signals."""
    state = create_swarm_state("test_exec")
    state["plan"] = [
        TaskItem(
            task_id="1", description="Initial Task", status="completed",
            skill_hint=None, assigned_skills=[], parent_id=None, depth=0, wave=0,
            dependencies=[], files_touched=[], complexity="medium",
            assigned_model=None, estimated_tokens=None
        )
    ]
    state["expansion_signals"] = [
        {"parent_id": "1", "description": "deeper sub-task", "depth": 0}
    ]
    state["dependency_graph"] = {"1": []}
    
    result = await planner_node(state)
    new_plan = result.get("plan", [])
    
    assert len(new_plan) == 2
    sub_task = next(t for t in new_plan if t["task_id"] == "1.1")
    assert sub_task["parent_id"] == "1"
    assert sub_task["depth"] == 1
    assert sub_task["dependencies"] == ["1"]
    assert result["expansion_signals"] == []

@pytest.mark.asyncio
async def test_recursion_depth_limit():
    """Test that recursion stops at depth 2."""
    state = create_swarm_state("test_exec")
    # Task at depth 2 should NOT be allowed to expand further
    state["plan"] = [
        TaskItem(
            task_id="1.1.1", description="Deep Task", status="completed",
            skill_hint=None, assigned_skills=[], parent_id="1.1", depth=2, wave=1,
            dependencies=[], files_touched=[], complexity="medium",
            assigned_model=None, estimated_tokens=None
        )
    ]
    state["partial_results"] = [
        PartialResult(
            task_id="1.1.1", 
            content="Too deep! [[EXPAND: way too deep]]",
            error=None, execution_time_ms=100
        )
    ]
    
    result = await expansion_monitor_node(state)
    assert len(result.get("expansion_signals", [])) == 0
