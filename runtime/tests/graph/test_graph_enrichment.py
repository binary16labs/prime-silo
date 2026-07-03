"""Unit tests for the pure logic in benny.graph.graph_enrichment.

These cover the parts that don't need Neo4j: predicate → rel_class mapping, name
normalization / token Jaccard, and the union-find grouping used by canonical merge.
The Neo4j-touching stages are exercised by the live backfill (dry-run) in the
verification step, not here.
"""

from benny.graph.graph_enrichment import (
    classify_predicate,
    _normalize_name,
    _token_set,
    _jaccard,
    _union_find_groups,
)


def test_classify_predicate_controlled_vocab():
    assert classify_predicate("is a prerequisite for") == "prerequisite"
    assert classify_predicate("requires") == "prerequisite"
    assert classify_predicate("conflicts with") == "conflict"
    assert classify_predicate("contradicts") == "conflict"
    assert classify_predicate("analogous to") == "analogy"
    assert classify_predicate("semantically_similar") == "similarity"
    assert classify_predicate("is part of") == "composition"
    # unknown / free text falls back
    assert classify_predicate("mentions foo") == "relates"
    assert classify_predicate(None) == "relates"


def test_normalize_and_tokens():
    assert _normalize_name("  Pypes-Plan  Command! ") == "pypes plan command"
    assert _normalize_name(None) == ""
    assert _token_set("Foo, Bar. Foo") == {"foo", "bar"}


def test_jaccard():
    assert _jaccard({"a", "b"}, {"a", "b", "c"}) == 2 / 3
    assert _jaccard(set(), {"a"}) == 0.0
    assert _jaccard({"a"}, {"a"}) == 1.0


def test_union_find_groups_only_returns_multimember():
    # 0-1-2 connected, 4-5 connected, 3 and 6 singletons
    groups = _union_find_groups([(0, 1), (1, 2), (4, 5)], 7)
    sizes = sorted(len(v) for v in groups.values())
    assert sizes == [2, 3]
    # every member appears exactly once across returned groups
    members = sorted(m for g in groups.values() for m in g)
    assert members == [0, 1, 2, 4, 5]


def test_union_find_no_pairs():
    assert _union_find_groups([], 5) == {}
