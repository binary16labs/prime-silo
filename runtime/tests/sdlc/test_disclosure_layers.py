"""Phase 2 acceptance tests: AOS-F8, AOS-F9, AOS-F10.

AOS-F8 — Layer 1 index for all registered tools fits in ≤ 500 tokens
AOS-F9 — activate(tool_name) returns JSON Schema; lazy-loaded and cached
AOS-F10 — examples(tool_name) returns Layer 3 only when explicitly called
"""
import json
import pytest

from benny.core.disclosure import DisclosureRegistry
from benny.core.artifact_store import _estimate_tokens


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_registry() -> DisclosureRegistry:
    """Return a fresh registry with a small set of test tools."""
    reg = DisclosureRegistry()
    reg.register(
        "graph.cypher_query",
        summary="Run a parameterised Cypher query against Neo4j.",
        schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "params": {"type": "object"},
            },
            "required": ["query"],
        },
        examples=["MATCH (n) RETURN n LIMIT 5"],
        docs_uri="artifact://" + "a" * 64,
    )
    reg.register(
        "fs.read",
        summary="Read a file from the workspace.",
        schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )
    reg.register(
        "fs.write",
        summary="Write content to a file in the workspace.",
        schema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
        examples=["{'path': 'out/report.md', 'content': '# Report'}"],
    )
    return reg


# ---------------------------------------------------------------------------
# AOS-F8: Layer 1 token budget
# ---------------------------------------------------------------------------


def test_aos_f8_layer1_token_budget():
    """Full Layer 1 index for all registered tools must fit in ≤ 500 tokens."""
    reg = make_registry()
    index = reg.layer1_index()

    serialised = json.dumps(index)
    tokens = _estimate_tokens(serialised)

    assert tokens <= 500, (
        f"Layer 1 index exceeds 500-token budget: {tokens} tokens "
        f"({len(serialised)} chars)"
    )


def test_layer1_contains_all_tools():
    """layer1_index() includes an entry for every registered tool."""
    reg = make_registry()
    index = reg.layer1_index()
    names = {entry["tool_name"] for entry in index}
    assert "graph.cypher_query" in names
    assert "fs.read" in names
    assert "fs.write" in names


def test_layer1_contains_only_summaries():
    """Layer 1 entries carry only tool_name and summary — no schema or examples."""
    reg = make_registry()
    for entry in reg.layer1_index():
        assert "tool_name" in entry
        assert "summary" in entry
        assert "schema" not in entry
        assert "examples" not in entry


# ---------------------------------------------------------------------------
# AOS-F9: activate() → schema, lazy load, cached
# ---------------------------------------------------------------------------


def test_aos_f9_activate_returns_schema():
    """activate(tool_name) returns the layer2 JSON Schema for the tool."""
    reg = make_registry()
    schema = reg.activate("graph.cypher_query")

    assert schema["type"] == "object"
    assert "query" in schema["properties"]


def test_aos_f9_lazy_load():
    """Layer 2 is not materialised at registration time."""
    reg = DisclosureRegistry()
    loaded = []

    def lazy_schema():
        loaded.append(True)
        return {"type": "object", "properties": {"x": {"type": "integer"}}}

    reg.register("lazy_tool", summary="A lazily-loaded tool.", schema_factory=lazy_schema)

    # Before activation — schema factory must NOT have been called
    assert loaded == [], "schema_factory must not be called at registration time"

    # After activation — factory is called exactly once
    schema = reg.activate("lazy_tool")
    assert loaded == [True]
    assert schema["type"] == "object"

    # Second call hits the cache, not the factory
    schema2 = reg.activate("lazy_tool")
    assert loaded == [True], "schema_factory must be called only once (cached)"
    assert schema2 == schema


def test_aos_f9_activate_unknown_tool_raises():
    """activate() raises KeyError for an unregistered tool name."""
    reg = DisclosureRegistry()
    with pytest.raises(KeyError):
        reg.activate("nonexistent.tool")


# ---------------------------------------------------------------------------
# AOS-F10: examples() → Layer 3, never loaded by default
# ---------------------------------------------------------------------------


def test_aos_f10_examples_layer3_optional():
    """Layer 3 is NEVER loaded unless examples() is explicitly called."""
    reg = DisclosureRegistry()
    layer3_loaded = []

    def lazy_examples():
        layer3_loaded.append(True)
        return {"examples": ["SELECT 1"], "docs_uri": "artifact://" + "b" * 64}

    reg.register(
        "db.query",
        summary="Query the database.",
        schema={"type": "object"},
        examples_factory=lazy_examples,
    )

    # layer1_index() and activate() must NOT trigger examples loading
    reg.layer1_index()
    reg.activate("db.query")
    assert layer3_loaded == [], "Layer 3 must not load during layer1 or activate"

    # Only examples() triggers the load
    payload = reg.examples("db.query")
    assert layer3_loaded == [True]
    assert "examples" in payload


def test_aos_f10_examples_tool_without_layer3():
    """examples() on a tool with no Layer 3 returns an empty dict, not an error."""
    reg = DisclosureRegistry()
    reg.register("simple.tool", summary="No examples registered.", schema={"type": "object"})
    result = reg.examples("simple.tool")
    assert isinstance(result, dict)
    assert result == {} or "examples" in result


def test_aos_f10_examples_unknown_tool_raises():
    """examples() raises KeyError for an unregistered tool."""
    reg = DisclosureRegistry()
    with pytest.raises(KeyError):
        reg.examples("nonexistent.tool")


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------


def test_module_singleton_exists():
    """benny.core.disclosure exposes a module-level `registry` instance."""
    from benny.core import disclosure
    assert hasattr(disclosure, "registry")
    assert isinstance(disclosure.registry, DisclosureRegistry)
