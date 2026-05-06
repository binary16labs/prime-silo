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
