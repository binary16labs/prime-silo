#!/usr/bin/env python
"""Populate the CODE graph (CodeEntity + CODE_REL) for a workspace via the pure
Tree-sitter AST scan — the data the TOGAF EPIC ICONIX robustness section needs.

CPU-only (no embeddings/eGPU), so it is safe to run alongside an LLM build. It is
IDEMPOTENT: it deletes the workspace's existing CodeEntity first, so re-running
never accumulates duplicate symbols across snapshots (the poison the runbook warns
about). Scan scope is governed by the workspace-root .gitignore
(CodeGraphAnalyzer._load_ignore_patterns) — keep worktrees/vendor/runtime-bundle
excluded there.

  python scripts/code_graph_scan.py --workspace sessions_v1 --src src/prime-silo

Requires NEO4J_URI/USER/PASSWORD (defaults localhost:7687 neo4j/password) + BENNY_HOME.
"""
import argparse
import os
import sys
import uuid


def main() -> int:
    ap = argparse.ArgumentParser(description="Idempotent Tree-sitter code-graph scan -> Neo4j")
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--src", default="src/prime-silo", help="workspace-relative source root to scan")
    args = ap.parse_args()
    os.environ.setdefault("NEO4J_URI", "bolt://localhost:7687")
    os.environ.setdefault("NEO4J_USER", "neo4j")
    os.environ.setdefault("NEO4J_PASSWORD", "password")

    from benny.core.graph_db import run_cypher
    from benny.graph.code_analyzer import CodeGraphAnalyzer
    from benny.portable.home import resolve_benny_home  # portable home

    ws_path = os.path.join(str(resolve_benny_home()), "workspaces", args.workspace)
    if not os.path.isdir(ws_path):
        print(f"[code-scan] workspace path not found: {ws_path}", file=sys.stderr)
        return 2

    # Idempotent: drop the prior code graph for this workspace so robustness never
    # double-counts across snapshots.
    try:
        run_cypher("MATCH (e:CodeEntity {workspace:$ws}) DETACH DELETE e", workspace=args.workspace)
        print(f"[code-scan] cleared prior CodeEntity for {args.workspace}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[code-scan] WARN could not clear prior snapshot: {exc}", flush=True)

    print(f"[code-scan] scanning {ws_path}/{args.src} (Tree-sitter, CPU)...", flush=True)
    analyzer = CodeGraphAnalyzer(ws_path)
    analyzer.analyze_workspace(args.src, deep_scan=True)
    snap = str(uuid.uuid4())
    analyzer.save_to_neo4j(args.workspace, snap, name="code-graph-scan")

    counts = run_cypher(
        "MATCH (e:CodeEntity {workspace:$ws}) RETURN e.type AS type, count(*) AS n ORDER BY n DESC",
        workspace=args.workspace) or []
    print(f"[code-scan] DONE snapshot={snap}", flush=True)
    for r in counts:
        print(f"    {r.get('type')}: {r.get('n')}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
