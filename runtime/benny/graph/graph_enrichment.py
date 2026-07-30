"""
Graph enrichment — turn per-document concept islands into a connected, typed,
categorised knowledge graph so cross-session patterns become visible.

Motivation (LONGVIEW): concept extraction (``benny.graph.triples.save_knowledge_triples``)
only ever writes ``RELATES_TO`` between a triple's subject and object — always
within one document — and bridges documents solely by exact concept-name MERGE.
The result is ~97% single-document concepts and zero cross-document edges. This
module adds the missing connective tissue:

  Stage 1  persist concept embeddings (reused by later stages + RAG)
  Stage 2  canonical merge — collapse near-duplicate concepts, so a concept
           recurring across sessions gains multi-document SOURCED_FROM bridges;
           records ``merge_count`` (drives node size in the graph view)
  Stage 3  cross-document similarity edges (the Concept↔Concept web)
  Stage 4  promote free-text predicates to a typed ``rel_class``
  Stage 5  run the existing (unused) code↔docs correlation suite
  Stage 6  re-cluster (LPA) and derive a ``category`` from the community, so the
           view colours by theme

Every stage is idempotent (MERGE-guarded / delete-once) and honours ``dry_run``,
which reports the counts it *would* write without touching the graph.

Runs as a one-off backfill (``benny enrich-graph``) and is wired into the ingest
path for forward runs.
"""

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

from ..core.graph_db import read_session, write_session

logger = logging.getLogger(__name__)


# ── live progress (observability) ────────────────────────────────────────────
# The enrich run used to be a silent black box (one buffered subprocess, no
# output until done). This reporter writes <workspace>/longview/
# enrich_progress.json on every stage transition + throttled in-stage ticks so
# dashboards can show todo/running/done with per-stage detail. Strictly
# best-effort: any IO failure is swallowed — observability must never break
# the run itself.

STAGE_LABELS = {
    "embeddings": "persist concept embeddings",
    "merge": "canonical-merge near-duplicate concepts",
    "similarity": "cross-document similarity links",
    "rel_class": "type free-text predicates",
    "correlation": "code↔docs correlation",
    "recluster": "re-cluster + name themes (LLM)",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EnrichProgress:
    def __init__(self, workspace: str, stages: List[str], dry_run: bool):
        self.path = None
        try:
            from ..core.workspace import get_workspace_path

            d = get_workspace_path(workspace, "longview")
            d.mkdir(parents=True, exist_ok=True)
            self.path = d / "enrich_progress.json"
        except Exception:
            pass
        self.state: Dict[str, Any] = {
            "workspace": workspace,
            "dry_run": dry_run,
            "started_at": _now_iso(),
            "updated_at": _now_iso(),
            "done": False,
            "ok": None,
            "stages": [
                {
                    "id": s,
                    "label": STAGE_LABELS.get(s, s),
                    "status": "todo",
                    "started_at": None,
                    "seconds": None,
                    "done_items": None,
                    "total_items": None,
                    "note": None,
                    "result": None,
                    "error": None,
                }
                for s in stages
            ],
        }
        self._t0: Dict[str, float] = {}
        self._last_write = 0.0
        self._write(force=True)

    def _stage(self, sid: str) -> Optional[Dict[str, Any]]:
        return next((s for s in self.state["stages"] if s["id"] == sid), None)

    def _write(self, force: bool = False) -> None:
        if self.path is None:
            return
        now = time.monotonic()
        if not force and now - self._last_write < 0.5:
            return
        self._last_write = now
        self.state["updated_at"] = _now_iso()
        try:
            self.path.write_text(json.dumps(self.state, default=str), encoding="utf-8")
        except Exception:
            pass

    def start(self, sid: str, total: Optional[int] = None, note: Optional[str] = None) -> None:
        st = self._stage(sid)
        if not st:
            return
        st.update(status="running", started_at=_now_iso(), total_items=total, note=note)
        self._t0[sid] = time.monotonic()
        self._write(force=True)

    def tick(
        self, sid: str, done: int, total: Optional[int] = None, note: Optional[str] = None
    ) -> None:
        st = self._stage(sid)
        if not st:
            return
        st["done_items"] = done
        if total is not None:
            st["total_items"] = total
        if note is not None:
            st["note"] = note
        st["seconds"] = round(time.monotonic() - self._t0.get(sid, time.monotonic()), 1)
        self._write()

    def finish(self, sid: str, result: Any) -> None:
        st = self._stage(sid)
        if not st:
            return
        st.update(status="done", result=result)
        st["seconds"] = round(time.monotonic() - self._t0.get(sid, time.monotonic()), 1)
        self._write(force=True)

    def fail(self, sid: str, err: str) -> None:
        st = self._stage(sid)
        if not st:
            return
        st.update(status="failed", error=str(err)[:500])
        st["seconds"] = round(time.monotonic() - self._t0.get(sid, time.monotonic()), 1)
        self._write(force=True)

    def complete(self, ok: bool) -> None:
        self.state["done"] = True
        self.state["ok"] = ok
        self._write(force=True)


# Module-level handle so stage functions can tick without signature churn.
_PROGRESS: Optional[EnrichProgress] = None


def _tick(sid: str, done: int, total: Optional[int] = None, note: Optional[str] = None) -> None:
    if _PROGRESS is not None:
        _PROGRESS.tick(sid, done, total, note)

# Cosine thresholds. Merge is deliberately stricter than linking: merging deletes
# a node, linking only adds an edge.
MERGE_COSINE = 0.90
MERGE_NAME_JACCARD = 0.5
SIMILARITY_COSINE = 0.82
SIMILARITY_TOP_K = 16
EMBED_DIM = 768
# Community naming (stage 6): only name the biggest clusters — colours must stay
# legible and each name is one LLM call.
MIN_NAMED_COMMUNITY = 4
MAX_NAMED_COMMUNITIES = 60

# Free-text predicate → controlled relation class. Matched as case-insensitive
# substrings against r.predicate; first hit wins, default "relates".
REL_CLASS_RULES: List[Tuple[str, str]] = [
    ("prerequisite", "prerequisite"),
    ("requires", "prerequisite"),
    ("depends", "prerequisite"),
    ("enables", "prerequisite"),
    ("leads to", "prerequisite"),
    ("conflict", "conflict"),
    ("contradict", "conflict"),
    ("versus", "conflict"),
    ("differs", "conflict"),
    ("analog", "analogy"),
    ("similar", "similarity"),
    ("like ", "analogy"),
    ("example of", "analogy"),
    ("part of", "composition"),
    ("contains", "composition"),
    ("includes", "composition"),
]

_WORD_RE = re.compile(r"[a-z0-9]+")


def _normalize_name(name: Optional[str]) -> str:
    return " ".join(_WORD_RE.findall((name or "").lower()))


def _token_set(name: Optional[str]) -> Set[str]:
    return set(_WORD_RE.findall((name or "").lower()))


def _jaccard(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def classify_predicate(predicate: Optional[str]) -> str:
    """Map a free-text predicate to a controlled rel_class."""
    p = (predicate or "").lower()
    for needle, cls in REL_CLASS_RULES:
        if needle in p:
            return cls
    return "relates"


# ── data loading ────────────────────────────────────────────────────────────

def _fetch_doc_concepts(workspace: str) -> List[Dict[str, Any]]:
    """Document concepts only — those SOURCED_FROM a Source. Excludes the
    code-structure :Concept nodes (which hang off CodeEntity via REPRESENTS)."""
    query = """
    MATCH (c:Concept {workspace: $ws})
    WHERE SIZE([(c)-[:SOURCED_FROM]->(:Source) | 1]) > 0
    RETURN id(c) AS id, c.name AS name,
           [(c)-[:SOURCED_FROM]->(s:Source) | id(s)] AS sources,
           c.embedding AS embedding
    """
    with read_session() as session:
        return [dict(r) for r in session.run(query, ws=workspace)]


def _normed_matrix(vectors: List[Optional[List[float]]]) -> np.ndarray:
    mat = np.array(
        [v if (v is not None and len(v) == EMBED_DIM) else [0.0] * EMBED_DIM for v in vectors],
        dtype=np.float32,
    )
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


# ── Stage 1: embeddings ──────────────────────────────────────────────────────

async def stage_embeddings(
    workspace: str, concepts: List[Dict[str, Any]], dry_run: bool
) -> Dict[str, Any]:
    """Compute + persist concept embeddings. Returns the normalised matrix aligned
    to ``concepts`` order (reused by later stages)."""
    from ..synthesis.engine import batch_embed_concepts

    names = [c["name"] for c in concepts]

    # Progress ticks during the embed fan-out — this is the ~45-min long pole,
    # and without per-item ticks the stall watchdog can't tell healthy from wedged.
    async def _on_embed(ev) -> None:
        d = getattr(ev, "data", None) or {}
        if d.get("current"):
            _tick("embeddings", d["current"], d.get("total"), note="embedding concepts")

    kv = await batch_embed_concepts(
        names, provider="local", workspace=workspace, event_callback=_on_embed
    )
    vectors = [kv.get(n) for n in names]
    normed = _normed_matrix(vectors)

    written = 0
    if not dry_run:
        batch = [
            {"id": c["id"], "emb": [float(x) for x in vectors[i]]}
            for i, c in enumerate(concepts)
            # any(): zero vectors are embed FAILURES (batch_embed_concepts's
            # fallback) — persisting them poisons the cache for every later run.
            if vectors[i] is not None and len(vectors[i]) == EMBED_DIM and any(vectors[i])
        ]
        write_query = """
        UNWIND $batch AS row
        MATCH (c) WHERE id(c) = row.id
        SET c.embedding = row.emb
        """
        with write_session() as session:
            for i in range(0, len(batch), 500):
                session.run(write_query, batch=batch[i : i + 500])
                _tick("embeddings", min(i + 500, len(batch)), len(batch), note="persisting vectors")
        written = len(batch)

    # keep the freshly-computed vectors on the concept dicts for reuse
    for i, c in enumerate(concepts):
        c["_vec"] = normed[i]
    return {"embedded": written or len(concepts), "dim": EMBED_DIM}


# ── Stage 2: canonical merge ─────────────────────────────────────────────────

def _union_find_groups(pairs: List[Tuple[int, int]], n: int) -> Dict[int, List[int]]:
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    groups: Dict[int, List[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return {root: members for root, members in groups.items() if len(members) > 1}


async def stage_merge(
    workspace: str, concepts: List[Dict[str, Any]], dry_run: bool
) -> Dict[str, Any]:
    """Collapse near-duplicate concepts (cosine ≥ MERGE_COSINE AND normalized-name
    Jaccard ≥ MERGE_NAME_JACCARD) into one canonical node, repointing SOURCED_FROM
    and RELATES_TO. Records merge_count / aliases / doc_count."""
    n = len(concepts)
    if n < 2:
        return {"groups": 0, "merged_away": 0, "candidates": []}

    mat = np.vstack([c["_vec"] for c in concepts])
    sims = mat @ mat.T
    tokens = [_token_set(c["name"]) for c in concepts]

    pairs: List[Tuple[int, int]] = []
    for i in range(n):
        # only look at the upper triangle
        js = np.where(sims[i, i + 1 :] >= MERGE_COSINE)[0]
        for offset in js:
            j = i + 1 + int(offset)
            if _jaccard(tokens[i], tokens[j]) >= MERGE_NAME_JACCARD:
                pairs.append((i, j))
        if i % 500 == 0:
            _tick("merge", i, n, note=f"scanning candidates ({len(pairs)} pairs)")

    groups = _union_find_groups(pairs, n)

    # Canonical = the member with the most sources (best-connected); tie → shortest name.
    plan: List[Dict[str, Any]] = []
    for members in groups.values():
        members_sorted = sorted(
            members,
            key=lambda idx: (-len(concepts[idx]["sources"]), len(concepts[idx]["name"])),
        )
        canonical = members_sorted[0]
        variants = members_sorted[1:]
        plan.append({"canonical": canonical, "variants": variants})

    sample = [
        {
            "canonical": concepts[p["canonical"]]["name"],
            "variants": [concepts[v]["name"] for v in p["variants"]][:5],
        }
        for p in plan[:15]
    ]
    merged_away = sum(len(p["variants"]) for p in plan)

    if dry_run:
        return {"groups": len(plan), "merged_away": merged_away, "candidates": sample}

    merge_query = """
    MATCH (c) WHERE id(c) = $cid
    MATCH (v) WHERE id(v) = $vid
    // repoint SOURCED_FROM
    WITH c, v
    CALL {
      WITH c, v
      MATCH (v)-[:SOURCED_FROM]->(s:Source) MERGE (c)-[:SOURCED_FROM]->(s)
    }
    // repoint outgoing RELATES_TO
    CALL {
      WITH c, v
      MATCH (v)-[r:RELATES_TO]->(o) WHERE id(o) <> id(c)
      MERGE (c)-[nr:RELATES_TO {predicate: r.predicate}]->(o)
      ON CREATE SET nr += properties(r)
    }
    // repoint incoming RELATES_TO
    CALL {
      WITH c, v
      MATCH (o)-[r:RELATES_TO]->(v) WHERE id(o) <> id(c)
      MERGE (o)-[nr:RELATES_TO {predicate: r.predicate}]->(c)
      ON CREATE SET nr += properties(r)
    }
    SET c.merge_count = coalesce(c.merge_count, 1) + 1,
        c.aliases = coalesce(c.aliases, []) + [v.name]
    WITH c, v
    DETACH DELETE v
    """
    with write_session() as session:
        for gi, p in enumerate(plan):
            cid = concepts[p["canonical"]]["id"]
            for v in p["variants"]:
                session.run(merge_query, cid=cid, vid=concepts[v]["id"])
            _tick(
                "merge",
                gi + 1,
                len(plan),
                note=f"merging into '{concepts[p['canonical']]['name'][:60]}'",
            )
        # recompute doc_count for canonicals we touched
        canon_ids = [concepts[p["canonical"]]["id"] for p in plan]
        session.run(
            """
            UNWIND $ids AS cid
            MATCH (c) WHERE id(c) = cid
            SET c.doc_count = SIZE([(c)-[:SOURCED_FROM]->(:Source) | 1])
            """,
            ids=canon_ids,
        )

    return {"groups": len(plan), "merged_away": merged_away, "candidates": sample}


# ── Stage 3: cross-document similarity edges ─────────────────────────────────

async def stage_similarity_links(workspace: str, dry_run: bool) -> Dict[str, Any]:
    """Add RELATES_TO{predicate:'semantically_similar'} edges between concepts in
    DIFFERENT documents above SIMILARITY_COSINE (top-k per concept). Reads
    persisted embeddings so it reflects the post-merge node set."""
    concepts = _fetch_doc_concepts(workspace)
    have_emb = [c for c in concepts if c.get("embedding") and len(c["embedding"]) == EMBED_DIM]
    if len(have_emb) < 2:
        return {"links": 0, "note": "insufficient embeddings — run stage 1 first"}

    mat = _normed_matrix([c["embedding"] for c in have_emb])
    sims = mat @ mat.T
    src_sets = [set(c["sources"]) for c in have_emb]
    n = len(have_emb)
    k = min(SIMILARITY_TOP_K + 1, n)  # +1 because self is the top match

    batch: List[Dict[str, Any]] = []
    seen: Set[Tuple[int, int]] = set()
    for i in range(n):
        top = np.argpartition(-sims[i], kth=k - 1)[:k]
        for j in top:
            j = int(j)
            if j == i or sims[i, j] < SIMILARITY_COSINE:
                continue
            if src_sets[i] & src_sets[j]:
                continue  # same-document → not a bridge
            key = (i, j) if i < j else (j, i)
            if key in seen:
                continue
            seen.add(key)
            a, b = key
            batch.append(
                {"a": have_emb[a]["id"], "b": have_emb[b]["id"], "sim": float(sims[a, b])}
            )

    if dry_run:
        return {"links": len(batch)}

    write_query = """
    UNWIND $batch AS row
    MATCH (a) WHERE id(a) = row.a
    MATCH (b) WHERE id(b) = row.b
    MERGE (a)-[r:RELATES_TO {predicate: 'semantically_similar'}]->(b)
    ON CREATE SET r.strategy = 'similarity', r.rel_class = 'similarity',
                  r.confidence = row.sim, r.workspace = $ws, r.created_at = timestamp()
    ON MATCH SET  r.strategy = 'similarity', r.rel_class = 'similarity',
                  r.confidence = row.sim, r.updated_at = timestamp()
    """
    with write_session() as session:
        for i in range(0, len(batch), 500):
            session.run(write_query, batch=batch[i : i + 500], ws=workspace)
    return {"links": len(batch)}


# ── Stage 4: typed relation promotion ────────────────────────────────────────

async def stage_rel_class(workspace: str, dry_run: bool) -> Dict[str, Any]:
    """Set r.rel_class on every RELATES_TO from its predicate. Scope by endpoint
    workspace (the relationship's own r.workspace is null on older edges)."""
    fetch = """
    MATCH (a:Concept {workspace: $ws})-[r:RELATES_TO]->(b:Concept {workspace: $ws})
    RETURN id(r) AS id, r.predicate AS predicate
    """
    with read_session() as session:
        rels = [dict(r) for r in session.run(fetch, ws=workspace)]

    updates = [{"id": r["id"], "cls": classify_predicate(r["predicate"])} for r in rels]
    dist: Dict[str, int] = {}
    for u in updates:
        dist[u["cls"]] = dist.get(u["cls"], 0) + 1

    if dry_run:
        return {"classified": len(updates), "distribution": dist}

    write_query = """
    UNWIND $batch AS row
    MATCH ()-[r]->() WHERE id(r) = row.id
    SET r.rel_class = row.cls
    """
    with write_session() as session:
        for i in range(0, len(updates), 1000):
            session.run(write_query, batch=updates[i : i + 1000])
    return {"classified": len(updates), "distribution": dist}


# ── Stage 5: code↔docs correlation ───────────────────────────────────────────

async def stage_correlation(workspace: str, threshold: float, dry_run: bool) -> Dict[str, Any]:
    if dry_run:
        return {"note": "would run safe + aggressive correlation (Concept↔CodeEntity)"}
    from ..synthesis.correlation import run_full_correlation_suite

    return await run_full_correlation_suite(workspace, threshold=threshold)


# ── Stage 6: recluster + categorise ──────────────────────────────────────────

async def stage_recluster(workspace: str, dry_run: bool) -> Dict[str, Any]:
    """Label-propagation over the KNOWLEDGE subgraph only — document concepts +
    sources + RELATES_TO/SOURCED_FROM edges — then name communities and set
    `category` from the community name so the view colours by theme.

    Deliberately does NOT use ClusteringService.run_lpa_on_workspace, which
    clusters every node in the workspace: on a synthesized graph that pulls in the
    200k-node code graph and the LPA never finishes. Scoping to the ~2k knowledge
    nodes (now cross-linked by the similarity stage) makes it complete in seconds
    and keeps communities meaningful for the Documents view."""
    from collections import Counter

    fetch = """
    MATCH (n:Concept {workspace: $ws})
    WHERE SIZE([(n)-[:SOURCED_FROM]->(:Source) | 1]) > 0
    OPTIONAL MATCH (n)-[:RELATES_TO|SOURCED_FROM]-(m {workspace: $ws})
    WHERE m:Concept OR m:Source
    RETURN id(n) AS id, n.name AS name, collect(DISTINCT id(m)) AS nbrs
    """
    with read_session() as session:
        rows = [dict(r) for r in session.run(fetch, ws=workspace)]
    if not rows:
        return {"nodes": 0}

    names = {r["id"]: r["name"] for r in rows}
    adj = {r["id"]: [x for x in r["nbrs"] if x is not None] for r in rows}

    # Label propagation: each node adopts the most common community among its
    # neighbours until stable (or 6 iterations).
    comm = {nid: nid for nid in adj}
    for _ in range(6):
        changes = 0
        for nid, nbrs in adj.items():
            if not nbrs:
                continue
            labels = [comm[x] for x in nbrs if x in comm]
            if not labels:
                continue
            top = Counter(labels).most_common(1)[0][0]
            if comm[nid] != top:
                comm[nid] = top
                changes += 1
        if changes == 0:
            break

    groups: Dict[int, List[int]] = {}
    for nid, c in comm.items():
        groups.setdefault(c, []).append(nid)
    # Only name the substantial communities, largest first, capped — 600+ tiny
    # clusters aren't legible as colours and would be 600 LLM calls. The long tail
    # keeps the neutral default colour.
    namable = sorted(
        (m for m in groups.values() if len(m) >= MIN_NAMED_COMMUNITY),
        key=len,
        reverse=True,
    )[:MAX_NAMED_COMMUNITIES]

    if dry_run:
        return {
            "nodes": len(adj),
            "communities": len(groups),
            "namable": len(namable),
            "largest": [len(m) for m in namable[:8]],
        }

    with write_session() as session:
        session.run(
            "UNWIND $data AS d MATCH (n) WHERE id(n) = d.id SET n.community_id = d.c",
            data=[{"id": nid, "c": c} for nid, c in comm.items()],
        )

    # Name the substantial communities and set category = community name (theme).
    # Per-CALL deadline, not per-run: a wedged LLM host hangs each request
    # indefinitely (observed 2026-07-14: LM Studio answered /models but chat
    # completions never returned) — without this every name burns the full
    # transport timeout × retries and the whole stage looks frozen.
    import asyncio as _asyncio
    import os as _os

    from ..synthesis.engine import name_community

    name_timeout = float(_os.environ.get("BENNY_COMMUNITY_NAME_TIMEOUT_S", "120"))
    timeouts = 0
    labeled = 0
    for members in namable:
        member_names = [names[m] for m in members if names.get(m)][:50]
        try:
            info = await _asyncio.wait_for(
                name_community(member_names, workspace=workspace), timeout=name_timeout
            )
            cname = (info or {}).get("community_name") or f"Community {members[0]}"
            timeouts = 0  # consecutive counter — a success proves the host is alive
        except _asyncio.TimeoutError:
            timeouts += 1
            logger.warning("Community naming timed out after %ss (host wedged?)", name_timeout)
            cname = f"Community {members[0]}"
            if timeouts >= 3:
                # The host is not coming back mid-run — stop burning a deadline
                # per community, leave the rest for a recluster re-run.
                logger.error(
                    "3 naming timeouts in a row — LLM host looks wedged; "
                    "leaving remaining communities unnamed (re-run recluster later)"
                )
                _tick("recluster", labeled, len(namable), note="ABORTED naming: LLM host wedged")
                break
        except Exception as e:
            logger.warning("Community naming failed (non-fatal): %s", e)
            cname = f"Community {members[0]}"
        with write_session() as session:
            session.run(
                "UNWIND $ids AS nid MATCH (n) WHERE id(n) = nid "
                "SET n.community_name = $cn, n.category = $cn",
                ids=members,
                cn=cname,
            )
        labeled += 1
        _tick("recluster", labeled, len(namable), note=f"named '{cname[:60]}'")

    return {"nodes": len(adj), "communities": len(groups), "labeled": labeled}


# ── orchestrator ─────────────────────────────────────────────────────────────

DEFAULT_STAGES = ["embeddings", "merge", "similarity", "rel_class", "correlation", "recluster"]


async def enrich_graph(
    workspace: str,
    dry_run: bool = True,
    stages: Optional[List[str]] = None,
    correlation_threshold: float = 0.82,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the enrichment stages in order. Returns a per-stage report.

    ``model`` is informational here (the caller pins it via BENNY_DEFAULT_MODEL);
    only the recluster stage's community naming uses an LLM.
    """
    global _PROGRESS
    stages = stages or DEFAULT_STAGES
    report: Dict[str, Any] = {"workspace": workspace, "dry_run": dry_run, "stages": {}}
    if model:
        report["naming_model"] = model

    progress = EnrichProgress(workspace, stages, dry_run)
    _PROGRESS = progress

    async def _run_stage(sid: str, coro_factory, total: Optional[int] = None, note: Optional[str] = None):
        progress.start(sid, total=total, note=note)
        try:
            res = await coro_factory()
            report["stages"][sid] = res
            progress.finish(sid, res)
            logger.info("enrich stage %s done: %s", sid, res)
            return res
        except Exception as e:
            progress.fail(sid, str(e))
            logger.error("enrich stage %s FAILED: %s", sid, e)
            raise

    try:
        concepts: List[Dict[str, Any]] = []
        if "embeddings" in stages or "merge" in stages:
            concepts = _fetch_doc_concepts(workspace)
            report["doc_concepts"] = len(concepts)

        if "embeddings" in stages:
            await _run_stage(
                "embeddings",
                lambda: stage_embeddings(workspace, concepts, dry_run),
                total=len(concepts),
                note=f"embedding {len(concepts)} concepts",
            )
        if "merge" in stages:
            if concepts and "_vec" not in concepts[0]:
                # Prefer embeddings already persisted by a prior run so a merge-only
                # invocation doesn't re-embed thousands of concepts against the flaky
                # local embedder. Fall back to computing them only if none are stored.
                if all(
                    c.get("embedding") and len(c["embedding"]) == EMBED_DIM and any(c["embedding"])
                    for c in concepts
                ):
                    normed = _normed_matrix([c["embedding"] for c in concepts])
                    for i, c in enumerate(concepts):
                        c["_vec"] = normed[i]
                else:
                    await stage_embeddings(workspace, concepts, dry_run=True)
            await _run_stage(
                "merge",
                lambda: stage_merge(workspace, concepts, dry_run),
                total=len(concepts),
            )
        if "similarity" in stages:
            await _run_stage("similarity", lambda: stage_similarity_links(workspace, dry_run))
        if "rel_class" in stages:
            await _run_stage("rel_class", lambda: stage_rel_class(workspace, dry_run))
        if "correlation" in stages:
            await _run_stage(
                "correlation",
                lambda: stage_correlation(workspace, correlation_threshold, dry_run),
            )
        if "recluster" in stages:
            await _run_stage("recluster", lambda: stage_recluster(workspace, dry_run))
        progress.complete(ok=True)
    except Exception:
        progress.complete(ok=False)
        raise
    finally:
        _PROGRESS = None

    return report
