"""benny.agentamp — AgentAmp: skinnable, pluggable agentic cockpit (AAMP-001).

Public surface (Phase 1)
  contracts  — Pydantic models for SkinManifest, SkinTokens, etc.
  signing    — sign_skin_pack() / verify_skin_pack()
  skin       — load() — open .aamp zip with path-traversal guard + sig verify
  scaffold   — scaffold_skin() — deterministic draft tree generator

Public surface (Phase 2)
  plugins    — PluginManifest, PluginPermissions, filter_events(),
               validate_permissions_subset(), PLUGIN_SANDBOX_ATTRS, PLUGIN_CSP
  sandbox    — SandboxHost, MountedPlugin, PluginPermissionsViolation

Public surface (Phase 3)
  dsp        — DSPTransform, Envelope, DerivedData, transform(), envelope_key(),
               make_layout_envelope()

Public surface (Phase 4)
  tui        — BennyTUI, SkinPalette, extract_palette(), run_tui(), run_line_mode()

Public surface (Phase 5)
  equalizer  — EqKnob, EqManifest, EqLock, EQ_ALLOWED_PATHS,
               EqPathNotAllowed, EqWriteResult, validate_knob_path(),
               apply_eq_write()

Public surface (Phase 6)
  playlist   — PlaylistEntry, get_playlist(), enqueue_manifest()
  user_state — CockpitWindowPosition, CockpitUserState,
               load_user_state(), save_user_state(),
               export_cockpit(), import_cockpit()
  layout     — SNAP_ZONES, LayoutResult, resolve_snap(), clamp_window(),
               apply_layout(), layout_event_envelope()

Feature flag: ``aamp.enabled`` (AAMP-F32). Checked at CLI dispatch; not re-checked here.
"""

from .contracts import (
    SkinCliPalette,
    SkinGlyphs,
    SkinLayout,
    SkinManifest,
    SkinMinimode,
    SkinPermissions,
    SkinPlugin,
    SkinShader,
    SkinSignature,
    SkinSound,
    SkinSprite,
    SkinTokens,
    SkinWindow,
)
from .skin import (
    SkinPathEscape,
    SkinSignatureInvalid,
    SkinSignatureMissing,
    load,
)
from .signing import sign_skin_pack, verify_skin_pack
from .scaffold import scaffold_skin
from .plugins import (
    PLUGIN_CSP,
    PLUGIN_SANDBOX_ATTRS,
    PLUGIN_WATCHDOG_TIMEOUT_S,
    PluginManifest,
    PluginPermissions,
    filter_events,
    validate_permissions_subset,
)
from .sandbox import (
    MountedPlugin,
    PluginPermissionsViolation,
    SandboxHost,
)
from .dsp import (
    DEFAULT_SPECTRUM_BINS,
    DSPTransform,
    DerivedData,
    Envelope,
    envelope_key,
    make_layout_envelope,
    transform,
)
from .equalizer import (
    EQ_ALLOWED_PATHS,
    EqKnob,
    EqLock,
    EqManifest,
    EqPathNotAllowed,
    EqWriteResult,
    apply_eq_write,
    validate_knob_path,
)
from .playlist import PlaylistEntry, get_playlist, enqueue_manifest
from .user_state import (
    CockpitUserState,
    CockpitWindowPosition,
    export_cockpit,
    import_cockpit,
    load_user_state,
    save_user_state,
)
from .layout import (
    SNAP_ZONES,
    LayoutResult,
    apply_layout,
    clamp_window,
    layout_event_envelope,
    resolve_snap,
)

__all__ = [
    # Phase 1 — contracts
    "SkinManifest",
    "SkinTokens",
    "SkinCliPalette",
    "SkinGlyphs",
    "SkinLayout",
    "SkinMinimode",
    "SkinPermissions",
    "SkinPlugin",
    "SkinShader",
    "SkinSignature",
    "SkinSound",
    "SkinSprite",
    "SkinWindow",
    # Phase 1 — exceptions
    "SkinPathEscape",
    "SkinSignatureMissing",
    "SkinSignatureInvalid",
    # Phase 1 — functions
    "load",
    "sign_skin_pack",
    "verify_skin_pack",
    "scaffold_skin",
    # Phase 2 — plugin contracts + constants
    "PluginManifest",
    "PluginPermissions",
    "PLUGIN_SANDBOX_ATTRS",
    "PLUGIN_CSP",
    "PLUGIN_WATCHDOG_TIMEOUT_S",
    "filter_events",
    "validate_permissions_subset",
    # Phase 2 — sandbox host
    "SandboxHost",
    "MountedPlugin",
    "PluginPermissionsViolation",
    # Phase 3 — DSP-A pipeline
    "DSPTransform",
    "DerivedData",
    "Envelope",
    "DEFAULT_SPECTRUM_BINS",
    "envelope_key",
    "transform",
    # Phase 5 — equalizer
    "EQ_ALLOWED_PATHS",
    "EqKnob",
    "EqLock",
    "EqManifest",
    "EqPathNotAllowed",
    "EqWriteResult",
    "apply_eq_write",
    "validate_knob_path",
    # Phase 6 — playlist
    "PlaylistEntry",
    "get_playlist",
    "enqueue_manifest",
    # Phase 6 — user state
    "CockpitUserState",
    "CockpitWindowPosition",
    "load_user_state",
    "save_user_state",
    "export_cockpit",
    "import_cockpit",
    # Phase 6 — layout DSL
    "SNAP_ZONES",
    "LayoutResult",
    "resolve_snap",
    "clamp_window",
    "apply_layout",
    "layout_event_envelope",
    # Phase 3 (extended Phase 6)
    "make_layout_envelope",
]
