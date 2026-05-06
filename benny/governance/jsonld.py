"""AOS-001 Phase 8 — JSON-LD provenance emission per artifact.

Public API
----------
  emit_provenance(artifact_sha, *, workspace_path, run_id, task_id,
                  persona, model, started_at, ended_at,
                  inputs_shas=None, outputs_shas=None,
                  prompt_hash=None, reasoning_hash=None,
                  adr_refs=None, policy_decision=None, cde_refs=None,
                  benny_home=None) -> Path
      Writes a JSON-LD sidecar at
      ``<workspace>/data_out/lineage/<artifact_sha>.jsonld`` using the
      PROV-O envelope defined in §4.4 of requirement.md.

      The ``@context`` is a compact prefix map embedded inline by default.
      When *benny_home* is provided the context value is replaced by a
      ``file://`` URI pointing to the vendored PROV-O file under
      ``<benny_home>/vendor/prov-o/prov-o.jsonld`` (OQ-3).

  check_no_orphans(*, workspace_path) -> list[dict]
      Scans every ``.jsonld`` file in
      ``<workspace>/data_out/lineage/`` and returns a list of orphan
      descriptors — artifact:// URIs in ``prov:used`` or
      ``prov:generated`` whose corresponding file does not exist in the
      artifact store (``<workspace>/artifacts/``).  Returns ``[]`` when
      the lineage graph is complete (AOS-COMP3).

AOS requirements covered
------------------------
  F23    emit_provenance(): .jsonld sidecar per artifact SHA.
  COMP2  cde_refs / policy_decision / prompt_hash in the envelope.
  COMP3  check_no_orphans(): no orphan prov:used / prov:generated edges.
  NFR11  stdlib-only (json, pathlib) → ≤ 5 ms p95 overhead.
  OQ-3   Vendored PROV-O context rewritten to file:// URI when possible.

Dependencies: stdlib only (json, pathlib).  No network calls.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Inline PROV-O compact context (offline-safe default)
# ---------------------------------------------------------------------------

_INLINE_CONTEXT: dict[str, Any] = {
    "prov":   "http://www.w3.org/ns/prov#",
    "xsd":    "http://www.w3.org/2001/XMLSchema#",
    "rdfs":   "http://www.w3.org/2000/01/rdf-schema#",
    "benny":  "https://benny.io/ontology/",
    "prov:Activity":          {"@id": "prov:Activity"},
    "prov:Entity":            {"@id": "prov:Entity"},
    "prov:used":              {"@id": "prov:used",              "@type": "@id"},
    "prov:generated":         {"@id": "prov:generated",         "@type": "@id"},
    "prov:wasAssociatedWith": {"@id": "prov:wasAssociatedWith", "@type": "@id"},
    "prov:startedAtTime":     {"@id": "prov:startedAtTime",     "@type": "xsd:dateTime"},
    "prov:endedAtTime":       {"@id": "prov:endedAtTime",       "@type": "xsd:dateTime"},
    "benny:prompt_hash":      {"@id": "benny:prompt_hash"},
    "benny:reasoning_hash":   {"@id": "benny:reasoning_hash"},
    "benny:adr_refs":         {"@id": "benny:adr_refs",         "@container": "@list"},
    "benny:policy_decision":  {"@id": "benny:policy_decision"},
    "benny:cde_refs":         {"@id": "benny:cde_refs",         "@container": "@list"},
    "benny:model":            {"@id": "benny:model"},
    "benny:model_hash":       {"@id": "benny:model_hash"},
}

_VENDOR_RELATIVE = "vendor/prov-o/prov-o.jsonld"

_ARTIFACT_PREFIX = "artifact://"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _lineage_dir(workspace_path: Path) -> Path:
    d = workspace_path / "data_out" / "lineage"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _artifact_path(sha: str, workspace_path: Path) -> Path:
    """Return the canonical path for *sha* in the artifact store."""
    return workspace_path / "artifacts" / sha[:2] / sha[2:]


def _artifact_exists(sha: str, workspace_path: Path) -> bool:
    return _artifact_path(sha, workspace_path).exists()


def _sha_from_uri(uri: str) -> Optional[str]:
    """Extract the SHA-256 hex string from an artifact:// URI, or None."""
    if isinstance(uri, str) and uri.startswith(_ARTIFACT_PREFIX):
        return uri[len(_ARTIFACT_PREFIX):]
    return None


# ---------------------------------------------------------------------------
# Public API — emit_provenance
# ---------------------------------------------------------------------------


def emit_provenance(
    artifact_sha: str,
    *,
    workspace_path: Path,
    run_id: str,
    task_id: str,
    persona: str,
    model: str,
    started_at: str,
    ended_at: str,
    inputs_shas: Optional[list[str]] = None,
    outputs_shas: Optional[list[str]] = None,
    prompt_hash: Optional[str] = None,
    reasoning_hash: Optional[str] = None,
    adr_refs: Optional[list[str]] = None,
    policy_decision: Optional[str] = None,
    cde_refs: Optional[list[str]] = None,
    benny_home: Optional[Path] = None,
) -> Path:
    """Write a JSON-LD provenance sidecar for *artifact_sha* (AOS-F23).

    Parameters
    ----------
    artifact_sha:
        SHA-256 hex string of the artifact being annotated.  Used as
        the filename (``{sha}.jsonld``) and in ``prov:generated`` if
        *outputs_shas* is not provided.
    workspace_path:
        Root path of the target workspace.
    run_id:
        AOS run identifier, e.g. ``"run-abc123"``.
    task_id:
        Task identifier within the run, e.g. ``"task_0_vision"``.
    persona:
        Agent persona name, e.g. ``"architect"``.
    model:
        LLM model identifier, e.g. ``"lemonade/qwen3-coder-30b"``.
    started_at:
        ISO-8601 timestamp when the task started.
    ended_at:
        ISO-8601 timestamp when the task ended.
    inputs_shas:
        List of SHA-256 hex strings for input artifacts (``prov:used``).
    outputs_shas:
        List of SHA-256 hex strings for output artifacts
        (``prov:generated``).  Defaults to ``[artifact_sha]``.
    prompt_hash:
        Optional SHA-256 hash of the prompt used (SOX chain).
    reasoning_hash:
        Optional SHA-256 hash of the reasoning trace.
    adr_refs:
        Optional list of ADR identifiers, e.g. ``["ADR-001", "ADR-002"]``.
    policy_decision:
        Optional policy gate result, e.g. ``"approved"`` or ``"denied"``.
    cde_refs:
        Optional list of CDE column names, e.g.
        ``["trade.notional", "trade.counterparty_id"]`` (AOS-COMP2).
    benny_home:
        Optional path to ``$BENNY_HOME``.  When provided, the
        ``@context`` is rewritten to a ``file://`` URI pointing at the
        vendored PROV-O file (OQ-3).

    Returns
    -------
    Path
        Absolute path to the written ``.jsonld`` file.
    """
    # Resolve @context
    if benny_home is not None:
        vendor_path = Path(benny_home) / _VENDOR_RELATIVE
        context: Any = f"file://{vendor_path.as_posix()}"
    else:
        context = _INLINE_CONTEXT

    # Build prov:used / prov:generated URI lists
    used: list[str] = [
        f"{_ARTIFACT_PREFIX}{sha}" for sha in (inputs_shas or [])
    ]
    generated: list[str] = [
        f"{_ARTIFACT_PREFIX}{sha}"
        for sha in (outputs_shas if outputs_shas is not None else [artifact_sha])
    ]

    # Assemble envelope (§4.4)
    doc: dict[str, Any] = {
        "@context": context,
        "@type": "prov:Activity",
        "@id": f"urn:benny:run:{run_id}:task:{task_id}",
        "prov:startedAtTime": started_at,
        "prov:endedAtTime": ended_at,
        "prov:wasAssociatedWith": {
            "@id": f"urn:benny:agent:{persona}",
            "model": model,
        },
        "prov:used": used,
        "prov:generated": generated,
    }

    # Optional fields — omit rather than emit null to keep records lean
    if prompt_hash is not None:
        doc["benny:prompt_hash"] = prompt_hash
    if reasoning_hash is not None:
        doc["benny:reasoning_hash"] = reasoning_hash
    if adr_refs:
        doc["benny:adr_refs"] = list(adr_refs)
    if policy_decision is not None:
        doc["benny:policy_decision"] = policy_decision
    if cde_refs:
        doc["benny:cde_refs"] = list(cde_refs)

    # Write sidecar
    lineage_dir = _lineage_dir(workspace_path)
    out_path = lineage_dir / f"{artifact_sha}.jsonld"
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return out_path


# ---------------------------------------------------------------------------
# Public API — check_no_orphans
# ---------------------------------------------------------------------------


def check_no_orphans(*, workspace_path: Path) -> list[dict[str, Any]]:
    """Return orphan edge descriptors for the workspace lineage graph (AOS-COMP3).

    An *orphan* is an ``artifact://`` URI that appears in ``prov:used`` or
    ``prov:generated`` of any lineage record but has no corresponding file
    in ``<workspace>/artifacts/``.

    Parameters
    ----------
    workspace_path:
        Root path of the workspace to audit.

    Returns
    -------
    list[dict]
        List of dicts each with keys ``"uri"``, ``"sha"``, ``"field"``,
        ``"record_id"`` describing the missing artifact.  Returns ``[]``
        when the graph is complete.
    """
    lineage_dir = workspace_path / "data_out" / "lineage"
    if not lineage_dir.exists():
        return []

    orphans: list[dict[str, Any]] = []

    for jsonld_file in lineage_dir.glob("*.jsonld"):
        try:
            doc = json.loads(jsonld_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        record_id = doc.get("@id", jsonld_file.stem)

        for field in ("prov:used", "prov:generated"):
            refs = doc.get(field, [])
            if isinstance(refs, str):
                refs = [refs]
            for uri in refs:
                sha = _sha_from_uri(uri)
                if sha is None:
                    continue  # not an artifact:// URI — skip
                if not _artifact_exists(sha, workspace_path):
                    orphans.append(
                        {
                            "uri": uri,
                            "sha": sha,
                            "field": field,
                            "record_id": record_id,
                        }
                    )

    return orphans
