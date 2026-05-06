"""AOS-001 Phase 1 — Content-addressed artifact store (pass-by-reference).

Implements AOS-F5 (put/get round-trip, content-addressed),
            AOS-F6 (auto-promote above threshold, summary clamp),
            AOS-F7 (URI substitution in tool-call args),
            AOS-SEC5 (path confinement — no escape beyond workspace root).

No external dependencies: stdlib only (hashlib, pathlib, json).
No network calls.  All storage is under workspace_path/artifacts/.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

from ..sdlc.contracts import ArtifactRef

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Outputs above this estimated-token count are stored by reference (PBR).
# Can be overridden per-manifest via memory.pbr_threshold_tokens.
DEFAULT_PBR_THRESHOLD_TOKENS: int = 1024

# Summary preview clamped to this many characters (AOS-F6 / §4.2 of requirement.md).
MAX_SUMMARY_CHARS: int = 200

_ARTIFACT_URI_PREFIX = "artifact://"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _estimate_tokens(text: str) -> int:
    """Fast approximation: 1 token ≈ 4 chars (GPT tokeniser convention)."""
    return max(1, len(text) // 4)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _artifacts_root(workspace_path: Path) -> Path:
    return workspace_path / "artifacts"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def path_for(sha256: str, *, workspace_path: Path) -> Path:
    """Return the canonical on-disk path for *sha256*, confined to workspace.

    Raises ValueError if the resolved realpath escapes the artifacts root
    (AOS-SEC5: symlink / traversal guard).
    """
    root = _artifacts_root(workspace_path)
    candidate = root / sha256[:2] / sha256[2:]

    # Realpath both sides so symlinks can't escape the root
    root_real = str(Path(os.path.realpath(root)))
    # We can only resolve the candidate if the intermediate dirs exist;
    # otherwise realpath just normalises the string — both are safe.
    candidate_real = str(Path(os.path.realpath(candidate)))

    if not candidate_real.startswith(root_real):
        raise ValueError(
            f"Path traversal attempt rejected: {candidate!r} "
            f"resolves to {candidate_real!r} outside {root_real!r}"
        )
    return candidate


def put(
    data: Union[str, bytes],
    *,
    workspace_path: Path,
    media_type: str = "text/plain",
    created_by_task: Optional[str] = None,
    summary: Optional[str] = None,
) -> ArtifactRef:
    """Store *data* content-addressed and return an :class:`ArtifactRef`.

    Idempotent: a second put of identical bytes is a no-op (file already exists).
    """
    if isinstance(data, str):
        data_bytes = data.encode("utf-8")
        text_preview = data
    else:
        data_bytes = data
        text_preview = data_bytes.decode("utf-8", errors="replace")

    sha = _sha256(data_bytes)
    target = path_for(sha, workspace_path=workspace_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data_bytes)

    # Build summary (AOS-F6 clamp)
    if summary is None:
        summary = text_preview[:MAX_SUMMARY_CHARS]
    else:
        summary = summary[:MAX_SUMMARY_CHARS]

    return ArtifactRef(
        uri=f"{_ARTIFACT_URI_PREFIX}{sha}",
        content_type=media_type,
        byte_size=len(data_bytes),
        sha256=sha,
        summary=summary,
    )


def get(uri: str, *, workspace_path: Path) -> bytes:
    """Resolve an *artifact://* URI to its raw bytes.

    Raises:
        ValueError: if *uri* does not use the artifact:// scheme.
        FileNotFoundError: if the artifact is not present in the store.
    """
    if not isinstance(uri, str) or not uri.startswith(_ARTIFACT_URI_PREFIX):
        raise ValueError(f"Not an artifact URI: {uri!r}")
    sha = uri[len(_ARTIFACT_URI_PREFIX):]
    target = path_for(sha, workspace_path=workspace_path)
    if not target.exists():
        raise FileNotFoundError(f"Artifact not found: {uri!r}")
    return target.read_bytes()


def gc(workspace_path: Path, *, keep_shas: set[str]) -> int:
    """Remove artifacts whose SHA-256 is not in *keep_shas*.

    Returns the number of files removed.
    """
    root = _artifacts_root(workspace_path)
    if not root.exists():
        return 0
    removed = 0
    for bucket in root.iterdir():
        if not bucket.is_dir():
            continue
        for artifact_file in list(bucket.iterdir()):
            sha = bucket.name + artifact_file.name
            if sha not in keep_shas:
                artifact_file.unlink(missing_ok=True)
                removed += 1
    return removed


def maybe_promote(
    text: str,
    *,
    workspace_path: Path,
    threshold_tokens: int = DEFAULT_PBR_THRESHOLD_TOKENS,
    task_id: Optional[str] = None,
    media_type: str = "text/plain",
) -> Union[str, Dict[str, Any]]:
    """Promote *text* to the artifact store if it exceeds *threshold_tokens*.

    Returns the original string when below threshold, or an :class:`ArtifactRef`
    serialised as a plain dict when promoted (safe to embed in JSON state).
    """
    if _estimate_tokens(text) <= threshold_tokens:
        return text
    ref = put(
        text,
        workspace_path=workspace_path,
        media_type=media_type,
        created_by_task=task_id,
    )
    return ref.model_dump()


def resolve_uri(value: str, *, workspace_path: Path) -> str:
    """If *value* is an artifact:// URI, fetch and return the stored content.

    Non-artifact strings are returned unchanged.
    """
    if isinstance(value, str) and value.startswith(_ARTIFACT_URI_PREFIX):
        return get(value, workspace_path=workspace_path).decode("utf-8", errors="replace")
    return value


def resolve_uris_in_args(
    args: Dict[str, Any],
    *,
    workspace_path: Path,
) -> Dict[str, Any]:
    """Walk *args* (tool-call kwargs) and expand any artifact:// string values.

    Only top-level string values are substituted; nested structures are left
    as-is to avoid unintended recursion.  Non-string values are untouched.
    """
    resolved: Dict[str, Any] = {}
    for key, value in args.items():
        if isinstance(value, str):
            resolved[key] = resolve_uri(value, workspace_path=workspace_path)
        else:
            resolved[key] = value
    return resolved
