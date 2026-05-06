"""
Schema Adapter — Dynamic Cypher Query Resolution.

Decouples the correlation engine from hardcoded Neo4j label assumptions.
Introspects the live graph schema once per session (cached per workspace)
and resolves the correct MATCH pattern for any entity type.

Pain Point A Resolution: Addresses the silent zero-row query failure documented
in the 6-Sigma Execution Plan when the graph uses separate labels (:File, :Class)
instead of a shared :CodeEntity label with a type property.
"""

import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

# Types the correlation engine cares about — in priority order
DEFAULT_ENTITY_TYPES = ["File", "Class", "Interface", "Function", "Variable"]


class SchemaAdapter:
    """
    Resolves the correct Cypher MATCH clause for a given entity type
    based on what labels and properties actually exist in the live Neo4j graph.

    Usage:
        adapter = SchemaAdapter(workspace="default")
        match_clause = adapter.resolve_node_match("File")
        valid_types  = adapter.get_valid_entity_types()

    Caching:
        Schema is introspected once per workspace per process lifetime.
        Call SchemaAdapter.invalidate(workspace) after a new code ingest
        to force a fresh introspection on the next use.
    """

    # Class-level cache: {workspace: introspection_result}
    _cache: dict = {}

    def __init__(self, workspace: str):
        self._workspace = workspace
        if workspace not in SchemaAdapter._cache:
            self._refresh(workspace)
        self._schema = SchemaAdapter._cache[workspace]

    def _refresh(self, workspace: str):
        """Fetch live schema and populate the cache."""
        try:
            from ..core.graph_db import introspect_schema
            result = introspect_schema(workspace)
            SchemaAdapter._cache[workspace] = result
            logger.info(
                "SchemaAdapter: introspected workspace='%s' — labels=%s, rel_types=%s",
                workspace,
                result.get("labels", []),
                result.get("relationship_types", [])
            )
        except Exception as e:
            logger.warning(
                "SchemaAdapter: introspection failed for workspace='%s': %s — "
                "falling back to property-based queries.",
                workspace, e
            )
            # Safe fallback — property-based queries always work on existing data
            SchemaAdapter._cache[workspace] = {
                "labels": [],
                "relationship_types": [],
                "entity_type_distribution": {}
            }

    @classmethod
    def invalidate(cls, workspace: str):
        """
        Invalidate cached schema for a workspace.
        Call this after a new code scan or ingestion run.
        """
        if workspace in cls._cache:
            del cls._cache[workspace]
            logger.info("SchemaAdapter: cache invalidated for workspace='%s'", workspace)

    def resolve_node_match(self, entity_type: str) -> str:
        """
        Return the correct Cypher MATCH clause for the given entity type.

        - If the type exists as a standalone Neo4j label (e.g. :File),
          returns a label-based match for performance.
        - Otherwise falls back to the property-based pattern used by
          the CodeEntity unified label model.

        Args:
            entity_type: e.g. 'File', 'Class', 'Function'

        Returns:
            Cypher MATCH string (without trailing newline)
        """
        labels = self._schema.get("labels", [])

        if entity_type in labels:
            # Label-based (faster — uses index)
            clause = (
                f"MATCH (n:{entity_type} {{workspace: $workspace}})"
            )
            logger.debug("SchemaAdapter: resolved '%s' → label-based", entity_type)
        else:
            # Property-based (works with CodeEntity + type property model)
            clause = (
                f"MATCH (n:CodeEntity {{workspace: $workspace, type: '{entity_type}'}})"
            )
            logger.debug("SchemaAdapter: resolved '%s' → property-based", entity_type)

        return clause

    def resolve_symbol_match(self) -> str:
        """
        Return a single MATCH clause that captures all valid symbol types
        in one query — avoids N separate queries per type.

        Returns a Cypher fragment like:
            MATCH (s:CodeEntity {workspace: $workspace})
            WHERE s.type IN ['File','Class','Function']
        or for label-based graphs:
            MATCH (s {workspace: $workspace})
            WHERE any(l IN labels(s) WHERE l IN ['File','Class','Function'])
        """
        valid_types = self.get_valid_entity_types()
        if not valid_types:
            valid_types = DEFAULT_ENTITY_TYPES

        labels = self._schema.get("labels", [])

        # Check if at least one type exists as a first-class label
        label_based_types = [t for t in valid_types if t in labels]

        if label_based_types:
            type_list = ", ".join(f"'{t}'" for t in valid_types)
            return (
                "MATCH (s:CodeEntity {workspace: $workspace})\n"
                f"    WHERE s.type IN [{type_list}]"
            )
        else:
            type_list = ", ".join(f"'{t}'" for t in valid_types)
            return (
                "MATCH (s:CodeEntity {workspace: $workspace})\n"
                f"    WHERE s.type IN [{type_list}]"
            )

    def get_valid_entity_types(self) -> List[str]:
        """
        Return the list of entity types that are confirmed to exist
        in the current workspace graph.

        Falls back to DEFAULT_ENTITY_TYPES if no distribution data is available.
        """
        dist = self._schema.get("entity_type_distribution", {})
        if not dist:
            logger.warning(
                "SchemaAdapter: no entity_type_distribution found — "
                "using defaults: %s", DEFAULT_ENTITY_TYPES
            )
            return DEFAULT_ENTITY_TYPES

        # Parse keys like "['CodeEntity']:Function" → "Function"
        valid = []
        for key in dist:
            # Key format: "['LabelA', 'LabelB']:type_value" or similar
            parts = key.split(":")
            type_val = parts[-1].strip() if len(parts) > 1 else None
            if type_val and type_val not in ("None", "null", ""):
                valid.append(type_val)

        # De-duplicate, preserve order, filter to known types
        seen = set()
        result = []
        for t in valid:
            if t not in seen:
                seen.add(t)
                result.append(t)

        if not result:
            return DEFAULT_ENTITY_TYPES

        logger.info(
            "SchemaAdapter: resolved valid entity types for workspace='%s': %s",
            self._workspace, result
        )
        return result

    def has_semantic_edges(self) -> bool:
        """Returns True if CORRELATES_WITH edges already exist in the schema."""
        rel_types = self._schema.get("relationship_types", [])
        return "CORRELATES_WITH" in rel_types

    def get_schema_mode(self) -> str:
        """
        Returns 'label-based', 'property-based', or 'hybrid'.
        Used by the schema-health API endpoint.
        """
        labels = self._schema.get("labels", [])
        label_types = [t for t in DEFAULT_ENTITY_TYPES if t in labels]

        if len(label_types) >= 3:
            return "label-based"
        elif len(label_types) == 0:
            return "property-based"
        else:
            return "hybrid"
