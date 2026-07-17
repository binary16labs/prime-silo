#!/usr/bin/env python
"""TOGAF EPIC v3 — recursive index-planned, reference-grounded SAD generation.

Stands on v2 (scripts/togaf_epic.py — evidence pack, diagrams-as-code, PDF gate)
and adds the depth layer:

  1. TOGAF SKELETON — the prescribed chapter/artifact standard is a deterministic
     floor. The planner can EXTEND it per chapter, never fall below it.
  2. RECURSIVE INDEX PLANNING — the planner LLM expands each chapter into a
     sub-chapter index (with required analysis frameworks: SWOT / PESTEL /
     5W1H where the skeleton prescribes them), then each leaf section is
     written by its own grounded LLM call. Depth is bounded and resumable.
  3. ROBUSTNESS MODEL (ICONIX) — deterministic: every significant object in the
     code graph is classified Boundary (interface) / Control (service) /
     Entity (data), each with its own catalog ID and index; rendered as a
     mermaid robustness diagram with real DEPENDS_ON edges.
  4. REFERENCES — every section receives an evidence bundle (Cypher results,
     catalog slices, ledger facts) and MUST cite it; a gate rejects sections
     with no References block. Global bibliography in the appendix.

Usage (from prime-silo/runtime; BENNY_HOME + BENNY_LMSTUDIO_ENDPOINTS set):

  python scripts/togaf_epic_v3.py --workspace sessions_v1                # full recursive build
  python scripts/togaf_epic_v3.py --workspace sessions_v1 --max-leaves 4 # bounded smoke
  python scripts/togaf_epic_v3.py --workspace sessions_v1 --resume       # continue a partial build

Observability: same TASK_METADATA_UPDATE AER stream as v2 — every planned index
node and every written section appears live at :8788/lineage.html.
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

import scripts.togaf_epic as base  # evidence + diagrams + emit machinery (reused)

RUN_ID = f"togaf-epic-v3-{_dt.datetime.now().strftime('%Y%m%d%H%M%S')}"


# ---------------------------------------------------------------------------
# The TOGAF-prescribed skeleton: chapters, prescribed artifacts, frameworks.
# This is the FLOOR. The planner extends; it cannot remove.
# ---------------------------------------------------------------------------
TOGAF_SKELETON = [
    {"id": "scope", "title": "Scope, Context and Stakeholders",
     "prescribed": ["scope statement", "stakeholder catalog + concerns matrix", "architecture principles"],
     "frameworks": ["5W1H"], "evidence": ["graph_summary", "models"]},
    {"id": "business", "title": "Business Architecture",
     "prescribed": ["business capability map", "value streams", "process (BPMN) narrative", "org/actor catalog"],
     "frameworks": ["SWOT", "PESTEL"], "evidence": ["concepts_top", "usecase"]},
    {"id": "data", "title": "Data Architecture",
     "prescribed": ["conceptual model", "logical model", "physical model", "data entity catalog",
                    "data sinks and structure templates per store", "data lifecycle + lineage", "data governance"],
     "frameworks": ["5W1H"], "evidence": ["graph_schema", "robustness_entities", "stores"]},
    {"id": "application", "title": "Application Architecture",
     "prescribed": ["application portfolio catalog", "n-tier decomposition (presentation, services, data)",
                    "use cases per channel", "robustness model (ICONIX)",
                    "interface catalog", "application interaction matrix"],
     "frameworks": ["SWOT"], "evidence": ["robustness_all", "code_top", "correlates"]},
    {"id": "technology", "title": "Technology Architecture",
     "prescribed": ["deployment topology", "technology standards catalog", "hardware requirements (derived)",
                    "inference rigs NPU vs eGPU", "network + ports"],
     "frameworks": ["PESTEL"], "evidence": ["hardware", "deps", "bench"]},
    {"id": "observability", "title": "Observability, Lineage and Governance",
     "prescribed": ["OpenLineage event model", "governance ledger + integrity", "dashboard operations",
                    "logging model", "audit + AER"],
     "frameworks": ["5W1H"], "evidence": ["lifecycle", "lineage_stats"]},
    {"id": "gap", "title": "Gap Analysis, Risks and Transition",
     "prescribed": ["baseline vs target gaps", "claimed-vs-observed reconciliation", "risk register",
                    "transition roadmap", "ADR summary"],
     "frameworks": ["SWOT"], "evidence": ["correlates", "delta"]},
]

FRAMEWORK_SPECS = {
    "SWOT": "a SWOT table (Strengths/Weaknesses/Opportunities/Threats) grounded in the evidence",
    "PESTEL": "a PESTEL scan (Political/Economic/Social/Technological/Environmental/Legal) — mark N/A factors honestly",
    "5W1H": "a Who/What/When/Where/Why/How table answered from the evidence, not invented",
}


# ---------------------------------------------------------------------------
# LLM access — direct OpenAI-compatible call to the pinned endpoint (simple,
# observable, and identical to what the bench measures).
# ---------------------------------------------------------------------------
def llm(prompt: str, max_tokens: int = 900, temperature: float = 0.4) -> str:
    """Direct OpenAI-compatible call with THINKING SUPPRESSED.

    gemma-4-12b on LM Studio defaults to hidden reasoning and will burn the
    ENTIRE token budget on reasoning_content, returning empty content with
    finish_reason=length (measured: 1097/1100 tokens as reasoning). Same
    lesson as benny/core/models.py section 2b: send BOTH the /no_think soft
    directive and chat_template_kwargs.enable_thinking=false. If a response
    still comes back with empty content but non-empty reasoning, salvage the
    reasoning text rather than silently returning nothing.
    """
    import httpx

    base_url = os.environ.get("BENNY_LMSTUDIO_ENDPOINTS", "").split(",")[0].rstrip("/")
    if not base_url:
        raise SystemExit("BENNY_LMSTUDIO_ENDPOINTS is required for v3 (section writing)")
    model = os.environ.get("BENNY_DEFAULT_MODEL", "lmstudio/google/gemma-4-12b").split("/", 1)[-1]
    # Verified live 2026-07-17: reasoning_effort "none" → finish=stop, full
    # content, 0 reasoning tokens. "low", /no_think and chat_template_kwargs
    # are all ignored by this LM Studio build — the model otherwise consumes
    # the ENTIRE budget thinking, whatever the cap is.
    r = httpx.post(base_url + "/chat/completions",
                   json={"model": model,
                         "messages": [{"role": "user", "content": prompt}],
                         "max_tokens": max_tokens, "temperature": temperature,
                         "reasoning_effort": "none"},
                   timeout=420)
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    content = (msg.get("content") or "").strip()
    if not content:
        content = (msg.get("reasoning_content") or "").strip()  # salvage, never silent-empty
    return content


# ---------------------------------------------------------------------------
# Robustness model (ICONIX): Boundary / Control / Entity — deterministic.
# ---------------------------------------------------------------------------
BOUNDARY_PAT = re.compile(r"/(api|routes?|pages?|app|frontend|ui|cli|mcp|tray|agentamp|commands)/|benny_cli", re.I)
ENTITY_PAT = re.compile(r"(persistence|store|schema|models?\.py|record|chromadb|graph_db|db|dataset|manifest)", re.I)

OBJECT_MAP_PATH = RUNTIME / "manifests" / "templates" / "togaf_object_map.json"


def load_object_map() -> dict:
    try:
        return json.loads(OBJECT_MAP_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"tiers": {}, "category_overrides": {}, "data_sinks": []}


def _tier_of(f: str, n: str, omap: dict) -> str:
    hay = (f + " " + n).lower()
    for tier, spec in (omap.get("tiers") or {}).items():
        if any(p.lower() in hay for p in spec.get("patterns", [])):
            return tier
    return "services"


def _sink_of(f: str, n: str, omap: dict) -> str | None:
    hay = (f + " " + n).lower()
    for s in omap.get("data_sinks", []):
        probe_words = s["name"].lower().split()[:1] + [s["id"].split("-")[-1].lower()]
        if any(w in hay for w in probe_words):
            return s["id"]
    return None


def build_robustness() -> dict:
    """Map-first, heuristics-fallback classification with drift detection.

    The governed map (togaf_object_map.json) is the curated truth: overrides
    win outright; tier comes from map patterns. Heuristics classify the rest
    and every disagreement/new-object is REPORTED as drift, never silently
    absorbed — the maintenance/alignment answer to a hand-kept map.
    """
    base._emit("Executing task: robustness_model (map-first ICONIX + n-tier classification)")
    omap = load_object_map()
    overrides = omap.get("category_overrides", {})
    rows = base._cypher(
        "MATCH (e:CodeEntity) WHERE e.workspace = $workspace AND e.type IN ['Class','File'] "
        "OPTIONAL MATCH (e)-[r:CODE_REL]-() "
        "WITH e, count(r) AS degree ORDER BY degree DESC LIMIT 90 "
        "RETURN e.name AS name, e.type AS type, e.file_path AS file, degree")
    cat = {"boundary": [], "control": [], "entity": []}
    drift = {"disagreements": [], "unmapped_high_degree": [], "vanished_overrides": []}
    seen_names = set()
    for r in rows:
        f = str(r.get("file") or "")
        n = str(r.get("name") or "?")
        seen_names.add(n)
        # heuristic verdict (always computed — drift needs it)
        if BOUNDARY_PAT.search(f) or BOUNDARY_PAT.search(n):
            heur = "boundary"
        elif ENTITY_PAT.search(f) or ENTITY_PAT.search(n):
            heur = "entity"
        else:
            heur = "control"
        ov = overrides.get(n)
        if ov:
            k = ov.get("category", heur)
            r["tier"] = ov.get("tier") or _tier_of(f, n, omap)
            r["source"] = "map"
            if ov.get("sink"):
                r["sink"] = ov["sink"]
            if k != heur:
                drift["disagreements"].append({"object": n, "map": k, "heuristic": heur})
        else:
            k = heur
            r["tier"] = _tier_of(f, n, omap)
            r["source"] = "heuristic"
            if r.get("degree", 0) >= 40:
                drift["unmapped_high_degree"].append({"object": n, "degree": r["degree"],
                                                      "proposed": {"category": k, "tier": r["tier"]}})
        if k == "entity" and not r.get("sink"):
            r["sink"] = _sink_of(f, n, omap)
        cat[k].append(r)
    for name in overrides:
        if name not in seen_names:
            drift["vanished_overrides"].append(name)
    ids = {}
    for k, prefix in (("boundary", "B"), ("control", "C"), ("entity", "E")):
        for i, r in enumerate(cat[k], 1):
            r["id"] = f"{prefix}-{i:02d}"
            ids[r["name"]] = r["id"]
    # Cross-category DEPENDS_ON edges for the diagram (capped).
    edges = base._cypher(
        "MATCH (a:CodeEntity)-[r:CODE_REL {type:'DEPENDS_ON'}]->(b:CodeEntity) "
        "WHERE a.workspace = $workspace AND a.name IN $names AND b.name IN $names "
        "RETURN a.name AS src, b.name AS dst, count(*) AS n ORDER BY n DESC LIMIT 40",
        names=list(ids.keys()))
    return {"catalog": cat, "ids": ids, "edges": edges, "drift": drift, "omap": omap}


def sinks_section(rob: dict) -> str:
    """Data sinks & structure templates — mechanics per store + live probes."""
    base._emit("Executing task: data_sinks (structure templates + live store probes)")
    bh = Path(os.environ.get("BENNY_HOME", ""))
    ws = bh / "workspaces" / base.ARGS.workspace
    out = ["### Data sinks & structure templates (governed map + live probes)\n"]
    for s in rob["omap"].get("data_sinks", []):
        probe = ""
        try:
            if s["probe"] == "label_counts":
                lc = base._cypher("MATCH (n) WHERE n.workspace = $workspace RETURN labels(n)[0] AS l, count(n) AS n ORDER BY n DESC LIMIT 5")
                probe = "; ".join(f"{r['l']}={r['n']}" for r in lc)
            elif s["probe"] == "chroma_size":
                probe = f"{base._dir_size_mb(ws / 'chromadb')} MB on disk"
            elif s["probe"] == "workspace_files":
                probe = f"data_out={base._dir_size_mb(ws / 'data_out')} MB; longview={base._dir_size_mb(ws / 'longview')} MB"
            elif s["probe"] == "manifest_counts":
                md_ = RUNTIME / "workspace" / "manifests"
                probe = f"{len(list(md_.glob('*.json')))} manifests; {len(list((md_ / 'runs').glob('*.json')))} run records"
            elif s["probe"] == "ledger_stats":
                g = RUNTIME / "workspace" / "governance.log"
                probe = f"{round(g.stat().st_size / 1e6, 1)} MB; {sum(1 for _ in g.open(encoding='utf-8', errors='replace'))} events"
            elif s["probe"] == "log_sizes":
                probe = f"benny-home logs = {base._dir_size_mb(bh / 'logs')} MB"
        except Exception as e:
            probe = f"probe failed: {str(e)[:60]}"
        ents = [r["id"] for r in rob["catalog"]["entity"] if r.get("sink") == s["id"]]
        out.append(f"\n#### {s['id']} — {s['name']}\n")
        out.append(f"- **Structure template**: {s['structure_template']}\n")
        out.append(f"- **Mechanics**: {s['mechanics']}\n")
        out.append(f"- **Live probe**: {probe}\n")
        out.append(f"- **Catalog entities backed by this sink**: {', '.join(ents) or '(none mapped yet — see drift report)'}\n")
    return "".join(out)


def drift_section(rob: dict) -> str:
    d = rob["drift"]
    out = ["### Object-map drift report (governed map vs observed graph)\n",
           f"\nMap: `{OBJECT_MAP_PATH.name}` v{rob['omap'].get('version', '?')} — "
           "update it deliberately; this report is the alignment mechanism.\n"]
    if d["disagreements"]:
        out.append("\n**Map vs heuristic disagreements** (map wins; review if surprising):\n\n| object | map says | heuristic says |\n|---|---|---|\n")
        out += [f"| {x['object']} | {x['map']} | {x['heuristic']} |\n" for x in d["disagreements"]]
    if d["unmapped_high_degree"]:
        out.append("\n**High-degree objects not yet in the map** (proposed additions):\n\n| object | degree | proposed |\n|---|---|---|\n")
        out += [f"| {x['object']} | {x['degree']} | {x['proposed']['category']}/{x['proposed']['tier']} |\n" for x in d["unmapped_high_degree"][:15]]
    if d["vanished_overrides"]:
        out.append(f"\n**Overrides whose objects vanished from the graph**: {', '.join(d['vanished_overrides'])}\n")
    if not any(d.values()):
        out.append("\nNo drift detected — map and graph are aligned.\n")
    return "".join(out)


def robustness_diagram(rob: dict) -> str:
    def node(r, shape):
        nid = re.sub(r"[^a-zA-Z0-9_]", "_", r["id"] + "_" + r["name"])[:40]
        label = f'{r["id"]} {r["name"][:22]}'
        return nid, shape.format(id=nid, label=label)
    lines, nid_of = [], {}
    for k, shape, klass in (("boundary", '{id}(["{label}"])', "b"),
                            ("control", '{id}(("{label}"))', "c"),
                            ("entity", '{id}[("{label}")]', "e")):
        lines.append(f"  subgraph {k.upper()}")
        for r in rob["catalog"][k][:14]:
            nid, decl = node(r, shape)
            nid_of[r["name"]] = nid
            lines.append("    " + decl + f":::{klass}")
        lines.append("  end")
    for e in rob["edges"]:
        a, b = nid_of.get(e["src"]), nid_of.get(e["dst"])
        if a and b and a != b:
            lines.append(f"  {a} --> {b}")
    lines += ["  classDef b fill:#dbeafe,stroke:#2563eb", "  classDef c fill:#dcfce7,stroke:#16a34a",
              "  classDef e fill:#fef3c7,stroke:#d97706"]
    return ("### Robustness model (ICONIX) — boundaries, controls, entities from the code graph\n\n"
            "```mermaid\nflowchart LR\n" + "\n".join(lines) + "\n```\n")


def robustness_indexes(rob: dict) -> str:
    out = ["### Robustness catalogs — every object classified, each with its own index\n"]
    for k, title in (("boundary", "Boundary objects (interfaces)"), ("control", "Control objects (services)"),
                     ("entity", "Entity objects (data)")):
        out.append(f"\n#### {title} — {len(rob['catalog'][k])} objects\n")
        out.append("| id | object | kind | tier | sink | src | file | degree |\n|---|---|---|---|---|---|---|---|")
        for r in rob["catalog"][k]:
            out.append(f"| {r['id']} | {r['name'][:30]} | {r['type']} | {r.get('tier','?')} | {r.get('sink') or '—'} "
                       f"| {r.get('source','?')[:4]} | {str(r.get('file') or '')[-44:]} | {r['degree']} |")
    # n-tier rollup: the same catalog looped by tier, as the SAD's structural spine
    out.append("\n#### N-tier decomposition (same objects, tier loop)\n")
    out.append("| tier | boundaries | controls | entities |\n|---|---|---|---|")
    for tier in ("presentation", "services", "data"):
        row = []
        for k in ("boundary", "control", "entity"):
            ids_ = [r["id"] for r in rob["catalog"][k] if r.get("tier") == tier]
            row.append(", ".join(ids_[:10]) + (f" +{len(ids_)-10}" if len(ids_) > 10 else "") or "—")
        out.append(f"| {tier} | {row[0]} | {row[1]} | {row[2]} |")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Evidence bundles per chapter (compact, citable)
# ---------------------------------------------------------------------------
def evidence_bundle(kind: str, ev: dict, rob: dict) -> tuple[str, list[str]]:
    """Return (compact JSON-ish evidence text, reference labels)."""
    refs, chunks = [], []
    def add(label, obj, cap=1400):
        refs.append(label)
        chunks.append(f"[{label}] " + json.dumps(obj, default=str)[:cap])
    if kind in ("graph_summary", "graph_schema"):
        add("EV-GRAPH: Neo4j label counts", ev["schema"].get("label_counts"))
        add("EV-RELS: relationship pairs w/ counts", ev["schema"].get("rel_pairs"))
    if kind == "concepts_top":
        add("EV-CONCEPTS: knowledge-graph census", ev["schema"].get("label_counts"))
    if kind in ("robustness_all", "robustness_entities"):
        which = ["boundary", "control", "entity"] if kind == "robustness_all" else ["entity"]
        for k in which:
            add(f"EV-ROB-{k.upper()}: catalog", [{x["id"]: x["name"]} for x in rob["catalog"][k][:20]])
    if kind == "code_top":
        add("EV-CLASSES: top classes by methods", ev["code"].get("top_classes"))
        add("EV-DEPS-AREAS: dependency pairs", ev["code"].get("dependency_pairs"))
    if kind == "correlates":
        add("EV-CORR: correlation strategy census", ev["code"].get("correlates"))
    if kind == "hardware":
        add("EV-HW: probed host", ev["hw"]["host"])
        add("EV-LAN: inference host probe", ev["hw"]["lan_inference_host"])
    if kind == "bench" and ev["hw"].get("bench"):
        add("EV-BENCH: measured rigs", ev["hw"]["bench"]["results"])
    if kind == "deps":
        add("EV-DEPS: dependency harvest", ev["deps"])
    if kind == "models":
        add("EV-MODELS: models tested (run records)", ev["models"]["swarm_models"])
    if kind == "lifecycle":
        add("EV-AER: real run lifecycle", ev["seq"])
    if kind == "lineage_stats":
        add("EV-LEDGER: OpenLineage source", {"governance_log": "runtime/workspace/governance.log",
                                              "dashboard": "http://127.0.0.1:8788/lineage.html"})
    if kind == "stores":
        add("EV-STORES: measured store sizes", "see data model physical section")
    if kind == "delta":
        add("EV-DELTA: build-over-build", "see delta chapter (evidence history)")
    return "\n".join(chunks), refs


# ---------------------------------------------------------------------------
# Recursive planning + writing
# ---------------------------------------------------------------------------
def plan_chapter_index(ch: dict, ev: dict, rob: dict) -> list[dict]:
    base._emit(f"Executing task: plan_index [{ch['id']}] (recursive sub-chapter planning)")
    ev_text, _ = evidence_bundle(ch["evidence"][0], ev, rob)
    prompt = (
        "You are the index planner for a TOGAF System Architecture Document chapter.\n"
        f"Chapter: {ch['title']}\n"
        f"TOGAF-PRESCRIBED artifacts that MUST each get a sub-section (the floor): {json.dumps(ch['prescribed'])}\n"
        f"Required analysis frameworks for this chapter: {json.dumps(ch['frameworks'])}\n"
        f"Evidence available: {ev_text[:900]}\n\n"
        "Return STRICT JSON only: a list of sub-sections, each "
        '{"title": str, "goal": one-sentence writing goal, "frameworks": subset of the required frameworks '
        "applied in that sub-section (each required framework must appear in exactly one sub-section)}. "
        "Include every prescribed artifact; you may add at most 2 extra sub-sections the evidence justifies. "
        "6-9 sub-sections total. JSON list only, no prose."
    )
    fallback = [{"title": p.title(), "goal": f"Document {p} for this estate.", "frameworks": []} for p in ch["prescribed"]]
    for fw in ch["frameworks"]:
        fallback[0].setdefault("frameworks", []).append(fw)
    try:
        raw = llm(prompt, max_tokens=700, temperature=0.2)
        m = re.search(r"\[.*\]", raw, re.S)
        plan = json.loads(m.group(0)) if m else None
        if not isinstance(plan, list) or not plan:
            return fallback
        # Enforce the floor: every prescribed artifact must be covered.
        covered = " ".join(s.get("title", "").lower() for s in plan)
        for p in ch["prescribed"]:
            probe = p.split("(")[0].strip().lower().split()[0]
            if probe not in covered:
                plan.append({"title": p.title(), "goal": f"Document {p}.", "frameworks": []})
        return plan[:9]
    except Exception as e:
        base._emit(f"planner fallback for {ch['id']}: {str(e)[:80]}")
        return fallback


def write_leaf(ch: dict, leaf: dict, ev: dict, rob: dict, word_floor: int) -> tuple[str, dict]:
    ev_texts, all_refs = [], []
    for kind in ch["evidence"]:
        t, refs = evidence_bundle(kind, ev, rob)
        ev_texts.append(t)
        all_refs += refs
    fw_req = "".join(f"\n- Include {FRAMEWORK_SPECS[f]}." for f in leaf.get("frameworks", []) if f in FRAMEWORK_SPECS)
    prompt = (
        f"Write the sub-section '{leaf['title']}' of the TOGAF SAD chapter '{ch['title']}' "
        f"for the binary16/prime-silo application estate.\n"
        f"Goal: {leaf['goal']}\n"
        f"EVIDENCE (cite labels inline like [EV-GRAPH]):\n" + "\n".join(ev_texts)[:3800] + "\n\n"
        f"Rules:\n- {word_floor}-450 words of substantive prose (tables count).\n"
        f"- Ground every claim in the evidence; cite [EV-*] labels inline; if evidence is missing say 'unverified'.{fw_req}\n"
        f"- End with a 'References:' line listing the [EV-*] labels used.\n"
        f"- Markdown; start directly with content, no chapter heading, no preamble."
    )
    txt = llm(prompt, max_tokens=1100)
    words = len(txt.split())
    cites = len(re.findall(r"\[EV-[A-Z-]+\]", txt))
    has_refs = "references:" in txt.lower()
    gate = {"section": f"{ch['id']}/{leaf['title'][:40]}", "words": words, "cites": cites,
            "refs_block": has_refs, "ok": words >= word_floor and cites >= 1 and has_refs}
    if not gate["ok"]:  # one retry with the failure named
        txt2 = llm(prompt + f"\n\nPREVIOUS ATTEMPT FAILED THE GATE (words={words}, citations={cites}, "
                   f"references_block={has_refs}). Fix exactly those problems.", max_tokens=1100)
        w2, c2 = len(txt2.split()), len(re.findall(r"\[EV-[A-Z-]+\]", txt2))
        if (w2 >= word_floor and c2 >= 1 and "references:" in txt2.lower()) or w2 > words:
            txt, gate = txt2, {**gate, "words": w2, "cites": c2,
                               "refs_block": "references:" in txt2.lower(),
                               "ok": w2 >= word_floor and c2 >= 1 and "references:" in txt2.lower(),
                               "retried": True}
    return txt, gate


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="TOGAF EPIC v3 — recursive, reference-grounded SAD")
    ap.add_argument("--workspace", default="sessions_v1")
    ap.add_argument("--out", default=None)
    ap.add_argument("--word-floor", dest="word_floor", type=int, default=220)
    ap.add_argument("--max-leaves", dest="max_leaves", type=int, default=0, help="Bound total written sections (0 = all)")
    ap.add_argument("--resume", action="store_true", help="Reuse already-written sections from the state file")
    ap.add_argument("--no-pdf", dest="pdf", action="store_false", default=True)
    args = ap.parse_args()

    bh = Path(os.environ.get("BENNY_HOME", ""))
    if not bh.exists():
        print("ERROR: BENNY_HOME not set", file=sys.stderr)
        return 2
    out = Path(args.out) if args.out else bh / "workspaces" / args.workspace / "data_out" / "TOGAF_EPIC_V3_SAD_binary16.md"
    state_path = out.parent / "togaf_epic_v3_state.json"

    # Shim base module globals so its evidence/diagram functions work for us.
    class _A: pass
    base.ARGS = _A(); base.ARGS.workspace = args.workspace; base.ARGS.word_floor = args.word_floor
    base.RUN_ID = RUN_ID
    base._emit(f"TOGAF EPIC v3 build starting (workspace={args.workspace}, recursive index planning)")

    hw = base.probe_hardware()
    # bench reuse from evidence history (same rule as v2)
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
    rob = build_robustness()
    D = base.diagrams(hw, ev["models"], ev["deps"], ev["schema"], ev["code"], ev["seq"])
    D["robustness"] = robustness_diagram(rob)
    # drift is evidence too — persist it so map updates are deliberate diffs
    ev_dir = out.parent / "togaf_epic_evidence"
    ev_dir.mkdir(parents=True, exist_ok=True)
    (ev_dir / "object_map_drift.json").write_text(json.dumps(rob["drift"], indent=1), encoding="utf-8")

    state = json.loads(state_path.read_text(encoding="utf-8")) if (args.resume and state_path.exists()) else {"sections": {}}
    gates, bibliography = [], set()
    written = 0
    chapters_md = []
    DIAGRAM_FOR = {"business": ["usecase", "bpmn"], "data": ["er", "data_conceptual", "data_logical", "data_physical"],
                   "application": ["robustness", "class", "c4_container", "sequence"],
                   "technology": ["deployment", "c4_context"], "observability": [], "gap": [], "scope": []}
    for ch in TOGAF_SKELETON:
        plan_key = f"plan::{ch['id']}"
        if plan_key in state["sections"]:
            plan = state["sections"][plan_key]
        else:
            plan = plan_chapter_index(ch, ev, rob)
            state["sections"][plan_key] = plan
            state_path.write_text(json.dumps(state, indent=1), encoding="utf-8")
        parts = [f"## {ch['title']}\n",
                 f"*Chapter index (planned): {', '.join(s['title'] for s in plan)}*\n"]
        for dk in DIAGRAM_FOR.get(ch["id"], []):
            if dk in D:
                parts.append(D[dk])
        if ch["id"] == "application":
            parts.append(robustness_indexes(rob))
        if ch["id"] == "data":
            parts.append(sinks_section(rob))
        if ch["id"] == "gap":
            parts.append(drift_section(rob))
        for leaf in plan:
            key = f"{ch['id']}::{leaf['title']}"
            if key in state["sections"]:
                txt, gate = state["sections"][key]["txt"], state["sections"][key]["gate"]
            elif args.max_leaves and written >= args.max_leaves:
                txt, gate = "*(deferred — bounded build; resume with --resume to complete)*", \
                            {"section": key[:60], "words": 0, "cites": 0, "refs_block": False, "ok": False, "deferred": True}
            else:
                base._emit(f"Executing task: write [{ch['id']}/{leaf['title'][:45]}]")
                txt, gate = write_leaf(ch, leaf, ev, rob, args.word_floor)
                state["sections"][key] = {"txt": txt, "gate": gate}
                state_path.write_text(json.dumps(state, indent=1), encoding="utf-8")
                written += 1
            gates.append(gate)
            bibliography.update(re.findall(r"\[EV-[A-Z-]+\]", txt))
            parts.append(f"### {leaf['title']}\n\n{txt}\n")
        chapters_md.append("\n".join(parts))

    base._emit("Executing task: assemble_v3 (chapters + robustness + gates + bibliography)")
    now = _dt.datetime.now().isoformat()
    real = [g for g in gates if not g.get("deferred")]
    doc = "\n".join([
        "# TOGAF Enterprise SAD — binary16 estate (EPIC v3, recursive index-planned)\n",
        f"*Generated {now} · run `{RUN_ID}` · every section planned from a TOGAF-prescribed skeleton, "
        f"written against a citable evidence bundle, and gated (word floor + citations + references).*\n",
        "\n".join(chapters_md),
        "\n## Quality gates (per written section)\n",
        "| section | words | citations | refs block | status |", "|---|---|---|---|---|",
        "\n".join(f"| {g['section']} | {g['words']} | {g['cites']} | {'y' if g['refs_block'] else 'n'} | "
                  f"{'deferred' if g.get('deferred') else ('OK' + (' (retried)' if g.get('retried') else '') if g['ok'] else 'BELOW GATE')} |"
                  for g in gates),
        "\n## Bibliography — evidence labels used\n",
        "\n".join(f"- {b} — see evidence pack `togaf_epic_evidence/`" for b in sorted(bibliography)),
        "\n## Appendix — reproducibility\n",
        f"- CLI: `python scripts/togaf_epic_v3.py --workspace {args.workspace}` (state: `{state_path.name}`, resumable)\n"
        f"- Contract: `manifests/templates/togaf_epic_v3_recursive.json`\n",
    ])
    out.write_text(doc, encoding="utf-8")
    census = {"words": len(doc.split()), "mermaid_diagrams": doc.count("```mermaid"),
              "chapters": len(TOGAF_SKELETON), "sections_written": written,
              "sections_total": sum(1 for g in gates), "gates_failed": sum(1 for g in real if not g["ok"]),
              "bibliography": len(bibliography), "output": str(out)}
    if args.pdf:
        base._emit("Executing task: pdf (realized diagrams + SVG gate)")
        pdf_path = str(out).replace(".md", ".pdf")
        r = subprocess.run(["node", str(RUNTIME / "scripts" / "togaf_epic_pdf.mjs"), str(out), pdf_path],
                           capture_output=True, text=True, timeout=300)
        try:
            census["pdf"] = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:
            census["pdf"] = {"ok": False, "error": (r.stderr or r.stdout)[-200:]}
        if not census["pdf"].get("ok"):
            base._emit(f"PDF GATE FAILED: {json.dumps(census['pdf'])[:150]}", status="failed")
            print(json.dumps(census, indent=1))
            return 1
    base._emit(f"DONE v3: {census['words']} words | {census['sections_written']} sections written | "
               f"{census['gates_failed']} gate failures | {census['bibliography']} evidence refs", status="completed")
    time.sleep(2)
    print(json.dumps(census, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
