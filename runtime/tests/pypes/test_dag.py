"""Topological-order tests for the Pypes orchestrator's DAG resolution."""

from __future__ import annotations

import pytest

from benny.pypes.models import PipelineStep
from benny.pypes.orchestrator import _topological_order


def _step(sid, inputs=None, outputs=None):
    return PipelineStep(id=sid, inputs=inputs or [], outputs=outputs or [sid])


def test_linear_dag_orders_in_input_chain():
    a = _step("a", outputs=["a_out"])
    b = _step("b", inputs=["a_out"], outputs=["b_out"])
    c = _step("c", inputs=["b_out"], outputs=["c_out"])
    order = _topological_order([c, b, a])  # deliberately scrambled
    assert order == ["a", "b", "c"]


def test_diamond_dag_resolves_to_valid_order():
    root = _step("root", outputs=["r"])
    left = _step("left", inputs=["r"], outputs=["l"])
    right = _step("right", inputs=["r"], outputs=["right_out"])
    sink = _step("sink", inputs=["l", "right_out"], outputs=["s"])
    order = _topological_order([sink, left, right, root])
    assert order[0] == "root"
    assert order[-1] == "sink"
    assert order.index("left") < order.index("sink")
    assert order.index("right") < order.index("sink")


def test_external_inputs_are_not_treated_as_dependencies():
    """An ``inputs`` name that no step produces is treated as an external file."""
    a = _step("ingest", inputs=["external://trades.csv"], outputs=["raw"])
    b = _step("transform", inputs=["raw"], outputs=["clean"])
    order = _topological_order([b, a])
    assert order == ["ingest", "transform"]


def test_cycle_raises_value_error():
    a = _step("a", inputs=["b_out"], outputs=["a_out"])
    b = _step("b", inputs=["a_out"], outputs=["b_out"])
    with pytest.raises(ValueError):
        _topological_order([a, b])


def test_step_without_explicit_outputs_uses_id_as_output():
    a = PipelineStep(id="a")
    b = PipelineStep(id="b", inputs=["a"])
    order = _topological_order([b, a])
    assert order == ["a", "b"]
