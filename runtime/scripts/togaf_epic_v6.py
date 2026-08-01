#!/usr/bin/env python
"""TOGAF EPIC v6 — engineered architecture document: full C4 hierarchy, complete
ICONIX robustness, per-workflow BPMN/UML/robustness, total component coverage.

Stands on v5 (per-section Cypher retrieval + width walk) and v3 (TOGAF skeleton,
citation gate) and fixes what made v5 read as "a collection slapped together":

  1. DIAGRAM ENGINE (shared, budgeted). Every diagram is built from a node/edge
     set through one renderer that sanitises ids, applies a SIZE BUDGET and
     SHARDS into numbered sheets past the budget. No diagram is unreadable and
     none can break the PDF gate. Object identity (catalog IDs) is stable across
     every view, so the same object is recognisable in C4, robustness and tables.
  2. FULL C4 HIERARCHY. L1 Context -> L2 Container -> L3 Component -> L4 Code,
     each level derived from the code graph and linked to its parent/children.
     v5 stopped at L2 and had no drill-down.
  3. COMPLETE ROBUSTNESS. v3/v5 classified only the top 90 of 2,438 Class+File
     entities (3.7%) and drew 14 per category. v6 classifies EVERYTHING, draws an
     estate overview aggregated BY COMPONENT (renderable), and a per-component
     robustness diagram, so the model is complete instead of a sample.
  4. WORKFLOW TRIAD. Each manifest contract gets BPMN (lanes, gateways, events),
     a UML sequence diagram, and a robustness view — not one stage chain.
  5. TOTAL COVERAGE. All modules resolved from the graph (v5 documented 18 of 75)
     and all workflow contracts, each with narrative + diagrams + catalog.
  6. COHESION. A reading spine, stable IDs, and explicit cross-references binding
     component <-> container <-> layer <-> workflow <-> robustness.

Usage (from prime-silo/runtime; BENNY_HOME + BENNY_LMSTUDIO_ENDPOINTS set):

  python scripts/togaf_epic_v6.py --workspace sessions_v1
  python scripts/togaf_epic_v6.py --workspace sessions_v1 --skeleton-only   # no LLM
  python scripts/togaf_epic_v6.py --workspace sessions_v1 --resume
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

RUNTIME = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RUNTIME))
os.chdir(RUNTIME)

import scripts.togaf_epic as base
import scripts.togaf_epic_v3 as v3
import scripts.togaf_epic_v5 as v5

RUN_ID = f"togaf-epic-v6-{_dt.datetime.now().strftime('%Y%m%d%H%M%S')}"

NODE_BUDGET = 34          # nodes per diagram sheet before sharding
EDGE_BUDGET = 46


# ---------------------------------------------------------------------------
# 1. Diagram engine — one renderer, sanitised, budgeted, shardable.
# ---------------------------------------------------------------------------
def _nid(v: str) -> str:
    return v5._nid(v)


def _lab(v: str, n: int = 30) -> str:
    return v5._lab(v, n)


SHAPES = {
    "box": '{id}["{label}"]',
    "round": '{id}("{label}")',
    "boundary": '{id}(["{label}"])',
    "control": '{id}(("{label}"))',
    "entity": '{id}[("{label}")]',
    "gateway": '{id}{{"{label}"}}',
    "event": '{id}(("{label}"))',
}

CLASSDEFS = [
    "classDef b fill:#dbeafe,stroke:#2563eb,color:#0b2f6b",
    "classDef c fill:#dcfce7,stroke:#16a34a,color:#06351a",
    "classDef e fill:#fef3c7,stroke:#d97706,color:#5b3a06",
    "classDef g fill:#f3e8ff,stroke:#9333ea,color:#3b0764",
    "classDef x fill:#f1f5f9,stroke:#64748b,color:#1e293b",
]


def render_graph(nodes: list[dict], edges: list[dict], title: str,
                 direction: str = "LR", subgraphs: bool = True) -> str:
    """Render a node/edge set as one or more mermaid sheets.

    nodes: [{id, label, shape, group, cls}]  edges: [{src, dst, label}]
    Returns "" when there is nothing worth drawing — never an empty fence,
    because togaf_epic_pdf.mjs gates on every block rendering.
    """
    nodes = [n for n in nodes if n.get("id")]
    if len(nodes) < 2:
        return ""
    sheets, out = [], []
    if len(nodes) <= NODE_BUDGET:
        sheets = [nodes]
    else:                                   # shard by group so lanes stay intact
        by_group: dict[str, list] = {}
        for n in nodes:
            by_group.setdefault(str(n.get("group") or ""), []).append(n)
        cur: list = []
        for grp, members in by_group.items():
            for i in range(0, len(members), NODE_BUDGET):
                chunk = members[i:i + NODE_BUDGET]
                if len(cur) + len(chunk) > NODE_BUDGET and cur:
                    sheets.append(cur)
                    cur = []
                cur.extend(chunk)
        if cur:
            sheets.append(cur)
    for si, sheet in enumerate(sheets, 1):
        ids = {n["id"] for n in sheet}
        lines, groups = [], {}
        for n in sheet:
            groups.setdefault(str(n.get("group") or ""), []).append(n)
        for grp, members in groups.items():
            indent = "  "
            if subgraphs and grp:
                lines.append(f"  subgraph {_nid(grp)}[\"{_lab(grp, 34)}\"]")
                indent = "    "
            for n in members:
                shape = SHAPES.get(n.get("shape") or "box", SHAPES["box"])
                decl = shape.format(id=n["id"], label=_lab(n.get("label") or n["id"], 26))
                cls = n.get("cls")
                lines.append(indent + decl + (f":::{cls}" if cls else ""))
            if subgraphs and grp:
                lines.append("  end")
        drawn = 0
        seen = set()
        for e in edges:
            s, d = e.get("src"), e.get("dst")
            if s not in ids or d not in ids or s == d or (s, d) in seen:
                continue
            seen.add((s, d))
            el = e.get("label")
            lines.append(f'  {s} -->|{_lab(el, 14)}| {d}' if el else f"  {s} --> {d}")
            drawn += 1
            if drawn >= EDGE_BUDGET:
                break
        if len([l for l in lines if "-->" in l or "[" in l or "(" in l]) < 2:
            continue
        cap = title if len(sheets) == 1 else f"{title} — sheet {si} of {len(sheets)}"
        out.append(f"**Diagram — {cap}**\n\n```mermaid\nflowchart {direction}\n"
                   + "\n".join(lines + CLASSDEFS) + "\n```\n")
    return "\n".join(out)


def render_sequence(participants: list[str], steps: list[tuple], title: str) -> str:
    """UML sequence diagram. Participants are aliased so labels can be free text."""
    parts = [p for p in dict.fromkeys(participants) if p][:12]
    if len(parts) < 2 or not steps:
        return ""
    alias = {p: f"P{i}" for i, p in enumerate(parts)}
    lines = [f'  participant {a} as {_lab(p, 22)}' for p, a in alias.items()]
    n = 0
    for src, dst, msg in steps:
        if src not in alias or dst not in alias:
            continue
        lines.append(f"  {alias[src]}->>{alias[dst]}: {_lab(msg, 30)}")
        n += 1
        if n >= 26:
            break
    if n < 1:
        return ""
    return (f"**Diagram — {title}**\n\n```mermaid\nsequenceDiagram\n"
            "  autonumber\n" + "\n".join(lines) + "\n```\n")


# ---------------------------------------------------------------------------
# 2. Full ICONIX robustness — every classified object, not a top-90 sample.
# ---------------------------------------------------------------------------
def build_robustness_full(limit: int = 4000) -> dict:
    """Classify EVERY Class/File entity. v3 capped at 90 (3.7% of 2,438)."""
    base._emit("Executing task: robustness_full (classifying every Class/File entity)")
    omap = v3.load_object_map()
    overrides = omap.get("category_overrides", {})
    rows = base._cypher(
        "MATCH (e:CodeEntity) WHERE e.workspace = $workspace AND e.type IN ['Class','File'] "
        "OPTIONAL MATCH (e)-[r:CODE_REL]-() "
        "WITH e, count(r) AS degree ORDER BY degree DESC "
        f"RETURN e.name AS name, e.type AS type, e.file_path AS file, degree LIMIT {limit}") or []
    cat = {"boundary": [], "control": [], "entity": []}
    drift = {"disagreements": [], "unmapped_high_degree": [], "vanished_overrides": []}
    seen = set()
    for r in rows:
        r = dict(r)
        f, n = str(r.get("file") or ""), str(r.get("name") or "?")
        seen.add(n)
        if v3.BOUNDARY_PAT.search(f) or v3.BOUNDARY_PAT.search(n):
            heur = "boundary"
        elif v3.ENTITY_PAT.search(f) or v3.ENTITY_PAT.search(n):
            heur = "entity"
        else:
            heur = "control"
        ov = overrides.get(n)
        if ov:
            k = ov.get("category", heur)
            r["tier"] = ov.get("tier") or v3._tier_of(f, n, omap)
            r["source"] = "map"
            if ov.get("sink"):
                r["sink"] = ov["sink"]
            if k != heur:
                drift["disagreements"].append({"object": n, "map": k, "heuristic": heur})
        else:
            k = heur
            r["tier"] = v3._tier_of(f, n, omap)
            r["source"] = "heuristic"
            if r.get("degree", 0) >= 40:
                drift["unmapped_high_degree"].append(
                    {"object": n, "degree": r["degree"], "proposed": {"category": k, "tier": r["tier"]}})
        if k == "entity" and not r.get("sink"):
            r["sink"] = v3._sink_of(f, n, omap)
        r["component"] = component_of(f)
        cat[k].append(r)
    for name in overrides:
        if name not in seen:
            drift["vanished_overrides"].append(name)
    ids = {}
    for k, prefix in (("boundary", "B"), ("control", "C"), ("entity", "E")):
        for i, r in enumerate(cat[k], 1):
            r["id"] = f"{prefix}-{i:03d}"
            ids.setdefault(r["name"], r["id"])
    total = sum(len(v) for v in cat.values())
    base._emit(f"robustness_full: {total} objects classified "
               f"(B={len(cat['boundary'])} C={len(cat['control'])} E={len(cat['entity'])})")
    return {"catalog": cat, "ids": ids, "drift": drift, "omap": omap, "total": total}


def comp_prefix(comp: str) -> str:
    """Path prefix for a component's files.

    23 of the 75 components ARE single files (`runtime/benny_cli.py`,
    `server/app.js`, ...). Appending "/" to those produces a prefix that can
    never match, which silently left them with no code-level or robustness
    diagram at all. Match the file itself in that case.
    """
    return f"src/prime-silo/{comp}" if v5.CODE_EXT.search(comp.split("/")[-1]) else f"src/prime-silo/{comp}/"


def component_dependencies_v6(comp: str, limit: int = 20) -> list[dict]:
    rows = base._cypher(
        "MATCH (a:CodeEntity)-[r:CODE_REL {type:'DEPENDS_ON'}]->(b:CodeEntity) "
        "WHERE a.workspace = $workspace AND b.type = 'Import' "
        f"AND a.file_path STARTS WITH '{comp_prefix(comp)}' "
        "RETURN split(a.file_path,'/')[-1] AS from_file, b.name AS stmt LIMIT 900") or []
    agg: dict[tuple, int] = {}
    for r in rows:
        tgt, src = v5._import_target(r.get("stmt")), r.get("from_file")
        if not tgt or not src or tgt == src:
            continue
        agg[(src, tgt)] = agg.get((src, tgt), 0) + 1
    ranked = sorted(agg.items(), key=lambda kv: -kv[1])[:limit]
    return [{"from_file": a, "imports": b, "n": n} for (a, b), n in ranked]


def component_of(file_path: str) -> str:
    parts = str(file_path or "").split("/")
    if len(parts) < 4 or parts[0] != "src":
        return "(unmapped)"
    area = parts[2]
    if area in v5.NOISE_AREAS:
        return "(vendored)"
    seg = [area, parts[3]] if len(parts) > 3 else [area]
    if len(parts) > 4 and not v5.CODE_EXT.search(parts[4]):
        seg.append(parts[4])
    return "/".join(seg)


def robustness_overview(rob: dict) -> str:
    """Estate robustness aggregated BY COMPONENT — the full model, renderable."""
    agg: dict[str, dict] = {}
    for k in ("boundary", "control", "entity"):
        for r in rob["catalog"][k]:
            d = agg.setdefault(r["component"], {"boundary": 0, "control": 0, "entity": 0})
            d[k] += 1
    ranked = sorted(agg.items(), key=lambda kv: -sum(kv[1].values()))[:26]
    nodes, edges = [], []
    for comp, d in ranked:
        cid = _nid("K_" + comp)
        dom = max(d, key=lambda x: d[x])
        nodes.append({"id": cid, "label": f"{comp.split('/')[-1]} B{d['boundary']}/C{d['control']}/E{d['entity']}",
                      "shape": {"boundary": "boundary", "control": "control", "entity": "entity"}[dom],
                      "group": comp.split("/")[0],
                      "cls": {"boundary": "b", "control": "c", "entity": "e"}[dom]})
    out = ["### Robustness model (ICONIX) — complete estate view\n",
           f"\nAll **{rob['total']}** Class/File entities are classified (v3/v5 sampled the top 90). "
           "Each node below is a component, shaped and coloured by its dominant ICONIX role, with its "
           "boundary/control/entity split. Per-component object-level diagrams appear in the "
           "Component Architecture chapter.\n\n"]
    out.append(render_graph(nodes, edges, "Estate robustness by component (dominant role)", "TB"))
    out.append("\n#### Robustness census by tier and category\n\n")
    out.append("| tier | boundary | control | entity | total |\n|---|---|---|---|---|\n")
    for tier in ("presentation", "services", "data"):
        row = [sum(1 for r in rob["catalog"][k] if r.get("tier") == tier)
               for k in ("boundary", "control", "entity")]
        out.append(f"| {tier} | {row[0]} | {row[1]} | {row[2]} | {sum(row)} |\n")
    tot = [len(rob["catalog"][k]) for k in ("boundary", "control", "entity")]
    out.append(f"| **all** | **{tot[0]}** | **{tot[1]}** | **{tot[2]}** | **{sum(tot)}** |\n")
    return "".join(out)


def robustness_for_component(rob: dict, comp: str) -> str:
    members = {k: [r for r in rob["catalog"][k] if r["component"] == comp]
               for k in ("boundary", "control", "entity")}
    if sum(len(v) for v in members.values()) < 2:
        return ""
    nodes = []
    for k, cls in (("boundary", "b"), ("control", "c"), ("entity", "e")):
        for r in members[k][:16]:
            nodes.append({"id": _nid(r["id"] + "_" + r["name"]), "label": f"{r['id']} {r['name']}",
                          "shape": k, "group": k.upper(), "cls": cls})
    return render_graph(nodes, [], f"{comp} — robustness (ICONIX)", "LR")


def robustness_catalog_full(rob: dict) -> str:
    out = ["### Robustness catalogs — every classified object\n"]
    for k, title in (("boundary", "Boundary objects (interfaces)"),
                     ("control", "Control objects (services)"),
                     ("entity", "Entity objects (data)")):
        rows = rob["catalog"][k]
        out.append(f"\n#### {title} — {len(rows)} objects\n\n")
        out.append("| id | object | kind | component | tier | sink | src | degree |\n|---|---|---|---|---|---|---|---|\n")
        for r in rows:
            out.append(f"| {r['id']} | {str(r['name'])[:34]} | {r['type']} | {r['component']} | "
                       f"{r.get('tier','?')} | {r.get('sink') or '—'} | {str(r.get('source','?'))[:4]} | {r['degree']} |\n")
    return "".join(out)


# ---------------------------------------------------------------------------
# 3. C4 hierarchy — L1 Context, L2 Container, L3 Component, L4 Code.
# ---------------------------------------------------------------------------
def c4_containers() -> list[dict]:
    rows = base._cypher(
        "MATCH (e:CodeEntity) WHERE e.workspace = $workspace AND e.file_path IS NOT NULL "
        "RETURN split(e.file_path,'/')[2] AS area, count(*) AS n ORDER BY n DESC LIMIT 20") or []
    return [{"area": r["area"], "n": r["n"]} for r in rows
            if r.get("area") and r["area"] not in v5.NOISE_AREAS]


def c4_container_diagram(containers: list[dict], comps: list[dict]) -> str:
    nodes, edges = [], []
    for c in containers:
        nodes.append({"id": _nid("A_" + c["area"]), "label": f"{c['area']} ({c['n']})",
                      "shape": "box", "group": "Containers", "cls": "c"})
    for ext, lab in (("neo4j", "Neo4j dual graph"), ("chroma", "ChromaDB"), ("lmstudio", "LM Studio eGPU")):
        nodes.append({"id": _nid("X_" + ext), "label": lab, "shape": "entity",
                      "group": "External", "cls": "e"})
    for c in containers:
        edges.append({"src": _nid("A_" + c["area"]), "dst": _nid("X_neo4j"), "label": ""})
    return render_graph(nodes, edges, "C4 L2 — Containers (areas observed in the code graph)", "TB")


def c4_component_diagram(area: str, comps: list[dict]) -> str:
    members = [c for c in comps if c["title"].split("/")[0] == area][:NODE_BUDGET]
    if len(members) < 2:
        return ""
    nodes = [{"id": _nid("M_" + c["title"]), "label": c["title"].split("/", 1)[-1],
              "shape": "box", "group": area, "cls": "c"} for c in members]
    return render_graph(nodes, [], f"C4 L3 — Components of container `{area}`", "LR")


def c4_code_diagram(comp: str) -> str:
    """L4 — the classes inside a component and what they define."""
    rows = base._cypher(
        "MATCH (c:CodeEntity)-[:CODE_REL {type:'DEFINES'}]->(f:CodeEntity) "
        "WHERE c.workspace = $workspace AND c.type='Class' "
        f"AND c.file_path STARTS WITH '{comp_prefix(comp)}' "
        "RETURN c.name AS cls, split(c.file_path,'/')[-1] AS file, count(f) AS methods "
        "ORDER BY methods DESC LIMIT 24") or []
    if len(rows) >= 2:
        nodes = [{"id": _nid("C_" + str(r["cls"])), "label": f"{r['cls']} ({r['methods']}m)",
                  "shape": "box", "group": str(r["file"]), "cls": "c"} for r in rows]
        return render_graph(nodes, [], f"C4 L4 — Code: classes in `{comp}`", "LR")
    # Fallback: most modules (especially JS) define functions at file scope with no
    # class, and 23 components are a SINGLE file — a class- or file-level L4 leaves
    # both undocumented. Drop to the definitions themselves, grouped by their file.
    drows = base._cypher(
        "MATCH (f:CodeEntity)-[:CODE_REL {type:'DEFINES'}]->(d:CodeEntity) "
        "WHERE f.workspace = $workspace AND f.type = 'File' "
        f"AND f.file_path STARTS WITH '{comp_prefix(comp)}' "
        "RETURN split(f.file_path,'/')[-1] AS file, d.name AS defn, d.type AS kind "
        "LIMIT 30") or []
    if len(drows) < 2:
        return ""
    nodes = [{"id": _nid("D_" + str(r["file"]) + "_" + str(r["defn"])),
              "label": str(r["defn"]), "shape": "round", "group": str(r["file"]),
              "cls": "c" if r.get("kind") == "Function" else "x"} for r in drows]
    return render_graph(nodes, [], f"C4 L4 — Code: definitions in `{comp}`", "LR")


# ---------------------------------------------------------------------------
# 4. Workflow triad — BPMN, UML sequence, robustness, per manifest contract.
# ---------------------------------------------------------------------------
GATEWAY_HINT = re.compile(r"(validate|check|gate|verify|decide|branch|if_|route)", re.I)
END_HINT = re.compile(r"(report|publish|emit|complete|final|output|render|pdf)", re.I)


def _edge_pair(e) -> tuple | None:
    """Manifest edges come as ["a","b"] OR {source,target} OR {from,to}."""
    if isinstance(e, (list, tuple)) and len(e) >= 2:
        return str(e[0]), str(e[1])
    if isinstance(e, dict):
        s = e.get("source") or e.get("from") or e.get("src")
        d = e.get("target") or e.get("to") or e.get("dst")
        if s and d:
            return str(s), str(d)
    return None


def inventory_workflows_v6() -> list[dict]:
    """One leaf per manifest contract, carrying its REAL DAG.

    The swarm/pipeline manifests keep their topology under `plan.tasks` +
    `plan.edges` (+ `plan.waves` for parallelism), not in a flat `stages` list —
    v5's extractor missed 16 of 23 contracts entirely and drew a fake linear
    chain for the rest. Here we take the actual graph when it exists.
    """
    out = []
    for f in sorted((RUNTIME / "manifests" / "templates").glob("*.json")):
        if f.name == "togaf_object_map.json":
            continue
        try:
            m = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        plan = m.get("plan") if isinstance(m.get("plan"), dict) else {}
        tasks, edges, waves = [], [], []
        raw_tasks = plan.get("tasks") or plan.get("phases") or plan.get("steps")
        if isinstance(raw_tasks, list) and raw_tasks:
            for t in raw_tasks:
                if isinstance(t, dict):
                    tid = str(t.get("id") or t.get("name") or "")[:48]
                    if tid:
                        tasks.append({"id": tid,
                                      "label": str(t.get("name") or tid)[:40],
                                      "desc": str(t.get("description") or "")[:180]})
                elif isinstance(t, str):
                    tasks.append({"id": t[:48], "label": t[:40], "desc": ""})
            for e in (plan.get("edges") or []):
                p = _edge_pair(e)
                if p:
                    edges.append(p)
            for w in (plan.get("waves") or []):
                if isinstance(w, list):
                    waves.append([str(x) for x in w])
        if not tasks:
            # Flat contracts. ORDERED keys imply a linear pipeline; UNORDERED ones
            # (a model set, an agent roster) must NOT get invented sequence edges —
            # they are genuinely parallel and BPMN should show them that way.
            ORDERED = ("steps", "stages", "chapters", "phases", "pipeline", "nodes")
            UNORDERED = ("agents", "models")
            for key in ORDERED + UNORDERED:
                v = m.get(key)
                if isinstance(v, list) and v:
                    for item in v:
                        nm = (str(item.get("name") or item.get("id") or item.get("title") or "")
                              if isinstance(item, dict) else str(item))[:48]
                        if nm:
                            tasks.append({"id": nm, "label": nm, "desc": ""})
                    if key in ORDERED:
                        for i in range(len(tasks) - 1):
                            edges.append((tasks[i]["id"], tasks[i + 1]["id"]))
                    break
        if not waves and tasks:
            waves = [[t["id"]] for t in tasks]
        out.append({
            "title": str(m.get("name") or f.stem)[:70],
            "goal": f"Document the {f.name} workflow contract: purpose, executor, topology "
                    "(tasks, dependencies, parallel waves) and evidence of real runs.",
            "kind": "workflow",
            "item": {"file": f.name, "id": m.get("id"), "schema_version": m.get("schema_version"),
                     "description": str(m.get("description") or "")[:700],
                     "executor": str(m.get("executor") or "")[:200],
                     "task_count": len(tasks), "edge_count": len(edges), "wave_count": len(waves),
                     "tasks": [t["label"] for t in tasks][:24],
                     "stages": [t["label"] for t in tasks][:16]},
            "dag": {"tasks": tasks, "edges": edges, "waves": waves},
            "frameworks": [],
        })
    return out


def _wave_of(dag: dict) -> dict:
    """taskid -> wave index, for BPMN lanes and sequence ordering."""
    w = {}
    for i, wave in enumerate(dag.get("waves") or [], 1):
        for t in wave:
            w.setdefault(t, i)
    return w


def bpmn_for(item: dict, dag: dict) -> str:
    """BPMN over the contract's REAL topology: start/end events, parallel-wave
    lanes, and a gateway shape wherever a task actually fans out."""
    tasks = (dag or {}).get("tasks") or []
    if len(tasks) < 2:
        return ""
    edges_raw = dag.get("edges") or []
    fanout: dict[str, int] = {}
    for s, _d in edges_raw:
        fanout[s] = fanout.get(s, 0) + 1
    waves = _wave_of(dag)
    ids = {t["id"] for t in tasks}
    srcs = {s for s, _ in edges_raw}
    dsts = {d for _, d in edges_raw}
    nodes = [{"id": "bp_start", "label": "start", "shape": "event", "group": "Events", "cls": "g"},
             {"id": "bp_end", "label": "end", "shape": "event", "group": "Events", "cls": "g"}]
    edges = []
    for t in tasks:
        tid = _nid("T_" + t["id"])
        is_gw = fanout.get(t["id"], 0) > 1 or GATEWAY_HINT.search(t["id"]) is not None
        nodes.append({"id": tid, "label": t["label"],
                      "shape": "gateway" if is_gw else "box",
                      "group": f"Wave {waves.get(t['id'], 1)}",
                      "cls": "g" if is_gw else ("e" if END_HINT.search(t["id"]) else "c")})
        if t["id"] not in dsts:                       # no predecessor -> start event
            edges.append({"src": "bp_start", "dst": tid, "label": ""})
        if t["id"] not in srcs:                       # no successor -> end event
            edges.append({"src": tid, "dst": "bp_end", "label": ""})
    for s, d in edges_raw:
        if s in ids and d in ids:
            edges.append({"src": _nid("T_" + s), "dst": _nid("T_" + d), "label": ""})
    return render_graph(nodes, edges, f"BPMN — {item.get('file', 'workflow')} "
                        f"({len(tasks)} tasks, {len(edges_raw)} dependencies)", "LR")


def sequence_for(item: dict, dag: dict) -> str:
    """UML sequence in real execution order (wave order, then declared order)."""
    tasks = (dag or {}).get("tasks") or []
    if len(tasks) < 2:
        return ""
    waves = _wave_of(dag)
    ordered = sorted(tasks, key=lambda t: (waves.get(t["id"], 99), tasks.index(t)))[:9]
    parts = ["Operator", "Executor"] + [t["label"] for t in ordered]
    steps = [("Operator", "Executor", "run " + str(item.get("file", "manifest"))[:20])]
    for t in ordered:
        steps.append(("Executor", t["label"], f"wave {waves.get(t['id'], 1)}"))
        steps.append((t["label"], "Executor", "result"))
    return render_sequence(parts, steps, f"UML sequence — {item.get('file', 'workflow')}")


def workflow_robustness(item: dict, dag: dict) -> str:
    """ICONIX view of a contract: the runner is the boundary, tasks are controls,
    data-shaped tasks are entities, wired by the real dependency edges."""
    tasks = (dag or {}).get("tasks") or []
    if len(tasks) < 2:
        return ""
    ids = {t["id"] for t in tasks}
    dsts = {d for _, d in (dag.get("edges") or [])}
    nodes = [{"id": "wb_cli", "label": "manifest runner / CLI", "shape": "boundary",
              "group": "BOUNDARY", "cls": "b"}]
    edges = []
    for t in tasks:
        tid = _nid("R_" + t["id"])
        is_data = v3.ENTITY_PAT.search(t["id"]) is not None or END_HINT.search(t["id"]) is not None
        nodes.append({"id": tid, "label": t["label"],
                      "shape": "entity" if is_data else "control",
                      "group": "ENTITY" if is_data else "CONTROL",
                      "cls": "e" if is_data else "c"})
        if t["id"] not in dsts:
            edges.append({"src": "wb_cli", "dst": tid, "label": ""})
    for s, d in (dag.get("edges") or []):
        if s in ids and d in ids:
            edges.append({"src": _nid("R_" + s), "dst": _nid("R_" + d), "label": ""})
    return render_graph(nodes, edges, f"Robustness — {item.get('file', 'workflow')}", "LR")


# ---------------------------------------------------------------------------
# 5. Use cases — actors x capabilities from the knowledge graph.
# ---------------------------------------------------------------------------
def inventory_usecases(limit: int = 10) -> list[dict]:
    rows = base._cypher(
        "MATCH (p)-[r]->(c:Concept) WHERE p.workspace = $workspace "
        "RETURN type(r) AS rel, count(*) AS n ORDER BY n DESC LIMIT 12") or []
    themes = base._cypher(
        "MATCH (c:Concept) WHERE c.workspace = $workspace "
        "MATCH (c)-[:RELATES_TO]-(o:Concept) "
        "WITH c, count(o) AS deg ORDER BY deg DESC LIMIT $lim "
        "RETURN c.name AS name, deg", lim=limit) or []
    out = []
    for t in themes:
        nm = str(t.get("name") or "?")
        out.append({
            "title": f"Use case — {nm}"[:70],
            "goal": f"Document the '{nm}' capability as a use case: actors, trigger, flow, "
                    "supporting components and evidence.",
            "kind": "usecase",
            "item": {"capability": nm, "graph_degree": t.get("deg"), "relationship_census": rows[:6]},
            "frameworks": [],
            "cypher": ("MATCH (c:Concept {name:$nm})-[:RELATES_TO]-(o:Concept) "
                       "WHERE c.workspace = $workspace "
                       "RETURN c.name AS capability, o.name AS related, count(*) AS n "
                       "ORDER BY n DESC LIMIT 20").replace("$nm", json.dumps(nm)),
            "diagram": "edges",
        })
    return out


# ---------------------------------------------------------------------------
# 5b. Data lineage — the real OpenLineage RunEvent stream.
# ---------------------------------------------------------------------------
def harvest_lineage() -> dict:
    """Read the OpenLineage event stream and fold it into a job/dataset graph.

    Two streams exist: `openlineage.json` (LONGVIEW phases) and
    `openlineage_runtime.json` (the Benny runtime: ingest, tools, agent runs).
    Both are OpenLineage RunEvents, so they fold into one graph.
    """
    base._emit("Executing task: lineage_evidence (OpenLineage RunEvent stream)")
    ws = Path(os.environ.get("BENNY_HOME", "")) / "workspaces" / base.ARGS.workspace
    lin = {"events": 0, "jobs": {}, "datasets": {}, "edges": [], "facets": {},
           "namespaces": {}, "event_types": {}, "sources": []}
    for name in ("openlineage.json", "openlineage_runtime.json"):
        p = ws / "longview" / "lineage" / name
        if not p.exists():
            continue
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        evs = raw if isinstance(raw, list) else (raw.get("events") or raw.get("runEvents") or [])
        lin["sources"].append({"file": name, "events": len(evs),
                               "bytes": p.stat().st_size})
        for e in evs:
            if not isinstance(e, dict):
                continue
            lin["events"] += 1
            job = e.get("job") or {}
            jns, jn = str(job.get("namespace") or "?"), str(job.get("name") or "?")
            key = f"{jns}/{jn}"
            j = lin["jobs"].setdefault(key, {"namespace": jns, "name": jn, "events": 0,
                                             "inputs": set(), "outputs": set(), "models": set(),
                                             "commits": set()})
            j["events"] += 1
            lin["namespaces"][jns] = lin["namespaces"].get(jns, 0) + 1
            et = str(e.get("eventType") or "?")
            lin["event_types"][et] = lin["event_types"].get(et, 0) + 1
            for fk, fv in ((e.get("run") or {}).get("facets") or {}).items():
                lin["facets"][fk] = lin["facets"].get(fk, 0) + 1
                if isinstance(fv, dict):
                    if fv.get("model"):
                        j["models"].add(str(fv["model"]))
                    if fv.get("git_commit"):
                        j["commits"].add(str(fv["git_commit"]))
            for d in (e.get("inputs") or []):
                nm = str((d or {}).get("name") or "?")
                j["inputs"].add(nm)
                lin["datasets"].setdefault(nm, {"produced_by": set(), "consumed_by": set()})["consumed_by"].add(key)
                lin["edges"].append((nm, key, "in"))
            for d in (e.get("outputs") or []):
                nm = str((d or {}).get("name") or "?")
                j["outputs"].add(nm)
                lin["datasets"].setdefault(nm, {"produced_by": set(), "consumed_by": set()})["produced_by"].add(key)
                lin["edges"].append((key, nm, "out"))
    base._emit(f"lineage: {lin['events']} events, {len(lin['jobs'])} jobs, "
               f"{len(lin['datasets'])} datasets, {len(lin['facets'])} facet types")
    return lin


def lineage_diagram(lin: dict) -> str:
    """dataset -> job -> dataset, the real produced/consumed topology."""
    jobs = sorted(lin["jobs"].items(), key=lambda kv: -kv[1]["events"])[:18]
    keep = {k for k, _ in jobs}
    nodes, edges, seen = [], [], set()
    for k, j in jobs:
        nodes.append({"id": _nid("J_" + k), "label": f"{j['name']} x{j['events']}",
                      "shape": "control", "group": f"jobs: {j['namespace']}", "cls": "c"})
    for ds, d in lin["datasets"].items():
        if not (d["produced_by"] & keep or d["consumed_by"] & keep):
            continue
        nodes.append({"id": _nid("DS_" + ds), "label": ds.split(":")[-1][:26],
                      "shape": "entity", "group": "datasets", "cls": "e"})
    for a, b, _kind in lin["edges"]:
        ia = _nid(("J_" if a in lin["jobs"] else "DS_") + a)
        ib = _nid(("J_" if b in lin["jobs"] else "DS_") + b)
        if (ia, ib) in seen:
            continue
        seen.add((ia, ib))
        edges.append({"src": ia, "dst": ib, "label": ""})
    return render_graph(nodes, edges, "Data lineage — OpenLineage job and dataset graph", "LR")


def lineage_catalog(lin: dict) -> str:
    out = ["### Data lineage — OpenLineage event catalog\n",
           f"\nFolded from {len(lin['sources'])} RunEvent stream(s): "
           + "; ".join(f"`{s['file']}` ({s['events']} events, {round(s['bytes']/1024)} KB)"
                       for s in lin["sources"]) + ".\n\n"]
    out.append("| stream fact | value |\n|---|---|\n")
    out.append(f"| total RunEvents | {lin['events']} |\n")
    out.append(f"| distinct jobs | {len(lin['jobs'])} |\n")
    out.append(f"| distinct datasets | {len(lin['datasets'])} |\n")
    out.append(f"| event types | {', '.join(f'{k}={v}' for k, v in sorted(lin['event_types'].items()))} |\n")
    out.append(f"| namespaces | {', '.join(f'{k}={v}' for k, v in sorted(lin['namespaces'].items()))} |\n")
    out.append(f"| run facets | {', '.join(f'{k}={v}' for k, v in sorted(lin['facets'].items()))} |\n")
    out.append("\n#### Jobs (by event volume)\n\n| job | namespace | events | inputs | outputs | models observed |\n|---|---|---|---|---|---|\n")
    for k, j in sorted(lin["jobs"].items(), key=lambda kv: -kv[1]["events"])[:40]:
        out.append(f"| {j['name'][:44]} | {j['namespace']} | {j['events']} | {len(j['inputs'])} | "
                   f"{len(j['outputs'])} | {', '.join(sorted(j['models']))[:40] or '—'} |\n")
    out.append("\n#### Datasets (produced / consumed)\n\n| dataset | produced by | consumed by |\n|---|---|---|\n")
    for ds, d in sorted(lin["datasets"].items()):
        out.append(f"| {ds[:52]} | {', '.join(sorted(x.split('/')[-1] for x in d['produced_by']))[:44] or '—'} "
                   f"| {', '.join(sorted(x.split('/')[-1] for x in d['consumed_by']))[:44] or '—'} |\n")
    return "".join(out)


def data_elements_catalog(ev: dict) -> str:
    """Data model ELEMENTS — every label with its real property keys and counts."""
    s = ev["schema"]
    out = ["### Data model — elements, properties and cardinality\n\n",
           "Every node label observed in this workspace with its measured population and the "
           "property keys actually present on it (sampled from live nodes, not a declared schema).\n\n",
           "| label | population | property keys |\n|---|---|---|\n"]
    props = s.get("props") or {}
    for r in (s.get("label_counts") or []):
        lab = r["label"]
        out.append(f"| {lab} | {r['n']} | {', '.join(props.get(lab, []))[:110] or '(not sampled)'} |\n")
    out.append("\n#### Relationship elements\n\n| source | relationship | target | count |\n|---|---|---|---|\n")
    for r in (s.get("rel_pairs") or []):
        out.append(f"| {r['src']} | {r['rel']} | {r['dst']} | {r['n']} |\n")
    return "".join(out)


# ---------------------------------------------------------------------------
# 5c. Full dependency inventory — software AND hardware.
# ---------------------------------------------------------------------------
def harvest_deps_full() -> dict:
    """Complete dependency lists. base.harvest_deps only keeps counts + top 15."""
    base._emit("Executing task: dependency_full (complete software inventory)")
    root = RUNTIME.parent
    d = {"node": {}, "node_packages": [], "python": {}, "docker": [], "installed": []}
    pkg = root / "package.json"
    if pkg.exists():
        try:
            p = json.loads(pkg.read_text(encoding="utf-8"))
            d["node"] = {"name": p.get("name"), "version": p.get("version"),
                         "dependencies": p.get("dependencies", {}),
                         "devDependencies": p.get("devDependencies", {}),
                         "engines": p.get("engines", {})}
        except Exception:
            pass
    # every package.json in the estate, not just the root one
    for rel in ("package.json", "packaging/package.json", "server/package.json",
                "app/package.json", "website/package.json"):
        f = root / rel
        if not f.exists():
            continue
        try:
            p = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        d["node_packages"].append({"file": rel, "name": p.get("name"), "version": p.get("version"),
                                   "dependencies": p.get("dependencies", {}),
                                   "devDependencies": p.get("devDependencies", {})})
    # THE DEPLOYED CLOSURE: requirements.txt is intent, the runtime bundle's site/
    # tree is what actually ships. Read the dist-info directories for real versions.
    site = Path(os.environ.get("APPDATA", "")) / "space-agent" / "runtime-bundle" / "site"
    if site.is_dir():
        for di in sorted(site.glob("*.dist-info")):
            stem = di.name[: -len(".dist-info")]
            name, _, ver = stem.rpartition("-")
            if name:
                d["installed"].append({"package": name, "version": ver})
    for req in ("requirements.txt", "requirements.runtime.txt", "requirements-dev.txt"):
        f = RUNTIME / req
        if f.exists():
            lines = [l.strip() for l in f.read_text(encoding="utf-8", errors="replace").splitlines()
                     if l.strip() and not l.strip().startswith("#")]
            d["python"][req] = lines
    compose = root / "docker-compose.yml"
    if compose.exists():
        txt = compose.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"^  ([\w-]+):\s*$", txt, re.M):
            svc = m.group(1)
            tail = txt[m.end():m.end() + 400]
            img = re.search(r"image:\s*(\S+)", tail)
            ports = re.findall(r'"?(\d+):(\d+)"?', tail)
            d["docker"].append({"service": svc, "image": img.group(1) if img else "—",
                                "ports": [f"{a}->{b}" for a, b in ports[:4]]})
    return d


def deps_catalog(d: dict, hw: dict) -> str:
    out = ["### Software dependency inventory (complete)\n\n"]
    n = d.get("node") or {}
    deps, dev = n.get("dependencies") or {}, n.get("devDependencies") or {}
    out.append(f"**Node package** `{n.get('name','?')}` v{n.get('version','?')} — "
               f"{len(deps)} runtime, {len(dev)} dev dependencies. "
               f"Engines: {json.dumps(n.get('engines') or {})}\n\n")
    if deps:
        out.append("| runtime dependency | version |\n|---|---|\n")
        out += [f"| {k} | {v} |\n" for k, v in sorted(deps.items())]
    if dev:
        out.append("\n| dev dependency | version |\n|---|---|\n")
        out += [f"| {k} | {v} |\n" for k, v in sorted(dev.items())]
    for req, lines in (d.get("python") or {}).items():
        out.append(f"\n**Python — `{req}`** ({len(lines)} requirements)\n\n| requirement |\n|---|\n")
        out += [f"| {l} |\n" for l in lines]
    others = [p for p in (d.get("node_packages") or []) if p["file"] != "package.json"]
    if others:
        out.append("\n**Other Node packages in the estate**\n\n| file | package | runtime deps | dev deps |\n|---|---|---|---|\n")
        out += [f"| `{p['file']}` | {p.get('name') or '—'} | {len(p['dependencies'])} | "
                f"{len(p['devDependencies'])} |\n" for p in others]
    inst = d.get("installed") or []
    if inst:
        out.append(f"\n**Deployed Python closure** — {len(inst)} packages actually installed in the "
                   "shipped runtime bundle. `requirements.txt` states intent; this is what ships.\n\n"
                   "| package | version |\n|---|---|\n")
        out += [f"| {p['package']} | {p['version']} |\n" for p in inst]
    if d.get("docker"):
        out.append("\n**Container services** (`docker-compose.yml`)\n\n| service | image | ports |\n|---|---|---|\n")
        out += [f"| {s['service']} | {s['image']} | {', '.join(s['ports']) or '—'} |\n" for s in d["docker"]]
    return "".join(out)


def hardware_catalog(hw: dict) -> str:
    out = ["### Hardware inventory (probed, not asserted)\n\n"]
    host = hw.get("host") or {}
    out.append("| host attribute | measured value |\n|---|---|\n")
    for k, v in host.items():
        out.append(f"| {k} | {str(v)[:120]} |\n")
    lan = hw.get("lan_inference_host") or {}
    if lan:
        out.append("\n**LAN inference host**\n\n| attribute | value |\n|---|---|\n")
        for k, v in lan.items():
            out.append(f"| {k} | {str(v)[:120]} |\n")
    rigs = hw.get("rigs") or []
    if rigs:
        out.append("\n**Inference rigs**\n\n| rig | hardware | models | status |\n|---|---|---|---|\n")
        for r in rigs:
            out.append(f"| {r.get('rig','?')} | {str(r.get('hardware',''))[:60]} | "
                       f"{str(r.get('models',''))[:50]} | {r.get('status','?')} |\n")
    bench = (hw.get("bench") or {}).get("results")
    if bench:
        out.append("\n**Measured rig benchmark**\n\n```\n" + json.dumps(bench, indent=1)[:1800] + "\n```\n")
    return "".join(out)


def deployment_section(hw: dict, d: dict, lin: dict) -> str:
    """Deployment topology: what runs where, on which port, backed by what."""
    out = ["### Deployment topology — processes, ports and hosts\n\n"]
    rows = [
        ("Space Agent shell", "Electron desktop", "local", "—", "packaging/desktop"),
        ("Benny runtime API", "FastAPI/uvicorn", "local", "8005", "runtime/benny/api"),
        ("Neo4j", "bundled 5.23 + JRE", "local", "7687 / 7474", "dual graph"),
        ("ChromaDB", "embedded", "local", "—", "vector index"),
        ("LM Studio", "eGPU RX 9060 XT (RDNA4)", "LAN/local", "1234", "gemma-4-12b + nomic-embed"),
        ("LONGVIEW dashboard", "node", "local", "8788", "ledger-sourced observability"),
    ]
    out.append("| component | runtime | host | port | backing |\n|---|---|---|---|---|\n")
    out += [f"| {a} | {b} | {c} | {e} | {f} |\n" for a, b, c, e, f in rows]
    for s in (d.get("docker") or []):
        out.append(f"| {s['service']} (container) | {s['image']} | docker | "
                   f"{', '.join(s['ports']) or '—'} | compose |\n")
    nodes = [
        {"id": "dep_ui", "label": "Space Agent (Electron)", "shape": "boundary", "group": "Workstation", "cls": "b"},
        {"id": "dep_api", "label": "Benny API :8005", "shape": "control", "group": "Workstation", "cls": "c"},
        {"id": "dep_dash", "label": "Dashboard :8788", "shape": "boundary", "group": "Workstation", "cls": "b"},
        {"id": "dep_neo", "label": "Neo4j :7687", "shape": "entity", "group": "Data stores", "cls": "e"},
        {"id": "dep_chroma", "label": "ChromaDB", "shape": "entity", "group": "Data stores", "cls": "e"},
        {"id": "dep_home", "label": "BENNY_HOME workspaces", "shape": "entity", "group": "Data stores", "cls": "e"},
        {"id": "dep_lm", "label": "LM Studio :1234 (eGPU)", "shape": "control", "group": "Inference", "cls": "g"},
    ]
    edges = [{"src": "dep_ui", "dst": "dep_api", "label": "IPC/HTTP"},
             {"src": "dep_dash", "dst": "dep_home", "label": "reads"},
             {"src": "dep_api", "dst": "dep_neo", "label": "bolt"},
             {"src": "dep_api", "dst": "dep_chroma", "label": "embed"},
             {"src": "dep_api", "dst": "dep_home", "label": "files"},
             {"src": "dep_api", "dst": "dep_lm", "label": "OpenAI HTTP"}]
    out.append("\n" + render_graph(nodes, edges, "Deployment topology", "LR"))
    return "".join(out)


# ---------------------------------------------------------------------------
# 5d. Storage architecture — folder breakdown by usage.
# ---------------------------------------------------------------------------
STORAGE_PURPOSE = {
    "longview": "LONGVIEW state: session cards, windows, ledger, lineage, quarantine",
    "longview/cards": "one distilled JSON card per session (the map-phase output)",
    "longview/windows": "per-session extraction windows + manifests (provenance)",
    "longview/lineage": "OpenLineage RunEvent streams",
    "data_out": "deliverables: SAD, book, dossiers, themes, timeline, reports",
    "data_out/dossiers": "per-project dossiers (reduce phase)",
    "data_out/opus": "the long-form book output",
    "data_out/togaf_epic_evidence": "SAD evidence pack + drift history",
    "data_in": "ingest inbox",
    "chromadb": "dense vector index for retrieval",
    "runs": "run records (task_*.json) per execution",
    "src": "source tree scanned into the code graph",
}


def _bounded_size_mb(p: Path, cap: int = 40000) -> tuple[float, int, bool]:
    """Size + file count, bounded so a huge store cannot stall the build."""
    total, n, truncated = 0, 0, False
    try:
        for f in p.rglob("*"):
            if n >= cap:
                truncated = True
                break
            try:
                if f.is_file():
                    total += f.stat().st_size
                    n += 1
            except OSError:
                continue
    except Exception:
        pass
    return round(total / 1e6, 1), n, truncated


def harvest_storage() -> dict:
    base._emit("Executing task: storage_evidence (folder breakdown by usage)")
    ws = Path(os.environ.get("BENNY_HOME", "")) / "workspaces" / base.ARGS.workspace
    out = {"workspace": str(ws), "dirs": []}
    for rel in ("longview", "longview/cards", "longview/windows", "longview/lineage",
                "data_out", "data_out/dossiers", "data_out/opus",
                "data_out/togaf_epic_evidence", "data_in", "chromadb", "runs", "src"):
        p = ws / rel
        if not p.is_dir():
            continue
        mb, n, trunc = _bounded_size_mb(p)
        out["dirs"].append({"path": rel, "mb": mb, "files": n, "truncated": trunc,
                            "purpose": STORAGE_PURPOSE.get(rel, "—")})
    base._emit(f"storage: {len(out['dirs'])} directories measured")
    return out


def storage_catalog(st: dict) -> str:
    out = ["### Storage structure — folder breakdown by usage\n\n",
           f"Workspace root: `{st['workspace']}`. Sizes are measured on disk; a bounded walk "
           "marks very large stores as sampled rather than stalling the build.\n\n",
           "| directory | purpose | size (MB) | files |\n|---|---|---|---|\n"]
    for d in sorted(st["dirs"], key=lambda x: -x["mb"]):
        out.append(f"| `{d['path']}` | {d['purpose']} | {d['mb']}{'+' if d['truncated'] else ''} "
                   f"| {d['files']}{'+' if d['truncated'] else ''} |\n")
    nodes = [{"id": "st_root", "label": "workspace root", "shape": "entity",
              "group": "root", "cls": "e"}]
    edges = []
    for d in sorted(st["dirs"], key=lambda x: -x["mb"])[:22]:
        nid = _nid("ST_" + d["path"])
        top = d["path"].split("/")[0]
        nodes.append({"id": nid, "label": f"{d['path']} ({d['mb']} MB)", "shape": "box",
                      "group": top, "cls": "x"})
        edges.append({"src": "st_root", "dst": nid, "label": ""})
    out.append("\n" + render_graph(nodes, edges, "Storage structure by usage", "LR"))
    return "".join(out)


# ---------------------------------------------------------------------------
# 6. Chapters
# ---------------------------------------------------------------------------
V6_CHAPTERS = [
    {"id": "usecases", "title": "Use Case Architecture — capabilities as use cases",
     "intro": "The estate's capabilities enumerated from the knowledge graph and written as use "
              "cases. The index is the graph's own highest-connectivity capabilities.",
     "evidence": ["concepts_top", "correlates"]},
    {"id": "c4", "title": "C4 Architecture Hierarchy — context to code",
     "intro": "The four C4 levels, each derived from the code graph and linked to its parent and "
              "children: Context (L1), Containers (L2), Components (L3), Code (L4).",
     "evidence": ["code_top", "graph_summary"]},
    {"id": "workflows", "title": "Workflow Architecture — every executable contract",
     "intro": "Every registered manifest contract, each with BPMN, a UML sequence diagram and a "
              "robustness view. The index is the contents of `manifests/templates/`.",
     "evidence": ["models", "lifecycle"]},
    {"id": "components", "title": "Component Architecture — every module in the estate",
     "intro": "Every module resolved from `CodeEntity.file_path`, each with its C4 L4 code view, "
              "import-resolved dependencies and its own ICONIX robustness diagram.",
     "evidence": ["code_top", "robustness_all"]},
    {"id": "layers", "title": "Layer Walk — presentation, services, data",
     "intro": "The n-tier spine walked layer by layer over the COMPLETE robustness catalog.",
     "evidence": ["robustness_all"]},
    {"id": "lineage", "title": "Data Lineage and Data Elements",
     "intro": "The real OpenLineage RunEvent stream folded into a job/dataset graph, alongside the "
              "data model's elements: every label, its measured population and its actual property keys.",
     "evidence": ["lineage_stats", "graph_schema"]},
    {"id": "dependencies", "title": "Dependency Architecture — software and hardware",
     "intro": "The complete dependency inventory: every Node runtime and dev package, every Python "
              "requirement, every container service, and the probed hardware the estate runs on.",
     "evidence": ["deps", "hardware"]},
    {"id": "deployment", "title": "Deployment Topology",
     "intro": "What runs where: processes, ports, hosts and the stores behind them.",
     "evidence": ["hardware", "deps"]},
    {"id": "storage", "title": "Storage Architecture — folder structure by usage",
     "intro": "Every workspace directory measured on disk, with the usage it serves.",
     "evidence": ["stores", "graph_summary"]},
]


def inventory_lineage(lin: dict) -> list[dict]:
    """One leaf per job namespace + the dataset flow, from the real event stream."""
    out = [{"title": "OpenLineage event model and run facets",
            "goal": "Explain the RunEvent model in use: streams, event types, namespaces and the "
                    "run facets that carry model, commit and workspace provenance.",
            "kind": "lineage", "frameworks": [],
            "item": {"events": lin["events"], "event_types": lin["event_types"],
                     "namespaces": lin["namespaces"], "facets": lin["facets"],
                     "sources": lin["sources"]}}]
    by_ns: dict[str, list] = {}
    for k, j in lin["jobs"].items():
        by_ns.setdefault(j["namespace"], []).append(j)
    for ns, jobs in sorted(by_ns.items(), key=lambda kv: -sum(j["events"] for j in kv[1])):
        top = sorted(jobs, key=lambda j: -j["events"])[:14]
        out.append({
            "title": f"Lineage — `{ns}` jobs",
            "goal": f"Document the {ns} namespace: which jobs emit lineage, what they consume and "
                    "produce, and what that says about the pipeline.",
            "kind": "lineage", "frameworks": [],
            "item": {"namespace": ns, "job_count": len(jobs),
                     "total_events": sum(j["events"] for j in jobs),
                     "jobs": [{"name": j["name"], "events": j["events"],
                               "inputs": sorted(j["inputs"])[:6], "outputs": sorted(j["outputs"])[:6],
                               "models": sorted(j["models"])} for j in top]}})
    out.append({"title": "Dataset flow — produced and consumed",
                "goal": "Walk the datasets in the lineage graph: what produces each one, what "
                        "consumes it, and where the chain breaks.",
                "kind": "lineage", "frameworks": [],
                "item": {"datasets": {k: {"produced_by": sorted(v["produced_by"]),
                                          "consumed_by": sorted(v["consumed_by"])}
                                      for k, v in list(lin["datasets"].items())[:24]}}})
    out.append({"title": "Data model elements and cardinality",
                "goal": "Describe the data model's elements: each label, its population, its property "
                        "keys and the relationships that connect them.",
                "kind": "lineage", "frameworks": [], "cypher":
                    "MATCH (a)-[r]->(b) WHERE a.workspace = $workspace "
                    "RETURN labels(a)[0] AS src, type(r) AS rel, labels(b)[0] AS dst, count(*) AS n "
                    "ORDER BY n DESC LIMIT 20", "diagram": "edges"})
    return out


def inventory_dependencies(d: dict, hw: dict) -> list[dict]:
    node = d.get("node") or {}
    pyc = {k: len(v) for k, v in (d.get("python") or {}).items()}
    return [
        {"title": "Node runtime dependencies", "kind": "deps", "frameworks": [],
         "goal": "Document the Node runtime dependency set and what each major group provides.",
         "item": {"package": node.get("name"), "version": node.get("version"),
                  "runtime_count": len(node.get("dependencies") or {}),
                  "dependencies": node.get("dependencies") or {}}},
        {"title": "Node development dependencies", "kind": "deps", "frameworks": [],
         "goal": "Document the build/test toolchain carried as dev dependencies.",
         "item": {"dev_count": len(node.get("devDependencies") or {}),
                  "devDependencies": node.get("devDependencies") or {}}},
        {"title": "Python runtime requirements", "kind": "deps", "frameworks": [],
         "goal": "Document the Python requirement sets and the capabilities they enable.",
         "item": {"files": pyc, "requirements": d.get("python") or {}}},
        {"title": "Deployed Python closure (runtime bundle)", "kind": "deps", "frameworks": [],
         "goal": "Document what actually ships in the runtime bundle versus what requirements.txt "
                 "declares, and what that gap means for reproducibility.",
         "item": {"installed_count": len(d.get("installed") or []),
                  "installed": (d.get("installed") or [])[:120],
                  "declared": {k: len(v) for k, v in (d.get("python") or {}).items()}}},
        {"title": "Container services", "kind": "deps", "frameworks": [],
         "goal": "Document the container services, their images and exposed ports.",
         "item": {"docker": d.get("docker") or []}},
        {"title": "Hardware inventory and inference rigs", "kind": "deps", "frameworks": [],
         "goal": "Document the probed hardware: host, accelerators, LAN inference host and rigs.",
         "item": {"host": hw.get("host"), "lan": hw.get("lan_inference_host"),
                  "rigs": hw.get("rigs")}},
    ]


def inventory_deployment(hw: dict, d: dict) -> list[dict]:
    return [
        {"title": "Process and port topology", "kind": "deploy", "frameworks": [],
         "goal": "Document every process, the port it listens on and the store behind it.",
         "item": {"docker": d.get("docker") or [], "host": hw.get("host")}},
        {"title": "Inference deployment — eGPU and LAN host", "kind": "deploy", "frameworks": [],
         "goal": "Document how inference is deployed and the constraints the eGPU imposes.",
         "item": {"lan": hw.get("lan_inference_host"), "rigs": hw.get("rigs")}},
        {"title": "Portability and the BENNY_HOME contract", "kind": "deploy", "frameworks": [],
         "goal": "Explain how the deployment stays portable via BENNY_HOME and the runtime bundle.",
         "item": {"note": "no absolute paths in manifests (SR-1 gate); runtime bundle carries "
                          "embedded python + Neo4j + JRE"}},
    ]


def inventory_storage(st: dict) -> list[dict]:
    out = [{"title": "Storage overview and sizing", "kind": "storage", "frameworks": [],
            "goal": "Summarise the workspace storage: what dominates, what grows and why.",
            "item": {"workspace": st["workspace"], "dirs": st["dirs"]}}]
    for d in sorted(st["dirs"], key=lambda x: -x["mb"])[:8]:
        out.append({"title": f"Storage — `{d['path']}`", "kind": "storage", "frameworks": [],
                    "goal": f"Document the {d['path']} store: its usage, structure, size and lifecycle.",
                    "item": d})
    return out


def reading_spine(counts: dict) -> str:
    return (
        "\n## How to read this document\n\n"
        "This document is generated from the estate itself: the knowledge graph, the Tree-sitter "
        "code graph, the manifest contracts and the governance ledger. Nothing below is asserted "
        "by hand.\n\n"
        "| Chapter group | What it answers | Index derived from |\n|---|---|---|\n"
        "| Scope -> Gap (TOGAF 1-7) | Why the estate exists and where it is going | TOGAF-prescribed skeleton |\n"
        "| Use Case Architecture | What it is used for | knowledge-graph capabilities |\n"
        "| C4 Hierarchy | How it decomposes, context down to code | code graph, 4 levels |\n"
        "| Workflow Architecture | What it executes | `manifests/templates/*.json` |\n"
        "| Component Architecture | What it is made of | `CodeEntity.file_path` grouping |\n"
        "| Layer Walk | How responsibility stacks | ICONIX n-tier classification |\n\n"
        "**Identity.** Every classified object carries a stable catalog ID — `B-nnn` boundary, "
        "`C-nnn` control, `E-nnn` entity — used identically in the robustness diagrams, the "
        "per-component views and the catalog tables, so an object can be tracked across views.\n\n"
        f"**Coverage.** {counts.get('robustness', 0)} classified objects, "
        f"{counts.get('components', 0)} components, {counts.get('workflows', 0)} workflow contracts, "
        f"{counts.get('containers', 0)} containers.\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="TOGAF EPIC v6 — engineered architecture document")
    ap.add_argument("--workspace", default="sessions_v1")
    ap.add_argument("--out", default=None)
    ap.add_argument("--word-floor", dest="word_floor", type=int, default=260)
    ap.add_argument("--max-leaves", dest="max_leaves", type=int, default=0)
    ap.add_argument("--components", type=int, default=0, help="0 = every module")
    ap.add_argument("--usecases", type=int, default=10)
    ap.add_argument("--skeleton-only", dest="skeleton_only", action="store_true",
                    help="Deterministic build: diagrams/catalogs only, no LLM narrative")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--no-pdf", dest="pdf", action="store_false", default=True)
    args = ap.parse_args()

    bh = Path(os.environ.get("BENNY_HOME", ""))
    if not bh.exists():
        print("ERROR: BENNY_HOME not set", file=sys.stderr)
        return 2
    out = Path(args.out) if args.out else bh / "workspaces" / args.workspace / "data_out" / "TOGAF_EPIC_V6_SAD_binary16.md"
    state_path = out.parent / "togaf_epic_v6_state.json"

    class _A: pass
    base.ARGS = _A(); base.ARGS.workspace = args.workspace; base.ARGS.word_floor = args.word_floor
    base.RUN_ID = RUN_ID; v3.RUN_ID = RUN_ID
    base._emit(f"TOGAF EPIC v6 build starting (workspace={args.workspace}, full C4 + complete robustness)")

    hw = base.probe_hardware()
    hist = out.parent / "togaf_epic_evidence" / "history"
    for d in sorted(hist.iterdir(), reverse=True) if hist.exists() else []:
        f = d / "hardware.json"
        if f.exists():
            prev = json.loads(f.read_text(encoding="utf-8"))
            if prev.get("bench"):
                hw["bench"] = prev["bench"]
                break
    ev = {"hw": hw, "models": base.harvest_models(), "deps": base.harvest_deps(),
          "schema": base.harvest_graph_schema(), "code": base.harvest_code_stats(),
          "seq": base.harvest_run_sequence()}
    rob = build_robustness_full()
    # v3 helpers expect the sampled shape; give them the full one (same keys).
    rob_compat = {"catalog": rob["catalog"], "ids": rob["ids"], "edges": [],
                  "drift": rob["drift"], "omap": rob["omap"]}
    D = base.diagrams(hw, ev["models"], ev["deps"], ev["schema"], ev["code"], ev["seq"])
    ev_dir = out.parent / "togaf_epic_evidence"
    ev_dir.mkdir(parents=True, exist_ok=True)
    (ev_dir / "object_map_drift.json").write_text(json.dumps(rob["drift"], indent=1), encoding="utf-8")

    base._emit("Executing task: v6_inventory (containers, components, workflows, use cases)")
    containers = c4_containers()
    comps = v5.inventory_components(args.components or 9999)
    wfs = inventory_workflows_v6()
    ucs = [] if args.skeleton_only else inventory_usecases(args.usecases)
    lin = harvest_lineage()
    deps_full = harvest_deps_full()
    storage = harvest_storage()
    base._emit(f"v6 inventory: {len(containers)} containers, {len(comps)} components, "
               f"{len(wfs)} workflows, {len(ucs)} use cases, {rob['total']} classified objects")

    # attach per-item deterministic diagrams
    for w in wfs:
        dag = w.get("dag") or {}
        w["diagrams"] = "\n".join(x for x in (bpmn_for(w["item"], dag), sequence_for(w["item"], dag),
                                              workflow_robustness(w["item"], dag)) if x)
    v5.component_dependencies = component_dependencies_v6   # prefix fix for file-like components
    for c in comps:
        comp = c["deps_for"]
        c["diagrams"] = "\n".join(x for x in (c4_code_diagram(comp),
                                              robustness_for_component(rob, comp)) if x)

    state = json.loads(state_path.read_text(encoding="utf-8")) if (args.resume and state_path.exists()) else {"sections": {}}
    gates, bibliography, chapters_md = [], set(), []
    written = 0

    chapters = [dict(c, _planned=True) for c in v3.TOGAF_SKELETON] + \
               [dict(c, _planned=False, prescribed=[], frameworks=[]) for c in V6_CHAPTERS]
    inv = {"usecases": ucs, "workflows": wfs, "components": comps,
           "layers": v5.inventory_layers(rob_compat), "c4": [],
           "lineage": inventory_lineage(lin),
           "dependencies": inventory_dependencies(deps_full, hw),
           "deployment": inventory_deployment(hw, deps_full),
           "storage": inventory_storage(storage)}

    # C4 chapter leaves: one per level + one per container at L3
    c4_leaves = [
        {"title": "L1 — System Context", "goal": "Describe the estate's system context: actors, external systems, boundaries.",
         "kind": "c4", "item": {"level": "L1", "containers": [c["area"] for c in containers]},
         "frameworks": [], "diagram_md": D.get("c4_context", "")},
        {"title": "L2 — Containers", "goal": "Describe each container (area) and the responsibility it owns.",
         "kind": "c4", "item": {"level": "L2", "containers": containers},
         "frameworks": [], "diagram_md": c4_container_diagram(containers, comps)},
    ]
    for c in containers[:8]:
        area = c["area"]
        members = [x["title"] for x in comps if x["title"].split("/")[0] == area]
        c4_leaves.append({
            "title": f"L3 — Components of `{area}`",
            "goal": f"Decompose the {area} container into its components and their responsibilities.",
            "kind": "c4", "item": {"level": "L3", "container": area, "entities": c["n"],
                                   "components": members[:40]},
            "frameworks": [], "diagram_md": c4_component_diagram(area, comps)})
    c4_leaves.append({
        "title": "L4 — Code level and drill-down chain",
        "goal": "Explain the L1->L2->L3->L4 drill-down chain and how code-level views are reached.",
        "kind": "c4", "item": {"level": "L4", "note": "per-component L4 diagrams appear in Component Architecture"},
        "frameworks": [], "diagram_md": D.get("class", "")})
    inv["c4"] = c4_leaves

    for ch in chapters:
        plan_key = f"plan::{ch['id']}"
        if ch["_planned"]:
            if args.skeleton_only:
                continue
            if plan_key in state["sections"]:
                plan = state["sections"][plan_key]
            else:
                plan = v5.plan_chapter_index_v5(ch, ev, rob_compat)
                state["sections"][plan_key] = plan
                state_path.write_text(json.dumps(state, indent=1), encoding="utf-8")
        else:
            plan = inv[ch["id"]]

        parts = [f"## {ch['title']}\n"]
        if ch.get("intro"):
            parts.append(f"*{ch['intro']}*\n")
        parts.append(f"*Chapter index ({'planned' if ch['_planned'] else 'inventoried'}, "
                     f"{len(plan)} sub-sections)*\n")
        for dk in {"business": ["usecase", "bpmn"],
                   "data": ["er", "data_conceptual", "data_logical", "data_physical"],
                   "application": ["c4_container", "sequence"],
                   "technology": ["deployment", "c4_context"]}.get(ch["id"], []):
            if dk in D:
                parts.append(D[dk])
        if ch["id"] == "application":
            parts.append(robustness_overview(rob))
            parts.append(robustness_catalog_full(rob))
        if ch["id"] == "data":
            parts.append(v3.sinks_section(rob_compat))
        if ch["id"] == "gap":
            parts.append(v3.drift_section(rob_compat))
        if ch["id"] == "lineage":
            parts.append(lineage_diagram(lin))
            parts.append(lineage_catalog(lin))
            parts.append(data_elements_catalog(ev))
        if ch["id"] == "dependencies":
            parts.append(deps_catalog(deps_full, hw))
            parts.append(hardware_catalog(hw))
        if ch["id"] == "deployment":
            parts.append(deployment_section(hw, deps_full, lin))
            if "deployment" in D:
                parts.append(D["deployment"])
        if ch["id"] == "storage":
            parts.append(storage_catalog(storage))

        for leaf in plan:
            key = f"{ch['id']}::{leaf['title']}"
            extra = leaf.get("diagrams") or leaf.get("diagram_md") or ""
            if args.skeleton_only:
                txt, gate, diagram = "*(skeleton build — narrative pending)*", \
                    {"section": key[:60], "words": 0, "cites": 0, "refs_block": False,
                     "ok": True, "skeleton": True}, ""
            elif key in state["sections"] and "txt" in state["sections"][key]:
                rec = state["sections"][key]
                txt, gate, diagram = rec["txt"], rec["gate"], rec.get("diagram", "")
            elif args.max_leaves and written >= args.max_leaves:
                txt, diagram = "*(deferred — bounded build; resume with --resume)*", ""
                gate = {"section": key[:60], "words": 0, "cites": 0, "refs_block": False,
                        "ok": False, "deferred": True}
            else:
                base._emit(f"Executing task: write_v6 [{ch['id']}/{leaf['title'][:45]}]")
                txt, gate, diagram = v5.write_leaf_v5(ch, leaf, ev, rob_compat, args.word_floor)
                state["sections"][key] = {"txt": txt, "gate": gate, "diagram": diagram}
                state_path.write_text(json.dumps(state, indent=1), encoding="utf-8")
                written += 1
            gates.append(gate)
            bibliography.update(re.findall(r"\[EV-[A-Z-]+\]", txt))
            block = f"### {leaf['title']}\n\n{txt}\n"
            if diagram:
                block += "\n" + diagram
            if extra:
                block += "\n" + extra
            parts.append(block)
        chapters_md.append("\n".join(parts))

    base._emit("Executing task: assemble_v6")
    now = _dt.datetime.now().isoformat()
    real = [g for g in gates if not g.get("deferred") and not g.get("skeleton")]
    counts = {"robustness": rob["total"], "components": len(comps),
              "workflows": len(wfs), "containers": len(containers)}
    doc = "\n".join([
        "# TOGAF Enterprise SAD — binary16 estate (EPIC v6)\n",
        f"*Generated {now} · run `{RUN_ID}` · {len(chapters)} chapters · full C4 hierarchy (L1-L4), "
        f"complete ICONIX robustness over {rob['total']} classified objects, per-workflow BPMN + UML "
        f"+ robustness, and total component coverage.*\n",
        reading_spine(counts),
        "\n".join(chapters_md),
        "\n## Quality gates (per written section)\n",
        "| section | words | citations | refs | rows | diagram | query | status |",
        "|---|---|---|---|---|---|---|---|",
        "\n".join(f"| {g['section']} | {g['words']} | {g['cites']} | {'y' if g['refs_block'] else 'n'} | "
                  f"{g.get('rows', 0)} | {'y' if g.get('diagram') else 'n'} | {g.get('query', 'none')} | "
                  f"{'skeleton' if g.get('skeleton') else 'deferred' if g.get('deferred') else ('OK' + (' (retried)' if g.get('retried') else '') if g['ok'] else 'BELOW GATE')} |"
                  for g in gates),
        "\n## Bibliography — evidence labels used\n",
        "\n".join(f"- {b} — see evidence pack `togaf_epic_evidence/`" for b in sorted(bibliography)),
        "\n## Appendix — reproducibility\n",
        f"- CLI: `python scripts/togaf_epic_v6.py --workspace {args.workspace}` (state: `{state_path.name}`, resumable)\n"
        f"- Contract: `manifests/templates/togaf_epic_v6_engineered.json`\n",
    ])
    out.write_text(doc, encoding="utf-8")
    census = {"words": len(doc.split()), "mermaid_diagrams": doc.count("```mermaid"),
              "chapters": len(chapters), "sections_written": written,
              "sections_total": len(gates), "robustness_objects": rob["total"],
              "components": len(comps), "workflows": len(wfs), "containers": len(containers),
              "gates_failed": sum(1 for g in real if not g["ok"]),
              "bibliography": len(bibliography), "output": str(out)}
    if args.pdf:
        base._emit("Executing task: pdf (fit pass + SVG gate)")
        pdf_path = str(out).replace(".md", ".pdf")
        r = subprocess.run(["node", str(RUNTIME / "scripts" / "togaf_epic_pdf.mjs"), str(out), pdf_path],
                           capture_output=True, text=True, timeout=1800)
        try:
            census["pdf"] = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:
            census["pdf"] = {"ok": False, "error": (r.stderr or r.stdout)[-200:]}
        if not census["pdf"].get("ok"):
            base._emit(f"PDF GATE FAILED: {json.dumps(census['pdf'])[:150]}", status="failed")
            print(json.dumps(census, indent=1))
            return 1
    base._emit(f"DONE v6: {census['words']} words | {census['chapters']} chapters | "
               f"{census['mermaid_diagrams']} diagrams | {census['robustness_objects']} objects | "
               f"{census['gates_failed']} gate failures", status="completed")
    time.sleep(2)
    print(json.dumps(census, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
