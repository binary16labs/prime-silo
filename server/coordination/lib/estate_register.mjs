// Estate live satellite discovery (EP-N / N7) — a satellite starting prime-silo on the same LAN
// REGISTERS with the driver node (T480): a heartbeat + a session-fingerprint manifest (content-
// hashes + quarantine flags ONLY, never a session's text) pushed to the hub, which records
// last-seen + reachability and recomputes the N4 drift live. LAN/loopback-only, authenticated by a
// shared per-estate key. Pure functions over injected inputs (no fs/network) so it is gate-testable.
// Spec: architecture/SOLUTION-estate.md §8.4. Privacy (R31): only hashes cross the wire.
import crypto from "node:crypto";
import { driftDelta } from "./estate_drift.mjs";

const hash = (s) => "sha256:" + crypto.createHash("sha256").update(String(s)).digest("hex");

// buildManifest(machine, sessions, quarantine) — the satellite's push payload: per session a
// content-hash + a quarantine flag, and NOTHING else. Session text/content is dropped here so it
// can never reach the wire (R31). sessions: [{ sid, content|contentHash, quarantined? }].
export function buildManifest(machine, sessions = [], quarantine = []) {
  const q = quarantine instanceof Set ? quarantine : new Set(quarantine);
  return {
    machine,
    at: Date.now(),
    sessions: (sessions || []).map((s) => ({
      sid: s.sid,
      contentHash: s.contentHash || hash(s.content ?? s.sid),
      quarantined: s.quarantined === true || q.has(s.sid)
    }))
  };
}

// isLanOrigin(remoteAddress) — loopback or RFC-1918 private LAN only; everything else is refused.
export function isLanOrigin(addr = "") {
  const a = String(addr).replace(/^::ffff:/, "");
  return (
    a === "127.0.0.1" || a === "::1" ||
    /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  );
}

// register(hubState, manifest, ctx) — authenticate (shared key) + LAN-gate + R31-guard, then record
// the satellite's last-seen/reachability and recompute drift via N4 driftDelta. Pure: returns a NEW
// state (never mutates hubState) or a rejection { ok:false, reason, state:<unchanged> }.
// ctx = { key, expectedKey, remoteAddress, hubHashes, quarantine }
export function register(hubState = {}, manifest = {}, ctx = {}) {
  const { key, expectedKey, remoteAddress = "127.0.0.1", hubHashes = [], quarantine = [] } = ctx;
  if (!expectedKey || key !== expectedKey) return { ok: false, reason: "unauthenticated", state: hubState };
  if (!isLanOrigin(remoteAddress)) return { ok: false, reason: "non-LAN origin refused", state: hubState };
  // R31 at the boundary: a manifest must carry hashes + flags only — reject any smuggled payload.
  if ((manifest.sessions || []).some((s) => "content" in s || "text" in s))
    return { ok: false, reason: "manifest carried payload — rejected (R31)", state: hubState };

  const satSessions = (manifest.sessions || []).map((s) => ({ sid: s.sid, contentHash: s.contentHash, quarantined: s.quarantined }));
  const drift = driftDelta(hubHashes, satSessions, quarantine); // reuse the N4 engine
  const state = {
    ...hubState,
    satellites: {
      ...(hubState.satellites || {}),
      [manifest.machine]: {
        lastSeen: manifest.at || Date.now(),
        reachable: true,
        sessionCount: satSessions.length,
        drift
      }
    }
  };
  return { ok: true, state, drift };
}
