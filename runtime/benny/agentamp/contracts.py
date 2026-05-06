"""AAMP-001 Phase 1 — Pydantic contracts for AgentAmp skin packs.

These models map 1:1 to the normative ``skin.manifest.json`` schema defined
in ``docs/requirements/11/requirement.md §4.1``.  Downstream code imports
from here; do NOT import from ``benny.agentamp.skin`` for model types.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Token sub-models
# ---------------------------------------------------------------------------


class SkinColor(BaseModel):
    bg: str = "#1a1a2e"
    surface: str = "#16213e"
    accent: str = "#e94560"
    text: str = "#eaeaea"
    muted: str = "#6c6c8a"


class SkinFont(BaseModel):
    family: str = "JetBrains Mono, monospace"
    size_base: int = 13


class SkinMotion(BaseModel):
    enabled: bool = True
    reduced: bool = False


class SkinSpacing(BaseModel):
    unit: int = 8


class SkinTokens(BaseModel):
    color: SkinColor = Field(default_factory=SkinColor)
    font: SkinFont = Field(default_factory=SkinFont)
    motion: SkinMotion = Field(default_factory=SkinMotion)
    spacing: SkinSpacing = Field(default_factory=SkinSpacing)


# ---------------------------------------------------------------------------
# Asset references
# ---------------------------------------------------------------------------


class SkinSprite(BaseModel):
    id: str
    uri: str
    width: int = 0
    height: int = 0


class SkinShader(BaseModel):
    id: str
    stage: str = "post"  # "pre" | "post"
    uri: str


class SkinSound(BaseModel):
    id: str
    uri: str
    trigger: str  # SSE event name that fires this sound


# ---------------------------------------------------------------------------
# CLI palette
# ---------------------------------------------------------------------------


class SkinGlyphs(BaseModel):
    bullet: str = "▸"
    running: str = "◆"
    done: str = "✔"
    failed: str = "✖"
    warning: str = "⚠"
    paused: str = "⏸"


class SkinCliPalette(BaseModel):
    ansi: Dict[str, str] = Field(default_factory=dict)
    glyphs: SkinGlyphs = Field(default_factory=SkinGlyphs)


# ---------------------------------------------------------------------------
# Layout DSL
# ---------------------------------------------------------------------------


class SkinWindow(BaseModel):
    id: str
    x: int = 0
    y: int = 0
    w: int = 400
    h: int = 300
    z: int = 0
    snap: Optional[str] = None  # snap zone: "tl"|"tr"|"bl"|"br"|"c" (AAMP-F20)
    min_w: int = 0              # minimum width in pixels (AAMP-F20)
    min_h: int = 0              # minimum height in pixels (AAMP-F20)


class SkinMinimode(BaseModel):
    rows: int = 24
    cols: int = 80


class SkinLayout(BaseModel):
    windows: List[SkinWindow] = Field(default_factory=list)
    minimode: SkinMinimode = Field(default_factory=SkinMinimode)


# ---------------------------------------------------------------------------
# Plugin ref
# ---------------------------------------------------------------------------


class SkinPlugin(BaseModel):
    kind: str = "agentvis"
    id: str
    uri: str
    events: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


class SkinPermissions(BaseModel):
    events: List[str] = Field(default_factory=list)
    egress: List[str] = Field(default_factory=list)  # empty = deny-all (AAMP-SEC2)
    audio: bool = False
    haptic: bool = False


# ---------------------------------------------------------------------------
# Signature envelope (AAMP-SEC4)
# ---------------------------------------------------------------------------


class SkinSignature(BaseModel):
    algorithm: str = "HMAC-SHA256"
    value: str
    signed_at: str  # ISO-8601 UTC


# ---------------------------------------------------------------------------
# Top-level manifest
# ---------------------------------------------------------------------------


class SkinManifest(BaseModel):
    """Root manifest embedded as ``skin.manifest.json`` inside a ``.aamp`` zip.

    ``signature`` is ``None`` in draft packs emitted by scaffold and
    ``skin_designer`` (AAMP-F33, AAMP-F34).  The install command rejects
    any pack whose ``signature`` is ``None`` or whose HMAC does not verify
    (AAMP-F35, GATE-AAMP-AUTOSIGN-1).
    """

    schema_version: str = "1.0"
    id: str
    tokens: SkinTokens = Field(default_factory=SkinTokens)
    sprites: List[SkinSprite] = Field(default_factory=list)
    shaders: List[SkinShader] = Field(default_factory=list)
    sounds: List[SkinSound] = Field(default_factory=list)
    cli_palette: SkinCliPalette = Field(default_factory=SkinCliPalette)
    layout: SkinLayout = Field(default_factory=SkinLayout)
    plugins: List[SkinPlugin] = Field(default_factory=list)
    permissions: SkinPermissions = Field(default_factory=SkinPermissions)
    signature: Optional[SkinSignature] = None
