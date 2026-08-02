// The shared per-estate registration key (EP-N / N7).
//
// N7 built the hub half of live satellite discovery — POST /api/estate/register, with a
// shared-key check, a LAN gate and an R31 payload guard — but nothing ever supplied the
// key, so `expectedKey` was null and `register()` refused EVERY registration as
// "unauthenticated". The route was wired and dead. This resolves the key so the feature
// can actually be switched on.
//
// FAIL CLOSED BY DEFAULT. No key configured means no key resolved means the route keeps
// refusing everything — the surface stays shut until the owner deliberately opens it.
// That is why the key is never auto-generated at server start: creating a credential as a
// side effect of booting is how a network surface opens without anyone deciding to open it.
// `--init` is a separate, explicit act.
//
// The key is a local shared secret between the owner's own two machines. It is stored
// alongside the existing `state/hmac-key` and is never logged, never printed by the
// server, and never sent anywhere by this module.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KEY_FILENAME = "estate-register-key";

/** Where the key lives. Honours BENNY_HOME like every other control (MI-5). */
export function keyPath(home = process.env.BENNY_HOME || "D:/benny-home/benny") {
  return path.join(String(home).replace(/\\/g, "/"), "state", KEY_FILENAME);
}

/** Resolve the key, or null. Env wins (useful on the satellite, and in tests); otherwise
 *  the keystore file. A blank or whitespace-only file resolves to null, NOT to "" — an
 *  empty string would compare equal to a missing client key and authenticate everyone. */
export function resolveRegisterKey({ home, env = process.env } = {}) {
  const fromEnv = String(env.ESTATE_REGISTER_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const v = fs.readFileSync(keyPath(home), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Generate and persist a key. Refuses to overwrite an existing one unless forced —
 *  rotating silently would lock out every satellite already holding the old key. */
export function initRegisterKey({ home, force = false } = {}) {
  const p = keyPath(home);
  if (fs.existsSync(p) && !force)
    return { ok: false, path: p, reason: "a key already exists — pass force to rotate (every satellite must be re-keyed)" };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, key + "\n", { encoding: "utf8", mode: 0o600 });
  return { ok: true, path: p, bytes: 32 };
}
