"""AAMP-001 Phase 2 — Plugin sandbox host (Python side).

Public API
----------
  PluginPermissionsViolation
      Raised by :meth:`SandboxHost.mount` when the plugin's permissions
      exceed the host skin's (AAMP-F3).

  MountedPlugin
      Dataclass representing an active plugin instance; owns a watchdog
      timer that kills the iframe after AAMP-NFR12 silence.

  SandboxHost
      Registry of mounted plugins.  The single source of truth for which
      plugins are alive, what CSP / sandbox attrs they use, and whether
      their watchdog has fired.

Usage
-----
  host = SandboxHost()
  mounted = host.mount(plugin_manifest, skin_manifest)
  # … each time a message arrives from the iframe:
  mounted.heartbeat()
  # … when the plugin is removed:
  host.unmount(plugin_id)

Requirements covered
--------------------
  F3    mount() validates permission subset; raises PluginPermissionsViolation.
  F3    unmount() tears down cleanly; watchdog stopped.
  NFR12 Watchdog fires after PLUGIN_WATCHDOG_TIMEOUT_S of silence (2 s).

Dependencies: stdlib only (threading, time, dataclasses).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

from .contracts import SkinManifest
from .plugins import (
    PLUGIN_CSP,
    PLUGIN_SANDBOX_ATTRS,
    PLUGIN_WATCHDOG_TIMEOUT_S,
    PluginManifest,
    validate_permissions_subset,
)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class PluginPermissionsViolation(ValueError):
    """Plugin permissions exceed the host skin's permissions (AAMP-F3)."""


# ---------------------------------------------------------------------------
# Mounted plugin (owns watchdog)
# ---------------------------------------------------------------------------


@dataclass
class MountedPlugin:
    """Represents an active plugin instance inside the sandbox host.

    Call :meth:`heartbeat` each time the iframe sends a message; the
    watchdog timer is reset on every heartbeat.  If no heartbeat arrives
    within :data:`~benny.agentamp.plugins.PLUGIN_WATCHDOG_TIMEOUT_S`
    seconds the ``on_watchdog_fire`` callback is invoked (AAMP-NFR12).
    """

    plugin_id: str
    manifest: PluginManifest
    on_watchdog_fire: Callable[[], None] = field(default=lambda: None)
    mounted_at: float = field(default_factory=time.monotonic)
    _last_heartbeat: float = field(init=False, default_factory=time.monotonic)
    _watchdog: Optional[threading.Timer] = field(init=False, default=None)

    # ------------------------------------------------------------------

    def heartbeat(self) -> None:
        """Reset the watchdog timer.  Call on every message from the iframe."""
        self._last_heartbeat = time.monotonic()
        if self._watchdog is not None:
            self._watchdog.cancel()
        t = threading.Timer(PLUGIN_WATCHDOG_TIMEOUT_S, self._fire)
        t.daemon = True
        t.start()
        self._watchdog = t

    def stop_watchdog(self) -> None:
        """Cancel the watchdog without triggering the callback."""
        if self._watchdog is not None:
            self._watchdog.cancel()
            self._watchdog = None

    @property
    def seconds_since_heartbeat(self) -> float:
        return time.monotonic() - self._last_heartbeat

    # ------------------------------------------------------------------

    def _fire(self) -> None:
        self._watchdog = None
        self.on_watchdog_fire()


# ---------------------------------------------------------------------------
# Sandbox host
# ---------------------------------------------------------------------------


class SandboxHost:
    """Registry of mounted AgentVis / Effect plugins (AAMP-F3).

    One instance is typically held by the AgentAmp runtime.  The host is
    responsible for:

    * Validating that a plugin's permissions are a subset of the host skin's
      before mounting (AAMP-F3).
    * Maintaining the watchdog per mounted plugin (AAMP-NFR12).
    * Providing the canonical sandbox attribute and CSP string so the JS
      layer can query them from the Python config path (AAMP-SEC1, AAMP-SEC2).
    """

    def __init__(self) -> None:
        self._plugins: Dict[str, MountedPlugin] = {}

    # ------------------------------------------------------------------
    # Mount / unmount
    # ------------------------------------------------------------------

    def mount(
        self,
        plugin_manifest: PluginManifest,
        skin_manifest: SkinManifest,
        on_watchdog_fire: Optional[Callable[[], None]] = None,
    ) -> MountedPlugin:
        """Validate permissions and register *plugin_manifest* as mounted.

        Parameters
        ----------
        plugin_manifest:
            Parsed ``plugin.manifest.json``.
        skin_manifest:
            The active skin; plugin permissions are checked against it.
        on_watchdog_fire:
            Called when the watchdog fires (AAMP-NFR12).  Defaults to a
            no-op; the JS layer is responsible for actually killing the iframe.

        Raises
        ------
        PluginPermissionsViolation
            When the plugin's permissions exceed the host skin's (AAMP-F3).
        """
        violations = validate_permissions_subset(
            plugin_manifest.permissions,
            skin_manifest.permissions.events,
            skin_manifest.permissions.audio,
            skin_manifest.permissions.haptic,
        )
        if violations:
            raise PluginPermissionsViolation(
                f"plugin {plugin_manifest.id!r} permission violations: "
                + "; ".join(violations)
            )

        callback = on_watchdog_fire if on_watchdog_fire is not None else lambda: None
        mounted = MountedPlugin(
            plugin_id=plugin_manifest.id,
            manifest=plugin_manifest,
            on_watchdog_fire=callback,
        )
        mounted.heartbeat()
        self._plugins[plugin_manifest.id] = mounted
        return mounted

    def unmount(self, plugin_id: str) -> None:
        """Stop the watchdog and remove the plugin from the registry."""
        mp = self._plugins.pop(plugin_id, None)
        if mp is not None:
            mp.stop_watchdog()

    def get(self, plugin_id: str) -> Optional[MountedPlugin]:
        return self._plugins.get(plugin_id)

    @property
    def mounted_ids(self) -> list[str]:
        return list(self._plugins)

    # ------------------------------------------------------------------
    # Security constants (AAMP-SEC1, AAMP-SEC2)
    # ------------------------------------------------------------------

    @property
    def sandbox_attrs(self) -> str:
        """``sandbox`` attribute for plugin iframes (AAMP-SEC1)."""
        return PLUGIN_SANDBOX_ATTRS

    @property
    def csp(self) -> str:
        """CSP header string for plugin iframes (AAMP-SEC2)."""
        return PLUGIN_CSP
