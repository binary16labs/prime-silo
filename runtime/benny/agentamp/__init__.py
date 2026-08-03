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

Imports are LAZY (PEP 562). Eagerly importing all eleven submodules made every
consumer of *anything* in this package pay for the heaviest one: ``playlist``
pulls ``..persistence.run_store``, which pulls litellm/langchain_core/langsmith/
opentelemetry. That cost ``from benny.agentamp.coord import cmd_coord`` — the
`benny coord` dispatch path, which needs none of it — **18.1s warm**, and far
worse cold on an OneDrive-synced tree. Submodules now load on first attribute
access, so the public surface is unchanged but nobody pays for what they do not
touch. Keep it that way: do not add a module-level ``from .x import y`` here.
"""

from typing import TYPE_CHECKING

# Public name -> the submodule that defines it. Adding an export means adding it
# here AND to __all__; the test in tests/agentamp/test_lazy_imports.py asserts the
# two agree, so a mismatch fails rather than silently producing an AttributeError.
_EXPORTS = {
    # Phase 1 — contracts
    "SkinCliPalette": "contracts",
    "SkinGlyphs": "contracts",
    "SkinLayout": "contracts",
    "SkinManifest": "contracts",
    "SkinMinimode": "contracts",
    "SkinPermissions": "contracts",
    "SkinPlugin": "contracts",
    "SkinShader": "contracts",
    "SkinSignature": "contracts",
    "SkinSound": "contracts",
    "SkinSprite": "contracts",
    "SkinTokens": "contracts",
    "SkinWindow": "contracts",
    # Phase 1 — skin / signing / scaffold
    "SkinPathEscape": "skin",
    "SkinSignatureInvalid": "skin",
    "SkinSignatureMissing": "skin",
    "load": "skin",
    "sign_skin_pack": "signing",
    "verify_skin_pack": "signing",
    "scaffold_skin": "scaffold",
    # Phase 2 — plugins / sandbox
    "PLUGIN_CSP": "plugins",
    "PLUGIN_SANDBOX_ATTRS": "plugins",
    "PLUGIN_WATCHDOG_TIMEOUT_S": "plugins",
    "PluginManifest": "plugins",
    "PluginPermissions": "plugins",
    "filter_events": "plugins",
    "validate_permissions_subset": "plugins",
    "MountedPlugin": "sandbox",
    "PluginPermissionsViolation": "sandbox",
    "SandboxHost": "sandbox",
    # Phase 3 — DSP-A
    "DEFAULT_SPECTRUM_BINS": "dsp",
    "DerivedData": "dsp",
    "DSPTransform": "dsp",
    "Envelope": "dsp",
    "envelope_key": "dsp",
    "make_layout_envelope": "dsp",
    "transform": "dsp",
    # Phase 5 — equalizer
    "EQ_ALLOWED_PATHS": "equalizer",
    "EqKnob": "equalizer",
    "EqLock": "equalizer",
    "EqManifest": "equalizer",
    "EqPathNotAllowed": "equalizer",
    "EqWriteResult": "equalizer",
    "apply_eq_write": "equalizer",
    "validate_knob_path": "equalizer",
    # Phase 6 — playlist (the heavy one: pulls ..persistence -> litellm/langchain)
    "PlaylistEntry": "playlist",
    "enqueue_manifest": "playlist",
    "get_playlist": "playlist",
    # Phase 6 — user state
    "CockpitUserState": "user_state",
    "CockpitWindowPosition": "user_state",
    "export_cockpit": "user_state",
    "import_cockpit": "user_state",
    "load_user_state": "user_state",
    "save_user_state": "user_state",
    # Phase 6 — layout DSL
    "SNAP_ZONES": "layout",
    "LayoutResult": "layout",
    "apply_layout": "layout",
    "clamp_window": "layout",
    "layout_event_envelope": "layout",
    "resolve_snap": "layout",
}


def __getattr__(name: str):
    """Resolve a public name by importing only the submodule that defines it."""
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    value = getattr(import_module(f".{module_name}", __name__), name)
    globals()[name] = value  # cache: later lookups skip __getattr__ entirely
    return value


def __dir__():
    return sorted(__all__)


if TYPE_CHECKING:  # static analysis and IDEs still see the real symbols
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
    from .dsp import (
        DEFAULT_SPECTRUM_BINS,
        DerivedData,
        DSPTransform,
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
    from .layout import (
        SNAP_ZONES,
        LayoutResult,
        apply_layout,
        clamp_window,
        layout_event_envelope,
        resolve_snap,
    )
    from .playlist import PlaylistEntry, enqueue_manifest, get_playlist
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
    from .scaffold import scaffold_skin
    from .signing import sign_skin_pack, verify_skin_pack
    from .skin import (
        SkinPathEscape,
        SkinSignatureInvalid,
        SkinSignatureMissing,
        load,
    )
    from .user_state import (
        CockpitUserState,
        CockpitWindowPosition,
        export_cockpit,
        import_cockpit,
        load_user_state,
        save_user_state,
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
