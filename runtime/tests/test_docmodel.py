"""
VIS-001 / ADR-003 Phase 0 — DocModel tests.

Offline (no Docling, no network, no server): the pure transformation + guard
logic that makes the DocModel deterministic, idempotent and traversal-safe
(VIS-NFR1). The Docling-dependent extraction is proven separately by
``scripts/docmodel_smoke.py`` against the bundled 3.11 runtime.
"""
import json

import pytest

from benny.core import docmodel as D

# --------------------------------------------------------------------------- #
# hashing / ids — determinism (VIS-F4)
# --------------------------------------------------------------------------- #

def test_short_hash_is_stable_and_order_sensitive():
    assert D._short_hash("a", 1, None) == D._short_hash("a", 1, None)
    assert D._short_hash("a", 1) != D._short_hash(1, "a")
    assert len(D._short_hash("x")) == 16


def test_element_id_stable_across_calls():
    args = (3, "picture", 2, {"l": 1.0, "t": 2.0, "r": 3.0, "b": 4.0}, "cap", "#/pictures/0")
    assert D._element_id(*args) == D._element_id(*args)
    # a different reading order yields a different id
    assert D._element_id(4, *args[1:]) != D._element_id(*args)


# --------------------------------------------------------------------------- #
# traversal safety (VIS-SEC2)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("name,expected_clean", [
    ("report.pdf", "report"),
    ("../../etc/passwd", "passwd"),
    ("a b/c\\d.pdf", "d"),
    ("..", "doc"),
    ("weird@#$name.docx", "weird___name"),
])
def test_safe_stem_strips_paths_and_traversal(name, expected_clean):
    stem = D._safe_stem(name)
    assert "/" not in stem and "\\" not in stem and ".." not in stem
    assert stem == expected_clean


# --------------------------------------------------------------------------- #
# bbox normalization
# --------------------------------------------------------------------------- #

def test_bbox_to_dict_handles_none_and_object():
    assert D._bbox_to_dict(None) is None

    class _BBox:
        l, t, r, b = 1, 2, 3, 4

        class _O:
            value = "BOTTOMLEFT"

        coord_origin = _O()

    out = D._bbox_to_dict(_BBox())
    assert out == {"l": 1.0, "t": 2.0, "r": 3.0, "b": 4.0, "coord_origin": "BOTTOMLEFT"}


# --------------------------------------------------------------------------- #
# table → JSON (VIS-F2)
# --------------------------------------------------------------------------- #

def test_df_to_table_json_shape_and_nan():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"a": [1, None], "b": ["x", "y"]})
    out = D._df_to_table_json(df)
    assert out["columns"] == ["a", "b"]
    assert out["n_rows"] == 2 and out["n_cols"] == 2
    assert out["rows"][0] == [1.0, "x"]
    assert out["rows"][1][0] is None  # NaN -> None, JSON-safe


# --------------------------------------------------------------------------- #
# fallback DocModel (graceful degradation, no Docling)
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# PyMuPDF-backend pure helpers (no fitz needed)
# --------------------------------------------------------------------------- #

def test_rows_to_table_json_header_body_and_none():
    out = D._rows_to_table_json([["Term", "Definition"], ["ADM", "the method"], ["BB", None]])
    assert out["columns"] == ["Term", "Definition"]
    assert out["n_rows"] == 2 and out["n_cols"] == 2
    assert out["rows"][1] == ["BB", None]


def test_looks_like_table_accepts_real_rejects_junk():
    real = [["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]
    assert D._looks_like_table(real) is True
    assert D._looks_like_table([["only one row two cols", "x"]]) is False   # <2 rows
    assert D._looks_like_table([["a"], ["b"], ["c"]]) is False              # 1 col
    assert D._looks_like_table([["a", None], [None, None], [None, None]]) is False  # mostly empty


def test_classify_text_block():
    big, med = 20.0, 10.0
    assert D._classify_text_block("Figure 3-1 ADM Cycle", med, med, 3) == "caption"
    assert D._classify_text_block("• a bullet point", med, med, 3) == "list_item"
    assert D._classify_text_block("Core Concepts", big, med, 3) == "section_header"
    assert D._classify_text_block("The TOGAF Standard", big, med, 1) == "title"
    assert D._classify_text_block("A long paragraph of running body text that goes on.", med, med, 3) == "text"


def test_bbox_tuple_to_dict():
    assert D._bbox_tuple_to_dict((1, 2, 3, 4)) == {
        "l": 1.0, "t": 2.0, "r": 3.0, "b": 4.0, "coord_origin": "TOPLEFT"}


# --------------------------------------------------------------------------- #
# vector-region detection (the Databricks fix) — pure geometry, no fitz
# --------------------------------------------------------------------------- #

def test_is_diagram_region_accepts_figure_sized_cluster():
    page = (0, 0, 600, 800)
    rect = (100, 200, 400, 450)  # ~16% of page, square-ish
    assert D._is_diagram_region(rect, page, table_rects=[], img_rects=[]) is True


def test_is_diagram_region_rejects_tiny_thin_and_fullpage():
    page = (0, 0, 600, 800)
    assert D._is_diagram_region((0, 0, 30, 30), page, table_rects=[], img_rects=[]) is False  # tiny icon
    assert D._is_diagram_region((0, 0, 590, 12), page, table_rects=[], img_rects=[]) is False  # thin rule
    assert D._is_diagram_region((1, 1, 599, 799), page, table_rects=[], img_rects=[]) is False  # full page


def test_is_diagram_region_rejects_when_already_captured():
    page = (0, 0, 600, 800)
    rect = (100, 200, 400, 450)
    assert D._is_diagram_region(rect, page, table_rects=[rect], img_rects=[]) is False
    assert D._is_diagram_region(rect, page, table_rects=[], img_rects=[(90, 190, 410, 460)]) is False


# --------------------------------------------------------------------------- #
# PyMuPDF backend: page images + vector regions get captured (needs fitz)
# --------------------------------------------------------------------------- #

def test_pymupdf_captures_vector_region_and_page_image(tmp_path, monkeypatch):
    fitz = pytest.importorskip("fitz")
    monkeypatch.setattr(D, "get_workspace_path",
                        lambda ws="default", sub="": (tmp_path / ws / sub) if sub else (tmp_path / ws))

    # A PDF whose only figure is drawn as VECTORS (no embedded raster) — exactly the
    # case the xref-image path misses and the region path must now catch.
    pdf = tmp_path / "vec.pdf"
    doc = fitz.open()
    page = doc.new_page(width=600, height=800)
    page.insert_text((80, 120), "Medallion Architecture")
    page.draw_rect(fitz.Rect(120, 220, 300, 340), width=2)
    page.draw_rect(fitz.Rect(360, 220, 520, 340), width=2)
    page.draw_line(fitz.Point(300, 280), fitz.Point(360, 280))
    page.draw_oval(fitz.Rect(220, 420, 420, 520))
    doc.save(str(pdf))
    doc.close()

    if not hasattr(fitz.open(str(pdf))[0], "cluster_drawings"):
        pytest.skip("PyMuPDF without cluster_drawings")

    model = D.build_docmodel(pdf, workspace="wsV", emit_crops=True, force=True,
                             log_fn=lambda *_: None)

    # whole-page render persisted (the fidelity-judge substrate)
    assert model["pages"], "expected a per-page image map"
    page_rel = model["pages"].get(1) or model["pages"].get("1")
    assert page_rel and (tmp_path / "wsV" / page_rel).exists()

    # the vector drawing was lifted off the page as a region crop
    regions = [e for e in model["elements"] if e.get("type") == "picture" and e.get("region")]
    assert regions, "expected at least one vector region picture element"
    crop_rel = regions[0]["crop"]
    assert crop_rel and (tmp_path / "wsV" / crop_rel).exists()


def test_fallback_textonly_marks_degraded(tmp_path):
    src = tmp_path / "note.txt"
    src.write_text("hello world from a plain text file", encoding="utf-8")
    model = D._fallback_textonly(src, "note", reason="docling-import:test", log_fn=lambda *_: None)
    assert model["schema"] == D.DOCMODEL_SCHEMA
    assert model["degraded"] is True
    assert model["degraded_reason"] == "docling-import:test"
    assert len(model["elements"]) == 1
    assert model["elements"][0]["type"] == "text"
    assert "hello world" in model["elements"][0]["text"]


def test_fallback_empty_source_yields_no_elements(tmp_path):
    src = tmp_path / "empty.txt"
    src.write_text("   \n", encoding="utf-8")
    model = D._fallback_textonly(src, "empty", reason="x", log_fn=lambda *_: None)
    assert model["elements"] == []
    assert model["degraded"] is True


# --------------------------------------------------------------------------- #
# build_docmodel falls back + persists + is idempotent without Docling present
# --------------------------------------------------------------------------- #

def test_build_docmodel_pymupdf_text_and_idempotent(tmp_path, monkeypatch):
    # Redirect the workspace root so the test writes under tmp, never the real home.
    monkeypatch.setattr(D, "get_workspace_path",
                        lambda ws="default", sub="": (tmp_path / ws / sub) if sub else (tmp_path / ws))

    src = tmp_path / "doc.txt"
    src.write_text("alpha beta gamma", encoding="utf-8")

    # Default backend (pymupdf) handles .txt natively — NOT degraded.
    model = D.build_docmodel(src, workspace="wsX", emit_crops=False, log_fn=lambda *_: None)
    json_path = tmp_path / "wsX" / D.DOCMODEL_SUBDIR / "doc.json"
    assert json_path.exists()
    assert model["degraded"] is False and model["backend"] == "pymupdf"
    on_disk = json.loads(json_path.read_text(encoding="utf-8"))
    assert on_disk["elements"][0]["text"] == "alpha beta gamma"

    # Second call: artifact is fresh -> reused (idempotent), identical content.
    model2 = D.build_docmodel(src, workspace="wsX", emit_crops=False, log_fn=lambda *_: None)
    assert model2 == on_disk


def test_build_docmodel_falls_back_when_backend_errors(tmp_path, monkeypatch):
    monkeypatch.setattr(D, "get_workspace_path",
                        lambda ws="default", sub="": (tmp_path / ws / sub) if sub else (tmp_path / ws))
    # Force the pymupdf backend to fail -> graceful text-only fallback (degraded).
    monkeypatch.setattr(D, "_extract_with_pymupdf",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    src = tmp_path / "doc.txt"
    src.write_text("alpha beta gamma", encoding="utf-8")
    model = D.build_docmodel(src, workspace="wsX", emit_crops=False, log_fn=lambda *_: None)
    assert model["degraded"] is True
    assert model["elements"][0]["text"] == "alpha beta gamma"
