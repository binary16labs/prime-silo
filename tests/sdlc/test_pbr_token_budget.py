"""AOS-NFR1: PBR yields ≥ 80 % token reduction on the test fixture.

The fixture is a 5 000-char text (≈ 1 250 tokens). After PBR the context
carries only the ArtifactRef dict (≈ 50 tokens).  Reduction must be ≥ 80 %.
"""
import json
import pytest
from pathlib import Path

from benny.core.artifact_store import put, maybe_promote, _estimate_tokens


FIXTURE_TEXT = "The quick brown fox jumps over the lazy dog. " * 112  # ~5 000 chars / ~1 250 tokens


def test_aos_nfr1_token_reduction(tmp_path):
    """PBR reduces token load by ≥ 80 % on the reference fixture."""
    tokens_before = _estimate_tokens(FIXTURE_TEXT)

    result = maybe_promote(FIXTURE_TEXT, workspace_path=tmp_path, threshold_tokens=256)

    assert isinstance(result, dict), "Fixture must be promoted (too large for threshold)"

    # Serialise the ArtifactRef as it would appear in the LLM context
    ref_json = json.dumps(result)
    tokens_after = _estimate_tokens(ref_json)

    reduction = 1.0 - (tokens_after / tokens_before)
    assert reduction >= 0.80, (
        f"Token reduction {reduction:.1%} < 80 % "
        f"(before={tokens_before}, after={tokens_after})"
    )


def test_pbr_threshold_no_regression(tmp_path):
    """Small outputs (< threshold) are NOT promoted — no false-positive latency."""
    small = "short task output"
    result = maybe_promote(
        small, workspace_path=tmp_path, threshold_tokens=1024
    )
    assert result == small, "Small output must not be promoted"


def test_estimate_tokens_nonzero():
    """_estimate_tokens returns a positive integer for non-empty text."""
    assert _estimate_tokens("hello world") > 0
    assert _estimate_tokens("x" * 4000) == 1000
