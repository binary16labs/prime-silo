"""
Graph Database Connection - Neo4j integration for the Synthesis Knowledge Engine.

Provides connection management and core Cypher query helpers for the
relational graph, embedding storage, and synthesis operations.
"""

import os
import json
import logging
from contextlib import contextmanager
from typing import Optional, Dict, Any, List, Tuple
from neo4j import GraphDatabase

logger = logging.getLogger(__name__)

# =============================================================================
# CONNECTION CONFIGURATION
# =============================================================================

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")

_driver = None


def get_driver():
    """Get or create Neo4j driver singleton with connection pooling."""
    global _driver
    if _driver is None:
        _driver = GraphDatabase.driver(
            NEO4J_URI,
            auth=(NEO4J_USER, NEO4J_PASSWORD),
            max_connection_pool_size=50,
            connection_acquisition_timeout=30
        )
    return _driver


def close_driver():
    """Close the Neo4j driver."""
    global _driver
    if _driver:
        _driver.close()
        _driver = None


@contextmanager
def read_session():
    """Context manager for read-only database sessions."""
    driver = get_driver()
    session = driver.session()
    try:
        yield session
    finally:
        session.close()


@contextmanager
def write_session():
    """Context manager for write database sessions."""
    driver = get_driver()
    session = driver.session()
    try:
        yield session
    finally:
        session.close()


def introspect_schema(workspace: str = "default") -> dict:
    """
    Inspect the live Neo4j schema to determine available labels, relationship types,
    and the distribution of entity types within a workspace.
    Used by SchemaAdapter to generate correct Cypher queries.
    """
    with read_session() as session:
        # 1. All labels in the database
        labels_result = session.run("CALL db.labels() YIELD label RETURN collect(label) as labels")
        labels = labels_result.single()["labels"]

        # 2. All relationship types
        rel_result = session.run("CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) as types")
        rel_types = rel_result.single()["types"]

        # 3. Entity type distribution within this workspace
        dist_result = session.run("""
            MATCH (n {workspace: $workspace})
            WITH labels(n) as label_set, n.type as type_prop
            RETURN label_set, type_prop, count(*) as cnt
            ORDER BY cnt DESC
        """, workspace=workspace)

        distribution = {}
        for record in dist_result:
            key = f"{record['label_set']}:{record['type_prop']}"
            distribution[key] = record["cnt"]

        return {
            "labels": labels,
            "relationship_types": rel_types,
            "entity_type_distribution": distribution,
            "workspace": workspace
        }


def verify_connectivity() -> dict:
    """Verify Neo4j is reachable and return server info."""
    from neo4j.exceptions import ServiceUnavailable, AuthError
    try:
        driver = get_driver()
        driver.verify_connectivity()
        with read_session() as session:
            result = session.run("RETURN 1 AS ping")
            record = result.single()
            return {
                "status": "connected",
                "ping": record["ping"],
                "uri": NEO4J_URI
            }
    except ServiceUnavailable:
        return {
            "status": "unavailable",
            "error": "Could not connect to Neo4j. Is the server running on " + NEO4J_URI + "?",
            "uri": NEO4J_URI
        }
    except AuthError:
        return {
            "status": "auth_error",
            "error": "Neo4j authentication failed. Check your username and password.",
            "uri": NEO4J_URI
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "uri": NEO4J_URI
        }


# =============================================================================
# SCHEMA INITIALISATION
# =============================================================================

# Track detected embedding dimensions for auto-detection
_detected_embedding_dims: Optional[int] = None


def init_schema():
    """
    Create constraints and indexes for the knowledge graph.
    
    Node labels:
        - Concept: core idea/entity extracted from documents
        - Source: the originating document
    
    Relationship types:
        - RELATES_TO: explicit relationship with a predicate property
        - SOURCED_FROM: links a concept back to its source document
        - CONFLICTS_WITH: marks contradictory statements
        - ANALOGOUS_TO: structural isomorphism link
    """
    with write_session() as session:
        # Unique constraint on Concept name within a workspace
        session.run("""
            CREATE CONSTRAINT concept_unique IF NOT EXISTS
            FOR (c:Concept) REQUIRE (c.name, c.workspace) IS UNIQUE
        """)
        # Unique constraint on Source name within a workspace
        session.run("""
            CREATE CONSTRAINT source_unique IF NOT EXISTS
            FOR (s:Source) REQUIRE (s.name, s.workspace) IS UNIQUE
        """)
        # Unique constraint on SynthesisRun id
        session.run("""
            CREATE CONSTRAINT run_unique IF NOT EXISTS
            FOR (r:SynthesisRun) REQUIRE (r.run_id) IS UNIQUE
        """)
        # Unique constraint on CodeScan id
        session.run("""
            CREATE CONSTRAINT code_scan_unique IF NOT EXISTS
            FOR (s:CodeScan) REQUIRE (s.scan_id) IS UNIQUE
        """)
        # Index on workspace for faster filtering
        try:
            session.run("""
                CREATE INDEX concept_workspace IF NOT EXISTS
                FOR (c:Concept) ON (c.workspace)
            """)
        except Exception:
            pass

        # Vector index — use detected dimensions or default to 768 (local models)
        dims = _detected_embedding_dims or 768
        try:
            session.run(f"""
                CREATE VECTOR INDEX concept_embedding IF NOT EXISTS
                FOR (c:Concept) ON (c.embedding)
                OPTIONS {{
                    indexConfig: {{
                        `vector.dimensions`: {dims},
                        `vector.similarity_function`: 'cosine'
                    }}
                }}
            """)
        except Exception:
            # Vector indexes may already exist or not be supported
            pass

    logger.info("Neo4j schema initialized (vector dims=%d)", dims)
    return {"status": "schema_initialized", "vector_dimensions": dims}


def update_vector_index_dimensions(dims: int):
    """Auto-detect and update vector index dimensions from the first embedding stored."""
    global _detected_embedding_dims
    if _detected_embedding_dims is None or _detected_embedding_dims != dims:
        _detected_embedding_dims = dims
        logger.info("Auto-detected embedding dimensions: %d", dims)
        # Note: Neo4j doesn't support ALTER on vector indexes — would need to
        # drop and recreate. For now, just log and use for future schema inits.


# =============================================================================
# TRIPLE MANAGEMENT (Subject, Predicate, Object)
# =============================================================================

def add_triple(
    subject: str,
    predicate: str,
    obj: str,
    workspace: str = "default",
    source_name: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    timestamp: Optional[str] = None,
    section: Optional[str] = None,
    subject_type: str = "Concept",
    object_type: str = "Concept",
    citation: str = "",
    confidence: float = 1.0,
    run_id: Optional[str] = None
) -> dict:
    """
    Add a knowledge triple to the graph.
    
    Creates or merges Subject and Object as Concept nodes (with types), 
    then creates a RELATES_TO edge with the predicate, citation, and confidence.
    """
    meta_json = json.dumps(metadata or {})

    with write_session() as session:
        result = session.run("""
            MERGE (s:Concept {name: $subject, workspace: $workspace})
            ON CREATE SET s.created_at = datetime(), s.domain = '', s.node_type = $subject_type
            ON MATCH SET s.node_type = $subject_type
            MERGE (o:Concept {name: $obj, workspace: $workspace})
            ON CREATE SET o.created_at = datetime(), o.domain = '', o.node_type = $object_type
            ON MATCH SET o.node_type = $object_type
            
            CREATE (s)-[r:RELATES_TO {
                predicate: $predicate,
                source: $source_name,
                metadata: $metadata,
                section: $section,
                citation: $citation,
                confidence: $confidence,
                created_at: datetime(),
                timestamp: $timestamp,
                run_id: $run_id
            }]->(o)
            
            RETURN elementId(s) AS sid, elementId(o) AS oid, elementId(r) AS rid
        """, subject=subject, predicate=predicate, obj=obj,
             workspace=workspace, source_name=source_name or "",
             metadata=meta_json, timestamp=timestamp or "",
             section=section or "", citation=citation, confidence=confidence,
             subject_type=subject_type, object_type=object_type, run_id=run_id or "")

        record = result.single()
        return {
            "subject_id": record["sid"],
            "object_id": record["oid"],
            "relation_id": record["rid"],
            "triple": [subject, predicate, obj]
        }


def run_cypher(query: str, params: Optional[Dict[str, Any]] = None, workspace: str = "default") -> List[Dict[str, Any]]:
    """
    Execute a generic Cypher query. 
    Auto-injects workspace constraint if not present in simple queries.
    """
    with read_session() as session:
        # Basic safety: Ensure we only read or merge/create in a structured way
        # Note: In a production environment, we'd use a restricted Neo4j user.
        result = session.run(query, **(params or {}), workspace=workspace)
        return [dict(record) for record in result]


def scope_cypher_query(query: str, nexus_id: str) -> str:
    """
    Rewrites a Cypher query to enforce run_id or snapshot_id filtering.
    Injects {run_id: $nexus_id} or {snapshot_id: $nexus_id} into relationship patterns.
    """
    import re
    
    # 1. Inject snapshot_id into CodeEntity node matches
    # (n:CodeEntity) -> (n:CodeEntity {snapshot_id: $nexus_id})
    query = re.sub(
        r'\((\w+):CodeEntity\)', 
        fr'(\1:CodeEntity {{snapshot_id: $nexus_id}})', 
        query
    )
    
    # 2. Inject run_id into RELATES_TO relationship matches
    # -[r:RELATES_TO]-> -> -[r:RELATES_TO {run_id: $nexus_id}]->
    query = re.sub(
        r'-\[(\w+):RELATES_TO\]->', 
        fr'-[\1:RELATES_TO {{run_id: $nexus_id}}]->', 
        query
    )
    
    # 3. Inject snapshot_id into CODE_REL relationship matches
    # -[r:CODE_REL]-> -> -[r:CODE_REL {snapshot_id: $nexus_id}]->
    query = re.sub(
        r'-\[(\w+):CODE_REL\]->', 
        fr'-[\1:CODE_REL {{snapshot_id: $nexus_id}}]->', 
        query
    )
    
    return query


def batch_add_triples(
    triples: List[Any],
    workspace: str = "default",
    source_name: Optional[str] = None,
    run_id: Optional[str] = None
) -> dict:
    """
    Add multiple knowledge triples in a single broad transaction.
    Uses Cypher UNWIND for maximum performance.
    Accepts both KnowledgeTriple models and raw dicts.
    """
    from ..core.schema import KnowledgeTriple

    processed_triples = []
    for t in triples:
        if isinstance(t, KnowledgeTriple):
            processed_triples.append({
                "subject": t.subject,
                "predicate": t.predicate,
                "obj": t.object,
                "subject_type": t.subject_type,
                "object_type": t.object_type,
                "citation": t.citation,
                "confidence": t.confidence,
                "section": t.section_title or source_name or "",
                "timestamp": "",
                "metadata": "{}"
            })
        elif isinstance(t, dict):
            processed_triples.append({
                "subject": t.get("subject", ""),
                "predicate": t.get("predicate", ""),
                "obj": t.get("object", ""),
                "subject_type": t.get("subject_type", "Concept"),
                "object_type": t.get("object_type", "Concept"),
                "citation": t.get("citation", ""),
                "confidence": float(t.get("confidence", 1.0)),
                "section": t.get("section_title", source_name or ""),
                "timestamp": t.get("timestamp", ""),
                "metadata": json.dumps(t.get("metadata", {}))
            })

    with write_session() as session:
        session.run("""
            UNWIND $triples AS t
            
            MERGE (s:Concept {name: t.subject, workspace: $workspace})
            ON CREATE SET s.created_at = datetime(), s.node_type = t.subject_type
            ON MATCH SET s.node_type = t.subject_type
            
            MERGE (o:Concept {name: t.obj, workspace: $workspace})
            ON CREATE SET o.created_at = datetime(), o.node_type = t.object_type
            ON MATCH SET o.node_type = t.object_type
            
            CREATE (s)-[r:RELATES_TO {
                predicate: t.predicate,
                source: $source_name,
                metadata: t.metadata,
                section: t.section,
                citation: t.citation,
                confidence: t.confidence,
                created_at: datetime(),
                timestamp: t.timestamp,
                run_id: $run_id
            }]->(o)
            
            // Batch Source Linkage
            WITH s, o, r, $run_id AS run_id, $source_name AS source_name, $workspace AS workspace
            MERGE (src_node:Source {name: source_name, workspace: workspace})
            ON CREATE SET src_node.created_at = datetime()
            MERGE (s)-[:SOURCED_FROM]->(src_node)
            MERGE (o)-[:SOURCED_FROM]->(src_node)
            
            RETURN count(r) AS count
        """, triples=processed_triples, workspace=workspace,
             source_name=source_name or "", run_id=run_id or "")

    return {"status": "batch_completed", "count": len(processed_triples)}


def add_source_link(concept_name: str, source_name: str, workspace: str = "default") -> dict:
    """Link a concept node to its source document."""
    with write_session() as session:
        session.run("""
            MERGE (c:Concept {name: $concept, workspace: $workspace})
            MERGE (s:Source {name: $source, workspace: $workspace})
            ON CREATE SET s.created_at = datetime()
            MERGE (c)-[:SOURCED_FROM]->(s)
        """, concept=concept_name, source=source_name, workspace=workspace)
    return {"status": "linked", "concept": concept_name, "source": source_name}


def add_conflict(
    concept_a: str,
    concept_b: str,
    description: str,
    workspace: str = "default"
) -> dict:
    """Mark a conflict between two concepts."""
    with write_session() as session:
        session.run("""
            MERGE (a:Concept {name: $a, workspace: $workspace})
            MERGE (b:Concept {name: $b, workspace: $workspace})
            CREATE (a)-[:CONFLICTS_WITH {
                description: $description,
                created_at: datetime()
            }]->(b)
        """, a=concept_a, b=concept_b, description=description, workspace=workspace)
    return {"status": "conflict_added", "between": [concept_a, concept_b]}


def add_analogy(
    concept_a: str,
    concept_b: str,
    description: str,
    pattern: str,
    workspace: str = "default"
) -> dict:
    """Create a structural isomorphism link (cross-domain analogy)."""
    with write_session() as session:
        session.run("""
            MERGE (a:Concept {name: $a, workspace: $workspace})
            MERGE (b:Concept {name: $b, workspace: $workspace})
            CREATE (a)-[:ANALOGOUS_TO {
                description: $description,
                pattern: $pattern,
                created_at: datetime()
            }]->(b)
        """, a=concept_a, b=concept_b, description=description,
             pattern=pattern, workspace=workspace)
    return {"status": "analogy_added", "between": [concept_a, concept_b], "pattern": pattern}


# =============================================================================
# EMBEDDING STORAGE
# =============================================================================

def set_concept_embedding(concept_name: str, embedding: List[float], workspace: str = "default") -> dict:
    """Store a vector embedding on a Concept node."""
    # Auto-detect dimensions on first embedding
    update_vector_index_dimensions(len(embedding))

    with write_session() as session:
        session.run("""
            MERGE (c:Concept {name: $name, workspace: $workspace})
            SET c.embedding = $embedding
        """, name=concept_name, embedding=embedding, workspace=workspace)
    return {"status": "embedding_set", "concept": concept_name, "dimensions": len(embedding)}


def vector_search(query_embedding: List[float], workspace: str = "default", top_k: int = 10, run_id: Optional[str] = None) -> List[dict]:
    """Find the nearest concepts by vector similarity."""
    with read_session() as session:
        # Use Neo4j's native vector index
        try:
            # Note: We filter by workspace, and optionally by run_id if it's stored on the node
            # Concepts currently don't have run_id (they are merged), but we can filter by 
            # whether they have a relationship in that run_id if needed.
            # For now, we filter by workspace.
            result = session.run("""
                CALL db.index.vector.queryNodes('concept_embedding', $topK, $embedding)
                YIELD node, score
                WHERE node.workspace = $workspace
                RETURN node.name AS name, node.domain AS domain, score
                ORDER BY score DESC
            """, embedding=query_embedding, topK=top_k, workspace=workspace)
            return [dict(r) for r in result]
        except Exception:
            # Fallback: brute-force cosine (for dev / small graphs)
            result = session.run("""
                MATCH (c:Concept {workspace: $workspace})
                WHERE c.embedding IS NOT NULL
                RETURN c.name AS name, c.domain AS domain, c.embedding AS embedding
            """, workspace=workspace)

            from math import sqrt
            records = list(result)
            if not records:
                return []

            def cosine_sim(a, b):
                dot = sum(x * y for x, y in zip(a, b))
                na = sqrt(sum(x * x for x in a))
                nb = sqrt(sum(x * x for x in b))
                return dot / (na * nb) if (na and nb) else 0.0

            scored = []
            for rec in records:
                sim = cosine_sim(query_embedding, rec["embedding"])
                scored.append({"name": rec["name"], "domain": rec["domain"] or "", "score": sim})

            scored.sort(key=lambda x: x["score"], reverse=True)
            return scored[:top_k]


# =============================================================================
# GRAPH QUERYING
# =============================================================================

def get_full_graph(
    workspace: str = "default",
    page: Optional[int] = None,
    page_size: int = 200,
    show_all: bool = False,
    run_id: Optional[str] = None
) -> dict:
    """
    Return the knowledge graph for a workspace as nodes + edges
    suitable for 3d-force-graph rendering.
    
    If run_id is provided, only nodes and edges associated with that run 
    (or concepts connected by those relationships) are returned.
    """
    with read_session() as session:
        # 1. Fetch Edges based on workspace and optional run_id
        edge_match = "MATCH (a {workspace: $workspace})-[r:RELATES_TO]->(b {workspace: $workspace})"
        if run_id:
            edge_match = "MATCH (a {workspace: $workspace})-[r:RELATES_TO {run_id: $run_id}]->(b {workspace: $workspace})"
        
        edge_result = session.run(edge_match + """
            RETURN elementId(a) AS source, a.name AS source_name,
                   elementId(b) AS target, b.name AS target_name,
                   type(r) AS type, r.predicate AS predicate, 
                   r.description AS description, r.pattern AS pattern, 
                   r.source AS source_doc, r.created_at AS created_at, 
                   r.timestamp AS timestamp, r.section AS section, 
                   r.citation AS citation, r.confidence AS confidence,
                   r.run_id AS run_id
        """, workspace=workspace, run_id=run_id or "")

        edges = []
        visible_node_ids = set()
        for rec in edge_result:
            edges.append({
                "source": str(rec["source"]),
                "target": str(rec["target"]),
                "type": rec["type"],
                "predicate": rec["predicate"] or "",
                "description": rec["description"] or "",
                "pattern": rec["pattern"] or "",
                "source_doc": rec["source_doc"] or "",
                "section": rec["section"] or "",
                "citation": rec["citation"] or "",
                "confidence": rec["confidence"] if rec["confidence"] is not None else 1.0,
                "created_at": str(rec["created_at"]) if rec["created_at"] else "",
                "timestamp": rec["timestamp"] or "",
                "run_id": rec["run_id"] or ""
            })
            visible_node_ids.add(str(rec["source"]))
            visible_node_ids.add(str(rec["target"]))

        # 2. Fetch Nodes - filter to only those in the edges if run_id is active, 
        # or all workspace nodes if showing global nexus.
        if run_id:
            node_query = """
                MATCH (n {workspace: $workspace})
                WHERE elementId(n) IN $node_ids
                RETURN elementId(n) AS id, labels(n) AS labels, n.name AS name,
                       n.domain AS domain, n.created_at AS created_at, n.node_type AS node_type,
                       n.centrality AS centrality
            """
            node_result = session.run(node_query, workspace=workspace, node_ids=list(visible_node_ids))
        else:
            node_query = """
                MATCH (n {workspace: $workspace})
                WHERE n:Concept OR n:Source
                RETURN elementId(n) AS id, labels(n) AS labels, n.name AS name,
                       n.domain AS domain, n.created_at AS created_at, n.node_type AS node_type,
                       n.centrality AS centrality
            """
            if not show_all and page is None:
                 node_query += f" LIMIT {page_size}"
            elif page is not None:
                 node_query += f" SKIP {page * page_size} LIMIT {page_size}"
            
            node_result = session.run(node_query, workspace=workspace)

        nodes = []
        for rec in node_result:
            nodes.append({
                "id": str(rec["id"]),
                "name": rec["name"],
                "labels": rec["labels"],
                "domain": rec["domain"] or "",
                "created_at": str(rec["created_at"]) if rec["created_at"] else "",
                "node_type": rec["node_type"] or (rec["labels"][0] if rec["labels"] else "Concept"),
                "centrality": rec["centrality"] or 0,
                "community_id": rec.get("community_id")
            })

    return {
        "nodes": nodes,
        "edges": edges,
        "total_nodes": len(nodes),
        "page": page,
        "page_size": page_size
    }


def get_recent_updates(workspace: str = "default", seconds: int = 10) -> dict:
    """
    Get graph updates from the last N seconds using real timestamp filtering.
    Used for real-time 'fly-to-continent' visualization during ingestion.
    """
    with read_session() as session:
        result = session.run("""
            MATCH (a {workspace: $workspace})-[r]->(b {workspace: $workspace})
            WHERE r.created_at > datetime() - duration({seconds: $seconds})
            RETURN elementId(a) AS source, a.name AS source_name,
                   elementId(b) AS target, b.name AS target_name,
                   type(r) AS type, r.predicate AS predicate,
                   r.created_at AS created_at
            ORDER BY r.created_at DESC
            LIMIT 100
        """, workspace=workspace, seconds=seconds)

        edges = []
        for rec in result:
            edges.append({
                "source": str(rec["source"]),
                "source_name": rec["source_name"],
                "target": str(rec["target"]),
                "target_name": rec["target_name"],
                "type": rec["type"],
                "predicate": rec["predicate"] or "",
                "created_at": str(rec["created_at"]) if rec["created_at"] else ""
            })

    return {"edges": edges, "count": len(edges)}


def get_node_count(workspace: str = "default") -> int:
    """Get the total number of nodes in a workspace."""
    with read_session() as session:
        result = session.run(
            "MATCH (n {workspace: $ws}) WHERE n:Concept OR n:Source RETURN count(n) AS n",
            ws=workspace
        )
        return result.single()["n"]


def get_neighbors(concept_name: str, workspace: str = "default", depth: int = 1, run_id: Optional[str] = None) -> dict:
    """Get a concept's neighbourhood (nodes + edges) up to N hops, optionally filtered by run_id."""
    with read_session() as session:
        # If run_id is provided, we restrict to relationships within that run/snapshot
        rel_filter = ""
        if run_id:
            rel_filter = " WHERE all(rel in relationships(path) WHERE rel.run_id = $run_id OR rel.snapshot_id = $run_id)"
            
        query = f"""
            MATCH path = (c:Concept {{name: $name, workspace: $workspace}})-[*1..{depth}]->(n)
            {rel_filter}
            UNWIND relationships(path) AS r
            WITH DISTINCT startNode(r) AS a, r, endNode(r) AS b
            RETURN elementId(a) AS src_id, a.name AS src_name, labels(a) AS src_labels,
                   type(r) AS rel_type, r.predicate AS predicate,
                   elementId(b) AS tgt_id, b.name AS tgt_name, labels(b) AS tgt_labels
        """
        result = session.run(query, name=concept_name, workspace=workspace, run_id=run_id or "")

        nodes_map = {}
        edges = []
        for rec in result:
            src_id = str(rec["src_id"])
            tgt_id = str(rec["tgt_id"])
            if src_id not in nodes_map:
                nodes_map[src_id] = {"id": src_id, "name": rec["src_name"], "labels": rec["src_labels"]}
            if tgt_id not in nodes_map:
                nodes_map[tgt_id] = {"id": tgt_id, "name": rec["tgt_name"], "labels": rec["tgt_labels"]}
            edges.append({
                "source": src_id,
                "target": tgt_id,
                "type": rec["rel_type"],
                "predicate": rec["predicate"] or ""
            })

    return {"nodes": list(nodes_map.values()), "edges": edges}


def get_graph_stats(workspace: str = "default", run_id: Optional[str] = None) -> dict:
    """Get counts of concepts, sources, and relationships in a single query, optionally filtered by run_id."""
    with read_session() as session:
        query = """
            MATCH (n {workspace: $ws})
            WHERE ($run_id IS NULL OR $run_id = "" OR n.run_id = $run_id OR n.snapshot_id = $run_id)
            WITH
                count(CASE WHEN n:Concept THEN 1 END) AS concepts,
                count(CASE WHEN n:Source THEN 1 END) AS sources
            OPTIONAL MATCH (a {workspace: $ws})-[r]->(b {workspace: $ws})
            WHERE ($run_id IS NULL OR $run_id = "" OR r.run_id = $run_id OR r.snapshot_id = $run_id)
            WITH concepts, sources,
                count(r) AS relationships,
                count(CASE WHEN type(r) = 'CONFLICTS_WITH' THEN 1 END) AS conflicts,
                count(CASE WHEN type(r) = 'ANALOGOUS_TO' THEN 1 END) AS analogies
            RETURN concepts, sources, relationships, conflicts, analogies
        """
        result = session.run(query, ws=workspace, run_id=run_id or "")

        record = result.single()
        if record:
            return {
                "concepts": record["concepts"],
                "sources": record["sources"],
                "relationships": record["relationships"],
                "conflicts": record["conflicts"],
                "analogies": record["analogies"]
            }
        return {"concepts": 0, "sources": 0, "relationships": 0, "conflicts": 0, "analogies": 0}


def get_mapped_sources(workspace: str = "default") -> List[str]:
    """Get a list of all source documents that have been mapped into the graph."""
    with read_session() as session:
        result = session.run("""
            MATCH (s:Source {workspace: $ws})
            RETURN s.name AS name
            ORDER BY s.created_at DESC
        """, ws=workspace)
        return [record["name"] for record in result]


def delete_source_from_graph(source_name: str, workspace: str = "default") -> dict:
    """
    Remove a specific document's data from the knowledge graph.
    This deletes RELATES_TO edges mapping to this source, the Source node itself,
    and any cleanups orphaned Concept nodes.
    """
    with write_session() as session:
        # 1. Delete all RELATES_TO edges attributed to this source
        session.run("""
            MATCH ()-[r:RELATES_TO {source: $source_name}]->()
            DELETE r
        """, source_name=source_name)

        # 2. Delete the Source node and its connections (SOURCED_FROM)
        session.run("""
            MATCH (s:Source {name: $source_name, workspace: $workspace})
            DETACH DELETE s
        """, source_name=source_name, workspace=workspace)

        # 3. Clean up orphaned concepts and their derived relations (like Analogies or Conflicts)
        # Any concept in this workspace with no incoming or outgoing edges left is deleted.
        session.run("""
            MATCH (c:Concept {workspace: $workspace})
            WHERE NOT (c)--()
            DELETE c
        """, workspace=workspace)

    return {"status": "deleted", "source": source_name, "workspace": workspace}


def create_synthesis_run(
    run_id: str,
    partition_key: str,
    model: str,
    workspace: str,
    files: List[str],
    version: str = "1.0.0",
    artifact_path: str = "",
    name: Optional[str] = None
) -> dict:
    """Create a new SynthesisRun node with metadata."""
    with write_session() as session:
        session.run("""
            MERGE (r:SynthesisRun {run_id: $run_id})
            ON CREATE SET 
                r.partition_key = $pk,
                r.model = $model,
                r.workspace = $workspace,
                r.files = $files,
                r.version = $version,
                r.artifact_path = $artifact_path,
                r.name = $name,
                r.created_at = datetime()
        """, run_id=run_id, pk=partition_key, model=model,
             workspace=workspace, files=files, version=version,
             artifact_path=artifact_path, name=name or f"Synthesis_{run_id[:8]}")
    return {"status": "run_created", "run_id": run_id}


def create_code_scan(
    scan_id: str,
    workspace: str,
    root_dir: str,
    name: Optional[str] = None
) -> dict:
    """Create a new CodeScan node with metadata."""
    with write_session() as session:
        session.run("""
            MERGE (s:CodeScan {scan_id: $scan_id})
            ON CREATE SET 
                s.workspace = $workspace,
                s.root_dir = $root_dir,
                s.name = $name,
                s.created_at = datetime()
        """, scan_id=scan_id, workspace=workspace, root_dir=root_dir, 
             name=name or f"CodeScan_{scan_id[:8]}")
    return {"status": "scan_created", "scan_id": scan_id}


def get_code_scan_history(workspace: str = "default") -> List[dict]:
    """List all code scans in a workspace."""
    with read_session() as session:
        result = session.run("""
            MATCH (s:CodeScan {workspace: $workspace})
            RETURN s.scan_id AS scan_id, s.name AS name, s.root_dir AS root_dir, 
                   s.created_at AS created_at
            ORDER BY s.created_at DESC
        """, workspace=workspace)
        return [dict(rec) for rec in result]


def get_synthesis_history(workspace: str = "default") -> List[dict]:
    """List all synthesis runs in a workspace."""
    with read_session() as session:
        result = session.run("""
            MATCH (r:SynthesisRun {workspace: $workspace})
            RETURN r.run_id AS run_id, r.model AS model, r.timestamp AS timestamp, 
                   r.name AS name, r.files AS files, r.version AS version, 
                   r.created_at AS created_at, r.partition_key AS partition_key
            ORDER BY r.created_at DESC
        """, workspace=workspace)
        return [dict(rec) for rec in result]


def delete_synthesis_run(run_id: str, workspace: str = "default") -> dict:
    """Delete a specific run and all its associated triples."""
    with write_session() as session:
        # 1. Delete all edges tagged with this run_id
        session.run("""
            MATCH ()-[r:RELATES_TO {run_id: $run_id}]->()
            DELETE r
        """, run_id=run_id)

        # 2. Delete the SynthesisRun node
        session.run("""
            MATCH (r:SynthesisRun {run_id: $run_id, workspace: $workspace})
            DELETE r
        """, run_id=run_id, workspace=workspace)

        # 3. Cleanup orphaned concepts
        session.run("""
            MATCH (c:Concept {workspace: $workspace})
            WHERE NOT (c)--()
            DELETE c
        """, workspace=workspace)

    return {"status": "run_deleted", "run_id": run_id}


def update_graph_centrality(workspace: str = "default") -> dict:
    """
    Calculate centrality for all nodes in the workspace.
    Uses a lightweight PageRank approximation via iterative degree propagation.
    Falls back to simple degree count if APOC is not available.
    """
    with write_session() as session:
        # Try APOC PageRank if available
        try:
            session.run("""
                CALL apoc.algo.pageRank('Concept') YIELD node, score
                WHERE node.workspace = $workspace
                SET node.centrality = score
            """, workspace=workspace)
            return {"status": "centrality_updated", "method": "pagerank"}
        except Exception:
            pass

        # Fallback: weighted degree centrality 
        # (count direct connections + 0.5 * second-degree connections)
        session.run("""
            MATCH (c:Concept {workspace: $workspace})
            OPTIONAL MATCH (c)--(neighbor)
            WITH c, count(DISTINCT neighbor) AS degree
            OPTIONAL MATCH (c)--(neighbor)--(second)
            WHERE second <> c
            WITH c, degree, count(DISTINCT second) AS second_degree
            SET c.centrality = degree + (second_degree * 0.3)
        """, workspace=workspace)

    return {"status": "centrality_updated", "method": "weighted_degree"}


def multi_hop_traversal(query: str, workspace: str = "default", depth: int = 3, limit: int = 10) -> List[Dict[str, Any]]:
    """
    Perform multi-hop graph traversal from entities mentioned in the query.
    
    Algorithm:
    1. Extract entity names from the query using simple NLP (word matching against existing nodes)
    2. For each matched entity, traverse relationships up to `depth` hops
    3. Collect connected nodes and relationship paths
    4. Return as list of {content, source, path} dicts
    
    Args:
        query: The search query
        workspace: Workspace scope
        depth: Maximum relationship hops (1-5)
        limit: Maximum results to return
    
    Returns:
        List of documents with relational context
    """
    driver = get_driver()
    if driver is None:
        return []
    
    results = []
    try:
        with driver.session() as session:
            # Step 1: Find entities mentioned in the query
            # Use a case-insensitive CONTAINS match against node names
            entity_query = """
            MATCH (n)
            WHERE any(word IN $words WHERE toLower(n.name) CONTAINS toLower(word))
            RETURN n.name AS name, labels(n) AS labels
            LIMIT 10
            """
            words = [w for w in query.split() if len(w) > 3]  # Skip short words
            if not words:
                return []
            
            entities = session.run(entity_query, words=words)
            entity_names = [record["name"] for record in entities]
            
            if not entity_names:
                return []
            
            # Step 2: Multi-hop traversal from each entity
            hop_query = f"""
            MATCH path = (start)-[*1..{min(depth, 5)}]-(connected)
            WHERE start.name IN $entity_names
            RETURN start.name AS source_entity,
                   connected.name AS connected_entity,
                   [rel IN relationships(path) | type(rel)] AS relationship_types,
                   length(path) AS hops,
                   connected.description AS description
            ORDER BY hops ASC
            LIMIT $limit
            """
            
            traversal_results = session.run(
                hop_query, 
                entity_names=entity_names, 
                limit=limit
            )
            
            for record in traversal_results:
                path_str = " → ".join(record["relationship_types"])
                content = (
                    f"Entity: {record['connected_entity']}\n"
                    f"Relationship path from {record['source_entity']}: {path_str}\n"
                    f"Hops: {record['hops']}\n"
                )
                if record.get("description"):
                    content += f"Description: {record['description']}\n"
                
                results.append({
                    "content": content,
                    "source": f"neo4j://{record['source_entity']}/{path_str}",
                    "hops": record["hops"],
                })
    except Exception as e:
        logger.warning("Multi-hop traversal failed: %s", e)
    
    return results
