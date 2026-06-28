"""Tests for the LLM triple-output parser (benny.synthesis.engine).

Local models (e.g. qwen3.5-9b-FLM) frequently emit slightly-malformed output;
the parser must recover triples from it instead of dropping the whole batch.
"""

from benny.synthesis.engine import _extract_xml_field, _parse_json_from_llm


def test_parse_wellformed_xml_triples():
    out = """<triples>
      <triple>
        <subject>Dopamine</subject>
        <predicate>drives</predicate>
        <object>reward-seeking behavior</object>
        <confidence>0.9</confidence>
      </triple>
    </triples>"""
    data, _ = _parse_json_from_llm(out)
    assert isinstance(data, list) and len(data) == 1
    assert data[0]["subject"] == "Dopamine"
    assert data[0]["object"] == "reward-seeking behavior"
    assert data[0]["confidence"] == 0.9


def test_parse_malformed_object_tag_is_recovered():
    """Regression: qwen3.5-9b emitted `<object(value)</object>` (no closing '>'
    on the open tag). The strict parser dropped the whole triple → 0 triples.
    The tolerant extractor must recover the object value."""
    out = """<triples>
      <triple>
        <subject>Large Language Models</subject>
        <subject_type>Technology</subject_type>
        <predicate>demonstrate breakthroughs in</predicate>
        <object(reasoning, insights, tool use)</object>
        <object_type>Capabilities</object_type>
        <confidence>1.0</confidence>
      </triple>
    </triples>"""
    data, _ = _parse_json_from_llm(out)
    assert isinstance(data, list) and len(data) == 1
    assert data[0]["subject"] == "Large Language Models"
    assert data[0]["object"] == "reasoning, insights, tool use"


def test_extract_xml_field_variants():
    assert _extract_xml_field("object", "<object>plain</object>") == "plain"
    assert _extract_xml_field("object", '<object type="x">attr</object>') == "attr"
    assert _extract_xml_field("object", "<object(a, b, c)</object>") == "a, b, c"
    assert _extract_xml_field("object", "no tags here") is None


def test_parse_json_array_fallback():
    out = 'Here you go:\n```json\n[{"subject":"A","predicate":"r","object":"B"}]\n```'
    data, _ = _parse_json_from_llm(out)
    assert isinstance(data, list) and len(data) == 1
    assert data[0]["subject"] == "A" and data[0]["object"] == "B"
