"""Regression tests for report-swarm manifest variable substitution.

Covers the two failure modes that broke TOGAF report generation:

  1. Running: ``${model}`` (and ``${topic}`` / ``${output_file}``) tokens were
     never resolved, so the literal string ``"${model}"`` reached litellm and
     every task failed with "LLM Provider NOT provided".
  2. Generation: a buggy recursive/character-level substitution produced a
     combinatorial blow-up (output_file × topic × model), writing a 267 MB
     degenerate manifest. The renderer must stay linear in input size.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RUNTIME = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RUNTIME))

import benny_cli  # noqa: E402
from benny.core.manifest import SwarmManifest  # noqa: E402

TEMPLATE = RUNTIME / "manifests" / "templates" / "togaf_sad_report_swarm.json"


def _raw():
    return json.loads(TEMPLATE.read_text(encoding="utf-8"))


def test_tokens_resolved_from_variables_block():
    rendered = benny_cli._render_manifest_vars(_raw())
    assert rendered["config"]["model"] == "lemonade/qwen3.5-9b-FLM"
    assert rendered["outputs"]["files"] == ["data_out/TOGAF_SAD_prime_silo.md"]
    assert rendered["plan"]["tasks"][0]["assigned_model"] == "lemonade/qwen3.5-9b-FLM"
    # No token survives, and the consumed ``variables`` block is removed.
    assert "${" not in json.dumps(rendered)
    assert "variables" not in rendered


def test_overrides_take_precedence():
    rendered = benny_cli._render_manifest_vars(_raw(), {"model": "lemonade/qwen3-tk-4b-FLM"})
    assert rendered["config"]["model"] == "lemonade/qwen3-tk-4b-FLM"


def test_rendered_manifest_validates_and_is_small():
    rendered = benny_cli._render_manifest_vars(_raw())
    size = len(json.dumps(rendered))
    # The 267 MB corruption was ~3e8 bytes; a correct render is a few KB.
    assert size < 100_000, f"rendered manifest unexpectedly large: {size} bytes"
    m = SwarmManifest.model_validate(rendered)
    assert m.config.model == "lemonade/qwen3.5-9b-FLM"
    assert len(m.plan.tasks) == 6


def test_no_combinatorial_explosion_on_self_referential_vars():
    """Even pathological variables (tokens referencing other tokens, and a
    self-referential token) must not blow up — output stays bounded."""
    raw = {
        "id": "x",
        "name": "x",
        "variables": {
            "a": "${b}${b}",
            "b": "${c}-${c}",
            "c": "leaf",
            "self": "${self}X",  # self-reference: must not loop forever
        },
        "config": {"model": "${a}"},
        "description": "${self}",
    }
    rendered = benny_cli._render_manifest_vars(raw)
    blob = json.dumps(rendered)
    assert len(blob) < 10_000  # bounded, no explosion
    # ${a} -> ${b}${b} -> (${c}-${c})x2 -> leaf-leafleaf-leaf
    assert rendered["config"]["model"] == "leaf-leafleaf-leaf"


def test_unresolved_token_is_left_intact_for_caller_guard():
    raw = {"id": "x", "name": "x", "variables": {}, "config": {"model": "${model}"}}
    rendered = benny_cli._render_manifest_vars(raw)
    # No variable named 'model' -> token survives so cmd_run's guard can reject it.
    assert rendered["config"]["model"] == "${model}"
