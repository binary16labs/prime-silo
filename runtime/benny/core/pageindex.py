"""
PageIndex spine — the deterministic, vectorless document backbone.

This module owns the *pure* half of the PageIndex-first ingestion strategy
(PIX-001 / ADR-002): the hierarchical "indexed abstract" tree and the
deterministic operations over it. It deliberately contains **no LLM calls and
no Neo4j driver** so that the core spine claims — completeness, provenance,
reproducibility — are unit-testable offline and byte-replay identical.

The LLM-dependent half (building a tree from raw document text via call_model)
and the graph-write half (persisting Section nodes to Neo4j) live in later
phases and are layered *on top* of these primitives; they consume what this
module produces. See docs/requirements/12/.

Tree node shape (a plain dict so it round-trips through JSON unchanged):

    {
        "node_id":   "0.0",            # stable, unique, dotted path
        "title":     "Installation",
        "summary":   "How to install the desktop app.",
        "page_range": [3, 5],           # optional; [start, end] inclusive
        "text":      "full body ...",   # leaves carry body text; branches may omit
        "children":  [ <node>, ... ],
    }

A "leaf" is any node with no children. Triple extraction fans out over leaves;
the abstract outline (titles + summaries only) is the cheap layer a coordinator
agent reads first to decide which sections to open.
"""

from __future__ import annotations

from typing import Any, Dict, List, TypedDict


class TreeNode(TypedDict, total=False):
    node_id: str
    title: str
    summary: str
    page_range: List[int]
    text: str
    children: List["TreeNode"]


# How the fan-out section dicts are keyed for parallel_extract_triples.
# Mirrors benny/synthesis/engine.py::parallel_extract_triples(sections=[{title,text}])
# and adds `node_id` so every extracted triple can be anchored to its Section
# instead of only to a filename.
SectionDict = Dict[str, str]


def iter_nodes(tree: TreeNode) -> List[TreeNode]:
    """Depth-first, left-to-right list of every node in the tree (root first).

    Deterministic: the order is a pure function of the tree structure, so the
    same tree always yields the same traversal — the basis of the determinism
    guarantee (PIX-F3).
    """
    out: List[TreeNode] = [tree]
    for child in tree.get("children", []) or []:
        out.extend(iter_nodes(child))
    return out


def flatten_leaves(tree: TreeNode) -> List[TreeNode]:
    """Return every leaf node (no children) that carries non-empty body text.

    There is intentionally **no truncation cap** here — the whole document is
    covered. This is the explicit fix for the legacy ``chunks[:10]`` partition
    in rag_routes.py, which silently dropped everything past the 10th paragraph.
    """
    leaves: List[TreeNode] = []
    for node in iter_nodes(tree):
        if node.get("children"):
            continue
        if (node.get("text") or "").strip():
            leaves.append(node)
    return leaves


def tree_to_sections(tree: TreeNode) -> List[SectionDict]:
    """Project leaves into the section dicts ``parallel_extract_triples`` expects.

    Each section preserves its ``node_id`` so triple provenance survives the
    hand-off into synthesis (PIX-F2). Order is deterministic (depth-first).
    """
    return [
        {
            "node_id": leaf.get("node_id", ""),
            "title": leaf.get("title", ""),
            "text": leaf.get("text", ""),
        }
        for leaf in flatten_leaves(tree)
    ]


def abstract_outline(tree: TreeNode, _depth: int = 0) -> str:
    """Render the compact "indexed abstract": titles + summaries, no body text.

    This is the human-readable map *and* the single-call retrieval payload — it
    must stay small, so body ``text`` is never included (PIX-F4).
    """
    lines: List[str] = []
    indent = "  " * _depth
    title = tree.get("title", "(untitled)")
    nid = tree.get("node_id", "")
    summary = (tree.get("summary") or "").strip()
    header = f"{indent}- [{nid}] {title}" if nid else f"{indent}- {title}"
    if summary:
        header += f": {summary}"
    lines.append(header)
    for child in tree.get("children", []) or []:
        lines.append(abstract_outline(child, _depth + 1))
    return "\n".join(lines)


def build_section_edges(document_source: str, tree: TreeNode) -> List[Dict[str, Any]]:
    """Produce the (Document)-[:HAS_SECTION]->(Section)-[:HAS_SECTION]->... edge
    payloads for Neo4j — as **pure data**, no driver. The graph-write phase
    consumes these; tests assert the spine is fully connected with no orphans
    (PIX-F5).

    The root node attaches to the Document; every other node attaches to its
    parent Section.
    """
    edges: List[Dict[str, Any]] = []

    def walk(node: TreeNode, parent_kind: str, parent_id: str) -> None:
        nid = node.get("node_id", "")
        edges.append(
            {
                "from_kind": parent_kind,
                "from_id": parent_id,
                "rel": "HAS_SECTION",
                "to_kind": "Section",
                "to_id": nid,
                "title": node.get("title", ""),
                "summary": node.get("summary", ""),
                "page_range": node.get("page_range"),
            }
        )
        for child in node.get("children", []) or []:
            walk(child, "Section", nid)

    walk(tree, "Document", document_source)
    return edges


def validate_tree(tree: TreeNode) -> List[str]:
    """Return a list of structural problems (empty list == valid).

    Enforces the invariants the rest of the spine relies on:
      * every node has a node_id
      * node_ids are unique (provenance keys must not collide) (PIX-F6)
    """
    problems: List[str] = []
    seen: Dict[str, int] = {}
    for node in iter_nodes(tree):
        nid = node.get("node_id")
        if not nid:
            problems.append(f"node missing node_id: title={node.get('title')!r}")
            continue
        seen[nid] = seen.get(nid, 0) + 1
    for nid, count in seen.items():
        if count > 1:
            problems.append(f"duplicate node_id {nid!r} ({count} occurrences)")
    return problems
