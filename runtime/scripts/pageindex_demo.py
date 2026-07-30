#!/usr/bin/env python
"""
PageIndex vectorless-spine demo runner (PIX-001 / ADR-002).

Runs the full vectorless pipeline over a workspace's data_in and prints a report:
build the indexed-abstract tree per document → write the Section graph (Neo4j,
if up) → fan triple extraction over the tree's leaves (LLM, if a provider is up).

It imports ONLY the lightweight pageindex modules, so it runs even where the
full `benny` CLI can't bootstrap. Degrades gracefully: no Neo4j → graph skipped;
no LLM provider → triples skipped; both → you still get the trees + outlines.

Usage (from runtime/):
    set BENNY_HOME=...\\.benny_home           # Windows
    export BENNY_HOME=.../.benny_home         # bash
    python scripts/pageindex_demo.py --workspace prime_silo_self
    python scripts/pageindex_demo.py --workspace prime_silo_self --llm --outline
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

# Make `benny` importable when run from runtime/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    sys.stdout.reconfigure(encoding="utf-8")  # arrows/box-drawing on Windows
except Exception:
    pass


async def run(workspace: str, use_llm: bool, show_outline: bool, do_triples: bool, do_graph: bool) -> int:
    from benny.core import pageindex_builder as pb
    from benny.core.pageindex_pipeline import run_pageindex_ingest

    offline = os.environ.get("BENNY_OFFLINE") in ("1", "true", "True")
    if offline and do_triples:
        # Triple extraction needs a live model; offline it only slow-fails. Skip
        # it cleanly so the offline demo proves the spine (trees + graph) fast.
        print("BENNY_OFFLINE set — skipping triple fan-out (needs a live model).\n")
        do_triples = False

    data_in = pb.get_workspace_path(workspace, "data_in")
    if not data_in.exists():
        print(f"no data_in for workspace {workspace!r}: {data_in}", file=sys.stderr)
        return 1

    supported = {".txt", ".md", ".pdf", ".docx", ".pptx", ".html"}
    files = sorted(f for f in data_in.glob("*.*") if f.suffix.lower() in supported)
    if not files:
        print(f"no supported files in {data_in}", file=sys.stderr)
        return 1

    print(f"workspace={workspace}  data_in={data_in}")
    print(f"files={[f.name for f in files]}  llm_summaries={use_llm}\n")

    totals = {"sections": 0, "triples": 0}
    text_formats = {".md", ".txt", ".html"}
    for fp in files:
        if fp.suffix.lower() in text_formats:
            # Plain text/markdown: read directly (avoids the heavy docling import).
            text = fp.read_text(encoding="utf-8", errors="ignore")
        else:
            # Binary formats (PDF/DOCX/PPTX): structured extraction.
            from benny.core.extraction import extract_structured_text
            text = extract_structured_text(fp)

        report = await run_pageindex_ingest(
            workspace=workspace,
            source=fp.name,
            text=text,
            use_llm_summaries=use_llm,
            write_graph=do_graph,
            extract_triples=do_triples,
        )
        g = report["graph"]
        graph = "WRITTEN" if g.get("written") else f"skipped({str(g.get('reason', 'n/a'))[:30]})"
        totals["sections"] += report["sections"]
        totals["triples"] += report["triples"]
        print(
            f"[{fp.name:<16}] sections={report['sections']:<4} "
            f"triples={report['triples']:<4} graph={graph}  json={os.path.basename(report['tree_json'])}"
        )
        if show_outline:
            print("\n" + report["outline"] + "\n")

    print(
        f"\nTOTAL  documents={len(files)}  sections={totals['sections']}  triples={totals['triples']}"
    )
    print(
        "Section trees persisted under "
        f"{pb.get_workspace_path(workspace) / '.benny' / 'pageindex'}"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="PageIndex vectorless-spine demo")
    ap.add_argument("--workspace", default="prime_silo_self")
    ap.add_argument("--llm", action="store_true", help="Enrich summaries via call_model (needs a provider)")
    ap.add_argument("--outline", action="store_true", help="Print each document's indexed abstract")
    ap.add_argument("--no-triples", dest="triples", action="store_false", help="Skip triple fan-out")
    ap.add_argument("--no-graph", dest="graph", action="store_false", help="Skip the Neo4j Section graph write")
    args = ap.parse_args()
    return asyncio.run(run(args.workspace, args.llm, args.outline, args.triples, args.graph))


if __name__ == "__main__":
    raise SystemExit(main())
