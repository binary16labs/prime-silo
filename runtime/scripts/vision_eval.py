"""
Vision-ingestion cascade eval (VIS-001 / ADR-003).

Runs the document → DocModel → describe → validate → review → **fidelity-judge**
cascade over a workspace and reports a per-stage FUNNEL, so you can see exactly
where diagrams leak out (the question behind "I don't see the diagrams being
created"). Two halves, each degrading honestly (no hollow success):

  STRUCTURAL (no models, always runs):
    visuals_total → crops_emitted (raster+region) → classified_diagram

  CASCADE (needs the local VLM; skipped+flagged when unreachable):
    → mermaid_valid → rendered_ok (needs mmdc) → fidelity>=T

Writes a JSON + Markdown report under ``<ws>/.benny/docmodel/eval/``.

Run with the bundled runtime (has fitz/docling + a reachable VLM for the cascade):
  PYTHONPATH="<runtime>;<bundle>/site" python scripts/vision_eval.py --workspace c5_test
  python scripts/vision_eval.py --workspace c5_test --source advanced-data-engineering-with-databricks
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Make `benny` importable when run as a loose script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from benny.core import docmodel as D  # noqa: E402
from benny.core.models import call_model  # noqa: E402
from benny.core.vision_describe import (  # noqa: E402
    DEFAULT_VLM,
    classify_visual,
    extract_code,
    render_validate_mermaid,
    validate_mermaid,
)
from benny.core.vision_pipeline import (  # noqa: E402
    VISUAL_TYPES,
    _caption_for,
    enrich_docmodel,
)
from benny.core.workspace import get_workspace_path  # noqa: E402

SUPPORTED = {".pdf", ".docx", ".pptx", ".html", ".md", ".txt"}


def _load_or_build_docmodels(
    workspace: str, source: Optional[str], backend: str, force: bool
) -> List[Dict[str, Any]]:
    """Reuse fresh DocModels under .benny/docmodel/, else build them from staging/data_in."""
    dm_dir = get_workspace_path(workspace, D.DOCMODEL_SUBDIR)
    models: List[Dict[str, Any]] = []
    existing = (
        [
            jf
            for jf in sorted(dm_dir.glob("*.json"))
            if not jf.name.endswith(".enriched.json")
        ]
        if dm_dir.exists()
        else []
    )
    if existing and not force:
        for jf in existing:
            if source and D._safe_stem(jf.stem) != D._safe_stem(source):
                continue
            models.append(json.loads(jf.read_text(encoding="utf-8")))
        if models:
            return models

    seen = set()
    for sub in ("staging", "data_in"):
        d = get_workspace_path(workspace, sub)
        if not d.exists():
            continue
        for f in sorted(d.glob("*.*")):
            if f.suffix.lower() not in SUPPORTED or D._safe_stem(f.name) in seen:
                continue
            if source and D._safe_stem(f.name) != D._safe_stem(source):
                continue
            seen.add(D._safe_stem(f.name))
            models.append(
                D.build_docmodel(f, workspace=workspace, backend=backend, force=force)
            )
    return models


def _structural_funnel(models: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Stages computable WITHOUT any model: how many visuals exist, how many got a
    crop (incl. vector regions), and how many we'd treat as a diagram."""
    visuals_total = crops_emitted = region_crops = classified_diagram = 0
    for dm in models:
        elements = dm.get("elements", [])
        by_order = {e["reading_order"]: e for e in elements}
        for el in elements:
            if el.get("type") not in VISUAL_TYPES:
                continue
            visuals_total += 1
            if not el.get("crop"):
                continue
            crops_emitted += 1
            if el.get("region"):
                region_crops += 1
            caption = _caption_for(by_order, el["reading_order"])
            if classify_visual(el["type"], caption, is_region=bool(el.get("region"))) == "diagram":
                classified_diagram += 1
    return {
        "visuals_total": visuals_total,
        "crops_emitted": crops_emitted,
        "region_crops": region_crops,
        "classified_diagram": classified_diagram,
    }


async def _probe_vlm(vlm_model: Optional[str], timeout: float = 12.0) -> Optional[str]:
    """Bounded reachability check so a dead VLM degrades fast instead of hanging the
    whole cascade. Returns None when reachable, else a short reason string."""
    model = vlm_model or DEFAULT_VLM
    try:
        await asyncio.wait_for(
            call_model(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                temperature=0.0,
                max_tokens=1,
                workspace_id="default",
                role="vision",
            ),
            timeout=timeout,
        )
        return None
    except asyncio.TimeoutError:
        return f"VLM '{model}' did not respond within {timeout:.0f}s"
    except Exception as e:
        return f"{type(e).__name__}: {e}"


async def _cascade(
    models: List[Dict[str, Any]], min_fidelity: float, vlm_model: Optional[str], limit: Optional[int]
) -> Dict[str, Any]:
    """Run the full enrich cascade per document and fold the summaries. Returns
    ``available=False`` (no hollow success) if the very first model call fails."""
    agg = {
        "available": True,
        "visual_processed": 0,
        "diagrams": 0,
        "mermaid_valid": 0,
        "rendered_ok": 0,
        "rendered_skipped": False,
        "fidelity_ge_t": 0,
        "caption_fallback": 0,
        "visual_judged": 0,
        "scores": [],
        "visual_scores": [],
        "per_doc": [],
    }
    for dm in models:
        kwargs: Dict[str, Any] = {
            "render_check": False,  # we render below to count, without gating validity
            "min_fidelity": min_fidelity,
            "limit": limit,
        }
        if vlm_model:
            kwargs["vlm_model"] = vlm_model
        try:
            res = await enrich_docmodel(dm, log_fn=lambda *a: None, **kwargs)
        except Exception as e:  # VLM unreachable / model error — report, don't fake
            agg["available"] = False
            agg["error"] = f"{type(e).__name__}: {e}"
            return agg
        s = res["summary"]
        agg["visual_processed"] += s["visual_processed"]
        agg["diagrams"] += s["diagrams"]
        agg["caption_fallback"] += s["caption_fallback"]
        agg["visual_judged"] += s["visual_judged"]
        for el in res["elements"]:
            sur = el.get("surrogate")
            if not sur or sur.get("surrogate_kind") != "mermaid":
                continue
            agg["mermaid_valid"] += 1
            ok, _r = validate_mermaid(extract_code(sur["content"], "mermaid"))
            rok, rreason, _png = render_validate_mermaid(sur["content"]) if ok else (False, "", None)
            if rreason == "mmdc-unavailable":
                agg["rendered_skipped"] = True
            elif rok:
                agg["rendered_ok"] += 1
            vs = sur.get("visual_score")
            if vs is not None:
                agg["visual_scores"].append(vs)
                if vs >= min_fidelity:
                    agg["fidelity_ge_t"] += 1
            if sur.get("score") is not None:
                agg["scores"].append(sur["score"])
        agg["per_doc"].append({"source": dm.get("source"), "summary": s})
    return agg


def _render_report(
    workspace: str, struct: Dict[str, Any], cascade: Dict[str, Any], min_fidelity: float
) -> str:
    avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else None  # noqa: E731
    lines = [
        f"# Vision cascade eval - workspace `{workspace}`",
        f"_generated {datetime.datetime.now(datetime.timezone.utc).isoformat()} | "
        f"fidelity threshold {min_fidelity}_",
        "",
        "## Funnel",
        "```",
        f"visuals_total          {struct['visuals_total']}",
        f"  |- crops_emitted      {struct['crops_emitted']}   (vector regions: {struct['region_crops']})",
        f"  |- classified_diagram {struct['classified_diagram']}",
    ]
    if cascade.get("available"):
        rendered = (
            "skipped (mmdc unavailable)"
            if cascade["rendered_skipped"] and cascade["rendered_ok"] == 0
            else str(cascade["rendered_ok"])
        )
        lines += [
            f"  |- mermaid_valid      {cascade['mermaid_valid']}",
            f"  |- rendered_ok        {rendered}",
            f"  \\- fidelity>={min_fidelity}      {cascade['fidelity_ge_t']}   "
            f"(avg visual {avg(cascade['visual_scores'])}, judged {cascade['visual_judged']})",
            "```",
            "",
            f"caption_fallback: {cascade['caption_fallback']}  |  "
            f"avg reviewer score: {avg(cascade['scores'])}",
        ]
    else:
        lines += [
            "  |- mermaid_valid      - (cascade skipped)",
            "  \\- fidelity           - (cascade skipped)",
            "```",
            "",
            f"> [!] Cascade stages skipped - VLM unavailable: `{cascade.get('error','unknown')}`",
            "> Structural funnel above is still authoritative (crops/regions need no model).",
        ]
    # Per-stage leak read-out
    lines += ["", "## Where it leaks"]
    if struct["visuals_total"] and struct["crops_emitted"] < struct["visuals_total"]:
        lines.append(
            f"- {struct['visuals_total'] - struct['crops_emitted']} visual(s) got **no crop** "
            "(vector figure the extractor missed, or extraction failed)."
        )
    if struct["crops_emitted"] and struct["classified_diagram"] == 0:
        lines.append("- crops exist but **none classified as a diagram** (caption/region heuristic).")
    if cascade.get("available") and cascade["mermaid_valid"] < struct["classified_diagram"]:
        lines.append(
            f"- {struct['classified_diagram'] - cascade['mermaid_valid']} diagram(s) "
            "never produced **valid Mermaid**."
        )
    if cascade.get("available") and cascade["mermaid_valid"] and cascade["fidelity_ge_t"] < cascade["mermaid_valid"]:
        lines.append(
            f"- {cascade['mermaid_valid'] - cascade['fidelity_ge_t']} valid diagram(s) "
            f"scored **below fidelity {min_fidelity}** (advisory — still emitted)."
        )
    if len(lines) and lines[-1] == "## Where it leaks":
        lines.append("- no leaks detected at the measured stages. OK")
    return "\n".join(lines)


async def _amain() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workspace", default="default")
    ap.add_argument("--source", default=None, help="restrict to one source stem")
    ap.add_argument("--backend", default="pymupdf", choices=["pymupdf", "docling"])
    ap.add_argument("--min-fidelity", type=float, default=7.0)
    ap.add_argument("--vlm-model", default=None)
    ap.add_argument("--limit", type=int, default=None, help="cap visuals per doc")
    ap.add_argument("--force", action="store_true", help="rebuild DocModels")
    ap.add_argument("--no-cascade", action="store_true",
                    help="structural funnel only (skip all model calls)")
    args = ap.parse_args()

    models = _load_or_build_docmodels(args.workspace, args.source, args.backend, args.force)
    if not models:
        print(f"No ingestible docs / DocModels found in workspace '{args.workspace}'.")
        return 2

    struct = _structural_funnel(models)
    if args.no_cascade:
        cascade = {"available": False, "error": "skipped (--no-cascade)"}
    else:
        unreachable = await _probe_vlm(args.vlm_model)
        if unreachable:
            cascade = {"available": False, "error": unreachable}
        else:
            cascade = await _cascade(models, args.min_fidelity, args.vlm_model, args.limit)
    report = _render_report(args.workspace, struct, cascade, args.min_fidelity)
    print(report)

    out_dir = get_workspace_path(args.workspace, f"{D.DOCMODEL_SUBDIR}/eval")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    (out_dir / f"eval-{stamp}.md").write_text(report, encoding="utf-8")
    (out_dir / f"eval-{stamp}.json").write_text(
        json.dumps({"structural": struct, "cascade": cascade}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\nReport written to {out_dir}")
    return 0


def main() -> int:
    return asyncio.run(_amain())


if __name__ == "__main__":
    raise SystemExit(main())
