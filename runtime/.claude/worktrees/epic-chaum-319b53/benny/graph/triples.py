"""
Triple Persistence - Merging knowledge triples into the Neo4j Graph.
"""

import logging
from typing import List, Dict, Any
from ..core.graph_db import get_driver
from ..core.schema import KnowledgeTriple

logger = logging.getLogger(__name__)

async def save_knowledge_triples(workspace: str, triples: List[KnowledgeTriple], source_file: str):
    """
    Persist a list of extracted triples into Neo4j.
    Merges Concepts and creates typed relationships.
    """
    driver = get_driver()
    
    # 1. Create the Source Document node if it doesn't exist
    source_query = """
    MERGE (d:Document {name: $name, workspace: $workspace})
    ON CREATE SET d.created_at = timestamp()
    ON MATCH SET  d.updated_at = timestamp()
    RETURN d
    """
    
    # 2. Add each triple
    # Note: We use MERGE for concepts to deduplicate them by name+workspace
    triple_query = """
    MATCH (d:Document {name: $source, workspace: $workspace})

    MERGE (s:Concept {name: $subject, workspace: $workspace})
    ON CREATE SET s.type = $subject_type, s.created_at = timestamp()
    ON MATCH SET  s.type = $subject_type, s.updated_at = timestamp()

    MERGE (o:Concept {name: $object, workspace: $workspace})
    ON CREATE SET o.type = $object_type, o.created_at = timestamp()
    ON MATCH SET  o.type = $object_type, o.updated_at = timestamp()

    MERGE (s)-[r:REL {predicate: $predicate}]->(o)
    ON CREATE SET
        r.confidence     = $confidence,
        r.citation       = $citation,
        r.workspace      = $workspace,
        r.model_id       = $model_id,
        r.strategy       = $strategy,
        r.rationale      = $rationale,
        r.source_file    = $source_file,
        r.doc_fragment_id = $doc_fragment_id,
        r.created_at     = timestamp()
    ON MATCH SET
        r.confidence     = $confidence,
        r.citation       = $citation,
        r.model_id       = $model_id,
        r.strategy       = $strategy,
        r.rationale      = $rationale,
        r.source_file    = $source_file,
        r.doc_fragment_id = $doc_fragment_id,
        r.updated_at     = timestamp()

    MERGE (d)-[:CONTAINS]->(s)
    MERGE (d)-[:CONTAINS]->(o)
    """

    with driver.session() as session:
        # Ensure source exists
        session.run(source_query, name=source_file, workspace=workspace)

        # Batch insert triples
        for t in triples:
            import hashlib
            # Generate doc_fragment_id from citation text for DNA trace
            fragment_id = hashlib.md5(
                (t.citation or f"{t.subject}|{t.predicate}|{t.object}").encode()
            ).hexdigest()[:12]

            rationale = (
                f"Extracted from '{source_file}' via '{t.strategy}' strategy "
                f"using model '{t.model_id}' (confidence={t.confidence:.2f})"
            )

            try:
                session.run(
                    triple_query,
                    source=source_file,
                    workspace=workspace,
                    subject=t.subject,
                    subject_type=t.subject_type,
                    predicate=t.predicate,
                    object=t.object,
                    object_type=t.object_type,
                    confidence=t.confidence,
                    citation=t.citation,
                    model_id=t.model_id,
                    strategy=t.strategy,
                    rationale=rationale,
                    source_file=source_file,
                    doc_fragment_id=getattr(t, 'fragment_id', fragment_id)
                )
            except Exception as e:
                logger.error(f"Failed to save triple {t.subject}->{t.object}: {e}")

    logger.info(f"Successfully persisted {len(triples)} triples from {source_file} to graph.")
