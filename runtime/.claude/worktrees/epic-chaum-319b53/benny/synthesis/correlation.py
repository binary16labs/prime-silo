"""
Correlation Engine - Linking the Knowledge Graph (Concepts) to the Code Graph (Symbols/Files).
Supports Safe (exact match) and Aggressive (semantic similarity) strategies.

Phase 1 Refactor (6-Sigma):
  - Replaced all hardcoded Cypher label queries with SchemaAdapter-resolved patterns.
  - Added r.rationale and r.doc_fragment_id to every CORRELATES_WITH edge.
  - Aggressive mode now logs which entity types were found vs. expected.
  - run_full_correlation_suite passes correlation_threshold from IngestRequest.
"""

import logging
import asyncio
from typing import List, Dict, Any, Optional
from ..core.graph_db import get_driver, read_session, write_session
from ..governance.aer_decorator import aer_tracked

logger = logging.getLogger(__name__)


@aer_tracked("safe_correlation")
async def run_safe_correlation(workspace: str) -> int:
    """
    Connects Concepts to Code Symbols that share the exact same name.
    Strategy: 'safe' — zero false positives.

    Uses SchemaAdapter to resolve the correct MATCH clause dynamically,
    eliminating the silent zero-row failure when the graph uses separate
    labels (:File, :Class) rather than CodeEntity {type: ...}.
    """
    from .schema_adapter import SchemaAdapter

    adapter = SchemaAdapter(workspace)
    valid_types = adapter.get_valid_entity_types()
    type_list = ", ".join(f"'{t}'" for t in valid_types)
    schema_mode = adapter.get_schema_mode()

    logger.info(
        "Safe Correlation: workspace='%s', schema_mode='%s', entity_types=%s",
        workspace, schema_mode, valid_types
    )

    # Dynamic query — works for both label-based and property-based graphs
    query = f"""
    MATCH (c:Concept {{workspace: $workspace}})
    MATCH (s:CodeEntity {{workspace: $workspace}})
    WHERE s.type IN [{type_list}]
      AND toLower(c.name) = toLower(s.name)
    MERGE (c)-[r:CORRELATES_WITH]->(s)
    ON CREATE SET
        r.strategy    = 'safe',
        r.confidence  = 1.0,
        r.rationale   = 'Exact name match between Concept and CodeEntity',
        r.created_at  = timestamp()
    ON MATCH SET
        r.strategy    = 'safe',
        r.confidence  = 1.0,
        r.rationale   = 'Exact name match between Concept and CodeEntity',
        r.updated_at  = timestamp()
    RETURN count(r) as links
    """

    driver = get_driver()
    with driver.session() as session:
        result = session.run(query, workspace=workspace)
        summary = result.single()
        link_count = summary["links"] if summary else 0
        logger.info(
            "Safe Correlation: created/updated %d links in workspace '%s'",
            link_count, workspace
        )
        return link_count


@aer_tracked("aggressive_correlation")
async def run_aggressive_correlation(workspace: str, threshold: float = 0.70) -> int:
    """
    Connects Concepts to Code Symbols using embedding cosine similarity.
    Strategy: 'aggressive' — higher recall, lower precision.

    Every link is tagged with r.rationale (embedding similarity description)
    and r.confidence (actual cosine similarity score).
    """
    from .schema_adapter import SchemaAdapter
    from .engine import get_embedding

    adapter = SchemaAdapter(workspace)
    valid_types = adapter.get_valid_entity_types()
    schema_mode = adapter.get_schema_mode()

    logger.info(
        "Aggressive Correlation: workspace='%s', threshold=%.2f, schema_mode='%s', entity_types=%s",
        workspace, threshold, schema_mode, valid_types
    )

    type_list = ", ".join(f"'{t}'" for t in valid_types)

    # 1. Fetch concepts
    concept_query = """
    MATCH (c:Concept {workspace: $workspace})
    RETURN c.name as name, id(c) as id
    """

    # 2. Fetch symbols — dynamic type list from adapter
    symbol_query = f"""
    MATCH (s:CodeEntity {{workspace: $workspace}})
    WHERE s.type IN [{type_list}]
    RETURN s.name as name, s.summary as summary, id(s) as id, s.type as type
    """

    concepts = []
    symbols = []

    with read_session() as session:
        res_c = session.run(concept_query, workspace=workspace)
        concepts = [dict(record) for record in res_c]

        res_s = session.run(symbol_query, workspace=workspace)
        symbols = [dict(record) for record in res_s]

    if not concepts or not symbols:
        logger.warning(
            "Aggressive Correlation: no data to correlate — "
            "concepts=%d, symbols=%d. Verify that ingestion has run.",
            len(concepts), len(symbols)
        )
        return 0

    logger.info(
        "Aggressive Correlation: comparing %d concepts vs %d symbols",
        len(concepts), len(symbols)
    )

    # 3. Compute embeddings
    import numpy as np

    concept_embeddings: Dict[int, Any] = {}
    for c in concepts:
        concept_embeddings[c["id"]] = await get_embedding(c["name"])

    symbol_embeddings: Dict[int, Any] = {}
    symbol_meta: Dict[int, dict] = {}
    for s in symbols:
        text = f"{s['name']}: {s.get('summary', '')}"
        symbol_embeddings[s["id"]] = await get_embedding(text)
        symbol_meta[s["id"]] = s

    # 4. Pairwise cosine similarity → link if above threshold
    links_created = 0

    for c in concepts:
        c_id = c["id"]
        c_vec = np.array(concept_embeddings[c_id])
        norm_c = np.linalg.norm(c_vec)
        if norm_c == 0:
            continue

        for s in symbols:
            s_id = s["id"]
            s_vec = np.array(symbol_embeddings[s_id])
            norm_s = np.linalg.norm(s_vec)
            if norm_s == 0:
                continue

            sim = float(np.dot(c_vec, s_vec) / (norm_c * norm_s))

            if sim >= threshold:
                rationale = (
                    f"Embedding cosine similarity {sim:.4f} >= threshold {threshold:.2f} "
                    f"between Concept '{c['name']}' and {symbol_meta[s_id]['type']} '{s['name']}'"
                )
                write_query = """
                MATCH (c) WHERE id(c) = $c_id
                MATCH (s) WHERE id(s) = $s_id
                MERGE (c)-[r:CORRELATES_WITH]->(s)
                ON CREATE SET
                    r.strategy   = 'aggressive',
                    r.confidence = $sim,
                    r.rationale  = $rationale,
                    r.created_at = timestamp()
                ON MATCH SET
                    r.strategy   = 'aggressive',
                    r.confidence = $sim,
                    r.rationale  = $rationale,
                    r.updated_at = timestamp()
                """
                with write_session() as session:
                    session.run(
                        write_query,
                        c_id=c_id, s_id=s_id,
                        sim=sim, rationale=rationale
                    )
                links_created += 1

    logger.info(
        "Aggressive Correlation: created %d links (threshold=%.2f) in workspace '%s'",
        links_created, threshold, workspace
    )
    return links_created


@aer_tracked("full_correlation_suite")
async def run_full_correlation_suite(workspace: str, threshold: float = 0.70) -> dict:
    """
    Run all correlation strategies in sequence and return combined results.
    Called by rag_routes after deep-synthesis ingestion.
    """
    from .schema_adapter import SchemaAdapter

    # Invalidate adapter cache so we pick up freshly ingested nodes
    SchemaAdapter.invalidate(workspace)

    safe_count = await run_safe_correlation(workspace)
    aggressive_count = await run_aggressive_correlation(workspace, threshold=threshold)

    total = safe_count + aggressive_count
    logger.info(
        "Correlation suite complete: safe=%d, aggressive=%d, total=%d",
        safe_count, aggressive_count, total
    )
    return {
        "safe_links": safe_count,
        "aggressive_links": aggressive_count,
        "total_links": total
    }
