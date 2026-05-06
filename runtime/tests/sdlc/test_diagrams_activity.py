"""AOS-F13 — PlantUML activity diagram per BDD scenario.

test_aos_f13_activity_diagram_per_scenario — one @startuml block per scenario
  with :Given;  :When;  :Then; steps.
"""
import pytest

from benny.sdlc.contracts import BddScenario
from benny.sdlc.diagrams import to_activity_diagram


def _make_scenarios() -> list:
    return [
        BddScenario(
            id="SC-01",
            given="a user has valid credentials",
            when="the user submits the login form",
            then="the user is redirected to the dashboard",
        ),
        BddScenario(
            id="SC-02",
            given="a user has invalid credentials",
            when="the user submits the login form",
            then="an error message is displayed",
        ),
    ]


# ---------------------------------------------------------------------------
# AOS-F13: to_activity_diagram
# ---------------------------------------------------------------------------


def test_aos_f13_activity_diagram_per_scenario():
    """to_activity_diagram() emits one @startuml block per scenario."""
    scenarios = _make_scenarios()
    diagram = to_activity_diagram(scenarios)

    count = diagram.count("@startuml")
    assert count == len(scenarios), (
        f"Expected {len(scenarios)} @startuml blocks, found {count}"
    )
    assert diagram.count("@enduml") == len(scenarios)


def test_activity_diagram_given_when_then_steps():
    """Each scenario's Given/When/Then steps appear as :step; lines."""
    scenarios = _make_scenarios()
    diagram = to_activity_diagram(scenarios)

    for sc in scenarios:
        assert sc.given in diagram, f"Missing given step for {sc.id}"
        assert sc.when in diagram, f"Missing when step for {sc.id}"
        assert sc.then in diagram, f"Missing then step for {sc.id}"


def test_activity_diagram_start_stop():
    """Each scenario block has a start and stop marker."""
    scenarios = _make_scenarios()
    diagram = to_activity_diagram(scenarios)

    assert diagram.count("start") >= len(scenarios)
    assert diagram.count("stop") >= len(scenarios)


def test_activity_diagram_scenario_ids():
    """Scenario IDs appear as labels in the output."""
    scenarios = _make_scenarios()
    diagram = to_activity_diagram(scenarios)
    for sc in scenarios:
        assert sc.id in diagram, f"Expected scenario ID {sc.id!r} in diagram"


def test_activity_diagram_empty():
    """to_activity_diagram([]) returns an empty string or minimal valid output."""
    result = to_activity_diagram([])
    assert isinstance(result, str)


def test_activity_diagram_single_scenario():
    """Single scenario produces exactly one @startuml...@enduml block."""
    sc = BddScenario(
        id="SC-X",
        given="the system is online",
        when="a request arrives",
        then="a response is returned",
    )
    diagram = to_activity_diagram([sc])
    assert diagram.count("@startuml") == 1
    assert diagram.count("@enduml") == 1
    assert "start" in diagram
    assert "stop" in diagram
