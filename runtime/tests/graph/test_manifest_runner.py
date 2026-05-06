import pytest
import sys
from unittest.mock import patch, MagicMock, AsyncMock

# PREVENT PyO3/Tokenizers error by mocking swarm before it loads
mock_swarm = MagicMock()
sys.modules["benny.graph.swarm"] = mock_swarm

from benny.graph.manifest_runner import plan_from_requirement, execute_manifest, _apply_delta
from benny.core.manifest import SwarmManifest, RunStatus

@pytest.fixture
def mock_planner():
    # planner_node is awaited in manifest_runner — use AsyncMock so the
    # mock returns a coroutine that resolves to the side_effect values.
    mock_swarm.planner_node = AsyncMock()
    return mock_swarm.planner_node

@pytest.fixture
def mock_scheduler():
    # wave_scheduler_node is called synchronously in manifest_runner
    # (delta = wave_scheduler_node(state), no await) — use MagicMock so
    # the return value is a dict rather than a coroutine.
    mock_swarm.wave_scheduler_node = MagicMock()
    return mock_swarm.wave_scheduler_node

@pytest.fixture
def mock_graph():
    graph = MagicMock()
    graph.ainvoke = AsyncMock()
    mock_swarm.build_swarm_graph = MagicMock(return_value=graph)
    return graph

@pytest.mark.asyncio
async def test_plan_from_requirement_success(mock_planner, mock_scheduler):
    mock_planner.side_effect = [
        {"plan": [{"task_id": "p1", "is_pillar": True, "is_expanded": False}]},
        {"plan": [{"task_id": "p1", "is_pillar": True, "is_expanded": True}, {"task_id": "t1"}]}
    ]
    mock_scheduler.return_value = {"waves": [["p1"]]}

    manifest = await plan_from_requirement(
        requirement="test req",
        model="m",
        output_spec=None
    )
    assert manifest.id.startswith("manifest-")
    assert mock_planner.call_count >= 2

@pytest.mark.asyncio
async def test_execute_manifest_success(mock_graph):
    manifest = SwarmManifest(id="m1", name="M", requirement="req")
    mock_graph.ainvoke.return_value = {
        "status": "completed",
        "plan": [{"task_id": "t1", "status": "completed"}]
    }

    # RunRecord.governance_url is a required string; configure the mocked
    # swarm module so the import inside execute_manifest resolves it to a
    # concrete URL rather than a MagicMock (which fails Pydantic validation).
    mock_swarm.get_governance_url = MagicMock(
        return_value="http://localhost/governance/run1"
    )

    with patch("benny.persistence.run_store.save_run"), \
         patch("benny.persistence.run_store.update_run_status") as mock_update:
        mock_update.return_value = MagicMock()
        await execute_manifest(manifest, run_id="run1")
        assert mock_update.called

def test_apply_delta_reducers():
    state = {"errors": ["e1"]}
    delta = {"errors": ["e2"], "status": "ok"}
    new_state = _apply_delta(state, delta)
    assert new_state["errors"] == ["e1", "e2"]
