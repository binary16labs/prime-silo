"""
Graph Diagnostics — Health Grading for the Neural Nexus.

Provides get_graph_health() which queries the live Neo4j graph and returns
a structured health report with a letter grade (A-F), semantic link density,
missing label coverage, and specific remediation recommendations.

Used by:
  - GET /api/graph/health  (C.1.2)
  - GET /api/graph/schema-health  (Phase 1, Task 6)
  - Frontend health badge in SourcePanel (C.1.3)
"""

import logging
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)

# Expected labels in a healthy, fully-ingested workspace
EXPECTED_LABELS = [
    "CodeEntity", "Concept", "Source", "Document",
    "File", "Class", "Function", "Documentation"
]

# Expected relationship types in a healthy graph
EXPECTED_REL_TYPES = [
    "DEFINES", "REPRESENTS", "CORRELATES_WITH", "REL", "CONTAINS"
]

# Scoring weights
WEIGHT_LABELS       = 0.30   # Label coverage: are expected labels present?
WEIGHT_SEM_EDGES    = 0.40   # Semantic edges: CORRELATES_WITH + REL count
WEIGHT_TEMPORAL     = 0.20   # Temporal coverage: do nodes have created_at?
WEIGHT_RATIONALE    = 0.10   # Lineage coverage: do edges have rationale?


def _letter_grade(score: float) -> str:
    """Convert 0-100 score to a letter grade."""
    if score >= 90: return "A"
    if score >= 75: return "B"
    if score >= 55: return "C"
    if score >= 35: return "D"
    return "F"


def _grade_color(grade: str) -> str:
    """Return a CSS hex color for the grade."""
    return {
        "A": "#10b981",  # green
        "B": "#3b82f6",  # blue
        "C": "#f59e0b",  # amber
        "D": "#f97316",  # orange
        "F": "#ef4444",  # red
    }.get(grade, "#6b7280")


def get_graph_health(workspace: str = "default") -> Dict[str, Any]:
    """
    Compute a comprehensive health report for the given workspace graph.

    Returns:
        {
            "score": float,           # 0-100 composite health score
            "grade": str,             # A / B / C / D / F
            "grade_color": str,       # CSS color for the grade
            "zero_link_condition": bool,
            "label_coverage": dict,
            "semantic_edges": dict,
            "temporal_coverage": dict,
            "rationale_coverage": dict,
            "recommendations": list[str],
            "schema_mode": str,       # 'label-based' | 'property-based' | 'hybrid'
        }
    """
    from ..core.graph_db import introspect_schema, read_session

    recommendations: List[str] = []
    score_components: Dict[str, float] = {}

    # ---- 1. Schema introspection ----
    try:
        schema = introspect_schema(workspace)
    except Exception as e:
        logger.error("get_graph_health: introspect_schema failed: %s", e)
        return {
            "score": 0,
            "grade": "F",
            "grade_color": _grade_color("F"),
            "error": str(e),
            "zero_link_condition": True,
            "recommendations": ["Neo4j is not reachable. Verify bolt://localhost:7687 is running."]
        }

    present_labels    = set(schema.get("labels", []))
    present_rel_types = set(schema.get("relationship_types", []))

    # ---- 2. Label coverage score ----
    missing_labels = [l for l in EXPECTED_LABELS if l not in present_labels]
    label_score = (1 - len(missing_labels) / len(EXPECTED_LABELS)) * 100
    score_components["label"] = label_score

    if missing_labels:
        recommendations.append(
            f"Missing labels: {missing_labels}. Run a code scan and knowledge ingestion to populate them."
        )

    # ---- 3. Semantic edge score ----
    semantic_edge_count = 0
    sem_edge_breakdown: Dict[str, int] = {}
    try:
        with read_session() as session:
            # Count CORRELATES_WITH
            r1 = session.run(
                "MATCH ()-[r:CORRELATES_WITH {workspace: $ws}]->() RETURN count(r) AS cnt",
                ws=workspace
            ).single()
            cw_count = r1["cnt"] if r1 else 0
            sem_edge_breakdown["CORRELATES_WITH"] = cw_count

            # Count REL
            r2 = session.run(
                "MATCH ()-[r:REL {workspace: $ws}]->() RETURN count(r) AS cnt",
                ws=workspace
            ).single()
            rel_count = r2["cnt"] if r2 else 0
            sem_edge_breakdown["REL"] = rel_count

            semantic_edge_count = cw_count + rel_count
    except Exception as e:
        logger.warning("get_graph_health: edge count query failed: %s", e)
        recommendations.append("Could not count semantic edges — check Neo4j connectivity.")

    zero_link = "CORRELATES_WITH" not in present_rel_types

    # Score: 0 edges = 0, 10+ = 50, 100+ = 100
    sem_score = min(100.0, semantic_edge_count)
    score_components["semantic"] = sem_score

    if zero_link:
        recommendations.append(
            "ZERO LINK CONDITION ACTIVE: No CORRELATES_WITH edges found. "
            "Run a deep-synthesis ingestion or force-correlate via the SourcePanel."
        )
    elif semantic_edge_count < 10:
        recommendations.append(
            f"Only {semantic_edge_count} semantic links found. "
            "Consider running aggressive correlation to improve semantic density."
        )

    # ---- 4. Temporal coverage score ----
    temporal_score = 0.0
    temporal_detail: Dict[str, Any] = {}
    try:
        with read_session() as session:
            # Count CodeEntity nodes missing created_at
            r3 = session.run(
                "MATCH (n:CodeEntity {workspace: $ws}) "
                "RETURN count(n) AS total, "
                "count(CASE WHEN n.created_at IS NOT NULL THEN 1 END) AS with_ts",
                ws=workspace
            ).single()
            if r3:
                total_ce = r3["total"] or 0
                ce_with_ts = r3["with_ts"] or 0
                temporal_detail["code_entities_total"]   = total_ce
                temporal_detail["code_entities_with_ts"] = ce_with_ts
                temporal_score = (ce_with_ts / total_ce * 100) if total_ce > 0 else 100.0
    except Exception as e:
        logger.warning("get_graph_health: temporal query failed: %s", e)
        temporal_score = 0.0

    score_components["temporal"] = temporal_score
    if temporal_score < 100:
        recommendations.append(
            f"Temporal coverage: {temporal_score:.0f}% of CodeEntity nodes have timestamps. "
            "Re-run a code scan to backfill created_at on older nodes."
        )

    # ---- 5. Rationale coverage score ----
    rationale_score = 100.0
    rationale_detail: Dict[str, Any] = {}
    try:
        with read_session() as session:
            r4 = session.run(
                "MATCH ()-[r:CORRELATES_WITH]->() "
                "WHERE r.workspace IS NULL OR r.workspace = $ws "
                "RETURN count(r) AS total, "
                "count(CASE WHEN r.rationale IS NOT NULL THEN 1 END) AS with_rationale",
                ws=workspace
            ).single()
            if r4:
                total_cw = r4["total"] or 0
                cw_with_rat = r4["with_rationale"] or 0
                rationale_detail["correlates_with_total"]      = total_cw
                rationale_detail["correlates_with_rationale"]  = cw_with_rat
                rationale_score = (cw_with_rat / total_cw * 100) if total_cw > 0 else 100.0
    except Exception as e:
        logger.warning("get_graph_health: rationale query failed: %s", e)
        rationale_score = 0.0

    score_components["rationale"] = rationale_score
    if rationale_score < 100:
        recommendations.append(
            f"Rationale coverage: {rationale_score:.0f}% of CORRELATES_WITH edges have rationale. "
            "Force-correlate again to update existing edges."
        )

    # ---- 6. Composite score ----
    composite = (
        score_components["label"]    * WEIGHT_LABELS    +
        score_components["semantic"] * WEIGHT_SEM_EDGES +
        score_components["temporal"] * WEIGHT_TEMPORAL  +
        score_components["rationale"]* WEIGHT_RATIONALE
    )

    grade = _letter_grade(composite)

    # ---- 7. Schema mode ----
    try:
        from ..synthesis.schema_adapter import SchemaAdapter
        adapter = SchemaAdapter(workspace)
        schema_mode = adapter.get_schema_mode()
    except Exception:
        schema_mode = "unknown"

    return {
        "score": round(composite, 1),
        "grade": grade,
        "grade_color": _grade_color(grade),
        "zero_link_condition": zero_link,
        "schema_mode": schema_mode,
        "score_components": {
            "label_coverage_pct":    round(score_components["label"], 1),
            "semantic_density_pct":  round(score_components["semantic"], 1),
            "temporal_coverage_pct": round(score_components["temporal"], 1),
            "rationale_coverage_pct":round(score_components["rationale"], 1),
        },
        "label_coverage": {
            "present":  list(present_labels),
            "expected": EXPECTED_LABELS,
            "missing":  missing_labels,
        },
        "semantic_edges": {
            "breakdown":      sem_edge_breakdown,
            "total":          semantic_edge_count,
        },
        "temporal_coverage":  temporal_detail,
        "rationale_coverage": rationale_detail,
        "recommendations": recommendations if recommendations else ["Graph is healthy. No action required."],
    }
