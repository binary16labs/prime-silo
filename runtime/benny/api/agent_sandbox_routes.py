"""ADR-001 — Agent sandbox routes.

Single-chokepoint write API for the in-browser agent. Every endpoint here
validates that the resolved target stays inside
``$BENNY_HOME/workspaces/<ws>/agent_sandbox/`` and emits an
``agent_authorship`` lineage event on success.

The four declared subdirectories mirror :data:`benny.core.workspace.AGENT_SANDBOX_SUBDIRS`:

- ``views/``   — agent-composed layouts (`.aamp.view` JSON, signable)
- ``notes/``   — agent markdown
- ``drafts/``  — draft manifests (require HITL promotion before execution)
- ``skills/``  — space-agent-style markdown skill files

The :class:`benny.api.agent_scope.AgentScopeMiddleware` already rejects any
mutating request from an agent-scoped caller that does not start with
``/api/agent_sandbox/`` — this router is what lives behind that prefix.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..core.workspace import (
    AGENT_SANDBOX_SUBDIRS,
    get_agent_sandbox_path,
    is_within_agent_sandbox,
)
from ..governance.lineage import emit_agent_authorship

router = APIRouter()


SubdirLiteral = Literal["views", "notes", "drafts", "skills"]


class SandboxWriteRequest(BaseModel):
    workspace: str = Field(default="default")
    subdir: SubdirLiteral
    filename: str = Field(
        description="Filename within the subdir. Must not contain path separators.",
    )
    content: str = Field(description="UTF-8 text content.")
    agent_id: str = Field(
        default="anonymous_agent",
        description="Identifier of the agent authoring this write — recorded in lineage.",
    )


class SandboxWriteResponse(BaseModel):
    status: Literal["written"]
    workspace: str
    relative_path: str
    bytes_written: int


@router.get("/health")
async def sandbox_health() -> dict:
    """Liveness probe — confirms the sandbox surface is mounted."""
    return {"status": "ok", "subdirs": list(AGENT_SANDBOX_SUBDIRS)}


@router.get("/list/{workspace}/{subdir}")
async def list_sandbox(workspace: str, subdir: SubdirLiteral) -> dict:
    """List files in a sandbox subdir. Read-only — also reachable via the
    standard file API, but exposed here so the agent has a single base URL."""
    target = get_agent_sandbox_path(workspace, subdir)
    target.mkdir(parents=True, exist_ok=True)
    entries = sorted(p.name for p in target.iterdir() if p.is_file())
    return {"workspace": workspace, "subdir": subdir, "entries": entries}


@router.get("/read/{workspace}/{subdir}/{filename}")
async def read_sandbox_file(workspace: str, subdir: SubdirLiteral, filename: str) -> dict:
    """Return the UTF-8 contents of a sandbox file.

    Read-only counterpart of :func:`write_sandbox_file`. Path validation is
    identical: the resolved target must stay inside the workspace's
    ``agent_sandbox/`` subtree, the filename must be a single component
    without path separators or leading ``.``, and the file must already
    exist (no implicit creation).
    """
    _validate_filename(filename)

    subdir_path = get_agent_sandbox_path(workspace, subdir)
    target = (subdir_path / filename).resolve()

    if not is_within_agent_sandbox(workspace, target):
        raise HTTPException(
            status_code=400,
            detail="Resolved path escapes the agent sandbox subtree.",
        )

    if not target.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"agent_sandbox/{subdir}/{filename} does not exist.",
        )

    content = target.read_text(encoding="utf-8")
    return {
        "workspace": workspace,
        "subdir": subdir,
        "filename": filename,
        "relative_path": f"agent_sandbox/{subdir}/{filename}",
        "content": content,
        "bytes": len(content.encode("utf-8")),
    }


@router.post("/write", response_model=SandboxWriteResponse)
async def write_sandbox_file(req: SandboxWriteRequest) -> SandboxWriteResponse:
    """Write a UTF-8 text file into ``agent_sandbox/<subdir>/``.

    Rejects:
      - Filenames containing path separators or starting with ``.``
      - Any resolved path that escapes the sandbox subtree
    """
    _validate_filename(req.filename)

    subdir_path = get_agent_sandbox_path(req.workspace, req.subdir)
    subdir_path.mkdir(parents=True, exist_ok=True)
    target = (subdir_path / req.filename).resolve()

    if not is_within_agent_sandbox(req.workspace, target):
        raise HTTPException(
            status_code=400,
            detail="Resolved path escapes the agent sandbox subtree.",
        )

    target.write_text(req.content, encoding="utf-8")
    bytes_written = len(req.content.encode("utf-8"))

    relative_path = f"agent_sandbox/{req.subdir}/{req.filename}"
    emit_agent_authorship(
        workspace_id=req.workspace,
        agent_id=req.agent_id,
        sandbox_path=relative_path,
        action="write",
        details={"bytes_written": bytes_written},
    )

    return SandboxWriteResponse(
        status="written",
        workspace=req.workspace,
        relative_path=relative_path,
        bytes_written=bytes_written,
    )


@router.post("/views/save", response_model=SandboxWriteResponse)
async def save_view(req: SandboxWriteRequest) -> SandboxWriteResponse:
    """Convenience endpoint for saving an agent-composed layout view.

    Forces ``subdir='views'`` so the agent cannot accidentally write a layout
    into ``drafts/`` or vice versa. Validates that ``content`` is valid JSON;
    rejects otherwise (views are JSON layout-DSL, not free-form text).
    """
    if req.subdir != "views":
        raise HTTPException(status_code=400, detail="save_view requires subdir='views'.")
    try:
        json.loads(req.content)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"View content must be valid JSON: {exc.msg}",
        ) from exc
    return await write_sandbox_file(req)


def _validate_filename(filename: str) -> None:
    if not filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Filename must not be empty or start with '.'")
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Filename must not contain path separators.")
    if Path(filename).name != filename:
        # Catches edge cases like 'foo/../bar' that survive the separator check on some OSes.
        raise HTTPException(status_code=400, detail="Filename must be a single path component.")
