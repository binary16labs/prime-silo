"""AOS-001 Phase 3 — Diagram generators (AOS-F11, AOS-F12, AOS-F13).

Three diagram output formats from a ManifestPlan or BDD scenario list:

  to_mermaid(plan)            → Mermaid graph TD with one subgraph per wave
  to_plantuml(plan)           → PlantUML component diagram with wave packages
  to_activity_diagram(scens)  → PlantUML activity diagram, one block per scenario
  populate_mermaid(manifest)  → writes to_mermaid output into manifest.plan.mermaid
"""

from __future__ import annotations

from typing import TYPE_CHECKING, List

if TYPE_CHECKING:
    from benny.core.manifest import ManifestPlan, SwarmManifest
    from benny.sdlc.contracts import BddScenario


def _safe_id(task_id: str) -> str:
    """Return a Mermaid/PlantUML-safe identifier (no dots, spaces, hyphens)."""
    return task_id.replace(".", "_").replace("-", "_").replace(" ", "_")


# ---------------------------------------------------------------------------
# AOS-F11 — Mermaid
# ---------------------------------------------------------------------------


def to_mermaid(plan: "ManifestPlan") -> str:
    """Emit a Mermaid graph TD with one subgraph per wave.

    Each wave becomes ``subgraph Wave_N ... end``.
    Dependency edges from plan.edges are emitted as ``src --> tgt`` lines.
    """
    lines: List[str] = ["graph TD"]

    task_map = {t.id: t for t in plan.tasks}

    for wave_idx, wave_task_ids in enumerate(plan.waves):
        lines.append(f"  subgraph Wave_{wave_idx}")
        for tid in wave_task_ids:
            task = task_map.get(tid)
            label = task.description[:40] if (task and task.description) else tid
            # Escape quotes in label
            label = label.replace('"', "'")
            lines.append(f'    {_safe_id(tid)}["{label}"]')
        lines.append("  end")

    for edge in plan.edges:
        src = _safe_id(edge.source)
        tgt = _safe_id(edge.target)
        if edge.label:
            lines.append(f"  {src} -->|{edge.label}| {tgt}")
        else:
            lines.append(f"  {src} --> {tgt}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# AOS-F12 — PlantUML component diagram
# ---------------------------------------------------------------------------


def to_plantuml(plan: "ManifestPlan") -> str:
    """Emit a PlantUML component diagram with one package per wave.

    Each wave is a ``package "Wave N" { ... }`` block.
    Dependency edges from plan.edges are emitted as ``src --> tgt`` lines.
    """
    lines: List[str] = ["@startuml", "skinparam monochrome true"]

    task_map = {t.id: t for t in plan.tasks}

    for wave_idx, wave_task_ids in enumerate(plan.waves):
        lines.append(f'package "Wave {wave_idx}" {{')
        for tid in wave_task_ids:
            task = task_map.get(tid)
            label = task.description[:40] if (task and task.description) else tid
            safe = _safe_id(tid)
            lines.append(f'  [{label}] as {safe}')
        lines.append("}")

    for edge in plan.edges:
        src = _safe_id(edge.source)
        tgt = _safe_id(edge.target)
        lines.append(f"{src} --> {tgt}")

    lines.append("@enduml")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# AOS-F13 — PlantUML activity diagram per BDD scenario
# ---------------------------------------------------------------------------


def to_activity_diagram(scenarios: "List[BddScenario]") -> str:
    """Emit one @startuml...@enduml activity block per BDD scenario.

    Each block contains:
      - A note with the scenario ID
      - :Given step;
      - :When step;
      - :Then step;
    """
    if not scenarios:
        return ""

    blocks: List[str] = []
    for scenario in scenarios:
        block = [
            "@startuml",
            "start",
            f"note: Scenario {scenario.id}",
            f":{scenario.given};",
            f":{scenario.when};",
            f":{scenario.then};",
            "stop",
            "@enduml",
        ]
        blocks.append("\n".join(block))

    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# populate_mermaid — wave_scheduler integration point
# ---------------------------------------------------------------------------


def populate_mermaid(manifest: "SwarmManifest") -> None:
    """Generate and store the Mermaid diagram in ``manifest.plan.mermaid``.

    Idempotent: safe to call multiple times; overwrites with the same value.
    """
    manifest.plan.mermaid = to_mermaid(manifest.plan)
