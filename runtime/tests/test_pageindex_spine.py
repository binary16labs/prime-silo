"""
Test suite for PIX-001 Phase 0 — PageIndex vectorless spine (ADR-002).

These tests pin the *deterministic* claims of the spine without any LLM or
Neo4j: completeness (whole doc covered, no chunks[:10] cap), provenance
(node_id survives into the fan-out sections), reproducibility (same tree →
same order), the abstract layer staying body-free, a connected Section graph,
and node_id uniqueness.

Run with:
    python -m pytest tests/test_pageindex_spine.py -v
"""

import copy

from benny.core.pageindex import (
    abstract_outline,
    build_section_edges,
    flatten_leaves,
    iter_nodes,
    tree_to_sections,
    validate_tree,
)


def _fixture_tree():
    """A small prime_silo_self-style tree with > 10 leaves on purpose, so the
    'no truncation cap' assertion actually bites against the legacy chunks[:10].
    """
    leaves = [
        {
            "node_id": f"0.{i}",
            "title": f"Section {i}",
            "summary": f"Summary of section {i}.",
            "page_range": [i, i],
            "text": f"Body text for section {i}. " * 3,
        }
        for i in range(13)  # 13 > 10
    ]
    return {
        "node_id": "0",
        "title": "USER_GUIDE",
        "summary": "Top-level guide.",
        "page_range": [0, 13],
        "children": leaves,
    }


def test_flatten_leaves_covers_whole_document():
    """Every leaf is returned — no 10-item cap (the legacy chunks[:10] bug)."""
    tree = _fixture_tree()
    leaves = flatten_leaves(tree)
    assert len(leaves) == 13
    assert [l["node_id"] for l in leaves] == [f"0.{i}" for i in range(13)]


def test_sections_preserve_provenance():
    """Each fan-out section carries node_id + title + text for triple anchoring."""
    sections = tree_to_sections(_fixture_tree())
    assert len(sections) == 13
    for sec in sections:
        assert sec["node_id"]
        assert sec["title"]
        assert sec["text"].strip()


def test_partition_is_deterministic():
    """Same tree → identical section ordering on repeated calls (PIX-F3)."""
    tree = _fixture_tree()
    first = tree_to_sections(tree)
    second = tree_to_sections(copy.deepcopy(tree))
    assert [s["node_id"] for s in first] == [s["node_id"] for s in second]


def test_empty_leaves_are_skipped():
    """Leaves with no body text never become fan-out work units."""
    tree = _fixture_tree()
    tree["children"].append(
        {"node_id": "0.99", "title": "Empty", "summary": "blank", "text": "   "}
    )
    ids = [s["node_id"] for s in tree_to_sections(tree)]
    assert "0.99" not in ids


def test_abstract_outline_excludes_body_text():
    """The indexed abstract is titles + summaries only — never the body
    (so it stays cheap as the single-call retrieval payload)."""
    tree = _fixture_tree()
    outline = abstract_outline(tree)
    assert "USER_GUIDE" in outline
    assert "Summary of section 4." in outline
    assert "[0.4]" in outline
    # Body text must NOT leak into the abstract layer.
    assert "Body text for section" not in outline


def test_section_edges_connect_every_node_no_orphans():
    """The Section graph is fully connected: root → Document, every other node
    → its parent Section; no node is left unlinked (PIX-F5)."""
    tree = _fixture_tree()
    edges = build_section_edges("USER_GUIDE.md", tree)
    # One edge per node (root attaches to Document, rest to their parent).
    assert len(edges) == len(iter_nodes(tree))
    # Root attaches to the Document.
    root_edge = [e for e in edges if e["to_id"] == "0"][0]
    assert root_edge["from_kind"] == "Document"
    assert root_edge["from_id"] == "USER_GUIDE.md"
    # Every leaf attaches to the root Section "0".
    leaf_edges = [e for e in edges if e["to_id"].startswith("0.")]
    assert all(e["from_id"] == "0" and e["from_kind"] == "Section" for e in leaf_edges)


def test_validate_tree_passes_on_good_tree():
    assert validate_tree(_fixture_tree()) == []


def test_validate_tree_flags_duplicate_node_ids():
    tree = _fixture_tree()
    tree["children"][1]["node_id"] = "0.0"  # collide with children[0]
    problems = validate_tree(tree)
    assert any("duplicate node_id" in p for p in problems)


def test_validate_tree_flags_missing_node_id():
    tree = _fixture_tree()
    del tree["children"][2]["node_id"]
    problems = validate_tree(tree)
    assert any("missing node_id" in p for p in problems)
