"""
PageIndex builder — turn document text into the indexed-abstract tree (PIX-F7/F8).

This is the *impure* layer that sits on top of the pure spine
(`benny/core/pageindex.py`). It does I/O and (optionally) one LLM call per node
for summaries, always through `call_model()` (ADR-001 rule 1).

Two build paths:

  * `build_tree_from_markdown` — DETERMINISTIC, no LLM. Headings (#, ##, ###)
    are the tree. This is the primary path for structured markdown (e.g. the
    `prime_silo_self` docs) and makes the whole pipeline runnable offline.
  * `build_tree_from_text` — generic deterministic fallback for unstructured
    text: fixed-size sections. Used when there are no headings.

Summaries default to a deterministic first-sentence extraction; `enrich_summaries`
upgrades them via `call_model()` when a provider is available.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import List, Optional

from .pageindex import TreeNode, iter_nodes, validate_tree
from .workspace import get_workspace_path

logger = logging.getLogger(__name__)

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_MAX_SECTION_CHARS = 4000  # generic-splitter section size; mirrors ingest chunking


def _first_sentence(text: str, limit: int = 160) -> str:
    """Deterministic summary fallback: first sentence, clamped."""
    clean = " ".join((text or "").split())
    if not clean:
        return ""
    m = re.search(r"(.+?[.!?])(\s|$)", clean)
    candidate = m.group(1) if m else clean
    return candidate[:limit].rstrip()


def build_tree_from_markdown(text: str, title: str = "document") -> TreeNode:
    """Build a deterministic tree from markdown heading structure.

    A heading that has both its own prose *and* sub-headings gets a synthetic
    "(overview)" leaf so no body text is lost — `flatten_leaves` only returns
    childless nodes, and we never want to drop content.
    """
    lines = text.splitlines()
    root: TreeNode = {
        "node_id": "0",
        "title": title,
        "summary": "",
        "page_range": None,
        "text": "",
        "children": [],
    }
    # Stack of (heading_level, node). Root sits at sentinel level 0.
    stack: List[tuple] = [(0, root)]
    preamble: List[str] = []  # text before the first heading → attaches to root

    def attach_text(node: TreeNode, buf: List[str]) -> None:
        body = "\n".join(buf).strip()
        if body:
            node["text"] = (node.get("text", "") + "\n" + body).strip()

    buf: List[str] = []
    for line in lines:
        m = _HEADING_RE.match(line)
        if not m:
            buf.append(line)
            continue
        # Flush buffered body to the current node before opening a new heading.
        level = len(m.group(1))
        heading = m.group(2).strip()
        current_node = stack[-1][1]
        if current_node is root and not root["children"]:
            preamble.extend(buf)
        else:
            attach_text(current_node, buf)
        buf = []
        # Pop to the parent of this heading level.
        while stack and stack[-1][0] >= level:
            stack.pop()
        if not stack:
            stack = [(0, root)]
        parent = stack[-1][1]
        child: TreeNode = {
            "node_id": f"{parent['node_id']}.{len(parent['children'])}",
            "title": heading,
            "summary": "",
            "page_range": None,
            "text": "",
            "children": [],
        }
        parent["children"].append(child)
        stack.append((level, child))

    # Flush the trailing buffer.
    last_node = stack[-1][1]
    if last_node is root and not root["children"]:
        preamble.extend(buf)
    else:
        attach_text(last_node, buf)
    attach_text(root, preamble)

    # If no headings at all, the root holds everything → make it a single leaf.
    if not root["children"]:
        root["summary"] = _first_sentence(root.get("text", ""))
        return root

    # Promote branch prose into synthetic "(overview)" leaves so nothing is lost.
    for node in list(iter_nodes(root)):
        if node["children"] and (node.get("text") or "").strip():
            overview: TreeNode = {
                "node_id": f"{node['node_id']}.{len(node['children'])}",
                "title": f"{node['title']} (overview)",
                "summary": "",
                "page_range": None,
                "text": node["text"],
                "children": [],
            }
            node["text"] = ""
            node["children"].insert(0, overview)

    _fill_summaries_deterministic(root)
    return root


def build_tree_from_text(text: str, title: str = "document") -> TreeNode:
    """Generic deterministic fallback: split unstructured text into fixed-size
    sections under a single root. No LLM.
    """
    blocks = [b.strip() for b in text.split("\n\n") if b.strip()] or ([text.strip()] if text.strip() else [])
    sections: List[str] = []
    for b in blocks:
        if len(b) > _MAX_SECTION_CHARS:
            for i in range(0, len(b), _MAX_SECTION_CHARS):
                sections.append(b[i : i + _MAX_SECTION_CHARS])
        else:
            sections.append(b)
    root: TreeNode = {
        "node_id": "0",
        "title": title,
        "summary": _first_sentence(text),
        "page_range": None,
        "text": "",
        "children": [
            {
                "node_id": f"0.{i}",
                "title": f"{title} — part {i + 1}",
                "summary": _first_sentence(sec),
                "page_range": None,
                "text": sec,
                "children": [],
            }
            for i, sec in enumerate(sections)
        ],
    }
    return root


def _fill_summaries_deterministic(tree: TreeNode) -> None:
    for node in iter_nodes(tree):
        if not node.get("summary"):
            node["summary"] = _first_sentence(node.get("text", "")) or node.get("title", "")


async def enrich_summaries(tree: TreeNode, model: Optional[str], workspace: str = "default") -> TreeNode:
    """Upgrade leaf summaries with one `call_model()` call each, falling back to
    the deterministic summary on any failure (offline-safe).
    """
    from .pageindex import flatten_leaves
    from .models import call_model

    for leaf in flatten_leaves(tree):
        body = (leaf.get("text") or "").strip()
        if not body:
            continue
        try:
            resp = await call_model(
                model=model,
                messages=[
                    {"role": "system", "content": "Summarise the section in ONE sentence. Output only the sentence."},
                    {"role": "user", "content": body[:2000]},
                ],
                temperature=0.0,
                max_tokens=80,
            )
            summary = " ".join((resp or "").split())
            if summary:
                leaf["summary"] = summary[:200]
        except Exception as e:  # offline / provider down → keep deterministic summary
            logger.debug("Summary enrichment skipped for %s: %s", leaf.get("node_id"), e)
    return tree


def _has_headings(text: str) -> bool:
    """True if any line is a markdown ATX heading (per-line, since _HEADING_RE
    anchors to the start of a single line, not the whole document)."""
    return any(_HEADING_RE.match(line) for line in (text or "").splitlines())


def build_document_tree(text: str, source: str) -> TreeNode:
    """Pick the right deterministic builder by content shape."""
    title = Path(source).stem or source
    if _has_headings(text):
        return build_tree_from_markdown(text, title=title)
    return build_tree_from_text(text, title=title)


# --------------------------------------------------------------------------- #
# Persistence (PIX-F8 / PIX-SEC2)
# --------------------------------------------------------------------------- #

def _pageindex_dir(workspace: str) -> Path:
    base = get_workspace_path(workspace) / ".benny" / "pageindex"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _safe_tree_path(workspace: str, source: str) -> Path:
    """Resolve <workspace>/.benny/pageindex/<source>.json, rejecting traversal."""
    base = _pageindex_dir(workspace).resolve()
    safe_name = Path(source).name  # strip any directory components
    target = (base / f"{safe_name}.json").resolve()
    if base not in target.parents:
        raise ValueError(f"pageindex path escapes workspace: {source!r}")
    return target


def persist_tree(workspace: str, source: str, tree: TreeNode) -> Path:
    problems = validate_tree(tree)
    if problems:
        raise ValueError(f"refusing to persist invalid tree: {problems}")
    path = _safe_tree_path(workspace, source)
    path.write_text(json.dumps(tree, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def load_tree(workspace: str, source: str) -> Optional[TreeNode]:
    path = _safe_tree_path(workspace, source)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_trees(workspace: str) -> List[str]:
    base = _pageindex_dir(workspace)
    return sorted(p.stem for p in base.glob("*.json"))
