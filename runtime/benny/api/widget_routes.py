"""ADR-001 — Widget registry contract.

The Prime-Silo shell fork (ADR-001) collapses Studio's overlapping canvases
into a typed widget registry. The agent in the Review zone composes layouts
by *selecting widget IDs* and binding their props to fields on a
:class:`CognitiveFrame`-shaped run output — it does not generate widget code.

This module defines the pydantic schema for widget manifests and exposes a
read-only HTTP surface for the frontend to enumerate registered widgets. The
registry itself is intentionally small in Phase A — it ships one entry per
existing canvas family, with concrete property schemas to be filled in as the
widgets are migrated under ``frontend/src/widgets/`` (Phase C).
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


WidgetAuthority = Literal[
    "read_only",            # pure visualisation — never mutates state
    "read_write_sandbox",   # may write to agent_sandbox/ via the guarded API
    "deterministic_only",   # mutates institutional state — agent CANNOT compose
]


class FrameBinding(BaseModel):
    """A single binding from a widget prop to a field on the run's output frame."""

    field: str = Field(description="JSON-pointer-style path into the frame, e.g. 'assertions[].entity'.")
    required: bool = Field(default=True)
    description: str | None = None


class WidgetManifest(BaseModel):
    """Manifest describing a single registered widget.

    Authored as JSON next to the widget's React component (or vendored from
    the upstream space-agent puzzle-piece convention). The frontend consumes
    these manifests through ``GET /api/widgets`` to know which widgets the
    agent is allowed to compose into a layout.
    """

    id: str = Field(description="Stable widget id, e.g. 'kg3d.synoptic_web'.")
    schema_version: str = Field(default="1.0.0")
    title: str
    description: str = ""
    category: Literal["graph", "table", "timeline", "inspector", "dag", "text"] = "inspector"

    # JSON Schema for the widget's props. Kept as a free-form dict so authors
    # can use the full JSON Schema vocabulary without us re-implementing it.
    props: Dict[str, Any] = Field(default_factory=dict)

    frame_bindings: List[FrameBinding] = Field(default_factory=list)

    authority: WidgetAuthority = "read_only"
    """Determines whether the agent may compose this widget into a Review-zone
    layout. ``deterministic_only`` widgets are reachable only from the static
    deterministic-zone shell pages."""

    defaults: Dict[str, Any] = Field(default_factory=dict)
    """A sensible starting layout — the agent can override but does not have to."""


# ---------------------------------------------------------------------------
# Phase A registry — one entry per existing canvas family.
#
# Phase C migrates the actual React components under ``frontend/src/widgets/``
# and replaces these stubs with real prop schemas. The IDs are committed now
# so layout DSL authored in Phase A remains valid after the migration.
# ---------------------------------------------------------------------------

_PHASE_A_REGISTRY: List[WidgetManifest] = [
    WidgetManifest(
        id="kg3d.synoptic_web",
        title="Knowledge Graph (3D)",
        description="Three.js synoptic web of concepts and documents.",
        category="graph",
        authority="read_only",
        frame_bindings=[FrameBinding(field="concepts", required=False)],
    ),
    WidgetManifest(
        id="codegraph.canvas",
        title="Code Graph",
        description="Tree-Sitter-derived file/class/function graph.",
        category="graph",
        authority="read_only",
    ),
    WidgetManifest(
        id="dag.canvas",
        title="DAG Canvas",
        description=(
            "Unified DAG canvas — replaces ManifestCanvas, PipelineCanvas, "
            "and WorkflowCanvas. Mode prop selects rendering."
        ),
        category="dag",
        authority="deterministic_only",
        props={
            "type": "object",
            "properties": {
                "mode": {"enum": ["manifest", "pipeline", "workflow"]},
            },
            "required": ["mode"],
        },
    ),
    WidgetManifest(
        id="run.drilldown_table",
        title="Run Drill-Down Table",
        description="Tabular view of a Pypes node output with CLP annotations.",
        category="table",
        authority="read_only",
        frame_bindings=[
            FrameBinding(field="rows", required=True),
            FrameBinding(field="clp_annotations", required=False),
        ],
        # Phase C — fetched-data widget. Pulls rows + CLP from
        # GET /api/runtime/pypes/runs/{run_id}/steps/{step_id}.
        props={
            "type": "object",
            "properties": {
                "run_id": {
                    "type": "string",
                    "description": "Pypes run id (without the 'pypes-' prefix).",
                },
                "step_id": {
                    "type": "string",
                    "description": "Step id within the run to drill into.",
                },
                "workspace": {
                    "type": "string",
                    "description": "Workspace id (default: 'default').",
                },
                "rows": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5000,
                    "description": "Max rows to load. Default 50.",
                },
            },
            "required": ["run_id", "step_id"],
        },
    ),
    WidgetManifest(
        id="run.frame_inspector",
        title="Frame Inspector",
        description="Cognitive Frame inspector with provenance and withdrawal register.",
        category="inspector",
        authority="read_only",
        frame_bindings=[FrameBinding(field=".", required=True)],
        # Phase C — props filled in during widget migration. The layout
        # supplies the bound frame; the widget is a pure renderer.
        props={
            "type": "object",
            "properties": {
                "frame": {
                    "type": "object",
                    "description": "Cognitive Frame object — full structure per PRD §9.",
                },
                "initialCollapsed": {
                    "type": "array",
                    "items": {
                        "enum": [
                            "header",
                            "assertions",
                            "withdrawal",
                            "provenance",
                            "confidence",
                            "raw",
                        ],
                    },
                    "description": "Sections that start collapsed. Defaults to ['raw'].",
                },
                "showRawJson": {
                    "type": "boolean",
                    "description": "Include the raw JSON escape hatch section (default true).",
                },
            },
            "required": ["frame"],
        },
    ),
    WidgetManifest(
        id="run.lineage_timeline",
        title="Lineage Timeline",
        description="Triple lineage timeline (process / skill / data) for a run.",
        category="timeline",
        authority="read_only",
        frame_bindings=[FrameBinding(field="run_id", required=True)],
        # Phase C — fetched-data widget. Pulls events from
        # GET /api/runtime/governance/events filtered by run_id.
        props={
            "type": "object",
            "properties": {
                "run_id": {
                    "type": "string",
                    "description": "Run id to filter governance events by (required).",
                },
                "workspace": {
                    "type": "string",
                    "description": "Workspace id (default: 'default').",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000,
                    "description": "Max events to load. Default 100.",
                },
                "eventType": {
                    "type": "string",
                    "description": "Optional event_type filter (e.g. 'AGENT_AUTHORSHIP').",
                },
            },
            "required": ["run_id"],
        },
    ),
    WidgetManifest(
        id="run.reasoning_trace",
        title="Reasoning Trace",
        description="LLM reasoning trace popover for a node.",
        category="inspector",
        authority="read_only",
    ),
    WidgetManifest(
        id="text.markdown",
        title="Markdown Note",
        description="Agent-authored markdown body, sourced from agent_sandbox/notes/.",
        category="text",
        authority="read_write_sandbox",
        props={
            "type": "object",
            "properties": {"source": {"type": "string"}},
            "required": ["source"],
        },
    ),
]


@router.get("", response_model=List[WidgetManifest])
async def list_widgets() -> List[WidgetManifest]:
    """Enumerate all registered widgets.

    The agent calls this to know which widgets it may compose into a Review-zone
    layout; the frontend calls it to render the widget palette.
    """
    return _PHASE_A_REGISTRY


@router.get("/{widget_id}", response_model=WidgetManifest)
async def get_widget(widget_id: str) -> WidgetManifest:
    for entry in _PHASE_A_REGISTRY:
        if entry.id == widget_id:
            return entry
    from fastapi import HTTPException
    raise HTTPException(status_code=404, detail=f"Unknown widget id: {widget_id}")
