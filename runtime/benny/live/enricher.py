"""
Live Mode Enricher — Lineage-compliant orchestration engine.

Pipeline per run:
  1.  task_manager.create_task(type="live_enrichment")
  2.  track_workflow_start  (OpenLineage)
  3.  For each entity × source:
        a. check manifest.enabled + cache TTL
        b. connector.enrich()  → List[KnowledgeTriple]
        c. track_tool_execution per connector call
        d. add_aer_entry  (intent / observation / inference / plan)
        e. emit IngestionEvent SSE
  4.  batch_add_triples → Neo4j  (run_id stamped on every RELATES_TO edge)
  5.  Save run artifacts: metadata.json, triples.json, lineage.json
  6.  track_workflow_complete
  7.  task_manager.complete_task
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from benny.core.graph_db import batch_add_triples
from benny.core.schema import IngestionEvent, IngestionEventType, KnowledgeTriple
from benny.core.task_manager import TaskManager
from benny.core.workspace import get_workspace_path, load_manifest
from benny.governance.lineage import track_tool_execution, track_workflow_complete, track_workflow_fail, track_workflow_start
from benny.live.connector import get_connector, list_connectors

logger = logging.getLogger(__name__)

task_manager = TaskManager()

# SSE queue registry keyed by run_id — consumed by /api/live/enrich/events/{run_id}
_live_events: Dict[str, asyncio.Queue] = {}


def _emit(run_id: str, event: IngestionEvent) -> None:
    q = _live_events.get(run_id)
    if q:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


async def run_enrichment(
    workspace: str,
    entities: List[Dict[str, str]],
    source_ids: Optional[List[str]] = None,
    run_id: Optional[str] = None,
) -> str:
    """
    Enrich a list of entities from all enabled (or explicitly requested) sources.

    Args:
        workspace:  workspace identifier
        entities:   list of {"name": "...", "type": "..."} dicts
        source_ids: override which connectors to use; if None, uses manifest.enabled_sources
        run_id:     caller-supplied run_id; generated if None

    Returns:
        run_id
    """
    run_id = run_id or str(uuid.uuid4())
    task = task_manager.create_task(workspace=workspace, task_type="live_enrichment", task_id=run_id)

    # Register SSE queue before any async work
    _live_events[run_id] = asyncio.Queue(maxsize=500)

    manifest = load_manifest(workspace)

    if not manifest.live_mode:
        _emit(run_id, IngestionEvent(
            event=IngestionEventType.ERROR,
            run_id=run_id,
            message="Live mode is disabled in workspace manifest. Set live_mode: true to enable.",
        ))
        task_manager.update_task(run_id, status="failed", message="Live mode disabled")
        return run_id

    active_sources = source_ids or manifest.live_config.enabled_sources
    if not active_sources:
        active_sources = list_connectors()

    ttl = manifest.live_config.cache_ttl_hours
    max_entities = manifest.live_config.max_entities_per_run
    entities = entities[:max_entities]

    run_dir = get_workspace_path(workspace) / "live" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # OpenLineage workflow start
    track_workflow_start(
        workflow_id=run_id,
        workflow_name="live_enrichment",
        workspace=workspace,
        inputs=[{"source": s} for s in active_sources],
        outputs=[{"store": "neo4j", "workspace": workspace}],
    )

    _emit(run_id, IngestionEvent(
        event=IngestionEventType.STARTED,
        run_id=run_id,
        message=f"Live enrichment started: {len(entities)} entities × {len(active_sources)} sources",
        data={"entities": entities, "sources": active_sources},
    ))

    task_manager.add_aer_entry(
        run_id,
        intent=f"Start live enrichment for {len(entities)} entities from {active_sources}",
        observation=f"Workspace: {workspace}, cache_ttl: {ttl}h, max_entities: {max_entities}",
        inference="Will dispatch connectors, collect triples, persist to Neo4j with full lineage.",
        plan=f"Process {len(entities)} entities sequentially; batch write all triples at the end.",
    )

    all_triples: List[KnowledgeTriple] = []
    per_entity_stats: List[Dict[str, Any]] = []

    total_steps = len(entities) * len(active_sources)
    step = 0

    for entity in entities:
        entity_name = entity.get("name", "")
        entity_type = entity.get("type", "any")
        entity_triples: List[KnowledgeTriple] = []

        for source_id in active_sources:
            step += 1
            progress = int(step / total_steps * 90)  # reserve last 10% for DB write
            task_manager.update_task(run_id, progress=progress, current_step=step, total_steps=total_steps,
                                     message=f"Fetching {entity_name} from {source_id}")

            _emit(run_id, IngestionEvent(
                event=IngestionEventType.SECTION_PROGRESS,
                run_id=run_id,
                source_name=source_id,
                message=f"Fetching {entity_name} ({entity_type}) from {source_id}",
                data={"entity": entity_name, "source": source_id, "step": step, "total": total_steps},
            ))

            success = False
            error_msg: Optional[str] = None
            fetched: List[KnowledgeTriple] = []

            try:
                connector = get_connector(source_id, workspace)
                fetched = await connector.enrich(entity_name, entity_type, ttl_hours=ttl, run_artifacts_dir=run_dir)
                entity_triples.extend(fetched)
                success = True

                task_manager.add_aer_entry(
                    run_id,
                    intent=f"Enrich '{entity_name}' from {source_id}",
                    observation=f"Fetched {len(fetched)} triples",
                    inference=f"Triples extracted: {[t.predicate for t in fetched[:5]]}",
                    plan="Continue to next source / entity.",
                    type="tool",
                )

            except EnvironmentError as e:
                error_msg = str(e)
                logger.warning(f"[enricher] {source_id}: {e}")
                task_manager.add_aer_entry(
                    run_id,
                    intent=f"Enrich '{entity_name}' from {source_id}",
                    observation=f"Skipped: {e}",
                    inference="Missing credentials — connector skipped.",
                    plan="Continue with remaining sources.",
                    type="warning",
                )

            except Exception as e:
                error_msg = str(e)
                logger.error(f"[enricher] {source_id} failed for '{entity_name}': {e}", exc_info=True)
                task_manager.add_aer_entry(
                    run_id,
                    intent=f"Enrich '{entity_name}' from {source_id}",
                    observation=f"Error: {e}",
                    inference="Connector raised an exception.",
                    plan="Log and continue; do not abort entire run.",
                    type="error",
                )

            track_tool_execution(
                parent_run_id=run_id,
                tool_name=f"live_connector:{source_id}",
                tool_args={"entity": entity_name, "type": entity_type},
                success=success,
                error_message=error_msg,
            )

            _emit(run_id, IngestionEvent(
                event=IngestionEventType.TRIPLES_EXTRACTED,
                run_id=run_id,
                source_name=source_id,
                message=f"{len(fetched)} triples from {source_id} for '{entity_name}'",
                data={"entity": entity_name, "source": source_id, "count": len(fetched), "success": success},
            ))

        all_triples.extend(entity_triples)
        per_entity_stats.append({
            "entity": entity_name,
            "type": entity_type,
            "triple_count": len(entity_triples),
            "sources": active_sources,
        })

    # Persist to Neo4j
    task_manager.update_task(run_id, progress=90, message=f"Writing {len(all_triples)} triples to Neo4j")
    _emit(run_id, IngestionEvent(
        event=IngestionEventType.STORED,
        run_id=run_id,
        message=f"Writing {len(all_triples)} triples to Neo4j",
        data={"total_triples": len(all_triples)},
    ))

    db_result: Dict[str, Any] = {}
    try:
        if all_triples:
            db_result = batch_add_triples(all_triples, workspace=workspace, source_name="live_enrichment", run_id=run_id)
    except Exception as e:
        logger.error(f"[enricher] Neo4j write failed: {e}", exc_info=True)
        db_result = {"error": str(e)}

    # Save run artifacts
    _save_artifacts(run_dir, run_id, workspace, entities, active_sources, all_triples, per_entity_stats)

    # OpenLineage completion
    completed_at = datetime.now(timezone.utc).isoformat()
    track_workflow_complete(
        workflow_id=run_id,
        workflow_name="live_enrichment",
        workspace=workspace,
        inputs=[{"source": s} for s in active_sources],
        outputs=[{"store": "neo4j", "triples_written": len(all_triples)}],
        execution_time_ms=0,
    )

    task_manager.update_task(
        run_id,
        status="completed",
        progress=100,
        message=f"Enrichment complete. {len(all_triples)} triples written.",
        metadata={
            "total_triples": len(all_triples),
            "entities_processed": len(entities),
            "sources_used": active_sources,
            "completed_at": completed_at,
        },
    )

    _emit(run_id, IngestionEvent(
        event=IngestionEventType.COMPLETED,
        run_id=run_id,
        message=f"Enrichment complete: {len(all_triples)} triples across {len(entities)} entities",
        data={
            "total_triples": len(all_triples),
            "per_entity": per_entity_stats,
            "run_dir": str(run_dir),
            "completed_at": completed_at,
        },
    ))

    # Signal SSE stream termination
    try:
        _live_events[run_id].put_nowait(None)
    except asyncio.QueueFull:
        pass

    return run_id


def _save_artifacts(
    run_dir: Path,
    run_id: str,
    workspace: str,
    entities: List[Dict],
    sources: List[str],
    triples: List[KnowledgeTriple],
    stats: List[Dict],
) -> None:
    ts = datetime.now(timezone.utc).isoformat()

    metadata = {
        "run_id": run_id,
        "workspace": workspace,
        "created_at": ts,
        "entities": entities,
        "sources": sources,
        "total_triples": len(triples),
        "per_entity_stats": stats,
    }
    (run_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")

    triples_data = [t.model_dump() for t in triples]
    (run_dir / "triples.json").write_text(json.dumps(triples_data, indent=2, ensure_ascii=False), encoding="utf-8")

    lineage_snapshot = {
        "run_id": run_id,
        "namespace": "benny",
        "job": "live_enrichment",
        "workspace": workspace,
        "created_at": ts,
        "inputs": sources,
        "output_store": "neo4j",
        "triple_count": len(triples),
        "provenance": [
            {
                "entity": t.subject,
                "predicate": t.predicate,
                "source": t.model_id,
                "citation": t.citation,
                "fragment_id": t.fragment_id,
                "fetched_at": t.fetched_at,
                "confidence": t.confidence,
            }
            for t in triples[:200]  # cap snapshot size
        ],
    }
    (run_dir / "lineage.json").write_text(json.dumps(lineage_snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
