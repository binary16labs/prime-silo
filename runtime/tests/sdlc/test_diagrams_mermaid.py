"""AOS-F11 — Mermaid diagram generator.

test_aos_f11_to_mermaid_emits_graph_td — output starts with 'graph TD'
test_aos_f11_subgraph_per_wave         — one subgraph per wave
"""
import uuid
import pytest

from benny.core.manifest import ManifestPlan, ManifestTask, ManifestEdge, SwarmManifest
from benny.sdlc.diagrams import to_mermaid, populate_mermaid


def _make_plan() -> ManifestPlan:
    tasks = [
        ManifestTask(id="t1", description="Design system"),
        ManifestTask(id="t2", description="Implement auth"),
        ManifestTask(id="t3", description="Write tests"),
        ManifestTask(id="t4", description="Deploy"),
    ]
    edges = [
        ManifestEdge(source="t1", target="t2"),
        ManifestEdge(source="t1", target="t3"),
        ManifestEdge(source="t2", target="t4"),
        ManifestEdge(source="t3", target="t4"),
    ]
    waves = [["t1"], ["t2", "t3"], ["t4"]]
    return ManifestPlan(tasks=tasks, edges=edges, waves=waves)


# ---------------------------------------------------------------------------
# AOS-F11: to_mermaid
# ---------------------------------------------------------------------------


def test_aos_f11_to_mermaid_emits_graph_td():
    """to_mermaid() output must start with 'graph TD'."""
    plan = _make_plan()
    diagram = to_mermaid(plan)
    assert diagram.startswith("graph TD"), (
        f"Expected diagram to start with 'graph TD', got: {diagram[:40]!r}"
    )


def test_aos_f11_subgraph_per_wave():
    """to_mermaid() emits exactly one subgraph block per wave."""
    plan = _make_plan()
    diagram = to_mermaid(plan)
    subgraph_count = diagram.count("subgraph")
    assert subgraph_count == 3, (
        f"Expected 3 subgraph blocks (one per wave), found {subgraph_count}"
    )
    assert "Wave_0" in diagram
    assert "Wave_1" in diagram
    assert "Wave_2" in diagram


def test_mermaid_edges_present():
    """Dependency edges appear as --> arrows in the Mermaid output."""
    plan = _make_plan()
    diagram = to_mermaid(plan)
    assert "-->" in diagram, "Expected --> edges in Mermaid output"


def test_mermaid_all_task_ids_present():
    """Every task ID appears in the Mermaid output."""
    plan = _make_plan()
    diagram = to_mermaid(plan)
    for tid in ("t1", "t2", "t3", "t4"):
        assert tid in diagram, f"Expected task {tid!r} in Mermaid output"


def test_mermaid_empty_plan():
    """to_mermaid() on an empty plan emits a valid (minimal) graph TD."""
    plan = ManifestPlan()
    diagram = to_mermaid(plan)
    assert diagram.startswith("graph TD")


# ---------------------------------------------------------------------------
# populate_mermaid integration
# ---------------------------------------------------------------------------


def test_populate_mermaid_sets_plan_mermaid():
    """populate_mermaid(manifest) sets manifest.plan.mermaid to a graph TD string."""
    manifest = SwarmManifest(id=str(uuid.uuid4()), name="test", plan=_make_plan())
    assert manifest.plan.mermaid is None
    populate_mermaid(manifest)
    assert manifest.plan.mermaid is not None
    assert manifest.plan.mermaid.startswith("graph TD")


def test_populate_mermaid_is_idempotent():
    """Calling populate_mermaid twice produces the same result."""
    manifest = SwarmManifest(id=str(uuid.uuid4()), name="test", plan=_make_plan())
    populate_mermaid(manifest)
    first = manifest.plan.mermaid
    populate_mermaid(manifest)
    assert manifest.plan.mermaid == first
