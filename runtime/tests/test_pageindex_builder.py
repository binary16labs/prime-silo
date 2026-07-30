"""
Tests for PIX-001 Phases 1–2 — builder + pipeline (ADR-002).

Covers the deterministic markdown tree build, branch-prose preservation,
persistence + path-traversal rejection, provenance-anchored triple fan-out
(mocked extractor), and graceful Neo4j degradation. No live LLM or DB.

Run with:
    python -m pytest tests/test_pageindex_builder.py -v
"""

import asyncio
from unittest.mock import AsyncMock, patch

from benny.core import pageindex_builder as pb
from benny.core import pageindex_pipeline as pp
from benny.core.pageindex import flatten_leaves, tree_to_sections, validate_tree

MD = """# User Guide

Intro paragraph for the whole guide.

## Installation

Install the desktop app from the release page.

### Windows

Run the signed installer.

### macOS

Drag to Applications.

## Configuration

Set the home directory in the tray.
"""


def test_markdown_build_is_nested_and_valid():
    tree = pb.build_tree_from_markdown(MD, title="User Guide")
    assert validate_tree(tree) == []
    titles = {n["title"] for n in _all_titles(tree)}
    assert "Installation" in titles
    assert "Windows" in titles
    assert "Configuration" in titles


def _all_titles(tree):
    from benny.core.pageindex import iter_nodes
    return iter_nodes(tree)


def test_branch_prose_preserved_as_overview_leaf():
    """A heading with both prose and sub-headings keeps its prose as a leaf."""
    tree = pb.build_tree_from_markdown(MD, title="User Guide")
    leaf_titles = [l["title"] for l in flatten_leaves(tree)]
    # "Installation" has prose AND sub-headings → an "(overview)" leaf appears.
    assert "Installation (overview)" in leaf_titles
    # Root preamble is preserved too.
    assert any("(overview)" in t for t in leaf_titles)
    # Every leaf carries text.
    assert all(l.get("text", "").strip() for l in flatten_leaves(tree))


def test_no_heading_uses_generic_builder():
    tree = pb.build_document_tree("just some flat text with no headings at all.", "notes.txt")
    leaves = flatten_leaves(tree)
    assert len(leaves) >= 1
    assert validate_tree(tree) == []


def test_persist_and_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(pb, "get_workspace_path", lambda ws, sub="": tmp_path)
    tree = pb.build_tree_from_markdown(MD, title="User Guide")
    path = pb.persist_tree("ws", "USER_GUIDE.md", tree)
    assert path.exists()
    loaded = pb.load_tree("ws", "USER_GUIDE.md")
    assert tree_to_sections(loaded) == tree_to_sections(tree)
    assert "USER_GUIDE.md" in pb.list_trees("ws")


def test_persist_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(pb, "get_workspace_path", lambda ws, sub="": tmp_path)
    tree = pb.build_tree_from_markdown(MD, title="x")
    # A traversal source name must be stripped to its basename, never escape.
    path = pb.persist_tree("ws", "../../evil.md", tree)
    assert path.parent == (tmp_path / ".benny" / "pageindex")
    assert path.name == "evil.md.json"


def test_deterministic_summary_fallback():
    s = pb._first_sentence("This is the first sentence. This is the second.")
    assert s == "This is the first sentence."


def test_fanout_stamps_section_provenance():
    """Mocked extractor → every triple is anchored to its Section node_id."""
    from benny.core.schema import KnowledgeTriple

    tree = pb.build_tree_from_markdown(MD, title="User Guide")

    async def fake_extract(text, section_title, **kwargs):
        return [KnowledgeTriple(subject="A", predicate="rel", object="B")]

    with patch(
        "benny.synthesis.engine.extract_directed_triples_from_section",
        new=AsyncMock(side_effect=fake_extract),
    ):
        triples = asyncio.run(
            pp.extract_triples_over_tree("ws", "USER_GUIDE.md", tree, parallel_limit=2)
        )

    n_leaves = len(flatten_leaves(tree))
    assert len(triples) == n_leaves  # one triple per leaf, whole doc covered
    for t in triples:
        assert t.fragment_id  # anchored to a Section (node_id-derived)
        assert "USER_GUIDE.md §" in t.citation
        assert t.section_title


def test_save_section_tree_degrades_without_neo4j():
    """With no Neo4j driver available the pipeline must not crash — it reports
    the graph step as skipped and still counts the sections it *would* write.
    Force the no-driver path so the test holds whether or not neo4j is installed
    or a server is running in the dev environment."""
    import benny.core.graph_db as graph_db

    tree = pb.build_tree_from_markdown(MD, title="User Guide")
    with patch.object(graph_db, "get_driver", side_effect=RuntimeError("no neo4j")):
        status = pp.save_section_tree("ws", "USER_GUIDE.md", tree)
    assert status["written"] is False
    assert status["sections"] > 0
