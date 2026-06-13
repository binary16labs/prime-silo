// Phase M1 — integration-manifest HMAC signing helpers (node side).
//
// Mirrors runtime/benny/api/views_signing.py byte-for-byte so a manifest
// signed on either side of the stack verifies on the other:
//
//   • canonical payload = JSON with recursively sorted keys, "," / ":"
//     separators, no whitespace, top-level `signature` field stripped
//     (Python json.dumps(sort_keys=True, separators=(",", ":"),
//     ensure_ascii=False) equivalent)
//   • HMAC-SHA256 with the key from BENNY_HMAC_KEY (hex-decoded), falling
//     back to the same dev key string the runtime uses — explicitly NOT a
//     production key
//   • timing-safe comparison on verify
//
// Copied technique, not imported module — same rationale as the runtime's
// views_signing vs agentamp.signing split: surfaces with different change
// windows should not silently share algorithm changes.

import crypto from "node:crypto";

const DEV_FALLBACK_KEY = Buffer.from("benny-aos-dev-hmac-key-do-not-use-in-prod-000", "utf8");

function getHmacKey(env = process.env) {
  const raw = String(env.BENNY_HMAC_KEY || "");
  if (raw && /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, "hex");
  }
  return DEV_FALLBACK_KEY;
}

function sortValueDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortValueDeep);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValueDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic signing payload for a manifest object. Strips a top-level
 * `signature` field so sign → embed → re-sign loops are idempotent.
 */
export function canonicalManifestPayload(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("canonicalManifestPayload: manifest must be a JSON object.");
  }
  const cloned = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "signature") {
      continue;
    }
    cloned[key] = value;
  }
  return JSON.stringify(sortValueDeep(cloned));
}

/**
 * Compute an HMAC-SHA256 signature envelope over a manifest —
 * `{algorithm, value, signed_at}`, same shape as the runtime's
 * ViewSignature.
 */
export function signManifest(manifest, { env } = {}) {
  const payload = canonicalManifestPayload(manifest);
  const value = crypto.createHmac("sha256", getHmacKey(env)).update(payload, "utf8").digest("hex");
  return {
    algorithm: "HMAC-SHA256",
    value,
    signed_at: new Date().toISOString()
  };
}

/**
 * Return true iff `signature` validly signs `manifest`. Inline signatures
 * (top-level `signature` field) are stripped from the payload first, so a
 * signed file verifies against its own embedded envelope.
 */
export function verifyManifest(manifest, signature, { env } = {}) {
  if (!signature || typeof signature !== "object" || signature.algorithm !== "HMAC-SHA256") {
    return false;
  }
  const expectedHex = crypto
    .createHmac("sha256", getHmacKey(env))
    .update(canonicalManifestPayload(manifest), "utf8")
    .digest("hex");
  const provided = String(signature.value || "");
  if (provided.length !== expectedHex.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(provided, "utf8"));
}

export const __testing = { DEV_FALLBACK_KEY, getHmacKey, sortValueDeep };
