"""
VIS-001 / ADR-003 Phase 3 — orchestrator stitching tests (offline, no models).

Covers the deterministic glue: context gathering and surrogate→markdown stitching
in reading order. The live multi-model enrichment is exercised by the TOGAF run.
"""
import asyncio

from benny.core import vision_pipeline as P


def _by_order(els):
    return {e["reading_order"]: e for e in els}


# --------------------------------------------------------------------------- #
# context gathering
# --------------------------------------------------------------------------- #

def test_caption_and_context_for():
    els = [
        {"reading_order": 0, "type": "section_header", "text": "Core Concepts"},
        {"reading_order": 1, "type": "picture"},
        {"reading_order": 2, "type": "caption", "text": "Figure 3-1 ADM Cycle"},
        {"reading_order": 3, "type": "text", "text": "The ADM has phases A-H."},
    ]
    bo = _by_order(els)
    assert P._caption_for(bo, 1) == "Figure 3-1 ADM Cycle"
    ctx = P._context_for(bo, 1)
    assert "Core Concepts" in ctx and "ADM Cycle" in ctx and "phases A-H" in ctx


# --------------------------------------------------------------------------- #
# surrogate -> markdown
# --------------------------------------------------------------------------- #

def test_stitch_text_types():
    assert P._surrogate_to_markdown({"type": "title", "id": "x", "text": "T"}) == "# T"
    assert P._surrogate_to_markdown({"type": "section_header", "id": "x", "text": "H"}) == "## H"
    assert P._surrogate_to_markdown({"type": "list_item", "id": "x", "text": "i"}) == "- i"
    assert P._surrogate_to_markdown({"type": "text", "id": "x", "text": "p"}) == "p"


def test_stitch_diagram_surrogate_emits_mermaid_fence_with_provenance():
    el = {"type": "picture", "id": "abc", "page": 48,
          "surrogate": {"surrogate_kind": "mermaid", "content": "flowchart TD\n A-->B", "score": 9.0}}
    md = P._surrogate_to_markdown(el)
    assert "```mermaid" in md and "A-->B" in md
    assert "id=abc" in md and "page=48" in md and "figure_score=9.0" in md


def test_stitch_table_emits_markdown_and_json():
    el = {"type": "table", "id": "t", "page": 10,
          "table": {"columns": ["a", "b"], "rows": [[1, 2]], "n_rows": 1, "n_cols": 2}}
    md = P._surrogate_to_markdown(el)
    assert "| a | b |" in md and "```json" in md and "id=t" in md


def test_stitch_caption_fallback():
    el = {"type": "picture", "id": "p", "page": 5,
          "surrogate": {"surrogate_kind": "caption_fallback", "content": "a photo"}}
    md = P._surrogate_to_markdown(el)
    assert "*Figure (5): a photo*" in md


# --------------------------------------------------------------------------- #
# orchestrator skeleton with no visuals processed (limit=0 → no model calls)
# --------------------------------------------------------------------------- #

def test_stitch_diagram_includes_visual_score_when_present():
    el = {"type": "picture", "id": "abc", "page": 7,
          "surrogate": {"surrogate_kind": "mermaid", "content": "flowchart TD\n A-->B",
                        "score": 8.0, "visual_score": 9.0}}
    md = P._surrogate_to_markdown(el)
    assert "figure_score=8.0" in md and "visual_score=9.0" in md
    # absent when not judged
    el["surrogate"].pop("visual_score")
    assert "visual_score=" not in P._surrogate_to_markdown(el)


def test_enrich_docmodel_limit0_is_pure_stitch():
    docmodel = {
        "workspace": "default", "source": "d.pdf",
        "elements": [
            {"reading_order": 0, "type": "section_header", "id": "h", "text": "Intro"},
            {"reading_order": 1, "type": "text", "id": "t", "text": "Body text."},
            {"reading_order": 2, "type": "table", "id": "tb", "page": 1,
             "table": {"columns": ["c"], "rows": [["v"]], "n_rows": 1, "n_cols": 1}},
            {"reading_order": 3, "type": "picture", "id": "pic", "page": 1, "crop": "x.png",
             "region": True},
        ],
    }
    res = asyncio.run(P.enrich_docmodel(docmodel, limit=0, log_fn=lambda *a: None))
    s = res["summary"]
    assert s["visual_processed"] == 0
    assert s["tables"] == 1
    assert s["visual_total"] == 1
    assert s["region_crops"] == 1  # counted structurally, even with no VLM
    # new fidelity keys exist and are zero/None when nothing was judged
    assert s["visual_judged"] == 0 and s["avg_visual_score"] is None
    assert {"faithful", "partial", "poor"} <= set(s)
    assert "## Intro" in res["markdown"] and "Body text." in res["markdown"]
    assert "| c |" in res["markdown"]  # table stitched even with no VLM


def test_resolve_page_bytes_handles_str_and_int_keys(tmp_path):
    png = tmp_path / "p3.png"
    png.write_bytes(b"\x89PNG-bytes")
    # JSON-loaded docmodels use string keys; in-memory ones may use ints
    assert P._resolve_page_bytes({"3": "p3.png"}, 3, tmp_path) == b"\x89PNG-bytes"
    assert P._resolve_page_bytes({3: "p3.png"}, 3, tmp_path) == b"\x89PNG-bytes"
    assert P._resolve_page_bytes({}, 3, tmp_path) is None
    assert P._resolve_page_bytes({"3": "missing.png"}, 3, tmp_path) is None
