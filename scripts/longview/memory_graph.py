"""
memory_graph.py — teleport per-session knowledge-graph nodes + vector chunks
between Benny workspaces (the graph/vector half of lineage-based memory
quarantine; the Node CLI ``memory.mjs`` moves the card files and calls this).

Semantics
---------
Graph (Neo4j, see ``benny/graph/triples.py`` + ``benny/core/graph_db.py``):
  * ``Source`` nodes are matched by ``{workspace, name}`` and moved by
    rewriting ``workspace`` — SOURCED_FROM / RELATES_TO edges are left intact
    (they ARE the lineage; workspace-filtered queries never traverse across
    workspaces, and restore stays a trivial inverse).
  * A ``Concept`` is EXCLUSIVE when every Source it is SOURCED_FROM is either
    in the moved set or already resides in the destination workspace — those
    move too. A concept with at least one remaining source in the origin
    workspace is SHARED and stays put (counted in ``shared_concepts_kept``).

Vectors (ChromaDB, see ``benny/tools/knowledge.py``):
  * Chunks are located by their metadata source-document key (detected at
    runtime; the ingest path writes ``source``), copied — id, document,
    original embedding, metadata — into the destination workspace's
    ``knowledge`` collection (opened via ``get_knowledge_collection`` so the
    embedding-function convention matches exactly; nothing is re-embedded),
    then deleted from the origin. Batches of ≤200 with retry, because the
    Benny API server holds the same chroma dir open (sqlite lock).

Idempotent: re-running a move for already-moved names matches nothing and
honestly reports zeros. ``--dry-run`` computes every count and writes NOTHING.

Usage
-----
    python scripts/longview/memory_graph.py \
        --workspace sessions_v1 --target sessions_v1_private \
        --sources-file names.json --action move [--dry-run] --json

Prints progress to stderr; the LAST stdout line is always a single JSON
object: {"ok", "sources_moved", "concepts_moved", "shared_concepts_kept",
"chunks_moved", "dry_run", "errors": [...]}.
"""

import argparse
import json
import sys
import time
from pathlib import Path

# Resolve the benny package from the dev tree regardless of cwd: this script
# lives at <repo>/scripts/longview/, the package at <repo>/runtime/benny/.
_RUNTIME_DIR = Path(__file__).resolve().parents[2] / "runtime"
try:
    import benny  # noqa: F401
except ImportError:
    sys.path.insert(0, str(_RUNTIME_DIR))

from benny.core.graph_db import read_session, write_session  # noqa: E402
from benny.core.workspace import get_workspace_path  # noqa: E402
from benny.tools.knowledge import get_chromadb_client, get_knowledge_collection  # noqa: E402

BATCH_SIZE = 200
LOCK_RETRIES = 3
LOCK_SLEEP_S = 2.0

# Candidate metadata keys that may reference the ingested file name; the
# actual key is confirmed against live records before filtering.
SOURCE_KEY_CANDIDATES = ("source", "source_file", "doc", "document", "filename", "file")


def log(msg: str) -> None:
    """Progress lines go to stderr only — stdout is reserved for the JSON."""
    print(f"[memory_graph] {msg}", file=sys.stderr, flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# Neo4j — Source + exclusive-Concept teleport
# ─────────────────────────────────────────────────────────────────────────────


def classify_graph(src_ws: str, dst_ws: str, names: list) -> dict:
    """Read-only pass: which Sources match, and which touched Concepts are
    exclusive (move) vs shared (keep). Returns honest counts + the exact
    node name lists the write pass will use."""
    with read_session() as session:
        rec = session.run(
            "MATCH (s:Source {workspace: $ws}) WHERE s.name IN $names "
            "RETURN collect(s.name) AS matched",
            ws=src_ws,
            names=names,
        ).single()
        matched_sources = rec["matched"] if rec else []

        # Concepts touching the moved set. Exclusive = every SOURCED_FROM
        # Source is in the moved set OR already lives in the destination
        # (handles incremental moves); anything else keeps it shared.
        result = session.run(
            """
            MATCH (c:Concept {workspace: $ws})-[:SOURCED_FROM]->(s:Source)
            WHERE s.name IN $names AND s.workspace IN [$ws, $dst]
            WITH DISTINCT c
            WITH c, NOT EXISTS {
                MATCH (c)-[:SOURCED_FROM]->(o:Source)
                WHERE NOT o.name IN $names AND o.workspace <> $dst
            } AS exclusive
            RETURN c.name AS name, exclusive
            """,
            ws=src_ws,
            dst=dst_ws,
            names=names,
        )
        exclusive_concepts, shared_kept = [], 0
        for r in result:
            if r["exclusive"]:
                exclusive_concepts.append(r["name"])
            else:
                shared_kept += 1

    return {
        "matched_sources": matched_sources,
        "exclusive_concepts": exclusive_concepts,
        "shared_concepts_kept": shared_kept,
    }


def move_graph_nodes(src_ws: str, dst_ws: str, plan: dict, errors: list) -> dict:
    """Write pass: rewrite ``workspace`` on the planned Source + exclusive
    Concept nodes. Counts come from what Neo4j actually SET, never the plan."""
    sources_moved = concepts_moved = 0
    try:
        with write_session() as session:
            if plan["matched_sources"]:
                rec = session.run(
                    "MATCH (s:Source {workspace: $ws}) WHERE s.name IN $names "
                    "SET s.workspace = $dst RETURN count(s) AS n",
                    ws=src_ws,
                    dst=dst_ws,
                    names=plan["matched_sources"],
                ).single()
                sources_moved = rec["n"] if rec else 0
            if plan["exclusive_concepts"]:
                rec = session.run(
                    "MATCH (c:Concept {workspace: $ws}) WHERE c.name IN $names "
                    "SET c.workspace = $dst RETURN count(c) AS n",
                    ws=src_ws,
                    dst=dst_ws,
                    names=plan["exclusive_concepts"],
                ).single()
                concepts_moved = rec["n"] if rec else 0
    except Exception as e:  # honest partial reporting, never a crash
        errors.append(f"neo4j write failed: {e}")
    return {"sources_moved": sources_moved, "concepts_moved": concepts_moved}


# ─────────────────────────────────────────────────────────────────────────────
# ChromaDB — chunk teleport (embeddings preserved, never re-embedded)
# ─────────────────────────────────────────────────────────────────────────────


def detect_source_key(collection, names: list) -> str:
    """Inspect live metadata to find which key references the ingested file
    name. Ingest writes ``source`` (see benny/tools/knowledge.py usage), but
    confirm against records rather than trusting convention."""
    try:
        sample = collection.get(limit=20, include=["metadatas"])
        name_set = set(names)
        for meta in sample.get("metadatas") or []:
            if not meta:
                continue
            for key in SOURCE_KEY_CANDIDATES:
                if meta.get(key) in name_set:
                    return key
        # No sampled record matches a moved name; fall back to the first
        # candidate key that exists at all in the sampled metadata.
        for meta in sample.get("metadatas") or []:
            for key in SOURCE_KEY_CANDIDATES:
                if key in (meta or {}):
                    return key
    except Exception:
        pass
    return "source"


def fetch_matching_chunks(collection, key: str, names: list, errors: list) -> dict:
    """Return {ids, documents, embeddings, metadatas} for chunks whose
    metadata ``key`` is one of ``names``. Where-filter first; client-side
    scan as fallback for chroma versions without ``$in``."""
    include = ["embeddings", "documents", "metadatas"]
    try:
        got = collection.get(where={key: {"$in": names}}, include=include)
    except Exception as e:
        log(f"where-filter unsupported ({e}); falling back to client-side scan")
        try:
            all_meta = collection.get(include=["metadatas"])
            ids = [
                i
                for i, m in zip(all_meta["ids"], all_meta["metadatas"])
                if (m or {}).get(key) in set(names)
            ]
            if not ids:
                return {"ids": [], "documents": [], "embeddings": [], "metadatas": []}
            got = collection.get(ids=ids, include=include)
        except Exception as e2:
            errors.append(f"chroma fetch failed: {e2}")
            return {"ids": [], "documents": [], "embeddings": [], "metadatas": []}

    embeddings = got.get("embeddings")
    # Numpy → plain lists so add() round-trips the original vectors verbatim.
    if embeddings is not None and len(embeddings) > 0:
        embeddings = [[float(x) for x in vec] for vec in embeddings]
    else:
        embeddings = []
    return {
        "ids": got.get("ids") or [],
        "documents": got.get("documents") or [],
        "embeddings": embeddings,
        "metadatas": got.get("metadatas") or [],
    }


def _retry(op, what: str, errors: list) -> bool:
    """Run ``op`` with the sqlite-lock retry policy. Returns success."""
    for attempt in range(1, LOCK_RETRIES + 1):
        try:
            op()
            return True
        except Exception as e:
            if attempt == LOCK_RETRIES:
                errors.append(f"{what} failed after {LOCK_RETRIES} attempts: {e}")
                return False
            log(f"{what} attempt {attempt} failed ({e}); retrying in {LOCK_SLEEP_S}s")
            time.sleep(LOCK_SLEEP_S)
    return False


def move_chunks(src_collection, dst_collection, chunks: dict, errors: list) -> int:
    """Copy matched chunks into the destination collection then delete them
    from the origin, in batches of ≤200. Returns chunks actually moved
    (added + deleted); a batch that fails all retries is not counted."""
    moved = 0
    ids = chunks["ids"]
    for start in range(0, len(ids), BATCH_SIZE):
        end = min(start + BATCH_SIZE, len(ids))
        batch_ids = ids[start:end]
        batch_docs = chunks["documents"][start:end]
        batch_embs = chunks["embeddings"][start:end]
        batch_meta = chunks["metadatas"][start:end]

        added = _retry(
            lambda: dst_collection.add(
                ids=batch_ids,
                documents=batch_docs,
                embeddings=batch_embs,
                metadatas=batch_meta,
            ),
            f"chroma add batch {start}-{end}",
            errors,
        )
        if not added:
            continue  # leave originals in place — nothing lost, honest count
        deleted = _retry(
            lambda: src_collection.delete(ids=batch_ids),
            f"chroma delete batch {start}-{end}",
            errors,
        )
        if deleted:
            moved += len(batch_ids)
        log(f"chunks {start}-{end}: added={added} deleted={deleted}")
    return moved


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Teleport per-session Source/Concept nodes + vector chunks between workspaces."
    )
    parser.add_argument("--workspace", required=True, help="Public workspace (e.g. sessions_v1)")
    parser.add_argument("--target", required=True, help="Quarantine workspace")
    parser.add_argument(
        "--sources-file", required=True, help="JSON array of Source document names"
    )
    parser.add_argument("--action", required=True, choices=("move", "restore"))
    parser.add_argument("--dry-run", action="store_true", help="Count only; write nothing")
    parser.add_argument("--json", action="store_true", help="Accepted for contract parity")
    args = parser.parse_args()

    errors: list = []
    result = {
        "ok": False,
        "sources_moved": 0,
        "concepts_moved": 0,
        "shared_concepts_kept": 0,
        "chunks_moved": 0,
        "dry_run": bool(args.dry_run),
        "errors": errors,
    }

    try:
        names = json.loads(Path(args.sources_file).read_text(encoding="utf-8"))
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise ValueError("sources-file must be a JSON array of strings")
    except Exception as e:
        errors.append(f"could not read sources-file: {e}")
        print(json.dumps(result))
        return 1

    # move: workspace → target; restore: the exact inverse for the same names.
    if args.action == "move":
        src_ws, dst_ws = args.workspace, args.target
    else:
        src_ws, dst_ws = args.target, args.workspace
    log(f"action={args.action} {src_ws} -> {dst_ws} names={len(names)} dry_run={args.dry_run}")

    # ── graph ────────────────────────────────────────────────────────────
    try:
        plan = classify_graph(src_ws, dst_ws, names)
        result["shared_concepts_kept"] = plan["shared_concepts_kept"]
        log(
            f"graph plan: sources={len(plan['matched_sources'])} "
            f"exclusive_concepts={len(plan['exclusive_concepts'])} "
            f"shared_kept={plan['shared_concepts_kept']}"
        )
        if args.dry_run:
            result["sources_moved"] = len(plan["matched_sources"])
            result["concepts_moved"] = len(plan["exclusive_concepts"])
        else:
            moved = move_graph_nodes(src_ws, dst_ws, plan, errors)
            result.update(moved)
    except Exception as e:
        errors.append(f"neo4j classification failed: {e}")

    # ── vectors ──────────────────────────────────────────────────────────
    # get_chromadb_client mkdirs + PersistentClient creates chroma.sqlite3,
    # so opening a workspace that has no chromadb yet is a WRITE. A missing
    # source dir means honestly zero chunks — never materialise it (and in
    # dry-run, never materialise the destination either).
    try:
        if not get_workspace_path(src_ws, "chromadb").exists():
            log(f"no chromadb dir for workspace '{src_ws}': 0 chunks")
            raise StopIteration  # skip the vector phase cleanly
        src_collection = get_knowledge_collection(get_chromadb_client(src_ws))
        key = detect_source_key(src_collection, names)
        log(f"chroma source metadata key: '{key}'")
        chunks = fetch_matching_chunks(src_collection, key, names, errors)
        log(f"chroma matched chunks: {len(chunks['ids'])}")
        if args.dry_run:
            result["chunks_moved"] = len(chunks["ids"])
        elif chunks["ids"]:
            dst_collection = get_knowledge_collection(get_chromadb_client(dst_ws))
            result["chunks_moved"] = move_chunks(src_collection, dst_collection, chunks, errors)
    except StopIteration:
        pass  # missing source chromadb — already logged, chunks stay 0
    except Exception as e:
        errors.append(f"chroma move failed: {e}")

    result["ok"] = not errors
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
