"""AAMP-001 Phase 2 — AgentVis plugin manifest contracts and sandbox constants.

Public API
----------
  PLUGIN_SANDBOX_ATTRS
      The ``sandbox`` attribute for plugin iframes (AAMP-SEC1).
      Value: ``"allow-scripts"`` — no ``allow-same-origin``, no
      ``allow-top-navigation``, no ``allow-forms``, no ``allow-popups``.

  PLUGIN_CSP
      The Content-Security-Policy string for plugin iframes (AAMP-SEC2).
      ``connect-src 'none'`` denies ``fetch`` / ``WebSocket`` / ``EventSource``
      from inside the plugin.

  PLUGIN_WATCHDOG_TIMEOUT_S
      Seconds of silence after which the iframe is killed (AAMP-NFR12).

  PluginPermissions
      Permissions a plugin may claim; MUST be a subset of the host skin's
      permissions (verified pre-mount by :func:`validate_permissions_subset`).

  PluginManifest
      Pydantic model for ``plugin.manifest.json`` per requirement.md §4.2.

  filter_events(plugin_events, skin_events, envelope_type) -> bool
      AAMP-F4 / AAMP-SEC6: return True iff *envelope_type* should reach the
      plugin (declared by plugin AND permitted by skin).

  validate_permissions_subset(plugin_perms, skin_perms_events,
                              skin_perms_audio, skin_perms_haptic) -> list[str]
      Return a list of violation strings; empty = valid.  Called pre-mount
      (AAMP-F3).

Requirements covered
--------------------
  F3    mount(): CSP iframe created; plugin permissions validated pre-mount.
  F4    Event filtering: plugins receive only declared events.
  SEC1  iframe sandbox="allow-scripts" only.
  SEC2  CSP header string; connect-src 'none'.
  SEC6  filter_events(): intersection of plugin and skin event sets.
  NFR12 PLUGIN_WATCHDOG_TIMEOUT_S = 2.0.

Dependencies: pydantic, stdlib only.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Sandbox constants (AAMP-SEC1, AAMP-SEC2, AAMP-NFR12)
# ---------------------------------------------------------------------------

# AAMP-SEC1 — only allow-scripts; no allow-same-origin, allow-top-navigation,
# allow-forms, allow-popups, or allow-pointer-lock.
PLUGIN_SANDBOX_ATTRS: str = "allow-scripts"

# AAMP-SEC2 — CSP for plugin iframes.  connect-src 'none' prevents fetch /
# WebSocket / EventSource from inside the plugin.
PLUGIN_CSP: str = (
    "default-src 'none'; "
    "script-src 'self' 'wasm-unsafe-eval'; "
    "img-src data: blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "connect-src 'none'; "
    "frame-ancestors 'self'"
)

# AAMP-NFR12 — watchdog timeout in seconds.
PLUGIN_WATCHDOG_TIMEOUT_S: float = 2.0


# ---------------------------------------------------------------------------
# Plugin permission model
# ---------------------------------------------------------------------------


class PluginPermissions(BaseModel):
    """AAMP-SEC2: plugin permissions; must be a subset of the host skin's."""

    events: List[str] = Field(default_factory=list)
    egress: List[str] = Field(default_factory=list)   # empty = deny-all
    audio: bool = False
    haptic: bool = False


# ---------------------------------------------------------------------------
# Plugin manifest (requirement.md §4.2)
# ---------------------------------------------------------------------------


class PluginManifest(BaseModel):
    """Root model for ``plugin.manifest.json`` embedded in a skin pack.

    ``signature`` is ``None`` in draft packs; ``install`` rejects unsigned
    plugins with the same rules as skin packs (AAMP-F35 / AAMP-SEC4).
    """

    schema_version: str = "1.0"
    kind: str = "agentvis"          # "agentvis" | "effect"
    id: str
    name: str = ""
    version: str = "1.0.0"
    entry: str = "index.js"         # ES module loaded into sandbox iframe
    events_subscribed: List[str] = Field(default_factory=list)
    events_emitted: List[str] = Field(default_factory=list)    # plugins don't synthesise SSE
    renders: str = "canvas"          # "canvas" | "dom" | "audio" | "haptic"
    sdk_min: str = "1.0"
    permissions: PluginPermissions = Field(default_factory=PluginPermissions)
    signature: Optional[dict] = None  # SkinSignature shape; None in drafts


# ---------------------------------------------------------------------------
# Event filtering (AAMP-F4, AAMP-SEC6)
# ---------------------------------------------------------------------------


def filter_events(
    plugin_events: List[str],
    skin_events: List[str],
    envelope_type: str,
) -> bool:
    """Return True iff *envelope_type* should be forwarded to this plugin.

    AAMP-F4 / AAMP-SEC6: the plugin receives an event only when it both
    declared the type in ``permissions.events`` **and** the host skin's
    ``permissions.events`` also include it.  Attempts to subscribe to
    undeclared types are silently ignored (no exception across the iframe
    boundary).

    Parameters
    ----------
    plugin_events:
        ``plugin_manifest.permissions.events``
    skin_events:
        ``skin_manifest.permissions.events``
    envelope_type:
        The ``source_event.type`` field from the DSP-A envelope.
    """
    allowed = {e for e in plugin_events if e in skin_events}
    return envelope_type in allowed


# ---------------------------------------------------------------------------
# Permission subset validator (AAMP-F3)
# ---------------------------------------------------------------------------


def validate_permissions_subset(
    plugin_perms: PluginPermissions,
    skin_perms_events: List[str],
    skin_perms_audio: bool,
    skin_perms_haptic: bool,
) -> List[str]:
    """Validate that *plugin_perms* is a subset of the host skin's permissions.

    Returns a list of violation strings; an empty list means the check passed.
    Called pre-mount (AAMP-F3) by :class:`~benny.agentamp.sandbox.SandboxHost`.

    Parameters
    ----------
    plugin_perms:
        Permissions declared in the plugin manifest.
    skin_perms_events:
        ``skin_manifest.permissions.events``
    skin_perms_audio:
        ``skin_manifest.permissions.audio``
    skin_perms_haptic:
        ``skin_manifest.permissions.haptic``
    """
    violations: List[str] = []

    for ev in plugin_perms.events:
        if ev not in skin_perms_events:
            violations.append(
                f"plugin declares event {ev!r} not permitted by host skin"
            )
    if plugin_perms.audio and not skin_perms_audio:
        violations.append("plugin requests audio but host skin denies it")
    if plugin_perms.haptic and not skin_perms_haptic:
        violations.append("plugin requests haptic but host skin denies it")

    return violations
