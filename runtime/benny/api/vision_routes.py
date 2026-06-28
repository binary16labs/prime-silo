"""
Vision ingestion routes (VIS-001 / ADR-003).

Exposes the multimodal document-parsing workflow over HTTP so the
``vision_ingestion_pipeline`` manifest is runnable via ``benny enrich``:

  POST /api/vision/docmodel  — Phase 0: parse staged/ingestible docs into DocModels
                               (element tree + table JSON + picture crops).
  POST /api/vision/enrich    — Phase 2+3: run the describer ladder over each DocModel's
                               visuals and stitch an enriched markdown into data_in/
                               (which the existing /api/rag/ingest then consumes).

Both are long-running (Docling + local VLM); callers use the manifest's
blocking_with_task_fallback. All model calls flow through ``call_model``.
"""

import json
from typing import Optional

from fastapi import APIRouter, HTTPException

from ..core.docmodel import _safe_stem, build_docmodel
from ..core.vision_pipeline import enrich_docmodel, write_enriched
from ..core.workspace import get_workspace_path

router = APIRouter()

SUPPORTED = {".pdf", ".docx", ".pptx", ".html", ".md", ".txt"}


@router.post("/docmodel")
async def vision_docmodel(
    workspace: str = "default",
    emit_crops: bool = True,
    source: Optional[str] = None,
    force: bool = False,
):
    """Build DocModels for ingestible files under the workspace (staging + data_in)."""
    results = []
    seen = set()
    for sub in ("staging", "data_in"):
        d = get_workspace_path(workspace, sub)
        if not d.exists():
            continue
        for f in sorted(d.glob("*.*")):
            if f.suffix.lower() not in SUPPORTED or _safe_stem(f.name) in seen:
                continue
            if source and _safe_stem(f.name) != _safe_stem(source):
                continue
            seen.add(_safe_stem(f.name))
            try:
                model = build_docmodel(f, workspace=workspace, emit_crops=emit_crops, force=force)
                results.append(
                    {
                        "source": f.name,
                        "elements": len(model["elements"]),
                        "counts": model["counts"],
                        "degraded": model["degraded"],
                    }
                )
            except Exception as e:  # one bad file must not sink the batch
                results.append({"source": f.name, "error": str(e)})
    if not results:
        raise HTTPException(404, f"No ingestible files found under workspace '{workspace}'.")
    return {"status": "ok", "docmodels": results}


@router.post("/enrich")
async def vision_enrich(
    workspace: str = "default",
    source: Optional[str] = None,
    vlm_model: Optional[str] = None,
    reviewer_model: Optional[str] = None,
    render_check: bool = False,
    limit: Optional[int] = None,
    write_to_data_in: bool = True,
):
    """Run the describer ladder over each DocModel's visuals, stitch an enriched
    markdown (+ JSON sidecar), and drop the enriched markdown into data_in/ so the
    existing RAG ingest picks up the visually-complete document."""
    dm_dir = get_workspace_path(workspace, ".benny/docmodel")
    if not dm_dir.exists():
        raise HTTPException(404, "No DocModels yet — run POST /api/vision/docmodel first.")

    enriched = []
    for jf in sorted(dm_dir.glob("*.json")):
        if jf.name.endswith(".enriched.json"):
            continue
        if source and _safe_stem(jf.stem) != _safe_stem(source):
            continue
        docmodel = json.loads(jf.read_text(encoding="utf-8"))
        kwargs = {"render_check": render_check, "limit": limit}
        if vlm_model:
            kwargs["vlm_model"] = vlm_model
        if reviewer_model:
            kwargs["reviewer_model"] = reviewer_model
        res = await enrich_docmodel(docmodel, **kwargs)
        paths = write_enriched(res, workspace, docmodel.get("source", jf.stem))
        if write_to_data_in:
            di = get_workspace_path(workspace, "data_in")
            di.mkdir(parents=True, exist_ok=True)
            md_name = f"{_safe_stem(docmodel.get('source', jf.stem))}.md"
            (di / md_name).write_text(res["markdown"], encoding="utf-8")
            paths["data_in"] = str(di / md_name)
        enriched.append(
            {"source": docmodel.get("source"), "summary": res["summary"], "paths": paths}
        )

    if not enriched:
        raise HTTPException(404, f"No matching DocModel to enrich in workspace '{workspace}'.")
    return {"status": "ok", "enriched": enriched}
