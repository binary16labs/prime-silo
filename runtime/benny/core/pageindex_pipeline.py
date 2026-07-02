"""
PageIndex pipeline — deterministic fan-out + Section graph (PIX-F10/F11/F12).

Orchestrates the vectorless ingestion path on top of the pure spine and the
builder:

    extract text → build tree → persist JSON → write Section graph (Neo4j) →
    fan triple extraction over leaves (provenance-anchored)

The triple fan-out keeps each leaf's `node_id` alongside its result, so every
persisted triple is anchored to its Section + page range — not just a filename
(the gap in the legacy `chunks[:10]` path).

Neo4j writes degrade gracefully: if the driver is unavailable the run still
produces the tree + abstract and reports the graph step as skipped, so the
pipeline is demonstrable offline.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Dict, List, Optional

from .pageindex import TreeNode, build_section_edges, flatten_leaves

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Section graph write (PIX-F12)
# --------------------------------------------------------------------------- #


def save_section_tree(workspace: str, source: str, tree: TreeNode) -> Dict[str, Any]:
    """Write (:Document)-[:HAS_SECTION]->(:Section)-[:HAS_SECTION]->... to Neo4j.

    Returns a status dict; never raises on a missing/closed driver so callers
    can run the rest of the pipeline offline.
    """
    edges = build_section_edges(source, tree)
    try:
        from .graph_db import get_driver

        driver = get_driver()
    except Exception as e:
        logger.warning("Section graph skipped (no Neo4j driver): %s", e)
        return {"written": False, "reason": str(e), "sections": len(edges)}

    doc_query = """
    MERGE (d:Document {name: $source, workspace: $ws})
    ON CREATE SET d.created_at = timestamp()
    ON MATCH  SET d.updated_at = timestamp()
    """
    section_query = """
    MERGE (s:Section {node_id: $node_id, source: $source, workspace: $ws})
    SET s.title = $title, s.summary = $summary,
        s.page_start = $page_start, s.page_end = $page_end
    """
    edge_doc_query = """
    MATCH (d:Document {name: $from_id, workspace: $ws})
    MATCH (s:Section {node_id: $to_id, source: $source, workspace: $ws})
    MERGE (d)-[:HAS_SECTION]->(s)
    """
    edge_sec_query = """
    MATCH (p:Section {node_id: $from_id, source: $source, workspace: $ws})
    MATCH (c:Section {node_id: $to_id, source: $source, workspace: $ws})
    MERGE (p)-[:HAS_SECTION]->(c)
    """
    try:
        with driver.session() as session:
            session.run(doc_query, source=source, ws=workspace)
            for e in edges:
                pr = e.get("page_range") or [None, None]
                session.run(
                    section_query,
                    node_id=e["to_id"],
                    source=source,
                    ws=workspace,
                    title=e.get("title", ""),
                    summary=e.get("summary", ""),
                    page_start=pr[0],
                    page_end=pr[1] if len(pr) > 1 else None,
                )
            for e in edges:
                if e["from_kind"] == "Document":
                    session.run(
                        edge_doc_query,
                        from_id=e["from_id"],
                        to_id=e["to_id"],
                        source=source,
                        ws=workspace,
                    )
                else:
                    session.run(
                        edge_sec_query,
                        from_id=e["from_id"],
                        to_id=e["to_id"],
                        source=source,
                        ws=workspace,
                    )
        return {"written": True, "sections": len(edges)}
    except Exception as e:
        logger.warning("Section graph write failed: %s", e)
        return {"written": False, "reason": str(e), "sections": len(edges)}


# --------------------------------------------------------------------------- #
# Provenance-anchored triple fan-out (PIX-F10 / PIX-F11)
# --------------------------------------------------------------------------- #


def _fragment_id(source: str, node_id: str) -> str:
    return hashlib.md5(f"{source}#{node_id}".encode()).hexdigest()[:12]


async def extract_triples_over_tree(
    workspace: str,
    source: str,
    tree: TreeNode,
    model: Optional[str] = None,
    parallel_limit: int = 2,
    strategy: str = "safe",
    run_id: Optional[str] = None,
) -> List[Any]:
    """Fan the per-section extractor over EVERY leaf (no cap), stamping each
    resulting triple with its Section node_id + page range for provenance.
    """
    from ..synthesis.engine import extract_directed_triples_from_section

    leaves = flatten_leaves(tree)
    semaphore = asyncio.Semaphore(parallel_limit)
    {l.get("title", ""): l for l in leaves}

    async def run_leaf(leaf: TreeNode) -> List[Any]:
        async with semaphore:
            try:
                triples = await extract_directed_triples_from_section(
                    text=leaf.get("text", ""),
                    section_title=leaf.get("title", ""),
                    workspace=workspace,
                    model=model,
                    strategy=strategy,
                    run_id=run_id,
                )
            except Exception as e:
                logger.warning("Extraction failed for %s: %s", leaf.get("node_id"), e)
                return []
            nid = leaf.get("node_id", "")
            pr = leaf.get("page_range")
            for t in triples:
                # Anchor to the Section (PIX-F11): node_id-derived fragment + citation.
                t.fragment_id = _fragment_id(source, nid)
                if not t.section_title:
                    t.section_title = leaf.get("title", "")
                page = f" p.{pr[0]}-{pr[1]}" if pr else ""
                if not t.citation:
                    t.citation = f"{source} §{nid}{page}"
            return triples

    results = await asyncio.gather(*(run_leaf(l) for l in leaves))
    flat: List[Any] = []
    for group in results:
        flat.extend(group)
    return flat


# --------------------------------------------------------------------------- #
# Full vectorless ingestion (PIX-F7..F12 end to end)
# --------------------------------------------------------------------------- #


async def run_pageindex_ingest(
    workspace: str,
    source: str,
    text: str,
    model: Optional[str] = None,
    use_llm_summaries: bool = False,
    write_graph: bool = True,
    extract_triples: bool = True,
    save_triples: bool = True,
    strategy: str = "safe",
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    """End-to-end vectorless ingest for a single document. Returns a report dict
    that the CLI / ingest route surface to the operator.
    """
    from .pageindex import abstract_outline
    from .pageindex_builder import build_document_tree, enrich_summaries, persist_tree

    tree = build_document_tree(text, source)
    if use_llm_summaries:
        tree = await enrich_summaries(tree, model=model, workspace=workspace)

    json_path = persist_tree(workspace, source, tree)
    leaves = flatten_leaves(tree)

    report: Dict[str, Any] = {
        "source": source,
        "workspace": workspace,
        "tree_json": str(json_path),
        "sections": len(leaves),
        "outline": abstract_outline(tree),
        "graph": {"written": False, "skipped": True},
        "triples": 0,
    }

    if write_graph:
        report["graph"] = save_section_tree(workspace, source, tree)

    if extract_triples:
        triples = await extract_triples_over_tree(
            workspace, source, tree, model=model, strategy=strategy, run_id=run_id
        )
        report["triples"] = len(triples)
        if save_triples and triples:
            try:
                from ..graph.triples import save_knowledge_triples

                await save_knowledge_triples(workspace, triples, source)
                report["triples_saved"] = True
            except Exception as e:
                logger.warning("Triple persistence skipped: %s", e)
                report["triples_saved"] = False
                report["triples_save_error"] = str(e)

    return report
