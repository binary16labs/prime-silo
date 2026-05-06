"""
Live Mode API Routes — /api/live/*

Endpoints:
  POST   /api/live/enrich                       Trigger enrichment (background, SSE)
  GET    /api/live/enrich/events/{run_id}        SSE stream for a live enrichment run
  GET    /api/live/sources/{workspace}           List source manifests + status
  PATCH  /api/live/sources/{workspace}/{source}  Toggle enabled / update config
  GET    /api/live/runs/{workspace}              List enrichment run history
  GET    /api/live/runs/{workspace}/{run_id}/lineage  Full lineage snapshot
  GET    /api/live/cache/{workspace}/{source_id} Cache stats for a source
  DELETE /api/live/cache/{workspace}/{source_id} Bust cache for a source
  GET    /api/live/connectors                    List registered connector IDs
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from benny.core.workspace import get_workspace_path, load_manifest, save_manifest
from benny.live.connector import list_connectors
from benny.live.enricher import _live_events, run_enrichment

logger = logging.getLogger(__name__)
router = APIRouter()


# =============================================================================
# REQUEST / RESPONSE MODELS
# =============================================================================

class EnrichEntity(BaseModel):
    name: str
    type: str = "any"


class EnrichRequest(BaseModel):
    workspace: str = "default"
    entities: List[EnrichEntity]
    sources: Optional[List[str]] = None  # None = use manifest.enabled_sources


class SourcePatchRequest(BaseModel):
    enabled: Optional[bool] = None
    confidence_default: Optional[float] = None
    cache_ttl_hours: Optional[int] = None


# =============================================================================
# HELPERS
# =============================================================================

def _sources_dir(workspace: str) -> Path:
    return get_workspace_path(workspace) / "live" / "sources"


def _cache_dir(workspace: str, source_id: str) -> Path:
    return get_workspace_path(workspace) / "live" / "cache" / source_id


def _runs_dir(workspace: str) -> Path:
    return get_workspace_path(workspace) / "live" / "runs"


def _load_source_manifest(workspace: str, source_id: str) -> Dict[str, Any]:
    path = _sources_dir(workspace) / f"{source_id}.yaml"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Source manifest not found: {source_id}")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _save_source_manifest(workspace: str, source_id: str, data: Dict[str, Any]) -> None:
    path = _sources_dir(workspace) / f"{source_id}.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, sort_keys=False, allow_unicode=True)


# =============================================================================
# ENRICHMENT
# =============================================================================

@router.post("/live/enrich")
async def trigger_enrichment(request: EnrichRequest, background_tasks: BackgroundTasks):
    """
    Trigger a background live enrichment run.
    Returns run_id immediately; stream progress via /api/live/enrich/events/{run_id}.
    """
    import uuid
    run_id = str(uuid.uuid4())
    entities = [e.model_dump() for e in request.entities]

    background_tasks.add_task(
        run_enrichment,
        workspace=request.workspace,
        entities=entities,
        source_ids=request.sources,
        run_id=run_id,
    )

    return {
        "run_id": run_id,
        "workspace": request.workspace,
        "entities": len(entities),
        "sources": request.sources or "from manifest",
        "stream_url": f"/api/live/enrich/events/{run_id}",
        "status": "started",
    }


@router.get("/live/enrich/events/{run_id}")
async def enrichment_events(run_id: str):
    """
    SSE stream for a live enrichment run.
    Terminates when the run completes or fails (sentinel None in the queue).
    """
    # Ensure queue exists (may be called before background task initialises it)
    if run_id not in _live_events:
        _live_events[run_id] = asyncio.Queue(maxsize=500)

    async def event_stream():
        q = _live_events[run_id]
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield "event: heartbeat\ndata: {}\n\n"
                    continue

                if event is None:  # sentinel — stream complete
                    break

                yield event.to_sse()
        finally:
            _live_events.pop(run_id, None)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# =============================================================================
# SOURCE MANIFEST MANAGEMENT
# =============================================================================

@router.get("/live/sources/{workspace}")
async def list_sources(workspace: str):
    """List all source manifests for a workspace with live status."""
    src_dir = _sources_dir(workspace)
    if not src_dir.exists():
        return {"workspace": workspace, "sources": []}

    sources = []
    for yaml_file in sorted(src_dir.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_file.read_text(encoding="utf-8")) or {}
            source_id = data.get("source_id", yaml_file.stem)

            # Last run metadata
            runs = _runs_dir(workspace)
            last_run = None
            total_triples = 0
            if runs.exists():
                run_dirs = sorted(runs.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
                for rd in run_dirs[:10]:
                    meta_path = rd / "metadata.json"
                    if meta_path.exists():
                        try:
                            meta = json.loads(meta_path.read_text(encoding="utf-8"))
                            if source_id in meta.get("sources", []):
                                last_run = meta.get("created_at")
                                total_triples += meta.get("total_triples", 0)
                                break
                        except Exception:
                            pass

            # Cache stats
            cache_d = _cache_dir(workspace, source_id)
            cache_entries = len(list(cache_d.glob("*.json"))) if cache_d.exists() else 0

            sources.append({
                "source_id": source_id,
                "name": data.get("name", source_id),
                "enabled": data.get("enabled", False),
                "confidence_default": data.get("confidence_default", 0.7),
                "entity_types": data.get("entity_types", []),
                "auth_type": (data.get("auth") or {}).get("type", "none"),
                "last_run": last_run,
                "total_triples_enriched": total_triples,
                "cache_entries": cache_entries,
            })
        except Exception as e:
            logger.warning(f"Could not parse {yaml_file}: {e}")

    manifest = load_manifest(workspace)
    return {
        "workspace": workspace,
        "live_mode_enabled": manifest.live_mode,
        "enabled_sources": manifest.live_config.enabled_sources,
        "sources": sources,
    }


@router.patch("/live/sources/{workspace}/{source_id}")
async def update_source(workspace: str, source_id: str, patch: SourcePatchRequest):
    """Toggle a source's enabled flag or update configuration."""
    data = _load_source_manifest(workspace, source_id)

    if patch.enabled is not None:
        data["enabled"] = patch.enabled
    if patch.confidence_default is not None:
        data["confidence_default"] = patch.confidence_default

    _save_source_manifest(workspace, source_id, data)

    # Mirror enabled state into workspace manifest.live_config.enabled_sources
    manifest = load_manifest(workspace)
    enabled_sources = list(manifest.live_config.enabled_sources)
    if patch.enabled is True and source_id not in enabled_sources:
        enabled_sources.append(source_id)
    elif patch.enabled is False and source_id in enabled_sources:
        enabled_sources.remove(source_id)
    manifest.live_config.enabled_sources = enabled_sources
    save_manifest(workspace, manifest)

    return {"source_id": source_id, "updated": data}


# =============================================================================
# RUN HISTORY & LINEAGE
# =============================================================================

@router.get("/live/runs/{workspace}")
async def list_runs(workspace: str, limit: int = Query(default=20, le=100)):
    """List enrichment run metadata files, newest first."""
    runs_dir = _runs_dir(workspace)
    if not runs_dir.exists():
        return {"workspace": workspace, "runs": []}

    runs = []
    for rd in sorted(runs_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        meta_path = rd / "metadata.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                runs.append(meta)
            except Exception:
                pass

    return {"workspace": workspace, "runs": runs}


@router.get("/live/runs/{workspace}/{run_id}/lineage")
async def get_run_lineage(workspace: str, run_id: str):
    """Return the OpenLineage snapshot for a specific enrichment run."""
    lineage_path = _runs_dir(workspace) / run_id / "lineage.json"
    if not lineage_path.exists():
        raise HTTPException(status_code=404, detail=f"Lineage not found for run {run_id}")
    return json.loads(lineage_path.read_text(encoding="utf-8"))


@router.get("/live/runs/{workspace}/{run_id}/triples")
async def get_run_triples(workspace: str, run_id: str):
    """Return all extracted triples for a specific enrichment run."""
    triples_path = _runs_dir(workspace) / run_id / "triples.json"
    if not triples_path.exists():
        raise HTTPException(status_code=404, detail=f"Triples not found for run {run_id}")
    return json.loads(triples_path.read_text(encoding="utf-8"))


# =============================================================================
# CACHE MANAGEMENT
# =============================================================================

@router.get("/live/cache/{workspace}/{source_id}")
async def cache_stats(workspace: str, source_id: str):
    """Return cache entry count and approximate size for a source."""
    cache_d = _cache_dir(workspace, source_id)
    if not cache_d.exists():
        return {"workspace": workspace, "source_id": source_id, "entries": 0, "size_bytes": 0}

    files = list(cache_d.glob("*.json"))
    total_bytes = sum(f.stat().st_size for f in files)
    return {
        "workspace": workspace,
        "source_id": source_id,
        "entries": len(files),
        "size_bytes": total_bytes,
    }


@router.delete("/live/cache/{workspace}/{source_id}")
async def bust_cache(workspace: str, source_id: str):
    """Delete all cached responses for a source."""
    import shutil
    cache_d = _cache_dir(workspace, source_id)
    if cache_d.exists():
        shutil.rmtree(cache_d)
    return {"workspace": workspace, "source_id": source_id, "cache": "cleared"}


# =============================================================================
# CONNECTOR REGISTRY
# =============================================================================

@router.get("/live/connectors")
async def get_connectors():
    """List all registered connector IDs."""
    return {"connectors": list_connectors()}
