"""AOS-F12 — PlantUML diagram smoke test.

test_aos_f12_to_plantuml_smoke — output is a valid @startuml...@enduml block
"""
import pytest

from benny.core.manifest import ManifestPlan, ManifestTask, ManifestEdge
from benny.sdlc.diagrams import to_plantuml


def _make_plan() -> ManifestPlan:
    tasks = [
        ManifestTask(id="req", description="Gather requirements"),
        ManifestTask(id="design", description="Design components"),
        ManifestTask(id="impl", description="Implement"),
    ]
    edges = [
        ManifestEdge(source="req", target="design"),
        ManifestEdge(source="design", target="impl"),
    ]
    waves = [["req"], ["design"], ["impl"]]
    return ManifestPlan(tasks=tasks, edges=edges, waves=waves)


# ---------------------------------------------------------------------------
# AOS-F12: to_plantuml
# ---------------------------------------------------------------------------


def test_aos_f12_to_plantuml_smoke():
    """to_plantuml() produces a @startuml...@enduml block with --> edges."""
    plan = _make_plan()
    diagram = to_plantuml(plan)

    assert "@startuml" in diagram, "Missing @startuml header"
    assert "@enduml" in diagram, "Missing @enduml footer"
    assert "-->" in diagram, "Expected --> edges in PlantUML output"


def test_plantuml_contains_task_ids():
    """All task IDs appear somewhere in the PlantUML output."""
    plan = _make_plan()
    diagram = to_plantuml(plan)
    for tid in ("req", "design", "impl"):
        assert tid in diagram, f"Expected task {tid!r} in PlantUML output"


def test_plantuml_wave_labels():
    """PlantUML output references wave groupings."""
    plan = _make_plan()
    diagram = to_plantuml(plan)
    assert "Wave" in diagram, "Expected wave labels in PlantUML output"


def test_plantuml_empty_plan():
    """to_plantuml() on an empty plan still returns valid @startuml...@enduml."""
    plan = ManifestPlan()
    diagram = to_plantuml(plan)
    assert "@startuml" in diagram
    assert "@enduml" in diagram
