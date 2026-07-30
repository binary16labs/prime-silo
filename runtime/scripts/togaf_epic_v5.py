#!/usr/bin/env python
"""TOGAF EPIC v5 — width-walked, per-section-retrieved SAD generation.

Stands on v3 (scripts/togaf_epic_v3.py — TOGAF skeleton, recursive index
planning, ICONIX robustness, evidence citations, PDF SVG gate) and fixes the
two structural reasons v3/v4 output read "well-structured but shallow":

  1. PER-SECTION RETRIEVAL. In v3 every leaf of a chapter received the SAME
     chapter-level evidence bundle (write_leaf looped ch["evidence"]), so 6-9
     sections paraphrased one fact-set. In v5 the planner is shown the REAL
     Neo4j schema and emits a read-only Cypher query per sub-section; the
     section is written against its OWN slice of the graph. Depth now tracks
     the evidence instead of being uniform.
  2. WIDTH WALK. v3 had seven fixed chapters and never enumerated the estate.
     v5 adds three chapters whose INDEX IS AN INVENTORY, derived from disk and
     from the code graph itself:
       - Workflow Architecture  — one sub-section per manifest contract
       - Component Architecture — one per module resolved from CodeEntity paths
       - Layer Walk             — one per n-tier layer, full catalog
     The document's shape is therefore a function of the estate, not a guess.

  3. DIAGRAMS AS AN OBLIGATION. Every section may carry its own diagram,
     rendered DETERMINISTICALLY IN CODE from that section's rows. The model
     only picks a spec from a fixed vocabulary — it never writes mermaid.
     This is deliberate: togaf_epic_pdf.mjs gates on svg_rendered >=
     mermaid_blocks, so one malformed model-authored diagram would fail the
     whole build.

Usage (from prime-silo/runtime; BENNY_HOME + BENNY_LMSTUDIO_ENDPOINTS set):

  python scripts/togaf_epic_v5.py --workspace sessions_v1
  python scripts/togaf_epic_v5.py --workspace sessions_v1 --max-leaves 6   # smoke
  python scripts/togaf_epic_v5.py --workspace sessions_v1 --resume         # continue

State file is separate from v3's, so a v5 build never disturbs a v3/v4 artifact.
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

import scripts.togaf_epic as base          # evidence + diagrams + emit machinery
import scripts.togaf_epic_v3 as v3         # skeleton, robustness, evidence bundles

RUN_ID = f"togaf-epic-v5-{_dt.datetime.now().strftime('%Y%m%d%H%M%S')}"

# Areas that are scan noise rather than estate architecture: a vendored copy of
# runtime, a compiled trainer cache, and the portable-home scratch.
NOISE_AREAS = {"prime-silo-core", "unsloth_compiled_cache", ".benny_home", "site", "packages"}
CODE_EXT = re.compile(r"\.(py|js|mjs|cjs|ts|tsx|jsx|json|md)$", re.I)


# ---------------------------------------------------------------------------
# 1. Cypher safety — the planner is an LLM, so its queries are untrusted input.
# ---------------------------------------------------------------------------
FORBIDDEN = re.compile(
    r"\b(create|merge|delete|detach|set|remove|drop|load\s+csv|foreach|"
    r"periodic|terminate|dbms|db\.index|apoc\.(create|merge|refactor|trigger|periodic))\b", re.I)


def safe_cypher(q: str, cap: int = 40) -> str | None:
    """Return a hardened read-only query, or None if it cannot be trusted.

    Rules: single statement, must START with MATCH/OPTIONAL MATCH (no CALL —
    procedures are the escape hatch), must RETURN, no mutating keyword, and a
    LIMIT is forced on so a bad query cannot drag the whole build down.
    """
    if not q or not isinstance(q, str):
        return None
    q = q.strip().rstrip(";").strip()
    q = re.sub(r"```(?:cypher)?|```", "", q).strip()
    if ";" in q:                                  # no statement chaining
        return None
    if not re.match(r"^(optional\s+)?match\b", q, re.I):
        return None
    if "return" not in q.lower():
        return None
    if FORBIDDEN.search(q):
        return None
    if len(q) > 1200:
        return None
    if not re.search(r"\blimit\b", q, re.I):
        q += f" LIMIT {cap}"
    else:                                         # clamp an over-generous LIMIT
        q = re.sub(r"\blimit\s+(\d+)", lambda m: f"LIMIT {min(int(m.group(1)), cap)}", q, flags=re.I)
    return q


def run_section_query(q: str | None) -> tuple[list, str | None]:
    """Execute a planner query defensively. Never raises into the build."""
    hardened = safe_cypher(q or "")
    if not hardened:
        return [], "rejected (not a safe read-only MATCH...RETURN)"
    try:
        rows = base._cypher(hardened) or []
        return [dict(r) for r in rows], None
    except Exception as e:
        return [], f"failed: {str(e)[:120]}"


# ---------------------------------------------------------------------------
# 2. Schema card — what the planner must see to write valid Cypher at all.
# ---------------------------------------------------------------------------
def schema_card(ev: dict) -> str:
    s = ev["schema"]
    lines = ["NEO4J SCHEMA (this workspace — always filter `WHERE n.workspace = $workspace`):"]
    lines.append("Node labels + counts: " + ", ".join(
        f"{r['label']}={r['n']}" for r in (s.get("label_counts") or [])))
    lines.append("Relationship shapes: " + "; ".join(
        f"({r['src']})-[{r['rel']}]->({r['dst']}) x{r['n']}" for r in (s.get("rel_pairs") or [])))
    for lab, props in (s.get("props") or {}).items():
        lines.append(f"  {lab} properties: {', '.join(props[:12])}")
    lines.append("CodeEntity.type values: File, Folder, Class, Function, Import, "
                 "Interface, Documentation, ExternalClass.")
    lines.append("CODE_REL edges carry r.type in: DEFINES, CALLS, DEPENDS_ON, CONTAINS, INHERITS.")
    lines.append("CodeEntity.file_path looks like 'src/prime-silo/<area>/<module>/<file>'.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 3. Diagram vocabulary — rendered in CODE, never authored by the model.
#    The PDF gate requires every mermaid block to render, so these renderers
#    return "" rather than emit anything they are not certain of.
# ---------------------------------------------------------------------------
def _nid(v: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_]", "_", str(v))[:36].strip("_")
    return ("n" + s) if (not s or s[0].isdigit()) else s


def _lab(v: str, n: int = 30) -> str:
    s = re.sub(r"[\"'`\[\]{}()<>|;\\\n\r]", " ", str(v)).strip()
    s = re.sub(r"\s+", " ", s)
    return (s[:n] or "?")


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def render_edges(rows: list, title: str, direction: str = "LR") -> str:
    """Two string-ish columns (+ optional count) -> a flowchart."""
    if not rows:
        return ""
    keys = list(rows[0].keys())
    str_keys = [k for k in keys if not _is_num(rows[0].get(k))]
    num_keys = [k for k in keys if _is_num(rows[0].get(k))]
    if len(str_keys) < 2:
        return ""
    a, b = str_keys[0], str_keys[1]
    w = num_keys[0] if num_keys else None
    seen, lines, nodes = set(), [], {}
    for r in rows[:24]:
        sa, sb = r.get(a), r.get(b)
        if sa is None or sb is None:
            continue
        ia, ib = _nid(sa), _nid(sb)
        if not ia or not ib or ia == ib or (ia, ib) in seen:
            continue
        seen.add((ia, ib))
        nodes[ia] = _lab(sa)
        nodes[ib] = _lab(sb)
        edge = f'  {ia} -->|{_lab(r.get(w), 12)}| {ib}' if w else f"  {ia} --> {ib}"
        lines.append(edge)
    if len(lines) < 2 or len(nodes) < 3:
        return ""
    decl = [f'  {i}["{l}"]' for i, l in nodes.items()]
    return (f"**Diagram — {title}**\n\n```mermaid\nflowchart {direction}\n"
            + "\n".join(decl + lines) + "\n```\n")


def render_distribution(rows: list, title: str) -> str:
    """One label column + one numeric column -> a pie chart."""
    if not rows:
        return ""
    keys = list(rows[0].keys())
    lk = next((k for k in keys if not _is_num(rows[0].get(k))), None)
    nk = next((k for k in keys if _is_num(rows[0].get(k))), None)
    if not lk or not nk:
        return ""
    slices, used = [], set()
    for r in rows[:8]:
        lab, val = _lab(r.get(lk), 24), r.get(nk)
        if not _is_num(val) or val <= 0 or lab in used:
            continue
        used.add(lab)
        slices.append(f'  "{lab}" : {val}')
    if len(slices) < 2:
        return ""
    return (f"**Diagram — {title}**\n\n```mermaid\npie showData\n"
            f'  title {_lab(title, 48)}\n' + "\n".join(slices) + "\n```\n")


def render_chain(steps: list, title: str) -> str:
    """An ordered stage list -> a top-down flow (used for workflow contracts)."""
    steps = [s for s in steps if s][:14]
    if len(steps) < 2:
        return ""
    ids = []
    for i, s in enumerate(steps):
        nid = _nid(f"s{i}_{s}")
        ids.append((nid, _lab(s, 28)))
    decl = [f'  {i}["{l}"]' for i, l in ids]
    edges = [f"  {ids[i][0]} --> {ids[i+1][0]}" for i in range(len(ids) - 1)]
    return (f"**Diagram — {title}**\n\n```mermaid\nflowchart TD\n"
            + "\n".join(decl + edges) + "\n```\n")


def render_for(spec: str, rows: list, title: str) -> str:
    try:
        if spec == "distribution":
            return render_distribution(rows, title) or render_edges(rows, title)
        if spec == "edges":
            return render_edges(rows, title) or render_distribution(rows, title)
    except Exception:
        return ""
    return ""


# ---------------------------------------------------------------------------
# 4. Width inventories — the index IS the estate, resolved from disk + graph.
# ---------------------------------------------------------------------------
def inventory_workflows() -> list[dict]:
    """One leaf per manifest contract in manifests/templates."""
    out = []
    tdir = RUNTIME / "manifests" / "templates"
    for f in sorted(tdir.glob("*.json")):
        if f.name == "togaf_object_map.json":       # a map, not a workflow
            continue
        try:
            m = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        stages = []
        for key in ("stages", "chapters", "nodes", "steps", "tasks", "agents", "pipeline", "phases"):
            v = m.get(key)
            if isinstance(v, list) and v:
                for item in v:
                    if isinstance(item, dict):
                        stages.append(str(item.get("name") or item.get("id") or item.get("title") or "")[:40])
                    elif isinstance(item, str):
                        stages.append(item[:40])
                if stages:
                    break
        out.append({
            "title": str(m.get("name") or f.stem)[:70],
            "goal": f"Document the {f.name} workflow contract: purpose, executor, stages, and evidence of real runs.",
            "kind": "workflow",
            "item": {"file": f.name, "id": m.get("id"), "schema_version": m.get("schema_version"),
                     "description": str(m.get("description") or "")[:700],
                     "executor": str(m.get("executor") or "")[:200], "stages": stages[:14]},
            "frameworks": [],
        })
    return out


_IMP_FROM = re.compile(r"^\s*from\s+([\w\.]+)\s+import\b")
_IMP_PLAIN = re.compile(r"^\s*import\s+([\w\.]+)")
_IMP_JS_FROM = re.compile(r"""from\s+['"]([^'"]+)['"]""")
_IMP_JS_REQ = re.compile(r"""require\(\s*['"]([^'"]+)['"]""")


def _import_target(stmt: str) -> str | None:
    """Extract the imported module from a raw import statement.

    The code graph stores DEPENDS_ON edges as file -> Import node, where the
    Import node's `name` is the SOURCE LINE ('from ..core.models import x') and
    its file_path is the IMPORTING file. So a naive file-to-file query
    self-loops; the real dependency has to be parsed out of the statement.
    """
    s = str(stmt or "").strip()
    for pat in (_IMP_JS_FROM, _IMP_JS_REQ, _IMP_FROM, _IMP_PLAIN):
        m = pat.search(s)
        if m:
            tgt = m.group(1).strip()
            return tgt[:48] or None
    return None


def component_dependencies(comp: str, limit: int = 20) -> list[dict]:
    """Real module dependencies for a component, parsed from its import edges."""
    rows = base._cypher(
        "MATCH (a:CodeEntity)-[r:CODE_REL {type:'DEPENDS_ON'}]->(b:CodeEntity) "
        "WHERE a.workspace = $workspace AND b.type = 'Import' "
        f"AND a.file_path STARTS WITH 'src/prime-silo/{comp}/' "
        "RETURN split(a.file_path,'/')[-1] AS from_file, b.name AS stmt LIMIT 900") or []
    agg: dict[tuple, int] = {}
    for r in rows:
        tgt = _import_target(r.get("stmt"))
        src = r.get("from_file")
        if not tgt or not src or tgt == src:
            continue
        agg[(src, tgt)] = agg.get((src, tgt), 0) + 1
    ranked = sorted(agg.items(), key=lambda kv: -kv[1])[:limit]
    return [{"from_file": a, "imports": b, "n": n} for (a, b), n in ranked]


def inventory_components(limit: int = 18) -> list[dict]:
    """One leaf per real module, resolved from the code graph's own paths."""
    rows = base._cypher(
        "MATCH (e:CodeEntity) WHERE e.workspace = $workspace AND e.file_path IS NOT NULL "
        "AND e.type IN ['Class','File','Function'] "
        "WITH split(e.file_path,'/')[2] AS area, split(e.file_path,'/')[3] AS m1, "
        "     split(e.file_path,'/')[4] AS m2, e.type AS t "
        "RETURN area, m1, m2, t, count(*) AS n") or []
    agg: dict[str, dict] = {}
    for r in rows:
        area, m1, m2 = r.get("area"), r.get("m1"), r.get("m2")
        if not area or area in NOISE_AREAS or not m1:
            continue
        if str(m1).startswith("tests") or area == "tests":
            continue
        # roll a file leaf up to its parent module
        parts = [area, str(m1)]
        if m2 and not CODE_EXT.search(str(m2)):
            parts.append(str(m2))
        comp = "/".join(parts)
        d = agg.setdefault(comp, {"total": 0, "mix": {}})
        d["total"] += r["n"]
        d["mix"][r["t"]] = d["mix"].get(r["t"], 0) + r["n"]
    ranked = sorted(agg.items(), key=lambda kv: -kv[1]["total"])[:limit]
    out = []
    for comp, d in ranked:
        out.append({
            "title": comp,
            "goal": f"Document the {comp} component: responsibility, internal structure, and its dependencies.",
            "kind": "component",
            "item": {"component": comp, "entity_total": d["total"], "mix": d["mix"]},
            "frameworks": [],
            "deps_for": comp,        # resolved in code (see component_dependencies)
            "diagram": "edges",
        })
    return out


def inventory_layers(rob: dict) -> list[dict]:
    out = []
    for tier, blurb in (("presentation", "operator-facing surfaces: UI, CLI, tray, MCP and HTTP boundaries"),
                        ("services", "orchestration and control: executors, routers, governance and swarm logic"),
                        ("data", "persistence and retrieval: graph, vector, manifest and ledger stores")):
        objs = {k: [r for r in rob["catalog"][k] if r.get("tier") == tier]
                for k in ("boundary", "control", "entity")}
        out.append({
            "title": f"{tier.title()} layer",
            "goal": f"Walk the {tier} layer end to end — {blurb} — naming every catalogued object.",
            "kind": "layer",
            "item": {"tier": tier,
                     "objects": {k: [f"{r['id']} {r['name']}" for r in v[:22]] for k, v in objs.items()},
                     "counts": {k: len(v) for k, v in objs.items()}},
            "frameworks": [],
        })
    return out


WIDTH_CHAPTERS = [
    {"id": "workflows", "title": "Workflow Architecture — the estate's executable contracts",
     "intro": "Every registered manifest contract, walked one by one. The index of this chapter is "
              "the contents of `manifests/templates/` — it cannot drift from the estate.",
     "evidence": ["models", "lifecycle"]},
    {"id": "components", "title": "Component Architecture — modules resolved from the code graph",
     "intro": "Every significant module, resolved by grouping `CodeEntity.file_path` in the code graph "
              "and ranked by entity count. The index is derived, not asserted.",
     "evidence": ["code_top", "robustness_all"]},
    {"id": "layers", "title": "Layer Walk — presentation, services, data",
     "intro": "The n-tier spine walked layer by layer, naming every classified object rather than "
              "summarising the counts.",
     "evidence": ["robustness_all"]},
]


# ---------------------------------------------------------------------------
# 5. Planning — now returns a query and a diagram spec per sub-section.
# ---------------------------------------------------------------------------
def plan_chapter_index_v5(ch: dict, ev: dict, rob: dict) -> list[dict]:
    base._emit(f"Executing task: plan_index_v5 [{ch['id']}] (schema-aware, query-per-section)")
    ev_text, _ = v3.evidence_bundle(ch["evidence"][0], ev, rob)
    prompt = (
        "You are the index planner for a chapter of a TOGAF System Architecture Document.\n"
        f"Chapter: {ch['title']}\n"
        f"TOGAF-PRESCRIBED artifacts that MUST each get a sub-section (the floor): {json.dumps(ch['prescribed'])}\n"
        f"Required analysis frameworks for this chapter: {json.dumps(ch['frameworks'])}\n\n"
        f"{schema_card(ev)}\n\n"
        f"Chapter-level evidence already available: {ev_text[:700]}\n\n"
        "For EACH sub-section also design ONE read-only Cypher query that retrieves the specific "
        "evidence THAT sub-section needs — different from the other sub-sections. Rules for the query:\n"
        "- must start with MATCH, must RETURN named columns, must include `WHERE <n>.workspace = $workspace`\n"
        "- aggregate (count/collect) and ORDER BY so the result is a small table, max 30 rows\n"
        "- no CREATE/MERGE/SET/DELETE/CALL — read only\n"
        "- prefer returning 2 text columns + 1 count, which renders as a diagram\n\n"
        'Return STRICT JSON only: a list of {"title": str, "goal": one sentence, '
        '"frameworks": subset of the required frameworks (each required framework in exactly one sub-section), '
        '"cypher": str, "diagram": "edges" | "distribution" | "none"}. '
        "Include every prescribed artifact; you may add at most 2 extra sub-sections the evidence justifies. "
        "6-9 sub-sections total. JSON list only, no prose."
    )
    fallback = [{"title": p.title(), "goal": f"Document {p} for this estate.", "frameworks": [],
                 "cypher": None, "diagram": "none"} for p in ch["prescribed"]]
    for fw in ch["frameworks"]:
        fallback[0].setdefault("frameworks", []).append(fw)
    try:
        raw = v3.llm(prompt, max_tokens=1600, temperature=0.2)
        m = re.search(r"\[.*\]", raw, re.S)
        plan = json.loads(m.group(0)) if m else None
        if not isinstance(plan, list) or not plan:
            return fallback
        clean = []
        for s in plan:
            if not isinstance(s, dict) or not s.get("title"):
                continue
            clean.append({"title": str(s["title"])[:80],
                          "goal": str(s.get("goal") or "")[:300],
                          "frameworks": [f for f in (s.get("frameworks") or []) if f in v3.FRAMEWORK_SPECS],
                          "cypher": s.get("cypher"),
                          "diagram": s.get("diagram") if s.get("diagram") in ("edges", "distribution") else "none"})
        if not clean:
            return fallback
        covered = " ".join(s["title"].lower() for s in clean)
        for p in ch["prescribed"]:                    # the floor still holds
            probe = p.split("(")[0].strip().lower().split()[0]
            if probe not in covered:
                clean.append({"title": p.title(), "goal": f"Document {p}.", "frameworks": [],
                              "cypher": None, "diagram": "none"})
        return clean[:9]
    except Exception as e:
        base._emit(f"planner fallback for {ch['id']}: {str(e)[:80]}")
        return fallback


# ---------------------------------------------------------------------------
# 6. Writing — chapter bundle + the section's OWN rows, heading-stripped, cited.
# ---------------------------------------------------------------------------
LEAD_HEADING = re.compile(r"^\s*#{1,6}\s*.+?\n+")


def _strip_echoed_heading(txt: str, title: str) -> str:
    """v3/v4's most visible defect: the model re-emits the section heading and
    the assembler adds its own, producing a duplicated title. Strip one leading
    heading when it merely echoes the title we are about to print."""
    m = LEAD_HEADING.match(txt)
    if not m:
        return txt.strip()
    head = m.group(0).strip().lstrip("#").strip().lower()
    if head[:40] == title.strip().lower()[:40] or len(head) < 80:
        return txt[m.end():].strip()
    return txt.strip()


def write_leaf_v5(ch: dict, leaf: dict, ev: dict, rob: dict, word_floor: int) -> tuple[str, dict, str]:
    """Returns (markdown, gate, diagram_md)."""
    ev_texts, all_refs = [], []
    for kind in ch["evidence"]:
        t, refs = v3.evidence_bundle(kind, ev, rob)
        ev_texts.append(t)
        all_refs += refs

    # --- the section's own slice ---
    rows, qerr, diagram = [], None, ""
    if leaf.get("deps_for"):
        rows = component_dependencies(leaf["deps_for"])
        if rows:
            ev_texts.append("[EV-SEC] import-resolved dependencies of "
                            f"{leaf['deps_for']}: " + json.dumps(rows, default=str)[:2600])
            all_refs.append("EV-SEC")
            diagram = render_edges(rows, f"{leaf['title']} — module dependencies")
        else:
            qerr = "no import edges resolved for this component"
    elif leaf.get("cypher"):
        rows, qerr = run_section_query(leaf["cypher"])
        if rows:
            ev_texts.append("[EV-SEC] section query `" + str(leaf["cypher"])[:220] + "` returned: "
                            + json.dumps(rows[:30], default=str)[:2600])
            all_refs.append("EV-SEC")
            diagram = render_for(leaf.get("diagram") or "edges", rows, leaf["title"])
    # --- width-chapter item evidence (deterministic, always present) ---
    if leaf.get("item"):
        ev_texts.append("[EV-ITEM] " + json.dumps(leaf["item"], default=str)[:2400])
        all_refs.append("EV-ITEM")
        if leaf.get("kind") == "workflow":
            diagram = diagram or render_chain(leaf["item"].get("stages") or [], leaf["title"])
        if leaf.get("kind") == "layer":
            counts = leaf["item"].get("counts") or {}
            diagram = diagram or render_distribution(
                [{"k": k, "n": v} for k, v in counts.items() if v], f"{leaf['title']} composition")

    fw_req = "".join(f"\n- Include {v3.FRAMEWORK_SPECS[f]}." for f in leaf.get("frameworks", [])
                     if f in v3.FRAMEWORK_SPECS)
    qnote = ("\n- The section query returned no rows (%s) — say so honestly and reason from the "
             "chapter evidence instead of inventing detail." % qerr) if (qerr and not rows) else ""
    prompt = (
        f"Write the sub-section '{leaf['title']}' of the TOGAF SAD chapter '{ch['title']}' "
        f"for the binary16/prime-silo application estate.\n"
        f"Goal: {leaf['goal']}\n"
        f"EVIDENCE (cite labels inline like [EV-SEC]):\n" + "\n".join(ev_texts)[:7000] + "\n\n"
        f"Rules:\n- {word_floor}-650 words of substantive prose (tables count).\n"
        "- Lead with the SPECIFIC evidence in [EV-SEC]/[EV-ITEM] where present — that slice is what "
        "makes this sub-section different from its siblings; do not restate general estate facts.\n"
        f"- Ground every claim in the evidence; cite [EV-*] labels inline; if evidence is missing say "
        f"'unverified'.{fw_req}{qnote}\n"
        "- End with a 'References:' line listing the [EV-*] labels used.\n"
        "- Markdown. Start directly with the prose. Do NOT repeat the sub-section title as a heading. "
        "Do NOT write mermaid or code fences — diagrams are added separately."
    )
    txt = v3.llm(prompt, max_tokens=1800)
    txt = _strip_echoed_heading(txt, leaf["title"])

    # Evidence labels are registered as "EV-GRAPH: Neo4j label counts" but cited
    # as "[EV-GRAPH]" — compare on the prefix, or every valid citation reads as
    # invalid and every section burns a pointless retry.
    known = {str(r).split(":")[0].strip() for r in all_refs}

    def _score(t: str) -> tuple[int, int, bool, list]:
        cites = re.findall(r"\[EV-[A-Z-]+\]", t)
        bad = sorted({c for c in cites if c.strip("[]") not in known})
        return len(t.split()), len(cites), "references:" in t.lower(), bad

    words, cites, has_refs, bad = _score(txt)
    gate = {"section": f"{ch['id']}/{leaf['title'][:40]}", "words": words, "cites": cites,
            "refs_block": has_refs, "rows": len(rows), "diagram": bool(diagram),
            "bad_cites": bad, "query": "ok" if rows else (qerr or "none"),
            "ok": words >= word_floor and cites >= 1 and has_refs and not bad}
    if not gate["ok"]:
        txt2 = v3.llm(prompt + f"\n\nPREVIOUS ATTEMPT FAILED THE GATE (words={words}, citations={cites}, "
                      f"references_block={has_refs}, invalid_citations={bad}). Fix exactly those problems; "
                      "only cite labels that actually appear in the EVIDENCE above.", max_tokens=1800)
        txt2 = _strip_echoed_heading(txt2, leaf["title"])
        w2, c2, r2, b2 = _score(txt2)
        ok2 = w2 >= word_floor and c2 >= 1 and r2 and not b2
        if ok2 or w2 > words:
            txt = txt2
            gate.update({"words": w2, "cites": c2, "refs_block": r2, "bad_cites": b2,
                         "ok": ok2, "retried": True})
    return txt, gate, diagram


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="TOGAF EPIC v5 — width-walked, per-section-retrieved SAD")
    ap.add_argument("--workspace", default="sessions_v1")
    ap.add_argument("--out", default=None)
    ap.add_argument("--word-floor", dest="word_floor", type=int, default=260)
    ap.add_argument("--max-leaves", dest="max_leaves", type=int, default=0, help="Bound written sections (0 = all)")
    ap.add_argument("--components", type=int, default=18, help="How many modules to walk")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--no-pdf", dest="pdf", action="store_false", default=True)
    args = ap.parse_args()

    bh = Path(os.environ.get("BENNY_HOME", ""))
    if not bh.exists():
        print("ERROR: BENNY_HOME not set", file=sys.stderr)
        return 2
    out = Path(args.out) if args.out else bh / "workspaces" / args.workspace / "data_out" / "TOGAF_EPIC_V5_SAD_binary16.md"
    state_path = out.parent / "togaf_epic_v5_state.json"

    class _A: pass
    base.ARGS = _A(); base.ARGS.workspace = args.workspace; base.ARGS.word_floor = args.word_floor
    base.RUN_ID = RUN_ID
    v3.RUN_ID = RUN_ID
    base._emit(f"TOGAF EPIC v5 build starting (workspace={args.workspace}, width walk + per-section retrieval)")

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
    rob = v3.build_robustness()
    D = base.diagrams(hw, ev["models"], ev["deps"], ev["schema"], ev["code"], ev["seq"])
    D["robustness"] = v3.robustness_diagram(rob)
    ev_dir = out.parent / "togaf_epic_evidence"
    ev_dir.mkdir(parents=True, exist_ok=True)
    (ev_dir / "object_map_drift.json").write_text(json.dumps(rob["drift"], indent=1), encoding="utf-8")

    state = json.loads(state_path.read_text(encoding="utf-8")) if (args.resume and state_path.exists()) else {"sections": {}}
    gates, bibliography, chapters_md = [], set(), []
    written = 0
    diagram_count = 0

    # Build the full chapter list: TOGAF skeleton (planned) + width walk (inventoried).
    base._emit("Executing task: width_inventory (workflows + components + layers)")
    inv = {"workflows": inventory_workflows(),
           "components": inventory_components(args.components),
           "layers": inventory_layers(rob)}
    base._emit(f"width walk: {len(inv['workflows'])} workflows, {len(inv['components'])} components, "
               f"{len(inv['layers'])} layers")

    chapters = [dict(c, _planned=True) for c in v3.TOGAF_SKELETON] + \
               [dict(c, _planned=False, prescribed=[], frameworks=[]) for c in WIDTH_CHAPTERS]

    for ch in chapters:
        plan_key = f"plan::{ch['id']}"
        if ch["_planned"]:
            if plan_key in state["sections"]:
                plan = state["sections"][plan_key]
            else:
                plan = plan_chapter_index_v5(ch, ev, rob)
                state["sections"][plan_key] = plan
                state_path.write_text(json.dumps(state, indent=1), encoding="utf-8")
        else:
            plan = inv[ch["id"]]

        parts = [f"## {ch['title']}\n"]
        if ch.get("intro"):
            parts.append(f"*{ch['intro']}*\n")
        parts.append(f"*Chapter index ({'planned' if ch['_planned'] else 'inventoried'}, "
                     f"{len(plan)} sub-sections): {', '.join(s['title'] for s in plan)}*\n")
        for dk in v3.DIAGRAM_FOR.get(ch["id"], []) if hasattr(v3, "DIAGRAM_FOR") else []:
            if dk in D:
                parts.append(D[dk])
        # the v3 global diagram assignment (kept: these are the estate-wide views)
        for dk in {"business": ["usecase", "bpmn"],
                   "data": ["er", "data_conceptual", "data_logical", "data_physical"],
                   "application": ["robustness", "class", "c4_container", "sequence"],
                   "technology": ["deployment", "c4_context"]}.get(ch["id"], []):
            if dk in D:
                parts.append(D[dk])
                diagram_count += D[dk].count("```mermaid")
        if ch["id"] == "application":
            parts.append(v3.robustness_indexes(rob))
        if ch["id"] == "data":
            parts.append(v3.sinks_section(rob))
        if ch["id"] == "gap":
            parts.append(v3.drift_section(rob))

        for leaf in plan:
            key = f"{ch['id']}::{leaf['title']}"
            if key in state["sections"] and "txt" in state["sections"][key]:
                rec = state["sections"][key]
                txt, gate, diagram = rec["txt"], rec["gate"], rec.get("diagram", "")
            elif args.max_leaves and written >= args.max_leaves:
                txt, diagram = "*(deferred — bounded build; resume with --resume to complete)*", ""
                gate = {"section": key[:60], "words": 0, "cites": 0, "refs_block": False,
                        "ok": False, "deferred": True}
            else:
                base._emit(f"Executing task: write_v5 [{ch['id']}/{leaf['title'][:45]}]")
                txt, gate, diagram = write_leaf_v5(ch, leaf, ev, rob, args.word_floor)
                state["sections"][key] = {"txt": txt, "gate": gate, "diagram": diagram}
                state_path.write_text(json.dumps(state, indent=1), encoding="utf-8")
                written += 1
            gates.append(gate)
            bibliography.update(re.findall(r"\[EV-[A-Z-]+\]", txt))
            block = f"### {leaf['title']}\n\n{txt}\n"
            if diagram:
                block += "\n" + diagram
                diagram_count += 1
            parts.append(block)
        chapters_md.append("\n".join(parts))

    base._emit("Executing task: assemble_v5 (chapters + width walk + gates + bibliography)")
    now = _dt.datetime.now().isoformat()
    real = [g for g in gates if not g.get("deferred")]
    with_rows = sum(1 for g in real if g.get("rows"))
    doc = "\n".join([
        "# TOGAF Enterprise SAD — binary16 estate (EPIC v5, width-walked)\n",
        f"*Generated {now} · run `{RUN_ID}` · {len(chapters)} chapters — seven planned from the TOGAF "
        f"skeleton plus a three-chapter width walk whose index is inventoried from the estate itself. "
        f"Each sub-section is written against its own retrieved slice of the graph and gated "
        f"(word floor + citations + reference block + citation validity).*\n",
        "\n".join(chapters_md),
        "\n## Quality gates (per written section)\n",
        "| section | words | citations | refs | rows | diagram | query | status |",
        "|---|---|---|---|---|---|---|---|",
        "\n".join(f"| {g['section']} | {g['words']} | {g['cites']} | {'y' if g['refs_block'] else 'n'} | "
                  f"{g.get('rows', 0)} | {'y' if g.get('diagram') else 'n'} | {g.get('query', 'none')} | "
                  f"{'deferred' if g.get('deferred') else ('OK' + (' (retried)' if g.get('retried') else '') if g['ok'] else 'BELOW GATE')} |"
                  for g in gates),
        "\n## Bibliography — evidence labels used\n",
        "\n".join(f"- {b} — see evidence pack `togaf_epic_evidence/`" for b in sorted(bibliography)),
        "\n## Appendix — reproducibility\n",
        f"- CLI: `python scripts/togaf_epic_v5.py --workspace {args.workspace}` (state: `{state_path.name}`, resumable)\n"
        f"- Contract: `manifests/templates/togaf_epic_v5_width.json`\n"
        f"- Sections retrieved their own evidence: {with_rows}/{len(real)}\n",
    ])
    out.write_text(doc, encoding="utf-8")
    census = {"words": len(doc.split()), "mermaid_diagrams": doc.count("```mermaid"),
              "chapters": len(chapters), "sections_written": written,
              "sections_total": len(gates), "sections_with_own_evidence": with_rows,
              "gates_failed": sum(1 for g in real if not g["ok"]),
              "bibliography": len(bibliography), "output": str(out)}
    if args.pdf:
        base._emit("Executing task: pdf (realized diagrams + SVG gate)")
        pdf_path = str(out).replace(".md", ".pdf")
        r = subprocess.run(["node", str(RUNTIME / "scripts" / "togaf_epic_pdf.mjs"), str(out), pdf_path],
                           capture_output=True, text=True, timeout=900)
        try:
            census["pdf"] = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:
            census["pdf"] = {"ok": False, "error": (r.stderr or r.stdout)[-200:]}
        if not census["pdf"].get("ok"):
            base._emit(f"PDF GATE FAILED: {json.dumps(census['pdf'])[:150]}", status="failed")
            print(json.dumps(census, indent=1))
            return 1
    base._emit(f"DONE v5: {census['words']} words | {census['chapters']} chapters | "
               f"{census['mermaid_diagrams']} diagrams | {census['sections_with_own_evidence']} sections "
               f"with own evidence | {census['gates_failed']} gate failures", status="completed")
    time.sleep(2)
    print(json.dumps(census, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
