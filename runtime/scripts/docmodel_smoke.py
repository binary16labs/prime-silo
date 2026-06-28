"""
VIS-001 / ADR-003 Phase 0 — live DocModel smoke.

Generates a small PDF (title + paragraph + an embedded image + a bordered table),
runs ``build_docmodel`` through the real Docling pipeline, and prints what was
captured: element types, page/bbox provenance, reading order, table→JSON, and a
persisted picture crop. Proves the figures/tables the old path discarded now
survive with provenance.

Run with the bundled runtime (has docling + fitz + Pillow):
  PYTHONPATH="<runtime>;<bundle>/site" <bundle>/python/python.exe scripts/docmodel_smoke.py

NOTE: the FIRST run downloads Docling's layout + TableFormer model weights from
Hugging Face (the offline caveat) — minutes + network. Subsequent runs are cached.
"""
import os
import sys
import tempfile
from pathlib import Path

SCRATCH = Path(tempfile.gettempdir()) / "vis_docmodel_smoke"
SCRATCH.mkdir(parents=True, exist_ok=True)
# Point the workspace root at a scratch home BEFORE importing benny.core.*
os.environ["BENNY_HOME"] = str(SCRATCH / "home")


def make_pdf(pdf_path: Path) -> None:
    import fitz  # PyMuPDF
    from PIL import Image, ImageDraw

    # an unmistakable picture (so a crop is produced)
    img_path = SCRATCH / "fig.png"
    im = Image.new("RGB", (180, 100), "white")
    d = ImageDraw.Draw(im)
    for i, col in enumerate([(0, 0, 255), (255, 0, 0), (255, 255, 0)]):
        d.rectangle([i * 60, 0, i * 60 + 60, 100], fill=col)
    im.save(img_path)

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "VIS-001 DocModel Smoke Test", fontsize=22)
    page.insert_text((72, 110),
                     "This paragraph proves text elements carry page and bbox "
                     "provenance in document reading order.", fontsize=11)
    page.insert_image(fitz.Rect(72, 140, 252, 240), filename=str(img_path))

    # a simple bordered table (best-effort: docling infers tables from layout)
    x0, y0, cw, rh, cols, rows = 72, 270, 120, 24, 3, 3
    cells = [["Metric", "Q1", "Q2"], ["Revenue", "100", "140"], ["Cost", "60", "75"]]
    shape = page.new_shape()
    for r in range(rows):
        for c in range(cols):
            rect = fitz.Rect(x0 + c * cw, y0 + r * rh, x0 + (c + 1) * cw, y0 + (r + 1) * rh)
            shape.draw_rect(rect)
            page.insert_text((rect.x0 + 4, rect.y0 + 16), cells[r][c], fontsize=10)
    shape.finish(width=0.8)
    shape.commit()

    doc.save(str(pdf_path))
    doc.close()


def main() -> int:
    pdf_path = SCRATCH / "smoke.pdf"
    make_pdf(pdf_path)
    print(f"[smoke] generated {pdf_path} ({pdf_path.stat().st_size} bytes)")

    from benny.core.docmodel import build_docmodel

    model = build_docmodel(pdf_path, workspace="vis_smoke", emit_crops=True, force=True)

    print("\n=== DocModel summary ===")
    print(f"schema={model['schema']} degraded={model['degraded']} "
          f"docling={model['docling_version']} pages={model['n_pages']}")
    print(f"counts={model['counts']}")
    print(f"elements={len(model['elements'])}")
    has_table = any("table" in e for e in model["elements"])
    has_crop = any("crop" in e for e in model["elements"])
    have_bbox = sum(1 for e in model["elements"] if e.get("bbox"))
    print(f"elements_with_bbox={have_bbox}  any_table_json={has_table}  any_crop={has_crop}")

    print("\n=== first 8 elements ===")
    for e in model["elements"][:8]:
        extra = "TABLE" if "table" in e else ("CROP=" + e["crop"] if "crop" in e else (e.get("text", "")[:48]))
        print(f"  #{e['reading_order']:>2} {e['type']:<14} p{e['page']} bbox={'Y' if e['bbox'] else '-'}  {extra}")

    if has_table:
        t = next(e["table"] for e in model["elements"] if "table" in e)
        print(f"\n=== table JSON === cols={t['columns']} {t['n_rows']}x{t['n_cols']}")
        for row in t["rows"]:
            print("   ", row)

    ok = (not model["degraded"]) and have_bbox > 0 and has_crop
    print(f"\n*** PHASE 0 SMOKE: {'PASS' if ok else 'PARTIAL/FAIL'} "
          f"(degraded={model['degraded']}, bbox={have_bbox>0}, crop={has_crop}, table={has_table}) ***")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
