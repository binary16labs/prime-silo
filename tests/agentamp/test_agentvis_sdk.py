"""AAMP-001 Phase 2 — AgentVis SDK + sandbox acceptance tests.

Covers
------
  AAMP-F3   test_aamp_f3_sdk_mount_iframe_csp
            test_aamp_f3_unmount_clean
  AAMP-F4   test_aamp_f4_event_filter_by_permissions
  AAMP-SEC1 test_aamp_sec1_iframe_sandbox_attrs
  AAMP-SEC2 test_aamp_sec2_csp_grammar
            test_aamp_sec2_connect_src_none
  AAMP-SEC6 test_aamp_sec6_event_filter_subset
  AAMP-NFR12 test_aamp_nfr12_plugin_watchdog
"""

from __future__ import annotations

import re
import threading
import time

import pytest

from benny.agentamp.plugins import (
    PLUGIN_CSP,
    PLUGIN_SANDBOX_ATTRS,
    PLUGIN_WATCHDOG_TIMEOUT_S,
    PluginManifest,
    PluginPermissions,
    filter_events,
    validate_permissions_subset,
)
from benny.agentamp.sandbox import (
    MountedPlugin,
    PluginPermissionsViolation,
    SandboxHost,
)
from benny.agentamp.contracts import (
    SkinManifest,
    SkinPermissions,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def skin_with_events():
    """A skin that permits token, wave_started, wave_ended events."""
    return SkinManifest(
        id="test-skin",
        permissions=SkinPermissions(
            events=["token", "wave_started", "wave_ended"],
            audio=True,
            haptic=False,
        ),
    )


@pytest.fixture()
def plugin_audio():
    """Plugin that declares token + wave_started and audio."""
    return PluginManifest(
        id="audio-waveform",
        entry="index.js",
        permissions=PluginPermissions(
            events=["token", "wave_started"],
            audio=True,
        ),
    )


@pytest.fixture()
def plugin_minimal():
    """Plugin that declares only token — no audio, no haptic."""
    return PluginManifest(
        id="token-counter",
        entry="counter.js",
        permissions=PluginPermissions(events=["token"]),
    )


@pytest.fixture()
def host():
    return SandboxHost()


# ---------------------------------------------------------------------------
# AAMP-SEC1: sandbox attribute
# ---------------------------------------------------------------------------


def test_aamp_sec1_iframe_sandbox_attrs():
    """PLUGIN_SANDBOX_ATTRS must be exactly 'allow-scripts' — no other tokens."""
    attrs = PLUGIN_SANDBOX_ATTRS.strip().split()
    assert attrs == ["allow-scripts"], (
        f"Expected sandbox='allow-scripts' only, got {PLUGIN_SANDBOX_ATTRS!r}. "
        "AAMP-SEC1 forbids allow-same-origin, allow-top-navigation, allow-forms, "
        "allow-popups, allow-pointer-lock."
    )


def test_aamp_sec1_no_allow_same_origin():
    assert "allow-same-origin" not in PLUGIN_SANDBOX_ATTRS


def test_aamp_sec1_no_allow_top_navigation():
    assert "allow-top-navigation" not in PLUGIN_SANDBOX_ATTRS


def test_aamp_sec1_no_allow_forms():
    assert "allow-forms" not in PLUGIN_SANDBOX_ATTRS


def test_aamp_sec1_no_allow_popups():
    assert "allow-popups" not in PLUGIN_SANDBOX_ATTRS


# ---------------------------------------------------------------------------
# AAMP-SEC2: CSP grammar + connect-src
# ---------------------------------------------------------------------------


def test_aamp_sec2_csp_grammar():
    """PLUGIN_CSP must contain all required directives (AAMP-SEC2)."""
    required_directives = [
        "default-src 'none'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "img-src data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'none'",
        "frame-ancestors 'self'",
    ]
    for directive in required_directives:
        assert directive in PLUGIN_CSP, (
            f"AAMP-SEC2: CSP missing directive {directive!r}. "
            f"Full CSP: {PLUGIN_CSP!r}"
        )


def test_aamp_sec2_connect_src_none():
    """connect-src 'none' must deny fetch / WebSocket / EventSource (AAMP-SEC2)."""
    assert "connect-src 'none'" in PLUGIN_CSP, (
        f"AAMP-SEC2: connect-src must be 'none', got: {PLUGIN_CSP!r}"
    )


def test_aamp_sec2_csp_is_string():
    assert isinstance(PLUGIN_CSP, str) and len(PLUGIN_CSP) > 0


# ---------------------------------------------------------------------------
# AAMP-F3: mount() — CSP iframe created; permissions validated
# ---------------------------------------------------------------------------


def test_aamp_f3_sdk_mount_iframe_csp(host, plugin_minimal, skin_with_events):
    """mount() succeeds when plugin permissions are a valid subset of the skin's."""
    mounted = host.mount(plugin_minimal, skin_with_events)
    assert isinstance(mounted, MountedPlugin)
    assert mounted.plugin_id == plugin_minimal.id
    assert host.sandbox_attrs == PLUGIN_SANDBOX_ATTRS
    assert host.csp == PLUGIN_CSP
    host.unmount(plugin_minimal.id)


def test_aamp_f3_mount_rejects_excess_events(host, skin_with_events):
    """mount() raises PluginPermissionsViolation when plugin claims unlisted events."""
    plugin_bad = PluginManifest(
        id="bad-plugin",
        permissions=PluginPermissions(events=["policy_denied"]),  # not in skin
    )
    with pytest.raises(PluginPermissionsViolation, match="policy_denied"):
        host.mount(plugin_bad, skin_with_events)


def test_aamp_f3_mount_rejects_audio_when_skin_denies(host):
    """mount() raises when plugin requests audio but skin denies it."""
    skin_no_audio = SkinManifest(
        id="quiet-skin",
        permissions=SkinPermissions(events=["token"], audio=False, haptic=False),
    )
    plugin_audio = PluginManifest(
        id="audio-plugin",
        permissions=PluginPermissions(events=["token"], audio=True),
    )
    with pytest.raises(PluginPermissionsViolation, match="audio"):
        host.mount(plugin_audio, skin_no_audio)


def test_aamp_f3_unmount_clean(host, plugin_minimal, skin_with_events):
    """unmount() stops watchdog and removes plugin from registry (AAMP-F3)."""
    host.mount(plugin_minimal, skin_with_events)
    assert plugin_minimal.id in host.mounted_ids

    host.unmount(plugin_minimal.id)
    assert plugin_minimal.id not in host.mounted_ids


def test_aamp_f3_unmount_idempotent(host, plugin_minimal, skin_with_events):
    """unmount() of an already-unmounted plugin is a no-op."""
    host.mount(plugin_minimal, skin_with_events)
    host.unmount(plugin_minimal.id)
    host.unmount(plugin_minimal.id)  # second call must not raise


def test_aamp_f3_host_exposes_csp_and_sandbox(host):
    assert host.csp == PLUGIN_CSP
    assert host.sandbox_attrs == PLUGIN_SANDBOX_ATTRS


# ---------------------------------------------------------------------------
# AAMP-F4: event filtering by declared permissions
# ---------------------------------------------------------------------------


def test_aamp_f4_event_filter_by_permissions():
    """filter_events() returns True only for declared events (AAMP-F4)."""
    plugin_events = ["token", "wave_started"]
    skin_events   = ["token", "wave_started", "wave_ended"]

    assert filter_events(plugin_events, skin_events, "token") is True
    assert filter_events(plugin_events, skin_events, "wave_started") is True
    assert filter_events(plugin_events, skin_events, "wave_ended") is False  # not declared by plugin


def test_aamp_f4_undeclared_events_silently_ignored():
    """Events not in the plugin's declared set are silently filtered (no exception)."""
    plugin_events = ["token"]
    skin_events = ["token", "wave_started"]
    # Attempt to receive an undeclared event
    assert filter_events(plugin_events, skin_events, "wave_started") is False
    assert filter_events(plugin_events, skin_events, "policy_denied") is False


# ---------------------------------------------------------------------------
# AAMP-SEC6: event filter is the intersection of plugin ∩ skin events
# ---------------------------------------------------------------------------


def test_aamp_sec6_event_filter_subset():
    """Plugin receives declared ∩ skin events; skin-denied events excluded even if declared."""
    # Plugin declares policy_denied but skin doesn't permit it
    plugin_events = ["token", "policy_denied"]
    skin_events   = ["token", "wave_started"]   # policy_denied not here

    assert filter_events(plugin_events, skin_events, "token") is True
    assert filter_events(plugin_events, skin_events, "policy_denied") is False


def test_aamp_sec6_empty_plugin_events():
    """A plugin with no declared events receives nothing."""
    assert filter_events([], ["token", "wave_started"], "token") is False


def test_aamp_sec6_empty_skin_events():
    """A skin that permits no events means no plugin receives any event."""
    assert filter_events(["token"], [], "token") is False


# ---------------------------------------------------------------------------
# AAMP-NFR12: plugin watchdog
# ---------------------------------------------------------------------------


def test_aamp_nfr12_plugin_watchdog(host, plugin_minimal, skin_with_events):
    """Watchdog fires within PLUGIN_WATCHDOG_TIMEOUT_S + 0.5 s tolerance (AAMP-NFR12)."""
    fired = threading.Event()

    host.mount(
        plugin_minimal,
        skin_with_events,
        on_watchdog_fire=lambda: fired.set(),
    )

    deadline = PLUGIN_WATCHDOG_TIMEOUT_S + 0.5
    fired.wait(timeout=deadline)
    assert fired.is_set(), (
        f"Watchdog did not fire within {deadline:.1f}s "
        f"(PLUGIN_WATCHDOG_TIMEOUT_S={PLUGIN_WATCHDOG_TIMEOUT_S})"
    )


def test_aamp_nfr12_heartbeat_resets_watchdog(host, plugin_minimal, skin_with_events):
    """Heartbeats keep the watchdog from firing (AAMP-NFR12)."""
    fired = threading.Event()
    mounted = host.mount(
        plugin_minimal,
        skin_with_events,
        on_watchdog_fire=lambda: fired.set(),
    )

    # Send heartbeats every 0.2 s for 0.8 s (watchdog timeout = 2 s)
    start = time.monotonic()
    while time.monotonic() - start < 0.8:
        mounted.heartbeat()
        time.sleep(0.2)

    assert not fired.is_set(), "Watchdog fired despite active heartbeats"
    host.unmount(plugin_minimal.id)


def test_aamp_nfr12_watchdog_timeout_value():
    """PLUGIN_WATCHDOG_TIMEOUT_S must be ≤ 2.0 s (AAMP-NFR12 budget)."""
    assert PLUGIN_WATCHDOG_TIMEOUT_S <= 2.0, (
        f"Watchdog timeout {PLUGIN_WATCHDOG_TIMEOUT_S}s exceeds NFR12 budget of 2 s"
    )


# ---------------------------------------------------------------------------
# validate_permissions_subset — unit tests
# ---------------------------------------------------------------------------


def test_validate_permissions_subset_valid(plugin_audio, skin_with_events):
    """No violations when plugin permissions are within the skin's."""
    violations = validate_permissions_subset(
        plugin_audio.permissions,
        skin_with_events.permissions.events,
        skin_with_events.permissions.audio,
        skin_with_events.permissions.haptic,
    )
    assert violations == []


def test_validate_permissions_subset_event_violation():
    perms = PluginPermissions(events=["policy_denied"])
    violations = validate_permissions_subset(perms, ["token"], False, False)
    assert any("policy_denied" in v for v in violations)


def test_validate_permissions_subset_audio_violation():
    perms = PluginPermissions(audio=True)
    violations = validate_permissions_subset(perms, [], False, False)
    assert any("audio" in v for v in violations)


def test_validate_permissions_subset_haptic_violation():
    perms = PluginPermissions(haptic=True)
    violations = validate_permissions_subset(perms, [], True, False)
    assert any("haptic" in v for v in violations)


def test_validate_permissions_subset_empty_perms():
    """Empty permissions are always a valid subset."""
    perms = PluginPermissions()
    violations = validate_permissions_subset(perms, [], False, False)
    assert violations == []
