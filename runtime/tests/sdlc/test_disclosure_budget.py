"""AOS-NFR12: Layer 1 disclosure for the full tool registry ≤ 500 tokens.

Uses the module-level singleton so this test reflects the real registry that
ships with Benny, not a test-only stub.
"""
import json
import pytest

from benny.core.artifact_store import _estimate_tokens
from benny.core.disclosure import registry as global_registry, DisclosureRegistry


def test_aos_nfr12_disclosure_budget():
    """Global registry Layer 1 index must fit within 500 tokens."""
    index = global_registry.layer1_index()
    serialised = json.dumps(index)
    tokens = _estimate_tokens(serialised)
    assert tokens <= 500, (
        f"Global Layer 1 index exceeds 500-token budget: {tokens} tokens"
    )


def test_layer1_per_entry_summary_clamped():
    """Summaries are clamped to 80 chars by the registry (budget guard).

    At 4 chars/token, an 80-char summary + ~20-char name + JSON overhead
    is ~35 tokens/entry.  Keeping summaries to ≤ 30 chars allows ~50 tools
    within the 500-token cap.  This test verifies the clamp is enforced.
    """
    reg = DisclosureRegistry()
    long_summary = "A" * 200
    reg.register("clamped.tool", summary=long_summary)
    entry = reg.layer1_index()[0]
    assert len(entry["summary"]) <= 80, (
        "Registry must clamp summaries to ≤ 80 chars to protect the token budget"
    )


def test_layer1_entry_format():
    """Every Layer 1 entry is a dict with exactly tool_name and summary keys."""
    reg = DisclosureRegistry()
    reg.register("a.tool", summary="Does something useful.")
    index = reg.layer1_index()
    assert len(index) == 1
    entry = index[0]
    assert set(entry.keys()) == {"tool_name", "summary"}
