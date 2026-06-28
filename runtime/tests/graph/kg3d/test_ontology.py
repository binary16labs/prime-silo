import pytest

from benny.graph.kg3d.ontology import content_hash, load_default_ontology


@pytest.mark.asyncio
async def test_kg3d_f1_load_counts():
    graph = await load_default_ontology()
    assert len(graph.nodes) > 0
    assert len(graph.edges) >= 0


@pytest.mark.asyncio
async def test_content_hash_stable():
    graph1 = await load_default_ontology()
    hash1 = content_hash(graph1)

    graph2 = await load_default_ontology()
    hash2 = content_hash(graph2)

    assert hash1 == hash2
    assert len(hash1) == 64
