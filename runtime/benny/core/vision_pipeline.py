"""
Vision pipeline orchestrator (VIS-001 / ADR-003 Phase 3).

Ties the pieces into the reusable, multimodal document-parsing workflow:

    DocModel (Phase 0)  →  describe each visual via the multi-model ladder (Phase 2)
                        →  stitch surrogates back IN READING ORDER
                        →  enriched markdown + JSON sidecar (graph-ready, provenance-kept)

This is the "greater than the sum of the parts" step: Docling supplies deterministic
structure, qwen3vl reads the figures, the qwen3-9b reviewer + validator keep them
honest, and the result is a single document where every figure is a Mermaid diagram,
every table is JSON, and every surrogate cites its page/bbox/source figure — feeding
the existing PageIndex/triple pipeline unchanged.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .docmodel import _safe_stem
from .vision_describe import (
    DEFAULT_REVIEWER,
    DEFAULT_VLM,
    _table_json_to_markdown,
    classify_visual,
    describe_element,
)
from .workspace import get_workspace_path

logger = logging.getLogger(__name__)

VISUAL_TYPES = {"picture", "chart"}


# =============================================================================
# CONTEXT GATHERING (caption + neighbours — the grounding the VLM needs)
# =============================================================================


def _caption_for(by_order: Dict[int, dict], order: int) -> str:
    for o in (order + 1, order - 1, order + 2):
        e = by_order.get(o)
        if e and e.get("type") == "caption" and e.get("text"):
            return e["text"]
    return ""


def _context_for(by_order: Dict[int, dict], order: int, window: int = 4) -> str:
    parts: List[str] = []
    for o in range(order - window, order + window + 1):
        if o == order:
            continue
        e = by_order.get(o)
        if e and e.get("type") in ("caption", "section_header", "text") and e.get("text"):
            tag = "CAPTION" if e["type"] == "caption" else e["type"]
            parts.append(f"[{tag}] {e['text'][:300]}")
    return "\n".join(parts)


# =============================================================================
# STITCHING — surrogate → markdown, in place
# =============================================================================


def _surrogate_to_markdown(el: dict) -> str:
    """Render one element's enriched markdown, with a provenance comment so a
    downstream node can cite the source figure/page/bbox."""
    t = el.get("type")
    sur = el.get("surrogate")
    prov = f"<!-- docmodel id={el['id']} type={t} page={el.get('page')} -->"

    if t == "title":
        return f"# {el.get('text','').strip()}"
    if t == "section_header":
        return f"## {el.get('text','').strip()}"
    if t == "list_item":
        return f"- {el.get('text','').strip()}"
    if t in ("text", "caption", "footnote", "paragraph"):
        return el.get("text", "").strip()

    if t == "table" and el.get("table"):
        md = _table_json_to_markdown(el["table"], max_rows=50)
        js = json.dumps(
            {"columns": el["table"]["columns"], "rows": el["table"]["rows"]}, ensure_ascii=False
        )
        return f"{prov}\n{md}\n\n```json\n{js}\n```"

    if t in VISUAL_TYPES and sur:
        kind = sur.get("surrogate_kind")
        score = sur.get("score")
        if kind == "mermaid":
            return f"{prov[:-4]} figure_score={score} -->\n```mermaid\n{sur['content']}\n```"
        if kind == "chart_json":
            return f"{prov}\n```json\n{sur['content']}\n```"
        # caption / caption_fallback
        return f"{prov}\n*Figure ({el.get('page')}): {sur.get('content','').strip()}*"

    # unhandled type with text
    return el.get("text", "").strip()


# =============================================================================
# ORCHESTRATION
# =============================================================================


async def enrich_docmodel(
    docmodel: Dict[str, Any],
    *,
    workspace_root: Optional[Path] = None,
    vlm_model: str = DEFAULT_VLM,
    reviewer_model: str = DEFAULT_REVIEWER,
    max_refine: int = 1,
    render_check: bool = False,
    limit: Optional[int] = None,
    run_id: Optional[str] = None,
    log_fn: Callable = print,
) -> Dict[str, Any]:
    """Run the describer ladder over every visual element of ``docmodel`` and stitch
    an enriched document. Returns ``{markdown, elements, summary}``. Tables reuse the
    Phase-0 JSON (no VLM). Mutates a copy — the input docmodel is left intact.
    """
    ws = docmodel.get("workspace") or "default"
    root = workspace_root or get_workspace_path(ws)
    elements = [dict(e) for e in docmodel.get("elements", [])]
    by_order = {e["reading_order"]: e for e in elements}

    visuals = [e for e in elements if e.get("type") in VISUAL_TYPES and e.get("crop")]
    if limit is not None:
        visuals = visuals[:limit]
    todo_ids = {e["id"] for e in visuals}

    summary = {
        "visual_total": sum(1 for e in elements if e.get("type") in VISUAL_TYPES),
        "visual_processed": 0,
        "diagrams": 0,
        "validated": 0,
        "caption_fallback": 0,
        "charts": 0,
        "tables": 0,
        "scores": [],
    }

    for el in elements:
        if el.get("type") == "table" and el.get("table"):
            summary["tables"] += 1
            continue
        if el["id"] not in todo_ids:
            continue
        crop_path = root / el["crop"]
        if not crop_path.exists():
            log_fn(f"[pipeline] crop missing for #{el['reading_order']}: {crop_path}")
            continue
        caption = _caption_for(by_order, el["reading_order"])
        context = _context_for(by_order, el["reading_order"])
        kind = classify_visual(el["type"], caption)
        log_fn(
            f"[pipeline] #{el['reading_order']} p{el.get('page')} {el['type']} -> {kind}  ({caption[:50]!r})"
        )

        sur = await describe_element(
            crop_path.read_bytes(),
            label=el["type"],
            caption=caption,
            context=context,
            vlm_model=vlm_model,
            reviewer_model=reviewer_model,
            max_refine=max_refine,
            render_check=render_check,
            run_id=run_id,
            log_fn=lambda *a: log_fn("    ", *a),
        )
        el["surrogate"] = sur
        summary["visual_processed"] += 1
        if sur["surrogate_kind"] in ("mermaid",):
            summary["diagrams"] += 1
        if sur["surrogate_kind"] == "chart_json":
            summary["charts"] += 1
        if sur.get("validated"):
            summary["validated"] += 1
        if sur["surrogate_kind"] == "caption_fallback":
            summary["caption_fallback"] += 1
        if sur.get("score") is not None:
            summary["scores"].append(sur["score"])

    scores = summary.pop("scores")
    summary["avg_score"] = round(sum(scores) / len(scores), 2) if scores else None

    markdown = "\n\n".join(
        _surrogate_to_markdown(e) for e in elements if _surrogate_to_markdown(e).strip()
    )

    return {
        "markdown": markdown,
        "elements": elements,
        "summary": summary,
        "source": docmodel.get("source"),
        "workspace": ws,
    }


def write_enriched(
    result: Dict[str, Any], workspace: str, stem: str, workspace_root: Optional[Path] = None
) -> Dict[str, str]:
    """Persist the enriched markdown (for ingest) + JSON sidecar (provenance) under
    ``.benny/docmodel/``. Returns the written paths."""
    root = workspace_root or get_workspace_path(workspace)
    out_dir = root / ".benny" / "docmodel"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(stem)
    md_path = out_dir / f"{stem}.enriched.md"
    json_path = out_dir / f"{stem}.enriched.json"
    md_path.write_text(result["markdown"], encoding="utf-8")
    json_path.write_text(
        json.dumps(
            {
                "source": result.get("source"),
                "summary": result["summary"],
                "elements": result["elements"],
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return {"markdown": str(md_path), "json": str(json_path)}
