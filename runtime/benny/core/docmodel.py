"""
DocModel — structured document extraction (VIS-001 / ADR-003 Phase 0).

Parses a document into Docling's element tree, preserving per-element **type**,
**page**, **bbox** and **reading order**; exports tables to **JSON**; persists a
**crop** per picture keyed by content-hash; and writes a
``workspace/.benny/docmodel/<source>.json`` artifact. **No VLM** runs here — this
is the visually-complete substrate the vision describer ladder (Phase 2) and the
PageIndex spine (ADR-002) consume.

This replaces the early-flatten in ``core/extraction.py`` for the vision path:
instead of throwing figures/tables away into markdown, every element survives
with provenance. The default ingest path is untouched (VIS-F5) — this is a
separate entry point gated behind the ``vision`` ingest flag.

The Docling-dependent extraction is intentionally thin; the transformation logic
(hashing, bbox/table serialization, traversal guard) is pure and unit-tested
offline (VIS-NFR1).
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import re
import statistics
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .workspace import get_workspace_path

logger = logging.getLogger(__name__)

DOCMODEL_SCHEMA = "prime-silo.docmodel/1"
DOCMODEL_SUBDIR = ".benny/docmodel"

# Element types that carry a visual crop worth describing later (Phase 2).
VISUAL_LABELS = {"picture", "chart"}


# =============================================================================
# PURE HELPERS (no Docling, no I/O — unit-tested offline)
# =============================================================================


def _short_hash(*parts: Any, length: int = 16) -> str:
    """Stable short sha256 over the string form of the given parts."""
    h = hashlib.sha256("\x1f".join("" if p is None else str(p) for p in parts).encode("utf-8"))
    return h.hexdigest()[:length]


def _safe_stem(name: str) -> str:
    """Filesystem-safe stem for a source name — strips any path/traversal and
    keeps only ``[A-Za-z0-9._-]`` (VIS-SEC2 belt-and-braces over the
    workspace-path guard)."""
    stem = Path(str(name)).stem
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", stem)
    stem = stem.strip("._") or "doc"
    return stem


def _bbox_to_dict(bbox: Any) -> Optional[Dict[str, Any]]:
    """Normalize a Docling BoundingBox to a plain dict, or None."""
    if bbox is None:
        return None
    try:
        origin = getattr(bbox, "coord_origin", None)
        return {
            "l": float(bbox.l),
            "t": float(bbox.t),
            "r": float(bbox.r),
            "b": float(bbox.b),
            "coord_origin": getattr(origin, "value", str(origin)) if origin is not None else None,
        }
    except Exception:
        return None


def _df_to_table_json(df: Any) -> Dict[str, Any]:
    """Convert a pandas DataFrame (from ``TableItem.export_to_dataframe``) into a
    JSON-serializable structured table: column names + rows + shape. NaN → None."""
    columns = [str(c) for c in df.columns]
    # astype(object) FIRST so the None replacement sticks — on a float column
    # ``where(..., None)`` re-casts None back to NaN (not JSON-safe). Object dtype
    # keeps None, giving valid JSON with no NaN tokens.
    safe = df.astype(object).where(df.notna(), None)
    rows = safe.values.tolist()
    return {
        "columns": columns,
        "rows": rows,
        "n_rows": int(df.shape[0]),
        "n_cols": int(df.shape[1]),
    }


def _element_id(
    reading_order: int,
    label: str,
    page: Any,
    bbox: Optional[Dict[str, Any]],
    text: Optional[str],
    self_ref: Any,
) -> str:
    """Stable per-element id. Uses structural coordinates (order/type/page/bbox)
    plus a text/self_ref discriminator so re-extracting the same document yields
    the same ids (idempotent crop keys, stable provenance)."""
    bbox_key = None if bbox is None else (bbox["l"], bbox["t"], bbox["r"], bbox["b"])
    return _short_hash(reading_order, label, page, bbox_key, (text or "")[:80], self_ref)


# =============================================================================
# DOCLING-DEPENDENT EXTRACTION
# =============================================================================


def _docmodel_dir(workspace: str) -> Path:
    return get_workspace_path(workspace, DOCMODEL_SUBDIR)


def _is_fresh(json_path: Path, source_path: Path) -> bool:
    """True if the docmodel json exists, is non-empty, and is at least as new as
    the source — the same idempotency guard ``promote_staged_files`` uses."""
    return (
        json_path.exists()
        and json_path.stat().st_size > 0
        and json_path.stat().st_mtime >= source_path.stat().st_mtime
    )


def _build_converter(do_ocr: bool, images_scale: float, emit_crops: bool):
    """Construct a Docling converter configured for structured extraction.

    ``generate_page_images`` is what makes per-picture crops available via
    ``PictureItem.get_image(doc)`` (the non-deprecated path in docling 2.107).
    ``do_table_structure`` powers ``export_to_dataframe`` → table JSON.
    """
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions()
    opts.do_ocr = do_ocr
    opts.do_table_structure = True
    opts.generate_page_images = emit_crops
    opts.images_scale = images_scale

    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=opts, backend=PyPdfiumDocumentBackend)
        }
    )


def build_docmodel(
    file_path: Path,
    workspace: str = "default",
    *,
    backend: str = "pymupdf",
    do_ocr: bool = False,
    images_scale: float = 2.0,
    emit_crops: bool = True,
    force: bool = False,
    log_fn: Callable = print,
) -> Dict[str, Any]:
    """Build (or reuse) the DocModel for ``file_path``.

    ``backend``:
      - ``"pymupdf"`` (default) — lean, fully offline, no torch / no model download.
        Figure crops via ``extract_image``, tables via ``find_tables``, text in
        reading order with font-size heading heuristics. Ships in the runtime bundle.
      - ``"docling"`` — higher-accuracy ML layout/table models (torch/transformers,
        fetches HF weights on first use). Opt-in; not bundled. Install ``docling``.

    Idempotent: returns the cached ``<stem>.json`` when it is at least as new as the
    source unless ``force``. On any backend error, falls back to a text-only DocModel
    (flagged ``degraded``) so the pipeline still has something to ingest — graceful
    degradation, never silent success.
    """
    file_path = Path(file_path)
    stem = _safe_stem(file_path.name)
    out_dir = _docmodel_dir(workspace)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{stem}.json"

    if not force and file_path.exists() and _is_fresh(json_path, file_path):
        log_fn(f"[docmodel] reusing fresh {json_path.name}")
        return json.loads(json_path.read_text(encoding="utf-8"))

    crops_dir = out_dir / "crops" / stem

    try:
        if backend == "docling":
            model = _extract_with_docling(
                file_path,
                workspace,
                out_dir,
                crops_dir,
                stem,
                do_ocr=do_ocr,
                images_scale=images_scale,
                emit_crops=emit_crops,
                log_fn=log_fn,
            )
        else:
            model = _extract_with_pymupdf(
                file_path,
                workspace,
                crops_dir,
                stem,
                emit_crops=emit_crops,
                log_fn=log_fn,
            )
    except ImportError as e:
        log_fn(
            f"[docmodel] {backend} backend unavailable ({e}); text-only fallback for {file_path.name}"
        )
        model = _fallback_textonly(file_path, stem, reason=f"{backend}-import:{e}", log_fn=log_fn)
    except Exception as e:
        log_fn(
            f"[docmodel] {backend} extraction failed for {file_path.name}: {e}; text-only fallback"
        )
        model = _fallback_textonly(file_path, stem, reason=f"{backend}-error:{e}", log_fn=log_fn)

    json_path.write_text(json.dumps(model, indent=2, ensure_ascii=False), encoding="utf-8")
    log_fn(
        f"[docmodel] wrote {json_path.name} [{backend}]: {len(model['elements'])} elements "
        f"({model['counts']})"
    )
    return model


# =============================================================================
# PyMuPDF BACKEND (default — lean, offline, no torch / no model download)
# =============================================================================


def _bbox_tuple_to_dict(t: Tuple[float, float, float, float]) -> Dict[str, Any]:
    return {
        "l": float(t[0]),
        "t": float(t[1]),
        "r": float(t[2]),
        "b": float(t[3]),
        "coord_origin": "TOPLEFT",
    }


def _rows_to_table_json(rows: List[List[Any]]) -> Dict[str, Any]:
    """Convert ``TableFinder.extract()`` rows (list of cell-string rows) to the same
    table JSON shape the Docling path emits. First row = header."""
    rows = [r for r in rows if r is not None]
    if not rows:
        return {"columns": [], "rows": [], "n_rows": 0, "n_cols": 0}
    header = ["" if c is None else str(c) for c in rows[0]]
    body = [[None if c is None else c for c in r] for r in rows[1:]]
    return {"columns": header, "rows": body, "n_rows": len(body), "n_cols": len(header)}


def _looks_like_table(rows: List[List[Any]]) -> bool:
    """Light sanity filter for RULED-line tables (high precision already): ≥2 rows,
    ≥2 cols, ≥50% cells non-empty. (We deliberately do NOT use PyMuPDF's
    text-alignment strategy — it shatters prose into fake columns and would
    suppress real body text. Borderless tables stay as text under this backend;
    use backend='docling' when structured borderless tables matter.)"""
    if len(rows) < 2:
        return False
    ncols = max((len(r) for r in rows), default=0)
    if ncols < 2:
        return False
    cells = [c for r in rows for c in r]
    nonempty = sum(1 for c in cells if c not in (None, ""))
    return bool(cells) and nonempty / len(cells) >= 0.5


def _rect_mostly_inside(outer: Tuple, inner: Tuple, frac: float = 0.6) -> bool:
    ix0, iy0 = max(outer[0], inner[0]), max(outer[1], inner[1])
    ix1, iy1 = min(outer[2], inner[2]), min(outer[3], inner[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area = max(1e-6, (inner[2] - inner[0]) * (inner[3] - inner[1]))
    return inter / area >= frac


def _is_diagram_region(
    rect: Tuple[float, float, float, float],
    page_rect: Tuple[float, float, float, float],
    *,
    table_rects: List[Tuple],
    img_rects: List[Tuple],
    min_area_frac: float = 0.02,
    max_area_frac: float = 0.92,
    min_side: float = 24.0,
    max_aspect: float = 12.0,
) -> bool:
    """Decide whether a clustered vector-drawing bbox is a *figure-like region* worth
    cropping (the vector/SVG diagrams the xref-image path misses — the #1 reason
    Databricks-style architecture figures never get a surrogate).

    Pure geometry, no fitz — so it is unit-tested offline. Rejects: tiny marks/icons,
    skinny rules/dividers, full-page backgrounds/borders, and clusters already covered
    by a captured table or raster image. ``cluster_drawings`` only returns vector
    drawings (not text), so prose is excluded upstream."""
    w = max(0.0, rect[2] - rect[0])
    h = max(0.0, rect[3] - rect[1])
    if w <= 0 or h <= 0:
        return False
    page_area = max(1e-6, (page_rect[2] - page_rect[0]) * (page_rect[3] - page_rect[1]))
    frac = (w * h) / page_area
    if frac < min_area_frac or frac > max_area_frac:
        return False
    if min(w, h) < min_side:
        return False  # rule / thin divider / icon
    if max(w, h) / max(1.0, min(w, h)) > max_aspect:
        return False  # long skinny line, not a diagram
    if any(_rect_mostly_inside(r, rect) or _rect_mostly_inside(rect, r) for r in table_rects):
        return False  # already captured as a table
    if any(_rect_mostly_inside(r, rect) or _rect_mostly_inside(rect, r) for r in img_rects):
        return False  # already captured as a raster figure
    return True


def _classify_text_block(text: str, max_size: float, median_size: float, page_no: int) -> str:
    s = text.strip()
    low = s.lower()
    if re.match(r"^(figure|fig\.|table)\s*\d", low):
        return "caption"
    if re.match(r"^\s*([•▪●■–\-\*]|\d+\.|\(?[a-z]\))\s+", s):
        return "list_item"
    short = len(s) <= 120 and s.count("\n") == 0
    if short and max_size >= median_size * 1.8 and page_no == 1:
        return "title"
    if short and max_size >= median_size * 1.18:
        return "section_header"
    return "text"


def _extract_with_pymupdf(
    file_path: Path,
    workspace: str,
    crops_dir: Path,
    stem: str,
    *,
    emit_crops: bool,
    log_fn: Callable,
) -> Dict[str, Any]:
    ext = file_path.suffix.lower()
    # Plain text needs no PyMuPDF — handle before importing fitz so a text ingest
    # works even where PyMuPDF isn't installed.
    if ext in (".txt", ".md"):
        text = file_path.read_text(encoding="utf-8", errors="replace").strip()
        els = (
            [
                {
                    "id": _element_id(0, "text", None, None, text, None),
                    "reading_order": 0,
                    "type": "text",
                    "page": None,
                    "bbox": None,
                    "self_ref": None,
                    "text": text,
                }
            ]
            if text
            else []
        )
        return _model_envelope(
            file_path, workspace, "pymupdf", n_pages=None, counts={"text": len(els)}, elements=els
        )
    if ext != ".pdf":
        # docx/pptx/html aren't well served by PyMuPDF — use backend="docling" for those.
        raise NotImplementedError(
            f"pymupdf backend handles .pdf/.txt/.md, not {ext} (use backend='docling')"
        )

    import fitz  # PyMuPDF

    doc = fitz.open(str(file_path))
    elements: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}
    pages: Dict[int, str] = {}  # page_no -> ws-relative full-page PNG (review substrate)
    pages_dir = crops_dir.parents[1] / "pages" / stem
    order = 0

    for pno in range(doc.page_count):
        page = doc[pno]
        page_no = pno + 1

        # Full-page render — the "image of the whole page" the fidelity judge reviews
        # against, and the in-situ grounding for the describer. 2x for legible labels.
        if emit_crops:
            try:
                ppix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
                pdata = ppix.tobytes("png")
                pages_dir.mkdir(parents=True, exist_ok=True)
                pp = pages_dir / f"p{page_no}.png"
                if not pp.exists() or pp.stat().st_size == 0:
                    pp.write_bytes(pdata)
                pages[page_no] = str(pp.relative_to(get_workspace_path(workspace))).replace(
                    "\\", "/"
                )
            except Exception as e:
                log_fn(f"[docmodel] page image p{page_no} failed: {e}")

        td = page.get_text("dict")
        sizes = [
            sp.get("size", 0)
            for b in td["blocks"]
            if b.get("type", 0) == 0
            for ln in b.get("lines", [])
            for sp in ln.get("spans", [])
        ]
        median_size = statistics.median(sizes) if sizes else 10.0

        items: List[Tuple[float, float, Dict[str, Any]]] = []  # (y0, x0, partial)

        # 1. tables — RULED lines only (high precision, zero prose false positives).
        # Borderless tables intentionally fall through as text (see _looks_like_table).
        table_rects: List[Tuple] = []
        try:
            for t in page.find_tables().tables:
                rows = t.extract()
                if not _looks_like_table(rows):
                    continue
                bbox = tuple(t.bbox)
                table_rects.append(bbox)
                items.append(
                    (
                        bbox[1],
                        bbox[0],
                        {"type": "table", "bbox": bbox, "table": _rows_to_table_json(rows)},
                    )
                )
        except Exception as e:
            log_fn(f"[docmodel] find_tables p{page_no} failed: {e}")

        # 2. figures (embedded raster images)
        img_rects: List[Tuple] = []
        if emit_crops:
            for info in page.get_image_info(xrefs=True):
                xref = info.get("xref", 0)
                bbox = tuple(info.get("bbox", (0, 0, 0, 0)))
                if xref <= 0 or (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) < 2500:
                    continue  # skip rules/icons/tiny marks
                img_rects.append(bbox)
                crop_rel = None
                try:
                    base = doc.extract_image(xref)
                    data = base["image"]
                    digest = hashlib.sha256(data).hexdigest()[:16]
                    crops_dir.mkdir(parents=True, exist_ok=True)
                    cp = crops_dir / f"{digest}.{base.get('ext', 'png')}"
                    if not cp.exists():
                        cp.write_bytes(data)
                    crop_rel = str(cp.relative_to(get_workspace_path(workspace))).replace("\\", "/")
                except Exception as e:
                    log_fn(f"[docmodel] image xref {xref} extract failed: {e}")
                items.append(
                    (bbox[1], bbox[0], {"type": "picture", "bbox": bbox, "crop": crop_rel})
                )

        # 2b. vector-drawing figure regions (architecture/lakehouse diagrams drawn as
        # vectors have NO raster xref, so the loop above misses them entirely). Cluster
        # the page's drawings and crop the figure-like ones via a clipped render.
        if emit_crops and hasattr(page, "cluster_drawings"):
            page_rect = tuple(page.rect)
            try:
                clusters = [tuple(r) for r in page.cluster_drawings()]
            except Exception as e:
                log_fn(f"[docmodel] cluster_drawings p{page_no} failed: {e}")
                clusters = []
            for rect in clusters:
                if not _is_diagram_region(
                    rect, page_rect, table_rects=table_rects, img_rects=img_rects
                ):
                    continue
                crop_rel = None
                try:
                    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=fitz.Rect(rect))
                    data = pix.tobytes("png")
                    digest = hashlib.sha256(data).hexdigest()[:16]
                    crops_dir.mkdir(parents=True, exist_ok=True)
                    cp = crops_dir / f"{digest}.png"
                    if not cp.exists():
                        cp.write_bytes(data)
                    crop_rel = str(cp.relative_to(get_workspace_path(workspace))).replace("\\", "/")
                except Exception as e:
                    log_fn(f"[docmodel] region crop p{page_no} failed: {e}")
                # Treat as a captured figure so text inside it stays with the figure.
                img_rects.append(rect)
                items.append(
                    (
                        rect[1],
                        rect[0],
                        {"type": "picture", "bbox": rect, "crop": crop_rel, "region": True},
                    )
                )

        # 3. text blocks (skip those inside a table or figure region)
        for b in td["blocks"]:
            if b.get("type", 0) != 0:
                continue
            bbox = tuple(b["bbox"])
            if any(_rect_mostly_inside(r, bbox) for r in table_rects + img_rects):
                continue
            lines = [
                " ".join(sp.get("text", "") for sp in ln.get("spans", [])).strip()
                for ln in b.get("lines", [])
            ]
            text = " ".join(ln for ln in lines if ln).strip()
            if not text:
                continue
            max_size = max(
                (sp.get("size", 0) for ln in b.get("lines", []) for sp in ln.get("spans", [])),
                default=median_size,
            )
            items.append(
                (
                    bbox[1],
                    bbox[0],
                    {
                        "type": _classify_text_block(text, max_size, median_size, page_no),
                        "bbox": bbox,
                        "text": text,
                    },
                )
            )

        # reading order: top-to-bottom, then left-to-right
        items.sort(key=lambda it: (round(it[0], 1), round(it[1], 1)))
        for _y, _x, d in items:
            label = d["type"]
            counts[label] = counts.get(label, 0) + 1
            bbox_d = _bbox_tuple_to_dict(d["bbox"])
            text = d.get("text")
            el = {
                "id": _element_id(order, label, page_no, bbox_d, text, None),
                "reading_order": order,
                "type": label,
                "page": page_no,
                "bbox": bbox_d,
                "self_ref": None,
            }
            if text:
                el["text"] = text
            if "table" in d:
                el["table"] = d["table"]
            if d.get("crop"):
                el["crop"] = d["crop"]
            if d.get("region"):
                el["region"] = True
            elements.append(el)
            order += 1

    n_pages = doc.page_count
    doc.close()
    return _model_envelope(
        file_path,
        workspace,
        "pymupdf",
        n_pages=n_pages,
        counts=counts,
        elements=elements,
        pages=pages,
    )


def _model_envelope(
    file_path: Path, workspace: str, backend: str, *, n_pages, counts, elements, pages=None
) -> Dict[str, Any]:
    return {
        "schema": DOCMODEL_SCHEMA,
        "source": file_path.name,
        "workspace": workspace,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "backend": backend,
        "docling_version": _safe_version("docling") if backend == "docling" else None,
        "n_pages": n_pages,
        "degraded": False,
        "counts": counts,
        "pages": pages or {},
        "elements": elements,
    }


# =============================================================================
# DOCLING BACKEND (optional — higher accuracy, heavier)
# =============================================================================


def _extract_with_docling(
    file_path: Path,
    workspace: str,
    out_dir: Path,
    crops_dir: Path,
    stem: str,
    *,
    do_ocr: bool,
    images_scale: float,
    emit_crops: bool,
    log_fn: Callable,
) -> Dict[str, Any]:
    from docling_core.types.doc import PictureItem, TableItem

    converter = _build_converter(do_ocr, images_scale, emit_crops)
    result = converter.convert(str(file_path))
    doc = result.document

    elements: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}

    for idx, (item, _level) in enumerate(doc.iterate_items()):
        label = getattr(item, "label", None)
        label_val = getattr(label, "value", None) or "unknown"
        counts[label_val] = counts.get(label_val, 0) + 1

        prov_list = getattr(item, "prov", None) or []
        prov = prov_list[0] if prov_list else None
        page = getattr(prov, "page_no", None) if prov else None
        bbox = _bbox_to_dict(getattr(prov, "bbox", None)) if prov else None
        text = getattr(item, "text", None) or None
        self_ref = getattr(item, "self_ref", None)

        el: Dict[str, Any] = {
            "id": _element_id(idx, label_val, page, bbox, text, self_ref),
            "reading_order": idx,
            "type": label_val,
            "page": page,
            "bbox": bbox,
            "self_ref": self_ref,
        }
        if text:
            el["text"] = text

        # Tables → structured JSON (VIS-F2)
        if isinstance(item, TableItem):
            try:
                el["table"] = _df_to_table_json(item.export_to_dataframe(doc))
            except Exception as e:
                log_fn(f"[docmodel] table export failed at #{idx}: {e}")

        # Pictures/charts → content-addressed crop (VIS-F3)
        if emit_crops and isinstance(item, PictureItem):
            crop_rel = _save_crop(item, doc, crops_dir, workspace, log_fn)
            if crop_rel:
                el["crop"] = crop_rel

        elements.append(el)

    pages = (
        _save_docling_page_images(doc, out_dir / "pages" / stem, workspace, log_fn)
        if emit_crops
        else {}
    )

    return {
        "schema": DOCMODEL_SCHEMA,
        "source": file_path.name,
        "workspace": workspace,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "docling_version": _safe_version("docling"),
        "n_pages": _num_pages(doc),
        "degraded": False,
        "counts": counts,
        "pages": pages,
        "elements": elements,
    }


def _save_docling_page_images(
    doc: Any, pages_dir: Path, workspace: str, log_fn: Callable
) -> Dict[int, str]:
    """Persist Docling's per-page renders (enabled via ``generate_page_images``) as the
    whole-page review substrate. Best-effort + guarded — Docling's page-image access
    shifts across versions, and a missing page image must not sink extraction."""
    pages: Dict[int, str] = {}
    try:
        page_map = getattr(doc, "pages", {}) or {}
        ws_root = get_workspace_path(workspace)
        for pno, page in page_map.items():
            img = getattr(getattr(page, "image", None), "pil_image", None)
            if img is None:
                continue
            try:
                import io

                buf = io.BytesIO()
                img.save(buf, format="PNG")
                pages_dir.mkdir(parents=True, exist_ok=True)
                pp = pages_dir / f"p{int(pno)}.png"
                if not pp.exists() or pp.stat().st_size == 0:
                    pp.write_bytes(buf.getvalue())
                pages[int(pno)] = str(pp.relative_to(ws_root)).replace("\\", "/")
            except Exception as e:
                log_fn(f"[docmodel] docling page image p{pno} failed: {e}")
    except Exception as e:
        log_fn(f"[docmodel] docling page images unavailable: {e}")
    return pages


def _save_crop(
    item: Any, doc: Any, crops_dir: Path, workspace: str, log_fn: Callable
) -> Optional[str]:
    """Render a picture's crop to PNG keyed by image-bytes hash (so identical
    images dedupe across re-ingest). Returns the workspace-relative path or None."""
    try:
        img = item.get_image(doc)
        if img is None:
            return None
        import io

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()[:16]
        crops_dir.mkdir(parents=True, exist_ok=True)
        crop_path = crops_dir / f"{digest}.png"
        if not crop_path.exists():
            crop_path.write_bytes(data)
        ws_root = get_workspace_path(workspace)
        return str(crop_path.relative_to(ws_root)).replace("\\", "/")
    except Exception as e:
        log_fn(f"[docmodel] crop save failed: {e}")
        return None


def _fallback_textonly(
    file_path: Path, stem: str, *, reason: str, log_fn: Callable
) -> Dict[str, Any]:
    """Produce a minimal text-only DocModel using basic extraction when Docling
    is unavailable/failed — keeps the pipeline alive without pretending the rich
    structure was extracted (``degraded`` flag + reason)."""
    text = ""
    try:
        from .extraction import _basic_extract

        text = _basic_extract(file_path)
    except Exception as e:
        log_fn(f"[docmodel] basic extraction also failed: {e}")

    elements = []
    if text.strip():
        elements.append(
            {
                "id": _element_id(0, "text", None, None, text, "#/texts/0"),
                "reading_order": 0,
                "type": "text",
                "page": None,
                "bbox": None,
                "self_ref": "#/texts/0",
                "text": text,
            }
        )

    return {
        "schema": DOCMODEL_SCHEMA,
        "source": file_path.name,
        "workspace": None,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "docling_version": None,
        "n_pages": None,
        "degraded": True,
        "degraded_reason": reason,
        "counts": {"text": len(elements)},
        "elements": elements,
    }


def _safe_version(pkg: str) -> Optional[str]:
    try:
        from importlib.metadata import version

        return version(pkg)
    except Exception:
        return None


def _num_pages(doc: Any) -> Optional[int]:
    try:
        n = doc.num_pages()
        return int(n)
    except Exception:
        try:
            return len(getattr(doc, "pages", {}) or {})
        except Exception:
            return None
